import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult } from "../types.js";

/**
 * V4 Feature: RateLimitPolicy
 * 
 * Instead of hard blocking, this policy implements rate limiting with
 * exponential backoff. It tracks call frequency and responds with
 * "warn" actions before escalating to "block".
 * 
 * This is the "soft landing" approach - agents get slowed down, not killed.
 */
export class RateLimitPolicy implements Policy {
    name = "RateLimitPolicy";

    private callsPerWindow: number;
    private windowMs: number;
    private callTimestamps: number[] = [];
    private warningThreshold: number;

    /**
     * @param callsPerWindow Max calls allowed in the time window
     * @param windowSeconds Time window in seconds
     */
    constructor(callsPerWindow: number, windowSeconds: number = 60) {
        this.callsPerWindow = callsPerWindow;
        this.windowMs = windowSeconds * 1000;
        this.warningThreshold = Math.floor(callsPerWindow * 0.8); // Warn at 80%
    }

    async validate(request: CallToolRequest, state: AgentRuntimeState): Promise<PolicyResult | null> {
        const now = Date.now();

        // Remove timestamps outside the current window
        this.callTimestamps = this.callTimestamps.filter(ts => (now - ts) < this.windowMs);

        const currentRate = this.callTimestamps.length;

        // Check if we're at the hard limit
        if (currentRate >= this.callsPerWindow) {
            const waitTime = this.calculateBackoff(currentRate);
            return {
                policyName: this.name,
                action: "block",
                reason: `Rate limit exceeded (${currentRate}/${this.callsPerWindow} calls in window). Retry after ${waitTime}ms.`
            };
        }

        // Check if we're approaching the limit (warning zone)
        if (currentRate >= this.warningThreshold) {
            // Record the call but warn
            this.callTimestamps.push(now);
            return {
                policyName: this.name,
                action: "warn",
                reason: `Approaching rate limit (${currentRate + 1}/${this.callsPerWindow}). Slow down.`
            };
        }

        // Under the limit - record and allow
        this.callTimestamps.push(now);
        return null;
    }

    /**
     * Calculate exponential backoff based on how far over the limit we are.
     */
    private calculateBackoff(currentRate: number): number {
        const overage = currentRate - this.callsPerWindow;
        const baseDelay = 1000; // 1 second
        const maxDelay = 30000; // 30 seconds max

        const delay = Math.min(baseDelay * Math.pow(2, overage), maxDelay);
        return Math.floor(delay);
    }

    /**
     * Get current rate info for monitoring
     */
    getCurrentRate(): { current: number, limit: number, windowMs: number } {
        const now = Date.now();
        const activeTimestamps = this.callTimestamps.filter(ts => (now - ts) < this.windowMs);
        return {
            current: activeTimestamps.length,
            limit: this.callsPerWindow,
            windowMs: this.windowMs
        };
    }
}
