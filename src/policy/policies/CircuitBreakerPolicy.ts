import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult } from "../types.js";

/**
 * Circuit Breaker Pattern: Auto-disables tools after consecutive failures.
 * Provides resilience by preventing cascading failures.
 */
export class CircuitBreakerPolicy implements Policy {
    name = "CircuitBreakerPolicy";

    private failureCounts: Map<string, number> = new Map();
    private openCircuits: Map<string, number> = new Map();
    private failureThreshold: number;
    private resetTimeMs: number;

    constructor(failureThreshold: number = 3, resetTimeSeconds: number = 60) {
        this.failureThreshold = failureThreshold;
        this.resetTimeMs = resetTimeSeconds * 1000;
    }

    async validate(request: CallToolRequest, state: AgentRuntimeState): Promise<PolicyResult | null> {
        const toolName = request.params.name;

        // Check if circuit is open (tool is disabled)
        const openTime = this.openCircuits.get(toolName);
        if (openTime) {
            const elapsed = Date.now() - openTime;
            if (elapsed < this.resetTimeMs) {
                return {
                    policyName: this.name,
                    action: "block",
                    reason: `Circuit OPEN for '${toolName}'. Tool disabled after ${this.failureThreshold} failures. Retry in ${Math.ceil((this.resetTimeMs - elapsed) / 1000)}s.`
                };
            }
            // Reset circuit after timeout (half-open state)
            this.openCircuits.delete(toolName);
            this.failureCounts.set(toolName, 0);
        }

        return null;
    }

    recordFailure(toolName: string): void {
        const count = (this.failureCounts.get(toolName) || 0) + 1;
        this.failureCounts.set(toolName, count);

        if (count >= this.failureThreshold) {
            this.openCircuits.set(toolName, Date.now());
        }
    }

    recordSuccess(toolName: string): void {
        this.failureCounts.set(toolName, 0);
        this.openCircuits.delete(toolName);
    }

    getStatus(toolName: string): { failures: number; isOpen: boolean; resetIn?: number } {
        const failures = this.failureCounts.get(toolName) || 0;
        const openTime = this.openCircuits.get(toolName);
        const isOpen = !!openTime;
        const resetIn = openTime ? Math.max(0, this.resetTimeMs - (Date.now() - openTime)) : undefined;

        return { failures, isOpen, resetIn };
    }
}
