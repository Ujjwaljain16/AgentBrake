import { MaxToolCallsPolicy } from "../src/policy/policies/MaxToolCallsPolicy";
import { AllowedToolsPolicy } from "../src/policy/policies/AllowedToolsPolicy";
import { MaxRuntimePolicy } from "../src/policy/policies/MaxRuntimePolicy";
import { RateLimitPolicy } from "../src/policy/policies/RateLimitPolicy";
import { GranularAccessPolicy } from "../src/policy/policies/GranularAccessPolicy";
import { CircuitBreakerPolicy } from "../src/policy/policies/CircuitBreakerPolicy";
import { AgentRuntimeState, PolicyResult } from "../src/policy/types";

const mockRequest = (toolName: string, args: any = {}) => ({
    params: { name: toolName, arguments: args },
    method: "tools/call"
} as any);

const mockState = (): AgentRuntimeState => ({
    toolCallsCount: 0,
    blocked: false,
    trustLevel: "sandbox",
    estimatedCost: 0,
    history: []
});

describe("MaxToolCallsPolicy", () => {
    it("should allow calls under limit", async () => {
        const policy = new MaxToolCallsPolicy(5);
        const state = { ...mockState(), toolCallsCount: 3 };
        const result = await policy.validate(mockRequest("calculator"), state);
        expect(result).toBeNull();
    });

    it("should block calls at limit", async () => {
        const policy = new MaxToolCallsPolicy(5);
        const state = { ...mockState(), toolCallsCount: 5 };
        const result = await policy.validate(mockRequest("calculator"), state);
        expect(result).not.toBeNull();
        expect(result?.action).toBe("block");
    });

    it("should block calls over limit", async () => {
        const policy = new MaxToolCallsPolicy(5);
        const state = { ...mockState(), toolCallsCount: 10 };
        const result = await policy.validate(mockRequest("calculator"), state);
        expect(result?.action).toBe("block");
        expect(result?.reason).toContain("Maximum tool calls limit");
    });
});

describe("AllowedToolsPolicy", () => {
    it("should allow whitelisted tools", async () => {
        const policy = new AllowedToolsPolicy(["calculator", "read_file"]);
        const result = await policy.validate(mockRequest("calculator"), mockState());
        expect(result).toBeNull();
    });

    it("should block non-whitelisted tools", async () => {
        const policy = new AllowedToolsPolicy(["calculator"]);
        const result = await policy.validate(mockRequest("dangerous_tool"), mockState());
        expect(result).not.toBeNull();
        expect(result?.action).toBe("block");
        expect(result?.reason).toContain("not in the allowed list");
    });
});

describe("MaxRuntimePolicy", () => {
    it("should allow calls within time limit", async () => {
        const policy = new MaxRuntimePolicy(60);
        const result = await policy.validate(mockRequest("calculator"), mockState());
        expect(result).toBeNull();
    });

    it("should have kill action when exceeded", async () => {
        const policy = new MaxRuntimePolicy(0);
        await new Promise(r => setTimeout(r, 10));
        const result = await policy.validate(mockRequest("calculator"), mockState());
        expect(result?.action).toBe("kill");
    });
});

describe("RateLimitPolicy", () => {
    it("should allow calls under rate limit", async () => {
        const policy = new RateLimitPolicy(10, 60);
        const result = await policy.validate(mockRequest("calculator"), mockState());
        expect(result).toBeNull();
    });

    it("should warn when approaching limit", async () => {
        const policy = new RateLimitPolicy(10, 60);
        for (let i = 0; i < 8; i++) {
            await policy.validate(mockRequest("calculator"), mockState());
        }
        const result = await policy.validate(mockRequest("calculator"), mockState());
        expect(result?.action).toBe("warn");
    });

    it("should block at limit", async () => {
        const policy = new RateLimitPolicy(5, 60);
        for (let i = 0; i < 5; i++) {
            await policy.validate(mockRequest("calculator"), mockState());
        }
        const result = await policy.validate(mockRequest("calculator"), mockState());
        expect(result?.action).toBe("block");
    });
});

describe("GranularAccessPolicy", () => {
    const rules = [
        { tool: "read_file", allow_if: { arguments: { path: "^/tmp/.*" } }, action: "block" as const },
        { tool: "read_file", deny_if: { arguments: { path: ".*passwd.*" } }, action: "kill" as const }
    ];

    it("should allow matching allow_if pattern", async () => {
        const policy = new GranularAccessPolicy(rules);
        const result = await policy.validate(mockRequest("read_file", { path: "/tmp/safe.txt" }), mockState());
        expect(result).toBeNull();
    });

    it("should block non-matching allow_if pattern", async () => {
        const policy = new GranularAccessPolicy(rules);
        const result = await policy.validate(mockRequest("read_file", { path: "/etc/config" }), mockState());
        expect(result?.action).toBe("block");
    });

    it("should block matching deny_if pattern", async () => {
        const policy = new GranularAccessPolicy(rules);
        const result = await policy.validate(mockRequest("read_file", { path: "/etc/passwd" }), mockState());
        expect(result).not.toBeNull();
    });

    it("should ignore tools without rules", async () => {
        const policy = new GranularAccessPolicy(rules);
        const result = await policy.validate(mockRequest("calculator", {}), mockState());
        expect(result).toBeNull();
    });
});

import { BudgetPolicy } from "../src/policy/policies/BudgetPolicy";

describe("CircuitBreakerPolicy", () => {
    it("should allow calls when circuit is closed", async () => {
        const policy = new CircuitBreakerPolicy(3, 60);
        const result = await policy.validate(mockRequest("calculator"), mockState());
        expect(result).toBeNull();
    });

    it("should open circuit after threshold failures", async () => {
        const policy = new CircuitBreakerPolicy(3, 60);
        policy.recordFailure("calculator");
        policy.recordFailure("calculator");
        policy.recordFailure("calculator");

        const result = await policy.validate(mockRequest("calculator"), mockState());
        expect(result?.action).toBe("block");
        expect(result?.reason).toContain("Circuit OPEN");
    });

    it("should reset circuit after success", async () => {
        const policy = new CircuitBreakerPolicy(3, 60);
        policy.recordFailure("calculator");
        policy.recordFailure("calculator");
        policy.recordSuccess("calculator");

        const status = policy.getStatus("calculator");
        expect(status.failures).toBe(0);
        expect(status.isOpen).toBe(false);
    });
});

describe("BudgetPolicy", () => {
    it("should allow calls under budget", async () => {
        const policy = new BudgetPolicy(1.00);
        const result = await policy.validate(mockRequest("calculator"), mockState());
        expect(result).toBeNull();
    });

    it("should warn at 80% budget", async () => {
        const policy = new BudgetPolicy(0.10, [], 0.01);
        for (let i = 0; i < 8; i++) {
            await policy.validate(mockRequest("calculator"), mockState());
        }
        const result = await policy.validate(mockRequest("calculator"), mockState());
        expect(result?.action).toBe("warn");
    });

    it("should block when budget exceeded", async () => {
        const policy = new BudgetPolicy(0.05, [], 0.01);
        for (let i = 0; i < 5; i++) {
            await policy.validate(mockRequest("calculator"), mockState());
        }
        const result = await policy.validate(mockRequest("calculator"), mockState());
        expect(result?.action).toBe("block");
        expect(result?.reason).toContain("Budget exceeded");
    });

    it("should track spend correctly", async () => {
        const policy = new BudgetPolicy(1.00, [], 0.01);
        await policy.validate(mockRequest("calculator"), mockState());
        await policy.validate(mockRequest("calculator"), mockState());
        expect(policy.getSpend()).toBe(0.02);
        expect(policy.getPercentUsed()).toBe(2);
    });

    it("should reset spend", async () => {
        const policy = new BudgetPolicy(1.00, [], 0.01);
        await policy.validate(mockRequest("calculator"), mockState());
        policy.reset();
        expect(policy.getSpend()).toBe(0);
    });
});
