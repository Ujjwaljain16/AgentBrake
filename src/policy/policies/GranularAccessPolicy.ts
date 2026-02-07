import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult } from "../types.js";
import { GranularRule } from "../../config/schema.js";

/**
 * Validates tool call arguments against regex patterns for DLP.
 */
export class GranularAccessPolicy implements Policy {
    name = "GranularAccessPolicy";
    private rules: GranularRule[];

    constructor(rules: GranularRule[]) {
        this.rules = rules;
    }

    async validate(request: CallToolRequest, state: AgentRuntimeState): Promise<PolicyResult | null> {
        const toolName = request.params.name;
        const args = request.params.arguments || {};
        const applicableRules = this.rules.filter(rule => rule.tool === toolName);

        if (applicableRules.length === 0) {
            return null;
        }

        for (const rule of applicableRules) {
            if (rule.deny_if?.arguments) {
                if (this.matchesPatterns(args, rule.deny_if.arguments)) {
                    return {
                        policyName: this.name,
                        action: rule.action || "block",
                        reason: `Tool '${toolName}' arguments match DENY pattern.`
                    };
                }
            }

            if (rule.allow_if?.arguments) {
                if (!this.matchesPatterns(args, rule.allow_if.arguments)) {
                    return {
                        policyName: this.name,
                        action: rule.action || "block",
                        reason: `Tool '${toolName}' arguments do not match ALLOW pattern.`
                    };
                }
            }
        }

        return null;
    }

    private matchesPatterns(args: Record<string, unknown>, patterns: Record<string, string>): boolean {
        for (const [argName, pattern] of Object.entries(patterns)) {
            const argValue = args[argName];
            if (argValue === undefined) return false;
            if (!new RegExp(pattern).test(String(argValue))) return false;
        }
        return true;
    }
}
