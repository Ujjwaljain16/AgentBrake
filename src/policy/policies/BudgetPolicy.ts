import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult } from "../types.js";

export interface ToolCost {
    tool: string;
    costPerCall: number;
}

/**
 * Estimated-cost budget. Each forwarded call adds its tool's configured cost (or the default).
 * Warns once the projected spend reaches warnThreshold of the budget, blocks above the budget.
 * This is an estimate from configured prices, not measured spend.
 */
export class BudgetPolicy implements Policy {
    name = "BudgetPolicy";

    private currentSpend = 0;
    private toolCosts: Map<string, number>;

    constructor(
        private maxBudget: number,
        toolCosts: ToolCost[] = [],
        private defaultCost: number = 0.01,
        private warnThreshold: number = 0.8,
        private currency: string = "USD"
    ) {
        this.toolCosts = new Map(toolCosts.map(tc => [tc.tool, tc.costPerCall]));
    }

    async validate(request: CallToolRequest, _state: AgentRuntimeState): Promise<PolicyResult | null> {
        const toolName = request.params.name;
        const cost = this.costOf(toolName);
        const projected = this.currentSpend + cost;

        if (projected > this.maxBudget + 1e-9) {
            return {
                policyName: this.name,
                action: "block",
                reason: `Budget exceeded. Spent: ${this.fmt(this.currentSpend)}, limit: ${this.fmt(this.maxBudget)}. Tool '${toolName}' would add ${this.fmt(cost)}.`
            };
        }

        if (projected >= this.maxBudget * this.warnThreshold) {
            return {
                policyName: this.name,
                action: "warn",
                reason: `Budget at ${((projected / this.maxBudget) * 100).toFixed(1)}% (${this.fmt(projected)} of ${this.fmt(this.maxBudget)}).`
            };
        }

        return null;
    }

    commit(request: CallToolRequest): void {
        // Round to avoid floating-point drift over many small additions.
        this.currentSpend = Math.round((this.currentSpend + this.costOf(request.params.name)) * 1e9) / 1e9;
    }

    getSpend(): number {
        return this.currentSpend;
    }

    getRemainingBudget(): number {
        return Math.max(0, this.maxBudget - this.currentSpend);
    }

    getPercentUsed(): number {
        return (this.currentSpend / this.maxBudget) * 100;
    }

    reset(): void {
        this.currentSpend = 0;
    }

    private costOf(toolName: string): number {
        return this.toolCosts.get(toolName) ?? this.defaultCost;
    }

    private fmt(amount: number): string {
        return `${amount.toFixed(4)} ${this.currency}`;
    }
}
