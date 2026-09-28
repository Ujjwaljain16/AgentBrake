import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { AgentBrakeConfigSchema, AgentBrakeConfig } from "./schema.js";
import { Logger } from "../monitor/logger.js";

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

export const ALLOW_INVALID_CONFIG_ENV = "AGENT_BRAKE_ALLOW_INVALID_CONFIG";

export function isAllowInvalidConfig(env: NodeJS.ProcessEnv = process.env): boolean {
    const value = (env[ALLOW_INVALID_CONFIG_ENV] || "").trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes";
}

/** Built-in defaults used when no config file exists (or, only with explicit opt-in, when one is invalid). */
export function defaultConfig(): AgentBrakeConfig {
    return {
        version: "3.0",
        agent: {
            name: "safe-fallback-agent",
            trust_level: "sandbox"
        },
        policies: {
            global: {
                on_violation: "block",
                max_retries: 3
            },
            limits: {},
            security: {}
        }
    };
}

export class ConfigLoader {
    /**
     * Load and validate the configuration.
     *
     * Fail-closed: an explicitly requested file (argument or AGENT_BRAKE_CONFIG) that is
     * missing, and any discovered file that cannot be parsed or validated, throws ConfigError.
     * The proxy must not start with a broken policy file. The only way to fall back to the
     * built-in defaults is AGENT_BRAKE_ALLOW_INVALID_CONFIG=1 (see bootstrap).
     * If no file is found at all in the default locations, built-in defaults are returned.
     */
    static load(configPath?: string): AgentBrakeConfig {
        const explicit = configPath || process.env.AGENT_BRAKE_CONFIG || "";

        if (explicit) {
            if (!fs.existsSync(explicit)) {
                throw new ConfigError(`Config file not found: ${explicit}`);
            }
            return ConfigLoader.readFile(explicit);
        }

        const candidates = [
            path.join(process.cwd(), "agent-brake.yml"),
            path.join(process.cwd(), "agent-brake.yaml"),
            path.join(process.cwd(), "agent-brake.json")
        ];

        for (const filePath of candidates) {
            if (fs.existsSync(filePath)) {
                return ConfigLoader.readFile(filePath);
            }
        }

        Logger.info("No configuration file found; using built-in defaults (no allow-list, tool call cap only).");
        return defaultConfig();
    }

    private static readFile(filePath: string): AgentBrakeConfig {
        let parsed: unknown;
        try {
            const content = fs.readFileSync(filePath, "utf-8");
            parsed = filePath.endsWith(".json") ? JSON.parse(content) : yaml.parse(content);
        } catch (err) {
            throw new ConfigError(`Failed to read/parse config ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
        }

        const result = AgentBrakeConfigSchema.safeParse(parsed);
        if (!result.success) {
            const details = result.error.issues
                .map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
                .join("; ");
            throw new ConfigError(`Invalid config ${filePath}: ${details}`);
        }

        Logger.info(`Loaded configuration from ${path.basename(filePath)}`, { agent: result.data.agent.name });
        return result.data;
    }
}
