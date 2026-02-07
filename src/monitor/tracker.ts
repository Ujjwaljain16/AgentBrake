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

    incrementToolCalls() {
        this.state.toolCallsCount++;
        // Very rough heuristic: $0.001 per tool call (logging/overhead)
        this.state.estimatedCost += 0.001;
    }

    setBlocked(reason: string) {
        this.state.blocked = true;
        this.state.violationReason = reason;
    }

    // New V2 Methods
    updateTrust(level: TrustLevel) {
        this.state.trustLevel = level;
    }

    logAction(action: string, policy: string) {
        this.state.history.push({
            timestamp: new Date().toISOString(),
            action,
            policy
        });
    }

    reset() {
        // Keeps trust level? usually reset session
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
