import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHarness, call, settle } from "./harness";
import { RateLimitPolicy } from "../src/policy/policies/RateLimitPolicy";
import { BudgetPolicy } from "../src/policy/policies/BudgetPolicy";
import { AllowedToolsPolicy } from "../src/policy/policies/AllowedToolsPolicy";
import { DeniedToolsPolicy } from "../src/policy/policies/DeniedToolsPolicy";
import { ApprovalPolicy } from "../src/policy/policies/ApprovalPolicy";
import { MaxRuntimePolicy } from "../src/policy/policies/MaxRuntimePolicy";
import { CircuitBreakerPolicy } from "../src/policy/policies/CircuitBreakerPolicy";
import { GranularAccessPolicy } from "../src/policy/policies/GranularAccessPolicy";
import { RuntimeMonitor, MAX_HISTORY } from "../src/monitor/tracker";
import { canonicalJson, toolCallRequest, Policy } from "../src/policy/types";
import { ConfigLoader, ignoredSettings } from "../src/config/loader";
import { buildPolicies } from "../src/proxy/build";

let logged: string[] = [];
beforeAll(() => {
    jest.spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)); });
});
beforeEach(() => { logged = []; });
afterAll(() => { jest.restoreAllMocks(); });

const ids = (lines: string[]) => lines.map(l => JSON.parse(l).id);

describe("two-phase commit: blocked calls use up nothing", () => {
    it("a call blocked by a later policy does not consume rate-limit quota", async () => {
        const limiter = new RateLimitPolicy(2, 60);
        const h = createHarness([limiter, new AllowedToolsPolicy(["ok"])]);
        h.input.write([call(1, "evil"), call(2, "evil"), call(3, "evil"), call(4, "ok"), call(5, "ok")].join("\n") + "\n");
        await settle();
        expect(ids(h.toServer)).toEqual([4, 5]);
        expect(limiter.getCurrentRate().current).toBe(2);
    });

    it("a call blocked by a later policy is not charged to the budget", async () => {
        const budget = new BudgetPolicy(1, [], 0.25);
        const h = createHarness([budget, new DeniedToolsPolicy(["evil"])]);
        h.input.write([call(1, "evil"), call(2, "evil"), call(3, "ok")].join("\n") + "\n");
        await settle();
        expect(ids(h.toServer)).toEqual([3]);
        expect(budget.getSpend()).toBe(0.25);
    });

    it("an approval is consumed only when the call is forwarded", async () => {
        const approval = new ApprovalPolicy(["send"]);
        const gate: Policy = { name: "Gate", validate: async () => (open ? null : { policyName: "Gate", action: "block", reason: "closed" }) };
        let open = false;
        const h = createHarness([approval, gate]);
        const key = ApprovalPolicy.requestKey(toolCallRequest("send", { to: "a" }));

        h.input.write(call(1, "send", { to: "a" }) + "\n");
        await settle();
        expect(approval.approve(key)).toBe(true);

        h.input.write(call(2, "send", { to: "a" }) + "\n"); // approved, but the gate blocks it
        await settle();
        open = true;
        h.input.write(call(3, "send", { to: "a" }) + "\n"); // approval still valid
        await settle();
        h.input.write(call(4, "send", { to: "a" }) + "\n"); // approval used up
        await settle();

        expect(ids(h.toServer)).toEqual([3]);
        expect(JSON.parse(h.toClient[h.toClient.length - 1]).error.code).toBe(-32001);
    });

    it("warnings are only logged for calls that are forwarded", async () => {
        const h = createHarness([new RateLimitPolicy(1, 60), new DeniedToolsPolicy(["evil"])]);
        h.input.write(call(1, "evil") + "\n");
        await settle();
        expect(logged.some(l => l.includes('"action":"WARN"'))).toBe(false);
    });

    it("blocks the call when a policy throws during commit", async () => {
        const bad: Policy = { name: "Bad", validate: async () => null, commit: () => { throw new Error("disk full"); } };
        const h = createHarness([bad]);
        h.input.write(call(1, "ok") + "\n");
        await settle();
        expect(h.toServer).toEqual([]);
        expect(JSON.parse(h.toClient[0]).error.data.policy).toBe("Bad");
    });
});

describe("decision traces and bounded state", () => {
    it("logs which policies ran and what each decided", async () => {
        const h = createHarness([new RateLimitPolicy(100, 60), new AllowedToolsPolicy(["ok"])]);
        h.input.write(call(1, "evil") + "\n");
        await settle();
        const entry = JSON.parse(logged.find(l => l.includes("POLICY_VIOLATION"))!);
        expect(entry.trace).toEqual([
            { policy: "RateLimitPolicy", verdict: "pass" },
            { policy: "AllowedToolsPolicy", verdict: "block" }
        ]);
    });

    it("violation logs stay constant-size however long the session runs", async () => {
        const h = createHarness([new AllowedToolsPolicy(["ok"])]);
        h.input.write(Array.from({ length: 300 }, (_, i) => call(i + 1, "evil")).join("\n") + "\n");
        await settle(50);
        const violations = logged.filter(l => l.includes("POLICY_VIOLATION"));
        expect(violations).toHaveLength(300);
        expect(violations[299].length).toBeLessThan(violations[0].length + 20);
        expect(h.proxy.getStats().block).toBe(300);
    });

    it("keeps at most MAX_HISTORY decisions in memory", () => {
        const monitor = new RuntimeMonitor();
        for (let i = 0; i < MAX_HISTORY + 50; i++) monitor.logAction("BLOCK", "P");
        expect(monitor.getHistory()).toHaveLength(MAX_HISTORY);
        expect(monitor.getState().decisions).toBe(MAX_HISTORY + 50);
    });
});

describe("tools/list filtering", () => {
    const listing = (id: number, names: unknown[]) => ({
        jsonrpc: "2.0", id, result: { tools: names.map(n => (typeof n === "string" ? { name: n, inputSchema: {} } : n)), nextCursor: "c" }
    });

    it("hides tools the policy would refuse, keeping the rest of the result", async () => {
        const h = createHarness([new AllowedToolsPolicy(["read", "write", "shell"]), new DeniedToolsPolicy(["shell"])]);
        h.input.write('{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}\n');
        await settle();
        h.serverSays(listing(7, ["read", "write", "shell", "secret_dump"]));
        await settle();
        const out = JSON.parse(h.toClient[0]);
        expect(out.result.tools.map((t: any) => t.name)).toEqual(["read", "write"]);
        expect(out.result.nextCursor).toBe("c");
    });

    it("drops malformed tool entries rather than relaying them", async () => {
        const h = createHarness([new DeniedToolsPolicy(["x"])]);
        h.input.write('{"jsonrpc":"2.0","id":"a","method":"tools/list"}\n');
        await settle();
        h.serverSays(listing("a" as any, ["fine", { noName: true }, null]));
        await settle();
        expect(JSON.parse(h.toClient[0]).result.tools.map((t: any) => t.name)).toEqual(["fine"]);
    });

    it("leaves responses that do not answer a tools/list untouched", async () => {
        const h = createHarness([new DeniedToolsPolicy(["shell"])]);
        const unrelated = listing(9, ["shell"]);
        h.serverSays(unrelated); // no tools/list request with id 9 was made
        await settle();
        expect(JSON.parse(h.toClient[0])).toEqual(unrelated);
    });

    it("hides a tool if a visibility check throws (fail closed)", async () => {
        const broken: Policy = { name: "B", validate: async () => null, isToolVisible: () => { throw new Error("x"); } };
        const h = createHarness([broken]);
        h.input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
        await settle();
        h.serverSays(listing(1, ["a"]));
        await settle();
        expect(JSON.parse(h.toClient[0]).result.tools).toEqual([]);
    });
});

describe("approval keys are canonical", () => {
    it("the same arguments in a different key order are the same request", () => {
        const a = ApprovalPolicy.requestKey(toolCallRequest("t", { b: 1, a: { y: 2, x: [1, { d: 1, c: 2 }] } }));
        const b = ApprovalPolicy.requestKey(toolCallRequest("t", { a: { x: [1, { c: 2, d: 1 }], y: 2 }, b: 1 }));
        expect(a).toBe(b);
    });

    it("canonicalJson sorts keys at every level and keeps array order", () => {
        expect(canonicalJson({ z: 1, a: [3, 1, { k: 2, j: 1 }] })).toBe('{"a":[3,1,{"j":1,"k":2}],"z":1}');
    });
});

describe("max runtime", () => {
    it("starts the clock at session start, not at construction", async () => {
        let t = 0;
        const policy = new MaxRuntimePolicy(10, () => t);
        t = 60_000; // an hour of config loading would not count
        policy.onSessionStart();
        expect(await policy.validate(toolCallRequest("x", {}), {} as any)).toBeNull();
        t += 11_000;
        expect((await policy.validate(toolCallRequest("x", {}), {} as any))?.action).toBe("kill");
    });

    it("kills the session on a hard timer even when no tool call arrives", async () => {
        const h = createHarness([new MaxRuntimePolicy(0.02)]);
        await settle(80);
        expect(h.child.kill).toHaveBeenCalled();
        expect(h.exit).toHaveBeenCalledWith(1);
    });
});

describe("circuit breaker half-open", () => {
    it("reopens after a single failed trial call", async () => {
        let t = 0;
        const breaker = new CircuitBreakerPolicy(3, 10, () => t);
        ["x", "x", "x"].forEach(n => breaker.recordFailure(n));
        expect(breaker.getStatus("x").isOpen).toBe(true);
        t = 11_000;
        expect(await breaker.validate(toolCallRequest("x", {}), {} as any)).toBeNull(); // trial allowed
        breaker.observeResult({ toolName: "x", args: {}, success: false });
        expect(breaker.getStatus("x").isOpen).toBe(true);
    });
});

describe("budget configuration", () => {
    it("uses per-tool costs, the default cost and the warn threshold", async () => {
        const budget = new BudgetPolicy(1, [{ tool: "llm", costPerCall: 0.5 }], 0.1, 0.5, "EUR");
        const r1 = await budget.validate(toolCallRequest("llm", {}), {} as any);
        expect(r1?.action).toBe("warn");
        expect(r1?.reason).toContain("EUR");
        budget.commit(toolCallRequest("llm", {}));
        budget.commit(toolCallRequest("cheap", {}));
        expect(budget.getSpend()).toBe(0.6);
    });

    it("is built from config with tool_costs and warn_threshold", () => {
        const [budget] = buildPolicies({
            version: "3.0",
            agent: { name: "a", trust_level: "sandbox" },
            policies: {
                global: { on_violation: "block", max_retries: 3 },
                limits: { budget: { max_cost: 2, currency: "USD", warn_threshold: 0.9, cost_per_call: 0, tool_costs: { pricey: 1 } } },
                security: {}
            }
        }) as BudgetPolicy[];
        budget.commit(toolCallRequest("free", {}));
        budget.commit(toolCallRequest("pricey", {}));
        expect(budget.getSpend()).toBe(1);
    });
});

describe("config wiring", () => {
    it("granular rules without an action use global.on_violation", async () => {
        const policies = buildPolicies({
            version: "3.0",
            agent: { name: "a", trust_level: "sandbox" },
            policies: {
                global: { on_violation: "kill", max_retries: 3 },
                limits: {},
                security: { granular_rules: [{ tool: "read", deny_if: { arguments: { path: "secret" } } }] }
            }
        });
        const granular = policies.find(p => p instanceof GranularAccessPolicy)!;
        expect((await granular.validate(toolCallRequest("read", { path: "/secret" }), {} as any))?.action).toBe("kill");
    });

    it("warns about settings that are accepted but not enforced", () => {
        expect(ignoredSettings({ agent: { trust_level: "trusted" }, policies: { global: { max_retries: 2 } } }))
            .toEqual(["agent.trust_level", "policies.global.max_retries"]);
        expect(ignoredSettings({ agent: { name: "x" } })).toEqual([]);

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrake-"));
        const file = path.join(dir, "c.yml");
        fs.writeFileSync(file, "agent:\n  trust_level: trusted\n");
        ConfigLoader.load(file);
        expect(logged.some(l => l.includes("agent.trust_level"))).toBe(true);
    });

    it("rejects a warn_threshold outside (0, 1]", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrake-"));
        const file = path.join(dir, "c.yml");
        fs.writeFileSync(file, "policies:\n  limits:\n    budget:\n      max_cost: 1\n      warn_threshold: 80\n");
        expect(() => ConfigLoader.load(file)).toThrow(/warn_threshold/);
    });
});
