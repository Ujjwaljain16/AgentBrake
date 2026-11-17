import { AgentRuntimeState } from "../policy/types.js";
import { TrustLevel } from "../config/schema.js";

export interface DecisionRecord {
    timestamp: string;
    action: string;
    policy: string;
}

/** Most recent decisions kept in memory; older ones are dropped (logs are the durable record). */
export const MAX_HISTORY = 1000;

export class RuntimeMonitor {
    private toolCallsCount = 0;
    private blocked = false;
    private violationReason?: string;
    private trustLevel: TrustLevel;
    private history: DecisionRecord[] = [];
    private decisions = 0;
    private counters: Record<string, number> = {};

    constructor(initialTrust: TrustLevel = "sandbox") {
        this.trustLevel = initialTrust;
    }

    getState(): AgentRuntimeState {
        return {
            toolCallsCount: this.toolCallsCount,
            blocked: this.blocked,
            violationReason: this.violationReason,
            trustLevel: this.trustLevel,
            decisions: this.decisions
        };
    }

    /** Small, constant-size summary for logs (never the history itself). */
    getStats(): Record<string, number> {
        return { forwarded: this.toolCallsCount, ...this.counters };
    }

    getHistory(): DecisionRecord[] {
        return [...this.history];
    }

    incrementToolCalls(): void {
        this.toolCallsCount++;
    }

    setBlocked(reason: string): void {
        this.blocked = true;
        this.violationReason = reason;
    }

    updateTrust(level: TrustLevel): void {
        this.trustLevel = level;
    }

    logAction(action: string, policy: string): void {
        this.decisions++;
        const key = action.toLowerCase();
        this.counters[key] = (this.counters[key] ?? 0) + 1;
        this.history.push({ timestamp: new Date().toISOString(), action, policy });
        if (this.history.length > MAX_HISTORY) {
            this.history.splice(0, this.history.length - MAX_HISTORY);
        }
    }

    reset(): void {
        this.toolCallsCount = 0;
        this.blocked = false;
        this.violationReason = undefined;
        this.history = [];
        this.decisions = 0;
        this.counters = {};
    }
}
