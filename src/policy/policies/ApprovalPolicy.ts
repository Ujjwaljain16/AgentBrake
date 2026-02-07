import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult } from "../types.js";

/**
 * Human-in-the-Loop Approval Policy.
 * Requires manual approval for specified high-risk tools.
 */
export class ApprovalPolicy implements Policy {
    name = "ApprovalPolicy";

    private toolsRequiringApproval: Set<string>;
    private pendingApprovals: Map<string, { requestId: string; timestamp: number }> = new Map();
    private approvedRequests: Set<string> = new Set();

    constructor(toolsRequiringApproval: string[]) {
        this.toolsRequiringApproval = new Set(toolsRequiringApproval);
    }

    async validate(request: CallToolRequest, state: AgentRuntimeState): Promise<PolicyResult | null> {
        const toolName = request.params.name;

        if (!this.toolsRequiringApproval.has(toolName)) {
            return null;
        }

        const requestKey = this.getRequestKey(request);

        // Check if already approved
        if (this.approvedRequests.has(requestKey)) {
            this.approvedRequests.delete(requestKey);
            return null;
        }

        // Check if pending approval
        if (this.pendingApprovals.has(requestKey)) {
            return {
                policyName: this.name,
                action: "block",
                reason: `Awaiting approval for '${toolName}'. Request pending.`
            };
        }

        // Request approval
        this.pendingApprovals.set(requestKey, {
            requestId: requestKey,
            timestamp: Date.now()
        });

        return {
            policyName: this.name,
            action: "request_approval",
            reason: `Tool '${toolName}' requires human approval. Approve or deny via CLI.`
        };
    }

    approve(requestKey: string): boolean {
        if (this.pendingApprovals.has(requestKey)) {
            this.pendingApprovals.delete(requestKey);
            this.approvedRequests.add(requestKey);
            return true;
        }
        return false;
    }

    deny(requestKey: string): boolean {
        return this.pendingApprovals.delete(requestKey);
    }

    getPendingApprovals(): Array<{ requestId: string; timestamp: number }> {
        return Array.from(this.pendingApprovals.values());
    }

    private getRequestKey(request: CallToolRequest): string {
        return `${request.params.name}:${JSON.stringify(request.params.arguments)}`;
    }
}
