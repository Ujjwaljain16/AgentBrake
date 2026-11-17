import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult } from "../types.js";

/**
 * Sliding-window rate limit over forwarded calls. Warns at 80% of capacity, blocks at the limit.
 * Only calls that are actually forwarded (commit) use up capacity.
 */
export class RateLimitPolicy implements Policy {
    name = "RateLimitPolicy";
    private callsPerWindow: number;
    private windowMs: number;
    private callTimestamps: number[] = [];
    private warningThreshold: number;

    constructor(callsPerWindow: number, windowSeconds: number = 60, private now: () => number = Date.now) {
        this.callsPerWindow = callsPerWindow;
        this.windowMs = windowSeconds * 1000;
        this.warningThreshold = Math.floor(callsPerWindow * 0.8);
    }

    async validate(_request: CallToolRequest, _state: AgentRuntimeState): Promise<PolicyResult | null> {
        const now = this.now();
        this.prune(now);
        const currentRate = this.callTimestamps.length;

        if (currentRate >= this.callsPerWindow) {
            const retryAfterMs = Math.max(0, this.callTimestamps[0] + this.windowMs - now);
            return {
                policyName: this.name,
                action: "block",
                reason: `Rate limit exceeded (${currentRate}/${this.callsPerWindow} per ${this.windowMs / 1000}s). Retry after ${retryAfterMs}ms.`
            };
        }

        if (currentRate >= this.warningThreshold) {
            return {
                policyName: this.name,
                action: "warn",
                reason: `Approaching rate limit (${currentRate + 1}/${this.callsPerWindow}).`
            };
        }

        return null;
    }

    commit(): void {
        this.callTimestamps.push(this.now());
    }

    getCurrentRate(): { current: number; limit: number; windowMs: number } {
        this.prune(this.now());
        return { current: this.callTimestamps.length, limit: this.callsPerWindow, windowMs: this.windowMs };
    }

    private prune(now: number): void {
        // Timestamps are appended in order, so expired ones are always at the front.
        let expired = 0;
        while (expired < this.callTimestamps.length && now - this.callTimestamps[expired] >= this.windowMs) expired++;
        if (expired > 0) this.callTimestamps.splice(0, expired);
    }
}
