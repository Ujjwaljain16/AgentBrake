import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult, ToolOutcome } from "../types.js";
import { FlowConfig, FlowSchema, ViolationAction } from "../../config/schema.js";
import { TaintStore, SourceRecord, FlowLabel, LeakMatch, resultText, argumentText } from "../../flow/taint.js";
import { findSecrets } from "../../flow/secrets.js";
import { canonicalizePath, isWithin, PathOptions, Platform } from "../semantic/paths.js";
import { Logger } from "../../monitor/logger.js";

interface CompiledSource {
    tools: Set<string>;
    label: FlowConfig["sources"][number]["label"];
    paths?: { argument: string; roots: string[]; options: PathOptions };
}

export interface FlowPolicyOptions {
    platform?: Platform;
    homeDir?: string;
}

/**
 * Secret-flow tracking across tool calls.
 *
 * Results of source tools (and any result containing a well-known credential format) are
 * remembered as winnowed fingerprints. Before a sink call is forwarded, its arguments, and
 * their base64 / hex / percent-decoded and reversed forms, are checked against them. A match
 * means data read from a protected source is about to leave through another tool.
 *
 * Separately, once the session has both read protected data and taken in untrusted content
 * (e.g. a fetched web page), sink calls get the `lethal_trifecta` action even without a match,
 * because the untrusted content may be steering the agent.
 */
export class FlowPolicy implements Policy {
    name = "FlowPolicy";
    readonly store: TaintStore;
    private config: FlowConfig;
    private sources: CompiledSource[];
    private sinks: Set<string> | "*";
    private exempt: Set<string>;
    private untrustedFrom: string | null = null;
    private protectedSeen: SourceRecord | null = null;
    /** A protected result too large to fingerprint completely: every sink is refused (fail closed). */
    private opaque: SourceRecord | null = null;

    constructor(config: Partial<FlowConfig> | FlowConfig, opts: FlowPolicyOptions = {}) {
        this.config = FlowSchema.parse(config);
        this.store = new TaintStore({
            k: this.config.kgram,
            w: this.config.window,
            maxFingerprints: this.config.max_fingerprints
        });
        this.sinks = this.config.sinks === "*" ? "*" : new Set(this.config.sinks);
        this.exempt = new Set(this.config.exempt_sinks);
        this.sources = this.config.sources.map(source => {
            const tools = new Set(Array.isArray(source.tool) ? source.tool : [source.tool]);
            if (!source.paths) return { tools, label: source.label };
            const options: PathOptions = {
                platform: opts.platform,
                homeDir: opts.homeDir,
                baseDir: source.paths.base_dir,
                caseInsensitive: source.paths.case_insensitive
            };
            const roots = source.paths.within.map(dir => {
                const c = canonicalizePath(dir, options);
                if (!c.ok) throw new Error(`Invalid directory '${dir}' in flow source: ${c.reason}`);
                return c.path;
            });
            return { tools, label: source.label, paths: { argument: source.paths.argument, roots, options } };
        });
    }

    async validate(request: CallToolRequest, _state: AgentRuntimeState): Promise<PolicyResult | null> {
        const toolName = request.params.name;
        if (!this.isSink(toolName)) return null;

        const text = argumentText((request.params.arguments ?? {}) as Record<string, unknown>);
        if (text.length > this.config.max_sink_chars) {
            return this.result(this.config.on_leak, `Tool '${toolName}' arguments are too large to check for protected data (${text.length} > ${this.config.max_sink_chars} characters).`);
        }

        if (this.opaque) {
            return this.result(this.config.on_leak, `Tool '${toolName}' refused: the session read a ${this.opaque.label} result from '${this.opaque.tool}' (source #${this.opaque.id}) that was too large to fingerprint completely.`);
        }

        const match = this.store.check(text);
        if (match) {
            Logger.logEvent("FLOW_LEAK", {
                sink: toolName,
                source: match.source.id,
                sourceTool: match.source.tool,
                label: match.source.label,
                origin: match.source.origin,
                via: match.via,
                hits: match.hits
            });
            return this.result(this.config.on_leak, this.describe(toolName, match));
        }

        if (this.config.lethal_trifecta !== "allow" && this.untrustedFrom && this.protectedSeen) {
            return this.result(this.config.lethal_trifecta,
                `Tool '${toolName}' can send data out after the session read ${this.protectedSeen.label} data from '${this.protectedSeen.tool}' and took in untrusted content from '${this.untrustedFrom}' (lethal trifecta).`);
        }

        return null;
    }

    observeResult(outcome: ToolOutcome): void {
        if (outcome.result === undefined) return;
        const labels = this.labelsFor(outcome);
        const { text, truncated } = resultText(outcome.result, this.config.max_source_chars);
        if (text.length === 0) return;

        for (const label of labels) {
            if (label === "untrusted") {
                this.untrustedFrom ??= outcome.toolName;
                continue;
            }
            const source = this.store.addSource(outcome.toolName, label, "configured source");
            const added = this.store.addText(source, text);
            this.protectedSeen ??= source;
            if (truncated) this.opaque ??= source;
            Logger.logEvent("FLOW_SOURCE", { source: source.id, tool: outcome.toolName, label, fingerprints: added, truncated });
        }

        if (this.config.detect_secrets) {
            const findings = findSecrets(text);
            if (findings.length > 0) {
                const kinds = [...new Set(findings.map(f => f.kind))];
                const source = this.store.addSource(outcome.toolName, "secret", `detected ${kinds.join(", ")}`);
                for (const finding of findings) this.store.addLiteral(source, finding.value);
                this.protectedSeen ??= source;
                Logger.logEvent("FLOW_SOURCE", { source: source.id, tool: outcome.toolName, label: "secret", detected: kinds, count: findings.length });
            }
        }
    }

    /** Observability: what the tracker currently holds. */
    getStatus() {
        return {
            ...this.store.stats(),
            untrustedFrom: this.untrustedFrom,
            protectedSeen: this.protectedSeen?.id ?? null,
            opaque: this.opaque?.id ?? null
        };
    }

    private isSink(toolName: string): boolean {
        if (this.exempt.has(toolName)) return false;
        return this.sinks === "*" || this.sinks.has(toolName);
    }

    private labelsFor(outcome: ToolOutcome): Array<FlowLabel | "untrusted"> {
        const labels: Array<FlowLabel | "untrusted"> = [];
        for (const source of this.sources) {
            if (!source.tools.has(outcome.toolName)) continue;
            if (source.paths && !this.pathMatches(source.paths, outcome.args)) continue;
            if (!labels.includes(source.label)) labels.push(source.label);
        }
        return labels;
    }

    private pathMatches(paths: NonNullable<CompiledSource["paths"]>, args: Record<string, unknown>): boolean {
        const value = args[paths.argument];
        const values = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter(v => typeof v === "string") : [];
        return values.some(v => {
            const c = canonicalizePath(v as string, paths.options);
            // A path that cannot be canonicalised is treated as matching: protect rather than miss.
            return !c.ok || paths.roots.some(root => isWithin(c.path, root, paths.options));
        });
    }

    private describe(toolName: string, match: LeakMatch): string {
        const how = match.via === "plain" ? "" : ` after ${match.via} decoding`;
        const what = match.kind === "literal" ? "a detected credential" : `${match.hits} fingerprint${match.hits === 1 ? "" : "s"}`;
        return `Tool '${toolName}' would send ${match.source.label} data first returned by '${match.source.tool}' (source #${match.source.id}, ${match.source.origin}); matched ${what}${how}.`;
    }

    private result(action: ViolationAction | "allow", reason: string): PolicyResult | null {
        if (action === "allow") return null;
        return { policyName: this.name, action, reason };
    }
}
