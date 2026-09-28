import { AgentBrakeConfig } from "../config/schema.js";
import { ConfigLoader, ConfigError, defaultConfig, isAllowInvalidConfig } from "../config/loader.js";
import { Logger } from "../monitor/logger.js";
import { Policy } from "../policy/types.js";
import { MaxToolCallsPolicy } from "../policy/policies/MaxToolCallsPolicy.js";
import { AllowedToolsPolicy } from "../policy/policies/AllowedToolsPolicy.js";
import { DeniedToolsPolicy } from "../policy/policies/DeniedToolsPolicy.js";
import { MaxRuntimePolicy } from "../policy/policies/MaxRuntimePolicy.js";
import { GranularAccessPolicy } from "../policy/policies/GranularAccessPolicy.js";
import { RateLimitPolicy } from "../policy/policies/RateLimitPolicy.js";
import { ApprovalPolicy } from "../policy/policies/ApprovalPolicy.js";
import { CircuitBreakerPolicy } from "../policy/policies/CircuitBreakerPolicy.js";
import { BudgetPolicy } from "../policy/policies/BudgetPolicy.js";

/** Build the policy chain from a validated config. Throws if any policy (e.g. a regex) is invalid. */
export function buildPolicies(config: AgentBrakeConfig): Policy[] {
    const { limits, security } = config.policies;
    const policies: Policy[] = [];

    // Explicit undefined checks: a limit of 0 is a real (very strict) limit, not "unset".
    if (limits.max_tool_calls !== undefined) {
        policies.push(new MaxToolCallsPolicy(limits.max_tool_calls));
    }
    if (limits.max_runtime_seconds !== undefined) {
        policies.push(new MaxRuntimePolicy(limits.max_runtime_seconds));
    }
    if (limits.rate_limit) {
        policies.push(new RateLimitPolicy(limits.rate_limit.calls_per_window, limits.rate_limit.window_seconds));
    }
    if (security.denied_tools) {
        policies.push(new DeniedToolsPolicy(security.denied_tools));
    }
    if (security.allowed_tools) {
        policies.push(new AllowedToolsPolicy(security.allowed_tools));
    }
    if (security.granular_rules?.length) {
        policies.push(new GranularAccessPolicy(security.granular_rules));
    }
    if (security.require_approval) {
        policies.push(new ApprovalPolicy(security.require_approval));
    }
    if (limits.circuit_breaker) {
        policies.push(new CircuitBreakerPolicy(
            limits.circuit_breaker.failure_threshold,
            limits.circuit_breaker.reset_timeout_seconds
        ));
    }
    if (limits.budget) {
        policies.push(new BudgetPolicy(limits.budget.max_cost));
    }

    return policies;
}

/**
 * Load config and build policies, failing closed: any config error propagates (ConfigError)
 * unless AGENT_BRAKE_ALLOW_INVALID_CONFIG is set, in which case a loud warning is logged and
 * the built-in defaults are used instead.
 */
export function bootstrap(env: NodeJS.ProcessEnv = process.env): { config: AgentBrakeConfig; policies: Policy[] } {
    try {
        const config = ConfigLoader.load();
        return { config, policies: buildPolicies(config) };
    } catch (err) {
        if (!isAllowInvalidConfig(env)) {
            throw err instanceof Error ? err : new ConfigError(String(err));
        }
        Logger.info("WARNING: configuration is invalid but AGENT_BRAKE_ALLOW_INVALID_CONFIG is set; running with built-in defaults, NOT your policies.", {
            error: err instanceof Error ? err.message : String(err)
        });
        const config = defaultConfig();
        return { config, policies: buildPolicies(config) };
    }
}
