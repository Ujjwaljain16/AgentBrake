import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult, ToolOutcome } from "../types.js";

/**
 * Per-tool circuit breaker driven by real tool outcomes.
 *
 * closed -> (failureThreshold consecutive failures) -> open -> (resetTimeout) -> half-open.
 * In half-open the next call is let through as a trial: a success closes the circuit, a single
 * failure reopens it immediately.
 */
export class CircuitBreakerPolicy implements Policy {
    name = "CircuitBreakerPolicy";

    private failureCounts: Map<string, number> = new Map();
    private openCircuits: Map<string, number> = new Map();
    private failureThreshold: number;
    private resetTimeMs: number;

    constructor(failureThreshold: number = 3, resetTimeSeconds: number = 60, private now: () => number = Date.now) {
        this.failureThreshold = failureThreshold;
        this.resetTimeMs = resetTimeSeconds * 1000;
    }

    async validate(request: CallToolRequest, _state: AgentRuntimeState): Promise<PolicyResult | null> {
        const toolName = request.params.name;
        const openTime = this.openCircuits.get(toolName);
        if (openTime === undefined) return null;

        const elapsed = this.now() - openTime;
        if (elapsed < this.resetTimeMs) {
            return {
                policyName: this.name,
                action: "block",
                reason: `Circuit OPEN for '${toolName}' after ${this.failureThreshold} consecutive failures. Retry in ${Math.ceil((this.resetTimeMs - elapsed) / 1000)}s.`
            };
        }

        // Half-open: allow a trial; one more failure reopens the circuit.
        this.openCircuits.delete(toolName);
        this.failureCounts.set(toolName, Math.max(0, this.failureThreshold - 1));
        return null;
    }

    observeResult(outcome: ToolOutcome): void {
        if (outcome.success) {
            this.recordSuccess(outcome.toolName);
        } else {
            this.recordFailure(outcome.toolName);
        }
    }

    recordFailure(toolName: string): void {
        const count = (this.failureCounts.get(toolName) || 0) + 1;
        this.failureCounts.set(toolName, count);
        if (count >= this.failureThreshold) {
            this.openCircuits.set(toolName, this.now());
        }
    }

    recordSuccess(toolName: string): void {
        this.failureCounts.delete(toolName);
        this.openCircuits.delete(toolName);
    }

    getStatus(toolName: string): { failures: number; isOpen: boolean; resetIn?: number } {
        const failures = this.failureCounts.get(toolName) || 0;
        const openTime = this.openCircuits.get(toolName);
        const isOpen = openTime !== undefined;
        const resetIn = isOpen ? Math.max(0, this.resetTimeMs - (this.now() - openTime)) : undefined;
        return { failures, isOpen, resetIn };
    }
}
