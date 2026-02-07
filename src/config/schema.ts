import { z } from "zod";

// Enums
export const TrustLevelSchema = z.enum(["sandbox", "limited", "trusted", "privileged"]);
export const ViolationActionSchema = z.enum(["warn", "block", "kill", "sandbox"]);

export type TrustLevel = z.infer<typeof TrustLevelSchema>;
export type ViolationAction = z.infer<typeof ViolationActionSchema>;

// Policy Configs
export const PoliciesSchema = z.object({
    global: z.object({
        on_violation: ViolationActionSchema.default("block"),
        max_retries: z.number().default(3),
    }),

    limits: z.object({
        max_tool_calls: z.number().optional(),
        max_runtime_seconds: z.number().optional(),
        max_cost_usd: z.number().optional() // Projected for V2
    }),

    security: z.object({
        allowed_tools: z.array(z.string()).optional(),
        denied_tools: z.array(z.string()).optional(),
    })
});

export type PoliciesConfig = z.infer<typeof PoliciesSchema>;

// Root Config
export const AgentBrakeConfigSchema = z.object({
    version: z.string().default("2.0"),
    agent: z.object({
        name: z.string().default("unknown-agent"),
        trust_level: TrustLevelSchema.default("sandbox")
    }),
    policies: PoliciesSchema
});

export type AgentBrakeConfig = z.infer<typeof AgentBrakeConfigSchema>;
