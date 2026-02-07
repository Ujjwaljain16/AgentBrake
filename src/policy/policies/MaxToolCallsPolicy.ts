import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult } from "../types.js";

export class MaxToolCallsPolicy implements Policy {
    name = "MaxToolCallsPolicy";
    private maxCalls: number;

    constructor(maxCalls: number) {
        this.maxCalls = maxCalls;
    }

    async validate(request: CallToolRequest, state: AgentRuntimeState): Promise<PolicyResult | null> {
        if (state.toolCallsCount >= this.maxCalls) {
            return {
                policyName: this.name,
                action: "block",
                reason: `Maximum tool calls limit (${this.maxCalls}) has been reached.`
            };
        }
        return null;
    }
}
