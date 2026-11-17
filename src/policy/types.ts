import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { TrustLevel, ViolationAction } from "../config/schema.js";

export interface AgentRuntimeState {
    toolCallsCount: number;
    blocked: boolean;
    violationReason?: string;
    trustLevel: TrustLevel;
    /** Number of entries in the bounded decision history (see RuntimeMonitor). */
    decisions: number;
}

export interface PolicyResult {
    policyName: string;
    action: ViolationAction;
    reason: string;
}

export type PolicyViolation = PolicyResult;

/** The real outcome of a forwarded tool call, as seen in the server's response. */
export interface ToolOutcome {
    toolName: string;
    /** Arguments of the call that was forwarded (exactly what the policies checked). */
    args: Record<string, unknown>;
    /** false for a JSON-RPC error or a result with isError: true. */
    success: boolean;
    /** The JSON-RPC `result` value (undefined for an error response). */
    result?: unknown;
}

export interface Policy {
    name: string;

    /**
     * Decide on a tools/call. Must NOT record usage (quota, spend, tokens): a later policy
     * may still block the call. Record usage in commit().
     */
    validate(request: CallToolRequest, state: AgentRuntimeState): Promise<PolicyResult | null>;

    /** Called once per call, only after every policy passed and the call is being forwarded. */
    commit?(request: CallToolRequest, state: AgentRuntimeState): void;

    /** Called with the real outcome of each forwarded call. */
    observeResult?(outcome: ToolOutcome): void;

    /**
     * Whether a tool should be visible in tools/list. Return false for tools this policy
     * would always refuse, so the model is never offered them.
     */
    isToolVisible?(toolName: string): boolean;

    /** Called once when the proxy session starts (e.g. to start clocks). */
    onSessionStart?(): void;

    /** Absolute epoch-ms deadline after which the session must be killed, if any. */
    deadline?(): number | undefined;
}

/** One line of a decision trace: what a single policy said about a call. */
export interface TraceEntry {
    policy: string;
    verdict: "pass" | "warn" | "block" | "kill" | "request_approval" | "error";
}

/** Build the request object policies see from a validated tool name and arguments. */
export function toolCallRequest(name: string, args: Record<string, unknown>): CallToolRequest {
    return { method: "tools/call", params: { name, arguments: args } };
}

/** Stable JSON: object keys sorted at every level, so argument order never matters. */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
