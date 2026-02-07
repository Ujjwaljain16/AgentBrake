import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult } from "../types.js";

/**
 * Rate limiting with exponential backoff. Warns at 80% capacity, blocks at limit.
 */
export class RateLimitPolicy implements Policy {
    name = "RateLimitPolicy";
    private callsPerWindow: number;
    private windowMs: number;
    private callTimestamps: number[] = [];
    private warningThreshold: number;

    constructor(callsPerWindow: number, windowSeconds: number = 60) {
        this.callsPerWindow = callsPerWindow;
        this.windowMs = windowSeconds * 1000;
        this.warningThreshold = Math.floor(callsPerWindow * 0.8);
    }

    async validate(request: CallToolRequest, state: AgentRuntimeState): Promise<PolicyResult | null> {
        const now = Date.now();
        this.callTimestamps = this.callTimestamps.filter(ts => (now - ts) < this.windowMs);
        const currentRate = this.callTimestamps.length;

        if (currentRate >= this.callsPerWindow) {
            const waitTime = this.calculateBackoff(currentRate);
            return {
                policyName: this.name,
                action: "block",
                reason: `Rate limit exceeded (${currentRate}/${this.callsPerWindow}). Retry after ${waitTime}ms.`
            };
        }

        if (currentRate >= this.warningThreshold) {
            this.callTimestamps.push(now);
            return {
                policyName: this.name,
                action: "warn",
                reason: `Approaching rate limit (${currentRate + 1}/${this.callsPerWindow}).`
            };
        }

        this.callTimestamps.push(now);
        return null;
    }

    private calculateBackoff(currentRate: number): number {
        const overage = currentRate - this.callsPerWindow;
        const baseDelay = 1000;
        const maxDelay = 30000;
        return Math.min(Math.floor(baseDelay * Math.pow(2, overage)), maxDelay);
    }

    getCurrentRate(): { current: number; limit: number; windowMs: number } {
        const now = Date.now();
        const activeTimestamps = this.callTimestamps.filter(ts => (now - ts) < this.windowMs);
        return {
            current: activeTimestamps.length,
            limit: this.callsPerWindow,
            windowMs: this.windowMs
        };
    }
}
