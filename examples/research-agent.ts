import { spawn, ChildProcess } from "child_process";
import * as path from "path";

// Define the Task structure
interface AgentTask {
    name: string;
    description: string;
    tool: string;
    args: any;
    expectedAction: "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED" | "REQUEST_APPROVAL" | "KILL";
}

// A "Research Agent" workflow
const TASKS: AgentTask[] = [
    {
        name: "Research Topic",
        description: "Agent searches for latest Q4 trends",
        tool: "search_web",
        args: { query: "Q4 enterprise software trends 2025" },
        expectedAction: "ALLOW"
    },
    {
        name: "Read Allowlisted Data",
        description: "Agent reads local context from /app/data",
        tool: "read_file",
        args: { path: "/app/data/context.txt" },
        expectedAction: "ALLOW"
    },
    {
        name: "Accidental Access (DLP)",
        description: "Agent tries to read sensitive file (should be blocked but not killed)",
        tool: "read_file",
        args: { path: "/private/confidential.txt" },
        expectedAction: "BLOCK"
    },
    {
        name: "Send Internal Report (HITL)",
        description: "Agent sends summary to internal team (should require approval)",
        tool: "send_email",
        args: {
            to: "manager@internal.com",
            subject: "Q4 Research Summary",
            body: "Here is the summary of the trends..."
        },
        expectedAction: "REQUEST_APPROVAL"
    },
    // Loop to test Rate Limit / Budget?
    // Let's add a few more "searches"
    {
        name: "Follow-up Search 1",
        description: "Refining search",
        tool: "search_web",
        args: { query: "AI agent security market size" },
        expectedAction: "ALLOW"
    }
];

class ResearchAgentDemo {
    private child: ChildProcess | null = null;
    private pendingResolve: ((value: string) => void) | null = null;

    async start() {
        console.log("\n══════════════════════════════════════════════════════════════════════");
        console.log("   🕵️  AGENTBRAKE: RESEARCH AGENT DOGFOODING");
        console.log("══════════════════════════════════════════════════════════════════════");
        console.log("\n📋 SCENARIO: A helpful 'Research Agent' performs a multi-step task.");
        console.log("   We verify that AgentBrake facilitates work while catching mistakes.");
        console.log("\n──────────────────────────────────────────────────────────────────────\n");

        await this.startProxy();

        // Give proxy a moment to initialize
        await this.sleep(1000);

        for (let i = 0; i < TASKS.length; i++) {
            const task = TASKS[i];
            await this.runTask(i + 1, task);
            await this.sleep(500); // Pause between tasks
        }

        this.stopProxy();

        console.log("\n══════════════════════════════════════════════════════════════════════");
        console.log("                      ✅ DEMO COMPLETE");
        console.log("══════════════════════════════════════════════════════════════════════\n");
    }

    private startProxy() {
        const proxyPath = path.resolve(__dirname, "../src/proxy/index.js");
        const toolsPath = path.resolve(__dirname, "enterprise-tools.js");
        const configPath = path.resolve(__dirname, "../../examples/enterprise-config.yml");

        console.log(`[ResearchAgent] Config Path: ${configPath}`);
        if (!require("fs").existsSync(configPath)) {
            console.error(`[ResearchAgent] CRITICAL: Config file not found at ${configPath}`);
        }

        // Spawn the proxy which wraps the tools server
        this.child = spawn("node", [proxyPath, "node", toolsPath], {
            stdio: ["pipe", "pipe", "pipe"], // We need to capture stdout/stderr
            env: { ...process.env, AGENT_BRAKE_CONFIG: configPath },
            shell: true
        });

        this.child.stdout?.on("data", (data) => {
            const lines = data.toString().trim().split("\n");
            for (const line of lines) {
                if (!line.trim()) continue;

                // Check for KILL signal
                if (line.includes("KILL action triggered")) {
                    const resolve = this.pendingResolve;
                    if (resolve) {
                        // Resolves as BLOCK because KILL is the ultimate block
                        resolve("BLOCK");
                    }
                }

                try {
                    const parsed = JSON.parse(line);

                    // console.log("DEBUG: ", line); // Uncommented for debugging

                    // Check for JSON-RPC response (error or result)
                    if (parsed.id) {
                        const resolve = this.pendingResolve;
                        if (parsed.error && resolve) {
                            const data = parsed.error.data;
                            if (data?.action) {
                                let action = data.action.toUpperCase();
                                if (action === "REQUEST_APPROVAL") {
                                    resolve("REQUEST_APPROVAL");
                                } else {
                                    resolve(action);
                                }
                            } else {
                                resolve("BLOCK");
                            }
                        } else if (parsed.result && resolve) {
                            resolve("ALLOW");
                        }
                    }
                } catch (e) {
                    // Ignore non-JSON lines
                }
            }
        });

        this.child.stderr?.on("data", (data) => {
            // console.error(`[Proxy Error]: ${data}`);
        });
    }

    private stopProxy() {
        if (this.child) {
            this.child.kill();
        }
    }

    private async runTask(index: number, task: AgentTask) {
        console.log(`[${index}/${TASKS.length}] 🤖 ACTION: ${task.name}`);
        console.log(`    └─ Tool: ${task.tool}`);

        // Construct JSON-RPC Request
        const msg = {
            jsonrpc: "2.0",
            id: index,
            method: `tools/call`,
            params: {
                name: task.tool,
                arguments: task.args
            }
        };

        const responsePromise = new Promise<string>((resolve) => {
            this.pendingResolve = resolve;
        });

        // Send to Proxy
        this.child?.stdin?.write(JSON.stringify(msg) + "\n");

        // Wait for result or timeout
        // "KILL" actions might not send a response before dying, handled by stdout listener
        const result = await Promise.race([
            responsePromise,
            this.sleep(2000).then(() => "TIMEOUT")
        ]);
        this.pendingResolve = null;

        // Verify expectation
        // We treat TIMEOUT as BLOCK for KILL actions sometimes
        let verdict = result;
        if (result === "TIMEOUT" && (task.expectedAction === "BLOCK" || task.expectedAction === "KILL")) {
            // If we expected a block/kill and timed out, it's likely the process died (Kill)
            // or the proxy blocked it silently (shouldn't happen with correct config).
            // But for this demo, let's mark it as potentially valid behavior for KILL.
            // However, our proxy sends error responses, so TIMEOUT is usually bad unless KILL.
            // We'll leave it as TIMEOUT to be honest, unless it matched KILL logic above.
        }

        // Map REQUEST_APPROVAL to APPROVAL_REQUIRED for display if needed, but we used consistent enum.

        const isSuccess = verdict === task.expectedAction || (task.expectedAction === "BLOCK" && verdict === "KILL");

        const icon = isSuccess ? "✅" : "⚠️";
        console.log(`    └─ Result: ${verdict} (Expected: ${task.expectedAction}) ${icon}`);

        if (!isSuccess) {
            console.log(`       Wait, expected ${task.expectedAction} but got ${verdict}`);
        }
    }

    private sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

new ResearchAgentDemo().start().catch(console.error);
