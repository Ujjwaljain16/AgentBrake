import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { AgentBrakeConfigSchema, AgentBrakeConfig } from "./schema.js";
import { Logger } from "../monitor/logger.js";

export class ConfigLoader {
    static load(configPath?: string): AgentBrakeConfig {
        const possiblePaths = configPath
            ? [configPath]
            : [
                process.env.AGENT_BRAKE_CONFIG || "",
                path.join(process.cwd(), "agent-brake.yml"),
                path.join(process.cwd(), "agent-brake.yaml"),
                path.join(process.cwd(), "agent-brake.json")
            ].filter(Boolean);

        for (const filePath of possiblePaths) {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, "utf-8");
                const parsed = filePath.endsWith(".json")
                    ? JSON.parse(content)
                    : yaml.parse(content);

                const validated = AgentBrakeConfigSchema.parse(parsed);
                Logger.info(`Loaded configuration from ${path.basename(filePath)}`, { agent: validated.agent.name });
                return validated;
            }
        }

        // Return defaults if no config found
        Logger.info("No configuration file found, using defaults.");
        return AgentBrakeConfigSchema.parse({});
    }
}
