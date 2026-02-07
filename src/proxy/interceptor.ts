import { spawn, ChildProcess } from "child_process";
import { RuntimeMonitor } from "../monitor/tracker.js";
import { Logger } from "../monitor/logger.js";
import { Policy } from "../policy/types.js";
import { MaxToolCallsPolicy } from "../policy/policies/MaxToolCallsPolicy.js"; // Default policies
import { AllowedToolsPolicy } from "../policy/policies/AllowedToolsPolicy.js";

export class BrakeProxy {
    private child: ChildProcess | null = null;
    private monitor: RuntimeMonitor;
    private policies: Policy[];

    constructor(
        private targetCommand: string,
        private targetArgs: string[],
        policies: Policy[] = []
    ) {
        this.monitor = new RuntimeMonitor();
        // Default policies for V1 if none provided
        this.policies = policies.length > 0 ? policies : [
            // By default, just a safety net, but usually we inject them from main
            new MaxToolCallsPolicy(10)
        ];
    }

    start() {
        // Spawn the target MCP server
        this.child = spawn(this.targetCommand, this.targetArgs, {
            stdio: ["pipe", "pipe", "inherit"] // Access stdin/stdout, inherit stderr for debugging
        });

        if (!this.child.stdin || !this.child.stdout) {
            throw new Error("Failed to spawn child process with pipes.");
        }

        // Handle incoming data from Parent (Client) -> Target
        process.stdin.on("data", (data: Buffer | string) => {
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            this.handleClientMessage(chunk)
        });

        // Handle incoming data from Target -> Parent (Client)
        this.child.stdout.on("data", (data) => {
            process.stdout.write(data);
        });

        this.child.on("exit", (code) => {
            process.exit(code ?? 0);
        });
    }

    private async handleClientMessage(data: Buffer) {
        const messageStr = data.toString();

        // Simple JSON-RPC parsing - dealing with potential fragmented chunks is hard in simple V1
        // For V1 hackathon, we assume newlines delimit messages (LineDelimitedJsonRpc) which makes it easier.
        // We will try to parse line by line.

        const lines = messageStr.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;

            try {
                const message = JSON.parse(line);
                const shouldBlock = await this.interceptRequest(message);

                if (shouldBlock) {
                    // If blocked, we reply with an error directly to stdout (to Client)
                    // and do NOT forward to child.
                    // The error is constructed in interceptRequest
                } else {
                    // Forward to child
                    this.child?.stdin?.write(line + '\n');
                }
            } catch (e) {
                // If not JSON, just forward it raw? Or ignore?
                // Best effort forward
                this.child?.stdin?.write(line + '\n');
            }
        }
    }

    private async interceptRequest(message: any): Promise<boolean> {
        // Check if it's a tool call
        // MCP tool call: method: "tools/call" (v1? or just call_tool in some versions?)
        // SDK uses "tools/call" usually.

        if (message.method === "tools/call" || message.method === "call_tool") {
            // Validate against policies
            const request = { params: message.params, method: "tools/call" } as any; // Cast for compatibility

            // Check monitor state first? 
            // We increment AFTER policy check? Or BEFORE?
            // Usually we count the ATTEMPT.
            this.monitor.incrementToolCalls();

            // State validation
            const currentState = this.monitor.getState();

            for (const policy of this.policies) {
                const result = await policy.validate(request, currentState);
                if (result) {

                    // V2 Action Engine
                    switch (result.action) {
                        case "warn":
                            // Just log, don't block
                            Logger.violation(result.policyName, result.reason, {
                                action: "WARN",
                                tool: message.params?.name,
                                stats: currentState
                            });
                            this.monitor.logAction("WARN", result.policyName);
                            break; // Continue to next policy? Or stop? Usually warnings don't stop.

                        case "block":
                        case "kill": // For V1/V2 transition, kill acts like block for the request + extra
                            this.monitor.setBlocked(result.reason);
                            this.sendError(message.id, result);

                            Logger.violation(result.policyName, result.reason, {
                                action: result.action.toUpperCase(),
                                tool: message.params?.name,
                                stats: currentState
                            });
                            this.monitor.logAction(result.action.toUpperCase(), result.policyName);

                            if (result.action === "kill") {
                                // TODO: Implement actual process kill logic
                                Logger.info("KILL action triggered. Exiting proxy.");
                                process.exit(1);
                            }

                            return true; // Blocked

                        case "sandbox":
                            // TODO: Implement sandbox downgrade
                            break;
                    }
                }
            }
        }

        return false; // Allowed
    }

    private sendError(id: number | string, result: any) {
        const errorResponse = {
            jsonrpc: "2.0",
            id: id,
            error: {
                code: -32000,
                message: `[AgentBrake] ${result.action.toUpperCase()}: ${result.reason}`,
                data: {
                    policy: result.policyName,
                    action: result.action
                }
            }
        };
        process.stdout.write(JSON.stringify(errorResponse) + "\n");
    }
}
