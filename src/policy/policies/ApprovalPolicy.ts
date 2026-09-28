import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntimeState, Policy, PolicyResult } from "../types.js";

/**
 * Human-in-the-Loop Approval Policy (EXPERIMENTAL / incomplete).
 *
 * Calls to the listed tools are never forwarded by this policy on their own: the first
 * attempt yields "request_approval" and repeats are blocked while pending. approve() and
 * deny() exist for library use, but the proxy exposes NO channel that calls them, so in the
 * CLI proxy these tools are effectively always refused. The WebhookNotifier is not wired in.
 */
export class ApprovalPolicy implements Policy {
    name = "ApprovalPolicy";

    private static readonly MAX_PENDING = 1000;

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

        // Request approval (bounded so a misbehaving agent cannot grow memory without limit)
        if (this.pendingApprovals.size >= ApprovalPolicy.MAX_PENDING) {
            const oldest = this.pendingApprovals.keys().next().value;
            if (oldest !== undefined) this.pendingApprovals.delete(oldest);
        }
        this.pendingApprovals.set(requestKey, {
            requestId: requestKey,
            timestamp: Date.now()
        });

        return {
            policyName: this.name,
            action: "request_approval",
            reason: `Tool '${toolName}' requires human approval. No approval channel is implemented in the proxy; the call was not forwarded.`
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
