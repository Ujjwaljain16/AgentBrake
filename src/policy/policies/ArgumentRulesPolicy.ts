import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult } from "../types.js";
import { ArgumentRule, PathRule, UrlRule, ViolationAction } from "../../config/schema.js";
import { canonicalizePath, isWithin, PathOptions, Platform } from "../semantic/paths.js";
import { canonicalizeUrl, hostMatches, isPrivateHost, resolvesToPrivate, Lookup } from "../semantic/urls.js";

interface CompiledPathRule {
    rule: PathRule;
    tools: Set<string>;
    options: PathOptions;
    within?: string[];
    notWithin?: string[];
}

interface CompiledUrlRule {
    rule: UrlRule;
    tools: Set<string>;
    schemes?: Set<string>;
}

export interface ArgumentRulesOptions {
    platform?: Platform;
    homeDir?: string;
    /** DNS lookup used when a rule sets resolve_dns (injectable for tests). */
    lookup?: Lookup;
}

/**
 * Typed argument rules: paths are compared by directory boundaries after canonicalisation and
 * URLs after WHATWG parsing, so "../" tricks, encodings and numeric IP forms do not slip past a
 * string pattern. Arguments that are neither a string nor a list of strings fail closed.
 */
export class ArgumentRulesPolicy implements Policy {
    name = "ArgumentRulesPolicy";
    private pathRules: CompiledPathRule[] = [];
    private urlRules: CompiledUrlRule[] = [];

    constructor(rules: ArgumentRule[], private defaultAction: ViolationAction = "block", private opts: ArgumentRulesOptions = {}) {
        for (const rule of rules) {
            const tools = new Set(Array.isArray(rule.tool) ? rule.tool : [rule.tool]);
            if (rule.type === "path") {
                const options: PathOptions = {
                    platform: opts.platform,
                    homeDir: opts.homeDir,
                    baseDir: rule.base_dir,
                    caseInsensitive: rule.case_insensitive,
                    resolveSymlinks: rule.resolve_symlinks
                };
                const root = (dir: string) => {
                    const c = canonicalizePath(dir, options);
                    if (!c.ok) throw new Error(`Invalid directory '${dir}' in path rule: ${c.reason}`);
                    return c.path;
                };
                this.pathRules.push({
                    rule,
                    tools,
                    options,
                    within: rule.within?.map(root),
                    notWithin: rule.not_within?.map(root)
                });
            } else {
                this.urlRules.push({
                    rule,
                    tools,
                    schemes: rule.allowed_schemes
                        ? new Set(rule.allowed_schemes.map(s => s.toLowerCase().replace(/:$/, "")))
                        : undefined
                });
            }
        }
    }

    async validate(request: CallToolRequest, _state: AgentRuntimeState): Promise<PolicyResult | null> {
        const toolName = request.params.name;
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;

        for (const compiled of this.pathRules) {
            if (!compiled.tools.has(toolName)) continue;
            const values = this.values(args, compiled.rule.argument);
            if (values === null) return this.violation(compiled.rule, toolName, "is not a string or list of strings");
            for (const value of values) {
                const problem = this.checkPath(compiled, value);
                if (problem) return this.violation(compiled.rule, toolName, problem);
            }
        }

        for (const compiled of this.urlRules) {
            if (!compiled.tools.has(toolName)) continue;
            const values = this.values(args, compiled.rule.argument);
            if (values === null) return this.violation(compiled.rule, toolName, "is not a string or list of strings");
            for (const value of values) {
                const problem = await this.checkUrl(compiled, value);
                if (problem) return this.violation(compiled.rule, toolName, problem);
            }
        }

        return null;
    }

    /** [] when the argument is absent; null when it has an unusable type (fail closed). */
    private values(args: Record<string, unknown>, name: string): string[] | null {
        if (!Object.prototype.hasOwnProperty.call(args, name)) return [];
        const value = args[name];
        if (typeof value === "string") return [value];
        if (Array.isArray(value) && value.every(v => typeof v === "string")) return value as string[];
        return null;
    }

    private checkPath(compiled: CompiledPathRule, value: string): string | null {
        const c = canonicalizePath(value, compiled.options);
        if (!c.ok) return `is not an acceptable path (${c.reason})`;
        const inside = (roots: string[]) => roots.find(root => isWithin(c.path, root, compiled.options));

        const denied = compiled.notWithin && inside(compiled.notWithin);
        if (denied) return `resolves to '${c.path}', inside denied '${denied}'`;
        if (compiled.within && !inside(compiled.within)) {
            return `resolves to '${c.path}', outside the allowed directories`;
        }
        return null;
    }

    private async checkUrl(compiled: CompiledUrlRule, value: string): Promise<string | null> {
        const { rule } = compiled;
        const c = canonicalizeUrl(value);
        if (!c.ok) return `is not an acceptable URL (${c.reason})`;

        const scheme = c.url.protocol.replace(/:$/, "");
        if (compiled.schemes && !compiled.schemes.has(scheme)) return `uses scheme '${scheme}', which is not allowed`;
        if (rule.deny_credentials && c.hasCredentials) return "embeds credentials (user:password@host)";
        if (rule.denied_hosts?.some(p => hostMatches(c.host, p))) return `targets denied host '${c.host}'`;
        if (rule.allowed_hosts && !rule.allowed_hosts.some(p => hostMatches(c.host, p))) {
            return `targets host '${c.host}', which is not allowed`;
        }
        if (rule.block_private_networks) {
            if (isPrivateHost(c.host)) return `targets private or internal address '${c.host}'`;
            if (rule.resolve_dns && await resolvesToPrivate(c.host, this.opts.lookup)) {
                return `host '${c.host}' resolves to a private or internal address (or does not resolve)`;
            }
        }
        return null;
    }

    private violation(rule: ArgumentRule, toolName: string, problem: string): PolicyResult {
        return {
            policyName: this.name,
            action: rule.action ?? this.defaultAction,
            reason: `Tool '${toolName}' argument '${rule.argument}' ${problem}.`
        };
    }
}
