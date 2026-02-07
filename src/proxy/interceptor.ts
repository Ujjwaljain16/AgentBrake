import { spawn, ChildProcess } from "child_process";
import { RuntimeMonitor } from "../monitor/tracker.js";
import { Logger } from "../monitor/logger.js";
import { Policy } from "../policy/types.js";
import { MaxToolCallsPolicy } from "../policy/policies/MaxToolCallsPolicy.js";

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
        this.policies = policies.length > 0 ? policies : [new MaxToolCallsPolicy(10)];
    }

    start(): void {
        this.child = spawn(this.targetCommand, this.targetArgs, {
            stdio: ["pipe", "pipe", "inherit"]
        });

        if (!this.child.stdin || !this.child.stdout) {
            throw new Error("Failed to spawn child process with pipes.");
        }

        process.stdin.on("data", (data: Buffer | string) => {
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            this.handleClientMessage(chunk);
        });

        this.child.stdout.on("data", (data) => {
            process.stdout.write(data);
        });

        this.child.on("exit", (code) => {
            process.exit(code ?? 0);
        });
    }

    private async handleClientMessage(data: Buffer): Promise<void> {
        const lines = data.toString().split('\n');

        for (const line of lines) {
            if (!line.trim()) continue;

            try {
                const message = JSON.parse(line);
                const blocked = await this.interceptRequest(message);

                if (!blocked) {
                    this.child?.stdin?.write(line + '\n');
                }
            } catch {
                this.child?.stdin?.write(line + '\n');
            }
        }
    }

    private async interceptRequest(message: any): Promise<boolean> {
        if (message.method !== "tools/call" && message.method !== "call_tool") {
            return false;
        }

        const request = { params: message.params, method: "tools/call" } as any;
        this.monitor.incrementToolCalls();
        const currentState = this.monitor.getState();

        for (const policy of this.policies) {
            const result = await policy.validate(request, currentState);

            if (!result) continue;

            switch (result.action) {
                case "warn":
                    Logger.violation(result.policyName, result.reason, {
                        action: "WARN",
                        tool: message.params?.name,
                        stats: currentState
                    });
                    this.monitor.logAction("WARN", result.policyName);
                    break;

                case "block":
                case "kill":
                    this.monitor.setBlocked(result.reason);
                    this.sendError(message.id, result);
                    Logger.violation(result.policyName, result.reason, {
                        action: result.action.toUpperCase(),
                        tool: message.params?.name,
                        stats: currentState
                    });
                    this.monitor.logAction(result.action.toUpperCase(), result.policyName);

                    if (result.action === "kill") {
                        Logger.info("KILL action triggered. Exiting proxy.");
                        process.exit(1);
                    }
                    return true;

                case "sandbox":
                    this.monitor.updateTrust("sandbox");
                    break;
            }
        }

        return false;
    }

    private sendError(id: number | string, result: any): void {
        const errorResponse = {
            jsonrpc: "2.0",
            id,
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
