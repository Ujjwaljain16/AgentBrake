#!/usr/bin/env node
import { BrakeProxy } from "./interceptor.js";
import { MaxToolCallsPolicy } from "../policy/policies/MaxToolCallsPolicy.js";
import { AllowedToolsPolicy } from "../policy/policies/AllowedToolsPolicy.js";
import { MaxRuntimePolicy } from "../policy/policies/MaxRuntimePolicy.js";
import { GranularAccessPolicy } from "../policy/policies/GranularAccessPolicy.js";
import { RateLimitPolicy } from "../policy/policies/RateLimitPolicy.js";
import { Logger } from "../monitor/logger.js";
import { ConfigLoader } from "../config/loader.js";
import { Policy } from "../policy/types.js";

const args = process.argv.slice(2);
const command = args[0];
const commandArgs = args.slice(1);

if (!command) {
    console.error("Usage: agent-brake <command> [args...]");
    process.exit(1);
}

const config = ConfigLoader.load();
const policies: Policy[] = [];

if (config.policies.limits.max_tool_calls) {
    policies.push(new MaxToolCallsPolicy(config.policies.limits.max_tool_calls));
}

if (config.policies.limits.max_runtime_seconds) {
    policies.push(new MaxRuntimePolicy(config.policies.limits.max_runtime_seconds));
}

if (config.policies.limits.rate_limit) {
    policies.push(new RateLimitPolicy(
        config.policies.limits.rate_limit.calls_per_window,
        config.policies.limits.rate_limit.window_seconds
    ));
}

if (config.policies.security.allowed_tools) {
    policies.push(new AllowedToolsPolicy(config.policies.security.allowed_tools));
}

if (config.policies.security.granular_rules?.length) {
    policies.push(new GranularAccessPolicy(config.policies.security.granular_rules));
}

Logger.info("Starting AgentBrake", {
    version: config.version,
    agent: config.agent.name,
    trust: config.agent.trust_level,
    activePolicies: policies.map(p => p.name),
    target: `${command} ${commandArgs.join(" ")}`
});

const proxy = new BrakeProxy(command, commandArgs, policies);
proxy.start();
