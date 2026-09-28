#!/usr/bin/env node
import * as path from "path";
import { BrakeProxy, DEFAULT_MAX_MESSAGE_BYTES } from "./interceptor.js";
import { bootstrap } from "./build.js";
import { Logger } from "../monitor/logger.js";

const args = process.argv.slice(2);
const command = args[0];
const commandArgs = args.slice(1);

if (!command) {
    console.error("Usage: agent-brake <command> [args...]");
    console.error("Config: AGENT_BRAKE_CONFIG or ./agent-brake.yml|yaml|json. An invalid config refuses to start");
    console.error("        (set AGENT_BRAKE_ALLOW_INVALID_CONFIG=1 to run with built-in defaults instead).");
    process.exit(1);
}

let config;
let policies;
try {
    ({ config, policies } = bootstrap());
} catch (err) {
    console.error(`[AgentBrake] Refusing to start: ${err instanceof Error ? err.message : String(err)}`);
    console.error("[AgentBrake] Fix the configuration (or set AGENT_BRAKE_ALLOW_INVALID_CONFIG=1 to run with built-in defaults).");
    process.exit(2);
}

const envMax = Number(process.env.AGENT_BRAKE_MAX_MESSAGE_BYTES);
const maxMessageBytes = Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_MESSAGE_BYTES;

// Command arguments may contain secrets (tokens, keys), so only the executable name and the
// argument count are logged.
Logger.info("Starting AgentBrake", {
    version: config.version,
    agent: config.agent.name,
    trust: config.agent.trust_level,
    activePolicies: policies.map(p => p.name),
    target: path.basename(command),
    targetArgCount: commandArgs.length
});

const proxy = new BrakeProxy(command, commandArgs, policies, { maxMessageBytes });
proxy.start();
