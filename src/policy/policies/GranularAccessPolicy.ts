import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult } from "../types.js";
import { GranularRule } from "../../config/schema.js";
import { compileSafeRegex } from "../safeRegex.js";

/** Argument values longer than this are never regex-tested (bounds ReDoS cost) and fail closed. */
export const MAX_ARGUMENT_VALUE_LENGTH = 8192;

type CompiledMatchers = Array<{ argName: string; regex: RegExp }>;

interface CompiledRule {
    rule: GranularRule;
    deny?: CompiledMatchers;
    allow?: CompiledMatchers;
}

/**
 * Validates tool call arguments against regex patterns for DLP.
 *
 * Patterns are compiled (and validated) once at construction, so an invalid or
 * dangerous pattern prevents startup instead of failing at call time.
 * Regex matching on arguments is a heuristic guard, not a sandbox.
 */
export class GranularAccessPolicy implements Policy {
    name = "GranularAccessPolicy";
    private rules: CompiledRule[];

    constructor(rules: GranularRule[]) {
        this.rules = rules.map(rule => ({
            rule,
            deny: rule.deny_if?.arguments ? this.compile(rule.deny_if.arguments) : undefined,
            allow: rule.allow_if?.arguments ? this.compile(rule.allow_if.arguments) : undefined
        }));
    }

    async validate(request: CallToolRequest, state: AgentRuntimeState): Promise<PolicyResult | null> {
        const toolName = request.params.name;
        const args = (request.params.arguments || {}) as Record<string, unknown>;
        const applicableRules = this.rules.filter(compiled => compiled.rule.tool === toolName);

        for (const { rule, deny, allow } of applicableRules) {
            if (deny && this.matchesAll(args, deny, "deny")) {
                return {
                    policyName: this.name,
                    action: rule.action || "block",
                    reason: `Tool '${toolName}' arguments match DENY pattern.`
                };
            }

            if (allow && !this.matchesAll(args, allow, "allow")) {
                return {
                    policyName: this.name,
                    action: rule.action || "block",
                    reason: `Tool '${toolName}' arguments do not match ALLOW pattern.`
                };
            }
        }

        return null;
    }

    private compile(patterns: Record<string, string>): CompiledMatchers {
        return Object.entries(patterns).map(([argName, pattern]) => ({
            argName,
            regex: compileSafeRegex(pattern)
        }));
    }

    /**
     * True when every argument matcher matches. Oversized values fail closed:
     * they count as a deny match and as an allow mismatch.
     */
    private matchesAll(args: Record<string, unknown>, matchers: CompiledMatchers, mode: "allow" | "deny"): boolean {
        for (const { argName, regex } of matchers) {
            if (!Object.prototype.hasOwnProperty.call(args, argName)) return false;

            const text = this.stringify(args[argName]);
            if (text.length > MAX_ARGUMENT_VALUE_LENGTH) {
                if (mode === "deny") continue;
                return false;
            }
            if (!regex.test(text)) return false;
        }
        return true;
    }

    private stringify(value: unknown): string {
        if (typeof value === "string") return value;
        if (value !== null && typeof value === "object") {
            try {
                return JSON.stringify(value);
            } catch {
                return "";
            }
        }
        return String(value);
    }
}
