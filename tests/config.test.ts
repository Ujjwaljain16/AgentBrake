import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConfigLoader, ConfigError, isAllowInvalidConfig } from "../src/config/loader";
import { AgentBrakeConfigSchema } from "../src/config/schema";
import { bootstrap, buildPolicies } from "../src/proxy/build";
import { GranularAccessPolicy, MAX_ARGUMENT_VALUE_LENGTH } from "../src/policy/policies/GranularAccessPolicy";
import { DeniedToolsPolicy } from "../src/policy/policies/DeniedToolsPolicy";
import { compileSafeRegex } from "../src/policy/safeRegex";
import { redact } from "../src/monitor/logger";
import { AgentRuntimeState } from "../src/policy/types";

beforeAll(() => { jest.spyOn(console, "error").mockImplementation(() => undefined); });
afterAll(() => { jest.restoreAllMocks(); });

const state = (): AgentRuntimeState => ({
    toolCallsCount: 0, blocked: false, trustLevel: "sandbox", estimatedCost: 0, history: []
});
const req = (name: string, args: any = {}) => ({ params: { name, arguments: args }, method: "tools/call" } as any);

describe("config loading fails closed", () => {
    let dir: string;
    const savedEnv = { ...process.env };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrake-"));
        delete process.env.AGENT_BRAKE_CONFIG;
        delete process.env.AGENT_BRAKE_ALLOW_INVALID_CONFIG;
    });
    afterEach(() => {
        process.env = { ...savedEnv };
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const write = (name: string, content: string) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, content);
        return file;
    };

    it("loads a valid file", () => {
        const file = write("ok.yml", "policies:\n  security:\n    allowed_tools: [a]\n");
        expect(ConfigLoader.load(file).policies.security.allowed_tools).toEqual(["a"]);
    });

    it("throws on malformed YAML", () => {
        const file = write("bad.yml", "policies: [unclosed\n  : :\n");
        expect(() => ConfigLoader.load(file)).toThrow(ConfigError);
    });

    it("throws on malformed JSON", () => {
        const file = write("bad.json", "{ not json");
        expect(() => ConfigLoader.load(file)).toThrow(ConfigError);
    });

    it("throws on schema violations", () => {
        const file = write("bad.yml", "policies:\n  limits:\n    max_tool_calls: many\n");
        expect(() => ConfigLoader.load(file)).toThrow(/max_tool_calls/);
    });

    it("throws on an empty file", () => {
        expect(() => ConfigLoader.load(write("empty.yml", ""))).toThrow(ConfigError);
    });

    it("rejects unknown keys so typos cannot silently disable a policy", () => {
        const file = write("typo.yml", "policies:\n  security:\n    allowed_tool: [a]\n");
        expect(() => ConfigLoader.load(file)).toThrow(ConfigError);
    });

    it("throws when an explicitly requested file does not exist", () => {
        expect(() => ConfigLoader.load(path.join(dir, "missing.yml"))).toThrow(/not found/);
        process.env.AGENT_BRAKE_CONFIG = path.join(dir, "missing.yml");
        expect(() => ConfigLoader.load()).toThrow(/not found/);
    });

    it("does not silently skip a broken discovered file", () => {
        const cwd = process.cwd();
        write("agent-brake.yml", "policies: 12\n");
        process.chdir(dir);
        try {
            expect(() => ConfigLoader.load()).toThrow(ConfigError);
        } finally {
            process.chdir(cwd);
        }
    });

    it("bootstrap refuses to start on an invalid config by default", () => {
        process.env.AGENT_BRAKE_CONFIG = write("bad.yml", "policies: 12\n");
        expect(() => bootstrap()).toThrow(ConfigError);
    });

    it("bootstrap refuses an invalid regex in a rule", () => {
        process.env.AGENT_BRAKE_CONFIG = write("re.yml",
            "policies:\n  security:\n    granular_rules:\n      - tool: t\n        deny_if:\n          arguments:\n            p: '('\n");
        expect(() => bootstrap()).toThrow(/Invalid regex/);
    });

    it("falls back to built-in defaults only with the explicit opt-in", () => {
        process.env.AGENT_BRAKE_CONFIG = write("bad.yml", "policies: 12\n");
        process.env.AGENT_BRAKE_ALLOW_INVALID_CONFIG = "1";
        const { config, policies } = bootstrap();
        expect(config.agent.name).toBe("safe-fallback-agent");
        expect(policies).toEqual([]);
    });

    it("parses the opt-in flag strictly", () => {
        expect(isAllowInvalidConfig({ AGENT_BRAKE_ALLOW_INVALID_CONFIG: "1" })).toBe(true);
        expect(isAllowInvalidConfig({ AGENT_BRAKE_ALLOW_INVALID_CONFIG: "true" })).toBe(true);
        expect(isAllowInvalidConfig({ AGENT_BRAKE_ALLOW_INVALID_CONFIG: "0" })).toBe(false);
        expect(isAllowInvalidConfig({})).toBe(false);
    });

    it("uses built-in defaults when no file exists at all", () => {
        const cwd = process.cwd();
        process.chdir(dir);
        try {
            expect(ConfigLoader.load().agent.name).toBe("safe-fallback-agent");
        } finally {
            process.chdir(cwd);
        }
    });

    it("loads the shipped example config", () => {
        const file = path.resolve(__dirname, "../examples/enterprise-config.yml");
        const config = ConfigLoader.load(file);
        expect(buildPolicies(config).length).toBeGreaterThan(0);
    });
});

describe("buildPolicies", () => {
    it("does not skip a limit of zero", () => {
        const config = AgentBrakeConfigSchema.parse({}) as any;
        config.policies.limits = { max_tool_calls: 0 };
        expect(buildPolicies(config).map(p => p.name)).toContain("MaxToolCallsPolicy");
    });

    it("enforces denied_tools instead of silently ignoring them", async () => {
        const policy = new DeniedToolsPolicy(["rm"]);
        expect((await policy.validate(req("rm"), state()))?.action).toBe("block");
        expect(await policy.validate(req("ls"), state())).toBeNull();
    });
});

describe("regex safety", () => {
    it("rejects nested quantifiers", () => {
        for (const p of ["(a+)+$", "(.*)*x", "(a|b*){2,}", "(\\d+)*"]) {
            expect(() => compileSafeRegex(p)).toThrow(/catastrophic/);
        }
    });

    it("accepts the patterns used in the shipped config", () => {
        expect(() => compileSafeRegex(".*(credentials|\\.env|\\.aws|\\.ssh|id_rsa|passwd|shadow|secrets?).*")).not.toThrow();
        expect(() => compileSafeRegex("^(/tmp/|/app/data/|/var/log/).*")).not.toThrow();
    });

    it("rejects over-long patterns and invalid syntax", () => {
        expect(() => compileSafeRegex("a".repeat(600))).toThrow(/too long/);
        expect(() => compileSafeRegex("[")).toThrow(/Invalid regex/);
    });

    it("policy construction fails on a dangerous pattern", () => {
        expect(() => new GranularAccessPolicy([{ tool: "t", deny_if: { arguments: { a: "(x+)+y" } }, action: "block" }])).toThrow();
    });

    it("oversized argument values fail closed for both deny_if and allow_if", async () => {
        const huge = "a".repeat(MAX_ARGUMENT_VALUE_LENGTH + 1);
        const deny = new GranularAccessPolicy([{ tool: "t", deny_if: { arguments: { a: "^never$" } }, action: "block" }]);
        expect((await deny.validate(req("t", { a: huge }), state()))?.action).toBe("block");

        const allow = new GranularAccessPolicy([{ tool: "t", allow_if: { arguments: { a: "^a+$" } }, action: "block" }]);
        expect((await allow.validate(req("t", { a: huge }), state()))?.action).toBe("block");
    });

    it("tests non-string argument values via their JSON form instead of '[object Object]'", async () => {
        const deny = new GranularAccessPolicy([{ tool: "t", deny_if: { arguments: { p: "\\.env" } }, action: "block" }]);
        expect((await deny.validate(req("t", { p: { nested: "/x/.env" } }), state()))?.action).toBe("block");
        expect((await deny.validate(req("t", { p: ["/x/.env"] }), state()))?.action).toBe("block");
    });

    it("ignores inherited properties when looking up arguments", async () => {
        const deny = new GranularAccessPolicy([{ tool: "t", deny_if: { arguments: { constructor: "function" } }, action: "block" }]);
        expect(await deny.validate(req("t", {}), state())).toBeNull();
    });
});

describe("log redaction", () => {
    it("redacts sensitive-looking keys recursively and truncates long strings", () => {
        const out: any = redact({
            message: "x",
            api_key: "sk-123",
            nested: { Authorization: "Bearer abc", fine: "ok" },
            list: [{ password: "p" }],
            long: "y".repeat(2000)
        });
        expect(out.api_key).toBe("[REDACTED]");
        expect(out.nested.Authorization).toBe("[REDACTED]");
        expect(out.nested.fine).toBe("ok");
        expect(out.list[0].password).toBe("[REDACTED]");
        expect(out.long.length).toBeLessThan(600);
        expect(JSON.stringify(out)).not.toContain("sk-123");
    });
});
