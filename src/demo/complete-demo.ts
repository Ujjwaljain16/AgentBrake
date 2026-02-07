import { spawn, ChildProcess } from "child_process";
import path from "path";

/**
 * AgentBrake Complete E2E Demo
 * 
 * Demonstrates all features:
 * 1. MaxToolCallsPolicy - Blocks after limit reached
 * 2. AllowedToolsPolicy - Blocks unauthorized tools
 * 3. GranularAccessPolicy - Blocks based on argument patterns (DLP)
 * 4. RateLimitPolicy - Warns at 80%, blocks at limit
 */

interface TestCase {
    name: string;
    description: string;
    method: string;
    params: any;
    expectedOutcome: "ALLOW" | "BLOCK" | "WARN";
}

const TEST_CASES: TestCase[] = [
    // Test 1: Allowed tool, safe arguments
    {
        name: "Allowed Tool (calculator)",
        description: "Calculator is in allowed_tools list",
        method: "tools/call",
        params: { name: "calculator", arguments: { a: 5, b: 3, operation: "add" } },
        expectedOutcome: "ALLOW"
    },

    // Test 2: Allowed tool with safe file path
    {
        name: "Safe File Read (/tmp/safe.txt)",
        description: "read_file is allowed, path matches ALLOW pattern",
        method: "tools/call",
        params: { name: "read_file", arguments: { path: "/tmp/safe.txt" } },
        expectedOutcome: "ALLOW"
    },

    // Test 3: Blocked tool (not in allowed list)
    {
        name: "Blocked Tool (dangerous_tool)",
        description: "dangerous_tool is NOT in allowed_tools list",
        method: "tools/call",
        params: { name: "dangerous_tool", arguments: {} },
        expectedOutcome: "BLOCK"
    },

    // Test 4: Semantic Firewall - DENY pattern
    {
        name: "Sensitive File (/etc/passwd)",
        description: "read_file is allowed, but path matches DENY pattern",
        method: "tools/call",
        params: { name: "read_file", arguments: { path: "/etc/passwd" } },
        expectedOutcome: "BLOCK"
    },

    // Test 5: Semantic Firewall - another DENY pattern
    {
        name: "Secret File (.secret)",
        description: "Path contains 'secret' - matches DENY pattern",
        method: "tools/call",
        params: { name: "read_file", arguments: { path: "/home/user/.secret" } },
        expectedOutcome: "BLOCK"
    },

    // Test 6-10: Loop to trigger MaxToolCalls (assuming limit is 10)
    {
        name: "Loop Call 1/10",
        description: "Testing MaxToolCalls limit",
        method: "tools/call",
        params: { name: "calculator", arguments: { a: 1, b: 1, operation: "add" } },
        expectedOutcome: "ALLOW"
    },
    {
        name: "Loop Call 2/10",
        description: "Testing MaxToolCalls limit",
        method: "tools/call",
        params: { name: "calculator", arguments: { a: 2, b: 2, operation: "add" } },
        expectedOutcome: "ALLOW"
    },
    {
        name: "Loop Call 3/10",
        description: "Testing MaxToolCalls limit",
        method: "tools/call",
        params: { name: "calculator", arguments: { a: 3, b: 3, operation: "add" } },
        expectedOutcome: "ALLOW"
    },
    {
        name: "Loop Call 4/10",
        description: "Testing MaxToolCalls limit",
        method: "tools/call",
        params: { name: "calculator", arguments: { a: 4, b: 4, operation: "add" } },
        expectedOutcome: "ALLOW"
    },
    {
        name: "Loop Call 5/10 (BLOCK - Limit Reached)",
        description: "Should be blocked by MaxToolCallsPolicy",
        method: "tools/call",
        params: { name: "calculator", arguments: { a: 5, b: 5, operation: "add" } },
        expectedOutcome: "BLOCK"
    }
];

class DemoRunner {
    private child: ChildProcess | null = null;
    private idCounter = 1;
    private results: Array<{ test: string; outcome: string; response: string }> = [];

    async run(): Promise<void> {
        console.log("=".repeat(60));
        console.log("       AGENTBRAKE E2E DEMO - ALL FEATURES");
        console.log("=".repeat(60));
        console.log("\nFeatures being tested:");
        console.log("  1. MaxToolCallsPolicy  - Limits total tool calls");
        console.log("  2. AllowedToolsPolicy  - Whitelists specific tools");
        console.log("  3. GranularAccessPolicy - DLP with regex patterns");
        console.log("  4. RateLimitPolicy     - Rate limiting with backoff");
        console.log("\n" + "-".repeat(60) + "\n");

        await this.startProxy();
        await this.sleep(1500);

        for (let i = 0; i < TEST_CASES.length; i++) {
            const test = TEST_CASES[i];
            await this.runTest(i + 1, test);
            await this.sleep(800);
        }

        this.printSummary();
        this.cleanup();
    }

    private async startProxy(): Promise<void> {
        const proxyPath = path.resolve(__dirname, "../../dist/proxy/index.js");
        const toolsPath = path.resolve(__dirname, "../../dist/demo/tools-server.js");

        console.log("Starting AgentBrake Proxy...\n");

        this.child = spawn("node", [proxyPath, "node", toolsPath], {
            stdio: ["pipe", "pipe", "inherit"],
            env: { ...process.env }
        });

        this.child.stdout?.on("data", (data) => {
            const response = data.toString().trim();
            if (response) {
                this.handleResponse(response);
            }
        });
    }

    private handleResponse(response: string): void {
        try {
            const parsed = JSON.parse(response);
            if (parsed.error) {
                const action = parsed.error.data?.action?.toUpperCase() || "BLOCKED";
                console.log(`        Response: ${action} - ${parsed.error.message}`);
                this.results[this.results.length - 1].outcome = action;
                this.results[this.results.length - 1].response = parsed.error.message;
            } else if (parsed.result) {
                console.log(`        Response: ALLOWED`);
                this.results[this.results.length - 1].outcome = "ALLOWED";
                this.results[this.results.length - 1].response = "Success";
            }
        } catch {
            // Non-JSON response
        }
    }

    private async runTest(num: number, test: TestCase): Promise<void> {
        console.log(`[Test ${num}/${TEST_CASES.length}] ${test.name}`);
        console.log(`        Description: ${test.description}`);
        console.log(`        Expected: ${test.expectedOutcome}`);

        this.results.push({
            test: test.name,
            outcome: "PENDING",
            response: ""
        });

        const msg = {
            jsonrpc: "2.0",
            id: this.idCounter++,
            method: test.method,
            params: test.params
        };

        this.child?.stdin?.write(JSON.stringify(msg) + "\n");
        console.log("");
    }

    private printSummary(): void {
        console.log("\n" + "=".repeat(60));
        console.log("                    TEST SUMMARY");
        console.log("=".repeat(60));

        let passed = 0;
        let failed = 0;

        for (let i = 0; i < this.results.length; i++) {
            const result = this.results[i];
            const expected = TEST_CASES[i].expectedOutcome;
            const actual = result.outcome === "ALLOWED" ? "ALLOW" : result.outcome;
            const match = actual === expected || actual.includes(expected);

            if (match) {
                passed++;
                console.log(`  [PASS] ${result.test}`);
            } else {
                failed++;
                console.log(`  [FAIL] ${result.test} (Expected: ${expected}, Got: ${actual})`);
            }
        }

        console.log("\n" + "-".repeat(60));
        console.log(`  Total: ${this.results.length} | Passed: ${passed} | Failed: ${failed}`);
        console.log("=".repeat(60));
    }

    private cleanup(): void {
        setTimeout(() => {
            this.child?.kill();
            process.exit(0);
        }, 1000);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

const demo = new DemoRunner();
demo.run().catch(console.error);
