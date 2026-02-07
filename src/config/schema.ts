import { z } from "zod";

export const TrustLevelSchema = z.enum(["sandbox", "limited", "trusted", "privileged"]);
export const ViolationActionSchema = z.enum(["warn", "block", "kill", "sandbox", "request_approval"]);

export type TrustLevel = z.infer<typeof TrustLevelSchema>;
export type ViolationAction = z.infer<typeof ViolationActionSchema>;

export const ArgumentMatcherSchema = z.record(z.string(), z.string());

export const GranularRuleSchema = z.object({
    tool: z.string(),
    allow_if: z.object({
        arguments: ArgumentMatcherSchema
    }).optional(),
    deny_if: z.object({
        arguments: ArgumentMatcherSchema
    }).optional(),
    action: ViolationActionSchema.default("block")
});

export type GranularRule = z.infer<typeof GranularRuleSchema>;

export const PoliciesSchema = z.object({
    global: z.object({
        on_violation: ViolationActionSchema.default("block"),
        max_retries: z.number().default(3),
    }),

    limits: z.object({
        max_tool_calls: z.number().optional(),
        max_runtime_seconds: z.number().optional(),
        max_cost_usd: z.number().optional(),
        rate_limit: z.object({
            calls_per_window: z.number(),
            window_seconds: z.number().default(60)
        }).optional()
    }),

    security: z.object({
        allowed_tools: z.array(z.string()).optional(),
        denied_tools: z.array(z.string()).optional(),
        granular_rules: z.array(GranularRuleSchema).optional()
    })
});

export type PoliciesConfig = z.infer<typeof PoliciesSchema>;

export const AgentBrakeConfigSchema = z.object({
    version: z.string().default("3.0"),
    agent: z.object({
        name: z.string().default("unknown-agent"),
        trust_level: TrustLevelSchema.default("sandbox")
    }),
    policies: PoliciesSchema
});

export type AgentBrakeConfig = z.infer<typeof AgentBrakeConfigSchema>;
