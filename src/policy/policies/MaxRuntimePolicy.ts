import { Policy, AgentRuntimeState, PolicyResult } from "../types.js";
import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";

export class MaxRuntimePolicy implements Policy {
    name = "MaxRuntimePolicy";
    private maxSeconds: number;
    private startTime: number;

    constructor(maxSeconds: number) {
        this.maxSeconds = maxSeconds;
        this.startTime = Date.now();
    }

    getMaxSeconds(): number {
        return this.maxSeconds;
    }

    async validate(request: CallToolRequest, state: AgentRuntimeState): Promise<PolicyResult | null> {
        const elapsed = (Date.now() - this.startTime) / 1000;

        if (elapsed > this.maxSeconds) {
            return {
                policyName: this.name,
                action: "kill",
                reason: `Maximum runtime exceeded (${elapsed.toFixed(1)}s > ${this.maxSeconds}s).`
            };
        }
        return null;
    }
}
