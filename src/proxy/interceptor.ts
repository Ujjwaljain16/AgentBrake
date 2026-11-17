import { spawn, ChildProcess } from "child_process";
import { Readable, Writable } from "stream";
import { RuntimeMonitor } from "../monitor/tracker.js";
import { Logger } from "../monitor/logger.js";
import { Policy, PolicyResult, TraceEntry, ToolOutcome, toolCallRequest } from "../policy/types.js";
import { MaxToolCallsPolicy } from "../policy/policies/MaxToolCallsPolicy.js";
import { LineFramer, FrameEvent } from "./framing.js";

export const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_TRACKED_CALLS = 10000;
/** setTimeout overflows above this many milliseconds (~24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;

const TOOL_CALL_METHODS = new Set(["tools/call", "call_tool"]);
const TOOL_LIST_METHODS = new Set(["tools/list", "list_tools"]);

// JSON-RPC error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
const POLICY_ERROR = -32000;
const APPROVAL_ERROR = -32001;

type JsonRpcId = string | number | null;

interface Verdict {
    policyName: string;
    action: string;
    reason: string;
}

export interface BrakeProxyOptions {
    /** Client -> proxy stream (default: process.stdin). */
    input?: Readable;
    /** Proxy -> client stream (default: process.stdout). */
    output?: Writable;
    /** Child process factory (default: child_process.spawn without a shell). */
    spawnFn?: (command: string, args: string[]) => ChildProcess;
    /** Max size of one client->server line before it is rejected (default 10 MiB). */
    maxMessageBytes?: number;
    /** Max size of one server->client line before it is dropped (default 64 MiB). */
    maxResponseBytes?: number;
    /** Called instead of process.exit (for tests). */
    exit?: (code: number) => void;
    /** Clock (for tests). */
    now?: () => number;
}

/** Environment for the wrapped server: everything except AgentBrake's own configuration/secrets. */
export function childEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
        if (/^AGENT_BRAKE_/i.test(key) || key === "WEBHOOK_URL" || key === "SLACK_WEBHOOK_URL") continue;
        out[key] = value;
    }
    return out;
}

export class BrakeProxy {
    private child: ChildProcess | null = null;
    private monitor: RuntimeMonitor;
    private policies: Policy[];
    private input: Readable;
    private output: Writable;
    private exit: (code: number) => void;
    private now: () => number;
    private clientFramer: LineFramer;
    private serverFramer: LineFramer;
    private queue: Promise<void> = Promise.resolve();
    private terminating = false;
    private pendingCalls = new Map<string, { toolName: string; args: Record<string, unknown> }>();
    private pendingToolLists = new Set<string>();
    private deadlineTimer: NodeJS.Timeout | null = null;

    constructor(
        private targetCommand: string,
        private targetArgs: string[],
        policies: Policy[] = [],
        private options: BrakeProxyOptions = {}
    ) {
        this.monitor = new RuntimeMonitor();
        this.policies = policies.length > 0 ? policies : [new MaxToolCallsPolicy(10)];
        this.input = options.input ?? process.stdin;
        this.output = options.output ?? process.stdout;
        this.exit = options.exit ?? ((code: number) => process.exit(code));
        this.now = options.now ?? Date.now;
        this.clientFramer = new LineFramer(options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES);
        this.serverFramer = new LineFramer(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    }

    /** Counters for observability and tests (forwarded calls, blocks, warnings, ...). */
    getStats(): Record<string, number> {
        return this.monitor.getStats();
    }

    start(): void {
        for (const policy of this.policies) {
            policy.onSessionStart?.();
        }

        // No shell: the target command and args are passed verbatim, never interpreted.
        this.child = this.options.spawnFn
            ? this.options.spawnFn(this.targetCommand, this.targetArgs)
            : spawn(this.targetCommand, this.targetArgs, {
                stdio: ["pipe", "pipe", "inherit"],
                shell: false,
                env: childEnvironment(),
                windowsHide: true
            });

        if (!this.child.stdin || !this.child.stdout) {
            throw new Error("Failed to spawn child process with pipes.");
        }

        const child = this.child;
        this.armDeadline();

        child.on("error", (err) => {
            Logger.info("Failed to run target server; exiting.", { error: err.message });
            this.exit(1);
        });
        child.stdin!.on("error", (err) => {
            // Child closed its stdin (EPIPE etc.); nothing more can be forwarded.
            Logger.info("Target server stdin error", { error: err.message });
        });

        this.input.on("data", (data: Buffer | string) => {
            if (this.terminating) return;
            // Framing is synchronous; policy evaluation is serialised through the queue so
            // messages are decided and forwarded strictly in arrival order.
            this.enqueue(this.clientFramer.push(data));
        });

        this.input.on("end", () => {
            this.enqueue(this.clientFramer.end());
            this.queue = this.queue.then(() => {
                child.stdin?.end();
            });
        });

        child.stdout!.on("data", (data: Buffer | string) => {
            for (const event of this.serverFramer.push(data)) {
                this.handleServerEvent(event);
            }
        });

        child.on("close", (code) => {
            if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
            for (const event of this.serverFramer.end()) {
                this.handleServerEvent(event);
            }
            this.exit(code ?? 1);
        });
    }

    // ---- client -> server ---------------------------------------------------------------

    private enqueue(events: FrameEvent[]): void {
        for (const event of events) {
            this.queue = this.queue.then(async () => {
                if (this.terminating) return;
                try {
                    await this.handleClientEvent(event);
                } catch (err) {
                    // Anything unexpected on the enforcement path fails closed.
                    Logger.info("Internal error while enforcing policy; message dropped", {
                        error: err instanceof Error ? err.message : String(err)
                    });
                    this.writeError(null, INVALID_REQUEST, "[AgentBrake] BLOCK: internal error while enforcing policy");
                }
            });
        }
    }

    private async handleClientEvent(event: FrameEvent): Promise<void> {
        if (event.type === "invalid") {
            const why = event.reason === "too_long" ? "message exceeds size limit" : "message is not valid UTF-8";
            Logger.info("Rejected client message", { reason: event.reason });
            this.writeError(null, PARSE_ERROR, `[AgentBrake] BLOCK: ${why}`);
            return;
        }
        await this.handleClientLine(event.line);
    }

    private async handleClientLine(line: string): Promise<void> {
        if (!line.trim()) return;

        let message: unknown;
        try {
            message = JSON.parse(line);
        } catch {
            Logger.info("Rejected unparseable client message", { length: line.length });
            this.writeError(null, PARSE_ERROR, "[AgentBrake] BLOCK: message is not valid JSON");
            return;
        }

        if (Array.isArray(message)) {
            Logger.info("Rejected JSON-RPC batch");
            this.writeError(null, INVALID_REQUEST, "[AgentBrake] BLOCK: JSON-RPC batches are not supported");
            return;
        }

        if (message === null || typeof message !== "object") {
            this.writeError(null, INVALID_REQUEST, "[AgentBrake] BLOCK: message is not a JSON-RPC object");
            return;
        }

        const msg = message as Record<string, unknown>;
        const has = (key: string) => Object.prototype.hasOwnProperty.call(msg, key);
        const id = this.validId(msg.id);
        const hasId = has("id");

        if (msg.method === undefined) {
            // Only a well-formed response to a server->client request may pass without a method.
            const isResponse = hasId && (has("result") || has("error"));
            if (!isResponse) {
                this.writeError(id, INVALID_REQUEST, "[AgentBrake] BLOCK: unrecognised JSON-RPC message");
                return;
            }
            this.forward(msg);
            return;
        }

        if (typeof msg.method !== "string") {
            this.writeError(id, INVALID_REQUEST, "[AgentBrake] BLOCK: method must be a string");
            return;
        }

        const method = msg.method.trim().toLowerCase();
        if (!TOOL_CALL_METHODS.has(method)) {
            if (TOOL_LIST_METHODS.has(method) && (typeof msg.id === "string" || typeof msg.id === "number")) {
                this.trackBounded(this.pendingToolLists, this.idKey(msg.id));
            }
            this.forward(msg);
            return;
        }

        const parsed = this.parseToolCall(msg.params);
        if (parsed === null) {
            Logger.info("Rejected malformed tools/call");
            this.writeError(hasId ? id : undefined, INVALID_PARAMS, "[AgentBrake] BLOCK: malformed tools/call params");
            return;
        }

        const blocked = await this.interceptRequest(hasId ? id : undefined, parsed.name, parsed.args);
        if (!blocked) {
            if (hasId && (typeof msg.id === "string" || typeof msg.id === "number")) {
                this.trackCall(msg.id, parsed.name, parsed.args);
            }
            this.forward(msg);
        }
    }

    /** Returns name and arguments if params is a well-formed tools/call payload, else null. */
    private parseToolCall(params: unknown): { name: string; args: Record<string, unknown> } | null {
        if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
        const p = params as Record<string, unknown>;
        if (typeof p.name !== "string" || p.name.length === 0) return null;
        if (p.arguments === undefined) return { name: p.name, args: {} };
        if (p.arguments === null || typeof p.arguments !== "object" || Array.isArray(p.arguments)) return null;
        return { name: p.name, args: p.arguments as Record<string, unknown> };
    }

    private validId(id: unknown): JsonRpcId {
        return typeof id === "string" || typeof id === "number" ? id : null;
    }

    /** Forward exactly what was parsed (re-serialised), so the server sees what the policies saw. */
    private forward(message: Record<string, unknown>): void {
        this.child?.stdin?.write(JSON.stringify(message) + "\n");
    }

    /**
     * Run the policy chain. Returns true when the call must NOT be forwarded.
     * respondTo is undefined for notifications (no response may be sent).
     *
     * Two phases: every policy validates first (no side effects); only if all of them pass does
     * each policy commit (use up rate-limit quota, budget, approval tokens). A blocked call
     * therefore costs nothing.
     */
    private async interceptRequest(respondTo: JsonRpcId | undefined, toolName: string, args: Record<string, unknown>): Promise<boolean> {
        const request = toolCallRequest(toolName, args);
        const currentState = this.monitor.getState();
        const trace: TraceEntry[] = [];
        const warnings: PolicyResult[] = [];

        for (const policy of this.policies) {
            let result: PolicyResult | null;
            try {
                result = await policy.validate(request, currentState);
            } catch (err) {
                trace.push({ policy: policy.name, verdict: "error" });
                this.refuse(respondTo, toolName, trace, {
                    policyName: policy.name,
                    action: "block",
                    reason: "Policy evaluation failed; call blocked."
                }, err);
                return true;
            }

            if (!result) {
                trace.push({ policy: policy.name, verdict: "pass" });
                continue;
            }

            switch (result.action) {
                case "warn":
                    trace.push({ policy: policy.name, verdict: "warn" });
                    warnings.push(result);
                    break;

                case "block":
                case "kill":
                    trace.push({ policy: policy.name, verdict: result.action });
                    this.refuse(respondTo, toolName, trace, result);
                    return true;

                case "sandbox":
                    // Sandbox isolation is not implemented, so it is enforced as a block (fail closed).
                    trace.push({ policy: policy.name, verdict: "block" });
                    this.refuse(respondTo, toolName, trace, {
                        policyName: result.policyName,
                        action: "block",
                        reason: `${result.reason} (sandbox isolation is not implemented; blocked)`
                    });
                    return true;

                case "request_approval":
                    trace.push({ policy: policy.name, verdict: "request_approval" });
                    this.monitor.logAction("APPROVAL_REQUIRED", result.policyName);
                    Logger.logEvent("APPROVAL_REQUIRED", {
                        policy: result.policyName,
                        tool: toolName,
                        reason: result.reason,
                        trace
                    });
                    this.writeApprovalError(respondTo, result);
                    return true;

                default:
                    // Unknown action from a policy: fail closed.
                    trace.push({ policy: policy.name, verdict: "block" });
                    this.refuse(respondTo, toolName, trace, {
                        policyName: result.policyName,
                        action: "block",
                        reason: "Unknown policy action; call blocked."
                    });
                    return true;
            }
        }

        // Commit phase: the call will be forwarded.
        for (const policy of this.policies) {
            try {
                policy.commit?.(request, currentState);
            } catch (err) {
                this.refuse(respondTo, toolName, trace, {
                    policyName: policy.name,
                    action: "block",
                    reason: "Policy failed to record usage; call blocked."
                }, err);
                return true;
            }
        }

        for (const warning of warnings) {
            this.monitor.logAction("WARN", warning.policyName);
            Logger.violation(warning.policyName, warning.reason, {
                action: "WARN",
                tool: toolName,
                stats: this.monitor.getStats()
            });
        }

        // Only calls that were actually allowed count toward max_tool_calls.
        this.monitor.incrementToolCalls();
        return false;
    }

    /** Record, log and answer a block or kill. */
    private refuse(respondTo: JsonRpcId | undefined, toolName: string, trace: TraceEntry[], verdict: Verdict, err?: unknown): void {
        const action = verdict.action === "kill" ? "kill" : "block";
        this.monitor.setBlocked(verdict.reason);
        this.monitor.logAction(action.toUpperCase(), verdict.policyName);
        Logger.violation(verdict.policyName, verdict.reason, {
            action: action.toUpperCase(),
            tool: toolName,
            stats: this.monitor.getStats(),
            trace,
            ...(err !== undefined ? { error: err instanceof Error ? err.message : String(err) } : {})
        });

        if (action === "kill") {
            this.terminate(respondTo, { ...verdict, action });
        } else {
            this.writePolicyError(respondTo, { ...verdict, action });
        }
    }

    /** Answer the triggering call (if any), stop the server and exit non-zero. */
    private terminate(respondTo: JsonRpcId | undefined, verdict: Verdict): void {
        if (this.terminating) return;
        this.terminating = true;
        if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
        this.writePolicyError(respondTo, verdict, () => {
            Logger.info("KILL action triggered. Exiting proxy.", { policy: verdict.policyName });
            this.child?.kill();
            this.exit(1);
        });
    }

    /** Hard timer for policies with a deadline (max runtime), so it fires without a tool call. */
    private armDeadline(): void {
        let first: { policy: Policy; at: number } | null = null;
        for (const policy of this.policies) {
            const at = policy.deadline?.();
            if (typeof at === "number" && Number.isFinite(at) && (first === null || at < first.at)) {
                first = { policy, at };
            }
        }
        if (first === null) return;

        const delay = Math.max(0, first.at - this.now());
        if (delay > MAX_TIMER_MS) return; // left to the per-call check

        const { policy } = first;
        this.deadlineTimer = setTimeout(() => {
            this.monitor.logAction("KILL", policy.name);
            Logger.violation(policy.name, "Session deadline reached", {
                action: "KILL",
                stats: this.monitor.getStats()
            });
            this.terminate(undefined, { policyName: policy.name, action: "kill", reason: "Session deadline reached." });
        }, delay);
        this.deadlineTimer.unref?.();
    }

    // ---- server -> client ---------------------------------------------------------------

    private handleServerEvent(event: FrameEvent): void {
        if (event.type === "invalid") {
            // Cannot be forwarded as a valid message; dropping is the only safe option.
            Logger.info("Dropped invalid server message", { reason: event.reason });
            return;
        }

        const line = event.line;
        if (!line.trim()) return;

        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            Logger.info("Dropped non-JSON output from target server", { length: line.length });
            return;
        }

        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            const msg = parsed as Record<string, unknown>;
            this.observeResponse(msg);
            const filtered = this.filterToolList(msg);
            if (filtered) {
                this.writeLine(JSON.stringify(filtered));
                return;
            }
        }

        this.writeLine(line);
    }

    private trackCall(id: string | number, toolName: string, args: Record<string, unknown>): void {
        if (this.pendingCalls.size >= MAX_TRACKED_CALLS) {
            const oldest = this.pendingCalls.keys().next().value;
            if (oldest !== undefined) this.pendingCalls.delete(oldest);
        }
        this.pendingCalls.set(this.idKey(id), { toolName, args });
    }

    private trackBounded(set: Set<string>, key: string): void {
        if (set.size >= MAX_TRACKED_CALLS) {
            const oldest = set.values().next().value;
            if (oldest !== undefined) set.delete(oldest);
        }
        set.add(key);
    }

    private idKey(id: string | number): string {
        return `${typeof id}:${String(id)}`;
    }

    private isResponse(msg: Record<string, unknown>): msg is Record<string, unknown> & { id: string | number } {
        return msg.method === undefined && (typeof msg.id === "string" || typeof msg.id === "number");
    }

    /**
     * If msg answers a tools/list request, return a copy without the tools some policy would
     * always refuse, so the model is never offered them. Returns null when nothing changes.
     */
    private filterToolList(msg: Record<string, unknown>): Record<string, unknown> | null {
        if (!this.isResponse(msg)) return null;
        const key = this.idKey(msg.id);
        if (!this.pendingToolLists.delete(key)) return null;

        const result = msg.result as Record<string, unknown> | undefined;
        if (!result || typeof result !== "object" || !Array.isArray(result.tools)) return null;

        const visible = result.tools.filter(tool => {
            const name = (tool as Record<string, unknown> | null)?.name;
            if (typeof name !== "string") return false; // malformed entry: do not relay
            return this.policies.every(p => {
                try {
                    return p.isToolVisible?.(name) ?? true;
                } catch {
                    return false; // fail closed: hide
                }
            });
        });
        if (visible.length === result.tools.length) return null;

        Logger.logEvent("TOOLS_HIDDEN", { hidden: result.tools.length - visible.length, shown: visible.length });
        return { ...msg, result: { ...result, tools: visible } };
    }

    /** Feed real tool outcomes to policies that want them (circuit breaker, flow tracking). */
    private observeResponse(msg: Record<string, unknown>): void {
        if (!this.isResponse(msg)) return;

        const key = this.idKey(msg.id);
        const call = this.pendingCalls.get(key);
        if (call === undefined) return;
        this.pendingCalls.delete(key);

        const result = msg.result as Record<string, unknown> | undefined;
        const success = msg.error === undefined && !(result && typeof result === "object" && result.isError === true);
        const outcome: ToolOutcome = { toolName: call.toolName, args: call.args, success, result: msg.result };

        for (const policy of this.policies) {
            try {
                policy.observeResult?.(outcome);
            } catch (err) {
                Logger.info("Policy observeResult failed", { policy: policy.name, error: String(err) });
            }
        }
    }

    // ---- output -------------------------------------------------------------------------

    private writeLine(line: string, callback?: () => void): void {
        this.output.write(line + "\n", callback);
    }

    private writeError(id: JsonRpcId | undefined, code: number, message: string, data?: Record<string, unknown>, callback?: () => void): void {
        if (id === undefined) {
            // Notification: JSON-RPC forbids a response.
            callback?.();
            return;
        }
        this.writeLine(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code, message, ...(data ? { data } : {}) }
        }), callback);
    }

    private writePolicyError(id: JsonRpcId | undefined, verdict: Verdict, callback?: () => void): void {
        this.writeError(id, POLICY_ERROR,
            `[AgentBrake] ${verdict.action.toUpperCase()}: ${verdict.reason}`,
            { policy: verdict.policyName, action: verdict.action },
            callback);
    }

    private writeApprovalError(id: JsonRpcId | undefined, result: { policyName: string; reason: string }): void {
        this.writeError(id, APPROVAL_ERROR,
            `[AgentBrake] APPROVAL_REQUIRED: ${result.reason}`,
            { policy: result.policyName, action: "request_approval", status: "pending" });
    }
}
