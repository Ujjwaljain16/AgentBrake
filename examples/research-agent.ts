import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";

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

    private async startProxy() {
        const fs = require("fs");
        // Paths must work both in local TS environment and compiled Docker (dist) environment
        // Compiled paths (relative to dist/examples/research-agent.js)
        // With rootDir: ".", dist structure mirrors source, so proxy is in dist/src/proxy/
        const distProxyPath = path.resolve(__dirname, "../src/proxy/index.js");
        const distToolsPath = path.resolve(__dirname, "enterprise-tools.js");
        const distConfigPath = path.resolve(__dirname, "../../examples/enterprise-config.yml");

        // Source paths (fallback for local development via ts-node)
        const srcProxyPath = path.resolve(__dirname, "../src/proxy/index.ts");
        const srcToolsPath = path.resolve(__dirname, "enterprise-tools.ts");
        const srcConfigPath = path.resolve(__dirname, "../../examples/enterprise-config.yml");

        const isDocker = fs.existsSync("/app");
        const proxyPath = isDocker ? distProxyPath : (fs.existsSync(distProxyPath) ? distProxyPath : srcProxyPath);
        const toolsPath = isDocker ? distToolsPath : (fs.existsSync(distToolsPath) ? distToolsPath : srcToolsPath);
        const configPath = isDocker ? distConfigPath : (fs.existsSync(distConfigPath) ? distConfigPath : srcConfigPath);

        console.log(`[ResearchAgent] Config Path: ${configPath}`);
        if (!fs.existsSync(configPath)) {
            console.error(`[ResearchAgent] CRITICAL: Config file not found at ${configPath}`);
            process.exit(1);
        }

        // Spawn the proxy which wraps the tools server
        this.child = spawn("node", [proxyPath, "node", toolsPath], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                AGENT_BRAKE_CONFIG: configPath,
                NODE_ENV: "production"
            },
            shell: process.platform === 'win32'
        });

        this.child.stdout?.on("data", (data) => {
            const lines = data.toString().split("\n");
            for (const line of lines) {
                if (!line.trim()) continue;

                if (line.includes("KILL action triggered")) {
                    const resolve = this.pendingResolve;
                    if (resolve) resolve("BLOCK");
                }

                try {
                    const parsed = JSON.parse(line);
                    if (parsed.id !== undefined) {
                        const resolve = this.pendingResolve;
                        if (parsed.error && resolve) {
                            const data = parsed.error.data;
                            const action = (data?.action || "BLOCK").toUpperCase();
                            resolve(action === "REQUEST_APPROVAL" ? "REQUEST_APPROVAL" : action);
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
            const msg = data.toString().trim();
            if (msg) console.error(`[Proxy Error] ${msg}`);
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

        const msg = {
            jsonrpc: "2.0",
            id: index,
            method: `tools/call`,
            params: { name: task.tool, arguments: task.args }
        };

        const responsePromise = new Promise<string>((resolve) => {
            this.pendingResolve = resolve;
        });

        this.child?.stdin?.write(JSON.stringify(msg) + "\n");

        const result = await Promise.race([
            responsePromise,
            this.sleep(5000).then(() => "TIMEOUT") // Increased timeout for container slow starts
        ]);
        this.pendingResolve = null;

        const isSuccess = result === task.expectedAction || (task.expectedAction === "BLOCK" && result === "KILL");
        const icon = isSuccess ? "✅" : "⚠️";
        console.log(`    └─ Result: ${result} (Expected: ${task.expectedAction}) ${icon}`);

        if (!isSuccess) {
            console.log(`       Wait, expected ${task.expectedAction} but got ${result}`);
        }
    }

    private sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

new ResearchAgentDemo().start().catch(console.error);
