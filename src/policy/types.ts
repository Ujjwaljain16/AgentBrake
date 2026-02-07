import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { TrustLevel, ViolationAction } from "../config/schema.js";

export interface AgentRuntimeState {
    toolCallsCount: number;
    blocked: boolean;
    violationReason?: string;
    trustLevel: TrustLevel;
    estimatedCost: number;
    history: Array<{ timestamp: string, action: string, policy: string }>;
}

export interface PolicyResult {
    policyName: string;
    action: ViolationAction;
    reason: string;
}

export type PolicyViolation = PolicyResult;

export interface Policy {
    name: string;
    validate(request: CallToolRequest, state: AgentRuntimeState): Promise<PolicyResult | null>;
}
