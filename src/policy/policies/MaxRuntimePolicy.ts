import { Policy, AgentRuntimeState, PolicyResult } from "../types.js";
import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";

/**
 * Session runtime limit. The clock starts when the proxy session starts (onSessionStart).
 * The proxy also arms a hard timer from deadline(), so the session ends on time even when
 * no further tool call arrives.
 */
export class MaxRuntimePolicy implements Policy {
    name = "MaxRuntimePolicy";
    private startTime: number;

    constructor(private maxSeconds: number, private now: () => number = Date.now) {
        this.startTime = now();
    }

    getMaxSeconds(): number {
        return this.maxSeconds;
    }

    onSessionStart(): void {
        this.startTime = this.now();
    }

    deadline(): number {
        return this.startTime + this.maxSeconds * 1000;
    }

    async validate(_request: CallToolRequest, _state: AgentRuntimeState): Promise<PolicyResult | null> {
        const elapsed = (this.now() - this.startTime) / 1000;
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
