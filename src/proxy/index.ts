#!/usr/bin/env node
import { BrakeProxy } from "./interceptor.js";
import { MaxToolCallsPolicy } from "../policy/policies/MaxToolCallsPolicy.js";
import { AllowedToolsPolicy } from "../policy/policies/AllowedToolsPolicy.js";
import { MaxRuntimePolicy } from "../policy/policies/MaxRuntimePolicy.js";
import { Logger } from "../monitor/logger.js";
import { ConfigLoader } from "../config/loader.js";

// Parse arguments
const args = process.argv.slice(2);
const command = args[0];
const commandArgs = args.slice(1);

if (!command) {
    console.error("Usage: agent-brake <command> [args...]");
    process.exit(1);
}

// Load V2 Config
const config = ConfigLoader.load();

// Instantiate Policies based on Config
const policies: any[] = [];

if (config.policies.limits.max_tool_calls) {
    policies.push(new MaxToolCallsPolicy(config.policies.limits.max_tool_calls));
}

if (config.policies.limits.max_runtime_seconds) {
    policies.push(new MaxRuntimePolicy(config.policies.limits.max_runtime_seconds));
}

if (config.policies.security.allowed_tools) {
    policies.push(new AllowedToolsPolicy(config.policies.security.allowed_tools));
}

// Log startup V2
Logger.info("Starting AgentBrake V2", {
    agent: config.agent.name,
    trust: config.agent.trust_level,
    activePolicies: policies.map(p => p.name),
    target: `${command} ${commandArgs.join(" ")}`
});

const proxy = new BrakeProxy(
    command,
    commandArgs,
    policies
);

proxy.start();
