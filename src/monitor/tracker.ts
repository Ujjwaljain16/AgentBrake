import { AgentRuntimeState } from "../policy/types.js";
import { TrustLevel } from "../config/schema.js";

export class RuntimeMonitor {
    private state: AgentRuntimeState;

    constructor(initialTrust: TrustLevel = "sandbox") {
        this.state = {
            toolCallsCount: 0,
            blocked: false,
            trustLevel: initialTrust,
            estimatedCost: 0,
            history: []
        };
    }

    getState(): AgentRuntimeState {
        return { ...this.state };
    }

    incrementToolCalls(): void {
        this.state.toolCallsCount++;
        this.state.estimatedCost += 0.001;
    }

    setBlocked(reason: string): void {
        this.state.blocked = true;
        this.state.violationReason = reason;
    }

    updateTrust(level: TrustLevel): void {
        this.state.trustLevel = level;
    }

    logAction(action: string, policy: string): void {
        this.state.history.push({
            timestamp: new Date().toISOString(),
            action,
            policy
        });
    }

    reset(): void {
        const trust = this.state.trustLevel;
        this.state = {
            toolCallsCount: 0,
            blocked: false,
            trustLevel: trust,
            estimatedCost: 0,
            history: []
        };
    }
}
