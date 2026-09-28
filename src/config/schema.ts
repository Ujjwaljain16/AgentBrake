import { z } from "zod";

export const TrustLevelSchema = z.enum(["sandbox", "limited", "trusted", "privileged"]);
export const ViolationActionSchema = z.enum(["warn", "block", "kill", "sandbox", "request_approval"]);

export type TrustLevel = z.infer<typeof TrustLevelSchema>;
export type ViolationAction = z.infer<typeof ViolationActionSchema>;

export const ArgumentMatcherSchema = z.record(z.string(), z.string());

// Unknown keys are rejected everywhere (z.strictObject) so a typo such as "allowed_tool"
// fails loudly instead of silently disabling a policy.
export const GranularRuleSchema = z.strictObject({
    tool: z.string(),
    allow_if: z.strictObject({
        arguments: ArgumentMatcherSchema
    }).optional(),
    deny_if: z.strictObject({
        arguments: ArgumentMatcherSchema
    }).optional(),
    action: ViolationActionSchema.default("block")
}).refine(rule => rule.allow_if !== undefined || rule.deny_if !== undefined, {
    message: "A granular rule needs at least one of allow_if or deny_if"
});

export type GranularRule = z.infer<typeof GranularRuleSchema>;

export const PoliciesSchema = z.strictObject({
    global: z.strictObject({
        on_violation: ViolationActionSchema.default("block"),
        max_retries: z.number().default(3),
    }).optional().default({ on_violation: "block", max_retries: 3 }),

    limits: z.strictObject({
        max_tool_calls: z.number().int().min(0).optional(),
        max_runtime_seconds: z.number().positive().optional(),

        rate_limit: z.strictObject({
            calls_per_window: z.number().int().positive(),
            window_seconds: z.number().positive().default(60)
        }).optional(),

        budget: z.strictObject({
            max_cost: z.number().positive(),
            currency: z.string().default("USD"),
            warn_threshold: z.number().default(0.8)
        }).optional(),

        circuit_breaker: z.strictObject({
            failure_threshold: z.number().int().positive().default(5),
            reset_timeout_seconds: z.number().positive().default(60)
        }).optional()
    }).optional().default({}),

    security: z.strictObject({
        allowed_tools: z.array(z.string()).optional(),
        denied_tools: z.array(z.string()).optional(),
        require_approval: z.array(z.string()).optional(),
        granular_rules: z.array(GranularRuleSchema).optional()
    }).optional().default({})
});

export type PoliciesConfig = z.infer<typeof PoliciesSchema>;

export const AgentBrakeConfigSchema = z.strictObject({
    version: z.string().default("3.0"),
    agent: z.strictObject({
        name: z.string().default("unknown-agent"),
        trust_level: TrustLevelSchema.default("sandbox")
    }).optional().default({ name: "unknown-agent", trust_level: "sandbox" }),
    policies: PoliciesSchema.optional().default({
        global: { on_violation: "block", max_retries: 3 },
        limits: {},
        security: {}
    })
});

export type AgentBrakeConfig = z.infer<typeof AgentBrakeConfigSchema>;
