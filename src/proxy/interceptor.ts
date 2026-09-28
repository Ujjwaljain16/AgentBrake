import { spawn, ChildProcess } from "child_process";
import { Readable, Writable } from "stream";
import { RuntimeMonitor } from "../monitor/tracker.js";
import { Logger } from "../monitor/logger.js";
import { Policy } from "../policy/types.js";
import { MaxToolCallsPolicy } from "../policy/policies/MaxToolCallsPolicy.js";
import { LineFramer, FrameEvent } from "./framing.js";

export const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_TRACKED_CALLS = 10000;

const TOOL_CALL_METHODS = new Set(["tools/call", "call_tool"]);

// JSON-RPC error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
const POLICY_ERROR = -32000;
const APPROVAL_ERROR = -32001;

type JsonRpcId = string | number | null;

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
    private clientFramer: LineFramer;
    private serverFramer: LineFramer;
    private queue: Promise<void> = Promise.resolve();
    private terminating = false;
    private pendingCalls = new Map<string, string>();

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
        this.clientFramer = new LineFramer(options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES);
        this.serverFramer = new LineFramer(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    }

    start(): void {
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

        if (!TOOL_CALL_METHODS.has(msg.method.trim().toLowerCase())) {
            this.forward(msg);
            return;
        }

        const toolName = this.toolNameOf(msg.params);
        if (toolName === null) {
            Logger.info("Rejected malformed tools/call");
            this.writeError(hasId ? id : undefined, INVALID_PARAMS, "[AgentBrake] BLOCK: malformed tools/call params");
            return;
        }

        const blocked = await this.interceptRequest(msg, hasId ? id : undefined, toolName);
        if (!blocked) {
            if (hasId && (typeof msg.id === "string" || typeof msg.id === "number")) {
                this.trackCall(msg.id, toolName);
            }
            this.forward(msg);
        }
    }

    /** Returns the tool name if params is a well-formed tools/call payload, else null. */
    private toolNameOf(params: unknown): string | null {
        if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
        const p = params as Record<string, unknown>;
        if (typeof p.name !== "string" || p.name.length === 0) return null;
        if (p.arguments !== undefined) {
            if (p.arguments === null || typeof p.arguments !== "object" || Array.isArray(p.arguments)) return null;
        }
        return p.name;
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
     */
    private async interceptRequest(message: Record<string, unknown>, respondTo: JsonRpcId | undefined, toolName: string): Promise<boolean> {
        const request = { params: message.params, method: "tools/call" } as any;
        const currentState = this.monitor.getState();

        for (const policy of this.policies) {
            let result;
            try {
                result = await policy.validate(request, currentState);
            } catch (err) {
                Logger.violation(policy.name, "Policy threw while evaluating; failing closed", {
                    action: "BLOCK",
                    tool: toolName,
                    error: err instanceof Error ? err.message : String(err)
                });
                this.monitor.logAction("BLOCK", policy.name);
                this.writePolicyError(respondTo, {
                    policyName: policy.name,
                    action: "block",
                    reason: "Policy evaluation failed; call blocked."
                });
                return true;
            }

            if (!result) continue;

            switch (result.action) {
                case "warn":
                    Logger.violation(result.policyName, result.reason, {
                        action: "WARN",
                        tool: toolName,
                        stats: currentState
                    });
                    this.monitor.logAction("WARN", result.policyName);
                    break;

                case "block":
                case "kill":
                case "sandbox": {
                    // "sandbox" isolation is not implemented, so it is enforced as a block (fail closed).
                    const action = result.action === "sandbox" ? "block" : result.action;
                    const reason = result.action === "sandbox"
                        ? `${result.reason} (sandbox isolation is not implemented; blocked)`
                        : result.reason;
                    this.monitor.setBlocked(reason);
                    Logger.violation(result.policyName, reason, {
                        action: action.toUpperCase(),
                        tool: toolName,
                        stats: currentState
                    });
                    this.monitor.logAction(action.toUpperCase(), result.policyName);

                    if (action === "kill") {
                        this.terminating = true;
                        this.writePolicyError(respondTo, { policyName: result.policyName, action, reason }, () => {
                            Logger.info("KILL action triggered. Exiting proxy.");
                            this.child?.kill();
                            this.exit(1);
                        });
                    } else {
                        this.writePolicyError(respondTo, { policyName: result.policyName, action, reason });
                    }
                    return true;
                }

                case "request_approval":
                    this.monitor.logAction("APPROVAL_REQUIRED", result.policyName);
                    Logger.logEvent("APPROVAL_REQUIRED", {
                        policy: result.policyName,
                        tool: toolName,
                        reason: result.reason
                    });
                    this.writeApprovalError(respondTo, result);
                    return true;

                default:
                    // Unknown action from a policy: fail closed.
                    this.writePolicyError(respondTo, {
                        policyName: result.policyName,
                        action: "block",
                        reason: "Unknown policy action; call blocked."
                    });
                    return true;
            }
        }

        // Only calls that were actually allowed count toward max_tool_calls.
        this.monitor.incrementToolCalls();
        return false;
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
            this.observeResponse(parsed as Record<string, unknown>);
        }

        this.writeLine(line);
    }

    private trackCall(id: string | number, toolName: string): void {
        if (this.pendingCalls.size >= MAX_TRACKED_CALLS) {
            const oldest = this.pendingCalls.keys().next().value;
            if (oldest !== undefined) this.pendingCalls.delete(oldest);
        }
        this.pendingCalls.set(this.idKey(id), toolName);
    }

    private idKey(id: string | number): string {
        return `${typeof id}:${String(id)}`;
    }

    /** Feed real tool outcomes to policies that want them (e.g. the circuit breaker). */
    private observeResponse(msg: Record<string, unknown>): void {
        if (typeof msg.id !== "string" && typeof msg.id !== "number") return;
        if (msg.method !== undefined) return; // a server->client request, not a response

        const key = this.idKey(msg.id);
        const toolName = this.pendingCalls.get(key);
        if (toolName === undefined) return;
        this.pendingCalls.delete(key);

        const result = msg.result as Record<string, unknown> | undefined;
        const success = msg.error === undefined && !(result && typeof result === "object" && result.isError === true);

        for (const policy of this.policies) {
            try {
                policy.observeResult?.(toolName, success);
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

    private writePolicyError(id: JsonRpcId | undefined, result: { policyName: string; action: string; reason: string }, callback?: () => void): void {
        this.writeError(id, POLICY_ERROR,
            `[AgentBrake] ${result.action.toUpperCase()}: ${result.reason}`,
            { policy: result.policyName, action: result.action },
            callback);
    }

    private writeApprovalError(id: JsonRpcId | undefined, result: { policyName: string; reason: string }): void {
        this.writeError(id, APPROVAL_ERROR,
            `[AgentBrake] APPROVAL_REQUIRED: ${result.reason}`,
            { policy: result.policyName, action: "request_approval", status: "pending" });
    }
}
