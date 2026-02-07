import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult } from "../types.js";
import { GranularRule } from "../../config/schema.js";

/**
 * V3 Semantic Firewall: GranularAccessPolicy
 * 
 * Validates tool call arguments against regex patterns.
 * Enables Data Loss Prevention (DLP) by restricting what data tools can access.
 * 
 * Example: Allow read_file only for /tmp/* paths, block /etc/* paths.
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

        // Find rules that apply to this tool
        const applicableRules = this.rules.filter(rule => rule.tool === toolName);

        if (applicableRules.length === 0) {
            return null; // No granular rules for this tool
        }

        for (const rule of applicableRules) {
            // Check deny_if first (deny takes precedence)
            if (rule.deny_if?.arguments) {
                const denied = this.matchesPatterns(args, rule.deny_if.arguments);
                if (denied) {
                    return {
                        policyName: this.name,
                        action: rule.action || "block",
                        reason: `Tool '${toolName}' arguments match DENY pattern. Blocked by Semantic Firewall.`
                    };
                }
            }

            // Check allow_if (if specified, arguments MUST match to be allowed)
            if (rule.allow_if?.arguments) {
                const allowed = this.matchesPatterns(args, rule.allow_if.arguments);
                if (!allowed) {
                    return {
                        policyName: this.name,
                        action: rule.action || "block",
                        reason: `Tool '${toolName}' arguments do not match ALLOW pattern. Blocked by Semantic Firewall.`
                    };
                }
            }
        }

        return null; // All checks passed
    }

    /**
     * Checks if the provided arguments match ALL the regex patterns.
     */
    private matchesPatterns(args: Record<string, unknown>, patterns: Record<string, string>): boolean {
        for (const [argName, pattern] of Object.entries(patterns)) {
            const argValue = args[argName];

            if (argValue === undefined) {
                return false; // Required argument not present
            }

            const regex = new RegExp(pattern);
            if (!regex.test(String(argValue))) {
                return false; // Pattern does not match
            }
        }
        return true; // All patterns matched
    }
}
