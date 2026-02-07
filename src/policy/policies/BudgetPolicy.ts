import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult } from "../types.js";

interface ToolCost {
    tool: string;
    costPerCall: number;
}

/**
 * Budget Tracking Policy - Prevents cost explosions by tracking estimated costs.
 * Warns at 80% of budget, blocks at 100%.
 */
export class BudgetPolicy implements Policy {
    name = "BudgetPolicy";

    private maxBudget: number;
    private currentSpend: number = 0;
    private toolCosts: Map<string, number>;
    private defaultCost: number;

    constructor(maxBudget: number, toolCosts: ToolCost[] = [], defaultCostPerCall: number = 0.01) {
        this.maxBudget = maxBudget;
        this.defaultCost = defaultCostPerCall;
        this.toolCosts = new Map(toolCosts.map(tc => [tc.tool, tc.costPerCall]));
    }

    async validate(request: CallToolRequest, state: AgentRuntimeState): Promise<PolicyResult | null> {
        const toolName = request.params.name;
        const cost = this.toolCosts.get(toolName) || this.defaultCost;
        const projectedSpend = this.currentSpend + cost;
        const percentUsed = (projectedSpend / this.maxBudget) * 100;

        if (projectedSpend > this.maxBudget) {
            return {
                policyName: this.name,
                action: "block",
                reason: `Budget exceeded. Spent: $${this.currentSpend.toFixed(4)}, Limit: $${this.maxBudget.toFixed(2)}. Tool '${toolName}' would add $${cost.toFixed(4)}.`
            };
        }

        // Record the spend
        this.currentSpend = projectedSpend;

        if (percentUsed >= 80) {
            return {
                policyName: this.name,
                action: "warn",
                reason: `Budget at ${percentUsed.toFixed(1)}%. Spent: $${this.currentSpend.toFixed(4)} of $${this.maxBudget.toFixed(2)}.`
            };
        }

        return null;
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
}
