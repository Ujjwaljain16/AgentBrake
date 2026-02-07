import { spawn, ChildProcess } from "child_process";
import path from "path";

interface TestCase {
    name: string;
    method: string;
    params: any;
    expectedOutcome: "ALLOW" | "BLOCK" | "WARN";
}

const TEST_CASES: TestCase[] = [
    {
        name: "Allowed Tool (calculator)",
        method: "tools/call",
        params: { name: "calculator", arguments: { a: 5, b: 3, operation: "add" } },
        expectedOutcome: "ALLOW"
    },
    {
        name: "Safe File Read (/tmp/safe.txt)",
        method: "tools/call",
        params: { name: "read_file", arguments: { path: "/tmp/safe.txt" } },
        expectedOutcome: "ALLOW"
    },
    {
        name: "Blocked Tool (dangerous_tool)",
        method: "tools/call",
        params: { name: "dangerous_tool", arguments: {} },
        expectedOutcome: "BLOCK"
    },
    {
        name: "Sensitive File (/etc/passwd)",
        method: "tools/call",
        params: { name: "read_file", arguments: { path: "/etc/passwd" } },
        expectedOutcome: "BLOCK"
    },
    {
        name: "Secret File (.secret)",
        method: "tools/call",
        params: { name: "read_file", arguments: { path: "/home/user/.secret" } },
        expectedOutcome: "BLOCK"
    },
    {
        name: "Loop Call 1/10",
        method: "tools/call",
        params: { name: "calculator", arguments: { a: 1, b: 1, operation: "add" } },
        expectedOutcome: "ALLOW"
    },
    {
        name: "Loop Call 2/10",
        method: "tools/call",
        params: { name: "calculator", arguments: { a: 2, b: 2, operation: "add" } },
        expectedOutcome: "ALLOW"
    },
    {
        name: "Loop Call 3/10",
        method: "tools/call",
        params: { name: "calculator", arguments: { a: 3, b: 3, operation: "add" } },
        expectedOutcome: "ALLOW"
    },
    {
        name: "Loop Call 4/10",
        method: "tools/call",
        params: { name: "calculator", arguments: { a: 4, b: 4, operation: "add" } },
        expectedOutcome: "ALLOW"
    },
    {
        name: "Call 10 (MaxToolCalls Limit)",
        method: "tools/call",
        params: { name: "calculator", arguments: { a: 5, b: 5, operation: "add" } },
        expectedOutcome: "BLOCK"
    }
];

class DemoRunner {
    private child: ChildProcess | null = null;
    private idCounter = 1;
    private results: Array<{ test: string; outcome: string }> = [];
    private pendingResolve: ((value: string) => void) | null = null;

    async run(): Promise<void> {
        console.log("=".repeat(60));
        console.log("       AGENTBRAKE E2E DEMO - ALL FEATURES");
        console.log("=".repeat(60));
        console.log("\nPolicies Active:");
        console.log("  - MaxToolCallsPolicy  (limit: 10)");
        console.log("  - AllowedToolsPolicy  (calculator, read_file)");
        console.log("  - GranularAccessPolicy (DLP regex patterns)");
        console.log("  - RateLimitPolicy     (20/min, warn at 80%)");
        console.log("\n" + "-".repeat(60) + "\n");

        await this.startProxy();
        await this.sleep(1500);

        for (let i = 0; i < TEST_CASES.length; i++) {
            await this.runTest(i + 1, TEST_CASES[i]);
        }

        this.printSummary();
        this.cleanup();
    }

    private async startProxy(): Promise<void> {
        const proxyPath = path.resolve(__dirname, "../../dist/proxy/index.js");
        const toolsPath = path.resolve(__dirname, "../../dist/demo/tools-server.js");

        this.child = spawn("node", [proxyPath, "node", toolsPath], {
            stdio: ["pipe", "pipe", "inherit"],
            env: { ...process.env }
        });

        this.child.stdout?.on("data", (data) => {
            const lines = data.toString().trim().split("\n");
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line);
                    if (this.pendingResolve) {
                        if (parsed.error) {
                            this.pendingResolve(parsed.error.data?.action?.toUpperCase() || "BLOCK");
                        } else if (parsed.result) {
                            this.pendingResolve("ALLOW");
                        }
                    }
                } catch {
                    // Ignore non-JSON
                }
            }
        });
    }

    private async runTest(num: number, test: TestCase): Promise<void> {
        console.log(`[${num}/${TEST_CASES.length}] ${test.name}`);
        console.log(`      Expected: ${test.expectedOutcome}`);

        const msg = {
            jsonrpc: "2.0",
            id: this.idCounter++,
            method: test.method,
            params: test.params
        };

        const responsePromise = new Promise<string>((resolve) => {
            this.pendingResolve = resolve;
        });

        this.child?.stdin?.write(JSON.stringify(msg) + "\n");

        const outcome = await Promise.race([
            responsePromise,
            this.sleep(1200).then(() => "TIMEOUT")
        ]);

        this.pendingResolve = null;
        const normalizedOutcome = outcome === "ALLOW" || outcome === "ALLOWED" ? "ALLOW" : outcome;

        console.log(`      Result:   ${normalizedOutcome}`);
        console.log("");

        this.results.push({ test: test.name, outcome: normalizedOutcome });
    }

    private printSummary(): void {
        console.log("=".repeat(60));
        console.log("                    TEST SUMMARY");
        console.log("=".repeat(60));

        let passed = 0;

        for (let i = 0; i < this.results.length; i++) {
            const result = this.results[i];
            const expected = TEST_CASES[i].expectedOutcome;
            const match = result.outcome === expected || result.outcome.includes(expected);

            if (match) {
                passed++;
                console.log(`  [PASS] ${result.test}`);
            } else {
                console.log(`  [FAIL] ${result.test} (Expected: ${expected}, Got: ${result.outcome})`);
            }
        }

        console.log("\n" + "-".repeat(60));
        console.log(`  Total: ${this.results.length} | Passed: ${passed} | Failed: ${this.results.length - passed}`);
        console.log("=".repeat(60));
    }

    private cleanup(): void {
        setTimeout(() => {
            this.child?.kill();
            process.exit(0);
        }, 500);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

new DemoRunner().run().catch(console.error);
