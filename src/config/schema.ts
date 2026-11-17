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
    /** Defaults to policies.global.on_violation (itself "block" by default). */
    action: ViolationActionSchema.optional()
}).refine(rule => rule.allow_if !== undefined || rule.deny_if !== undefined, {
    message: "A granular rule needs at least one of allow_if or deny_if"
});

export type GranularRule = z.infer<typeof GranularRuleSchema>;

/** One tool name or a list of them. */
const ToolSelectorSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/** A path argument checked by directory boundaries after canonicalisation (no regexes). */
export const PathRuleSchema = z.strictObject({
    type: z.literal("path"),
    tool: ToolSelectorSchema,
    argument: z.string().min(1),
    /** If set, the path must be inside one of these directories. */
    within: z.array(z.string().min(1)).min(1).optional(),
    /** The path must not be inside any of these directories (or be one of these files). */
    not_within: z.array(z.string().min(1)).min(1).optional(),
    /** Directory relative paths are resolved against (default: AgentBrake's working directory). */
    base_dir: z.string().optional(),
    case_insensitive: z.boolean().optional(),
    /** Resolve symlinks with realpath before comparing (catches links out of an allowed dir). */
    resolve_symlinks: z.boolean().default(false),
    action: ViolationActionSchema.optional()
}).refine(r => r.within !== undefined || r.not_within !== undefined, {
    message: "A path rule needs at least one of within or not_within"
});

/** A URL argument checked after WHATWG parsing. */
export const UrlRuleSchema = z.strictObject({
    type: z.literal("url"),
    tool: ToolSelectorSchema,
    argument: z.string().min(1),
    allowed_schemes: z.array(z.string().min(1)).min(1).optional(),
    /** Exact hosts or "*.example.com" (subdomains). If set, other hosts are refused. */
    allowed_hosts: z.array(z.string().min(1)).min(1).optional(),
    denied_hosts: z.array(z.string().min(1)).min(1).optional(),
    /** Refuse loopback, private, link-local (cloud metadata) and similar targets. */
    block_private_networks: z.boolean().default(true),
    /** Also resolve the host name and refuse it if any address is private. */
    resolve_dns: z.boolean().default(false),
    /** Refuse URLs carrying user:password@ credentials. */
    deny_credentials: z.boolean().default(true),
    action: ViolationActionSchema.optional()
});

export const ArgumentRuleSchema = z.discriminatedUnion("type", [PathRuleSchema, UrlRuleSchema]);
export type PathRule = z.infer<typeof PathRuleSchema>;
export type UrlRule = z.infer<typeof UrlRuleSchema>;
export type ArgumentRule = z.infer<typeof ArgumentRuleSchema>;

export const FlowLabelSchema = z.enum(["secret", "pii", "internal", "untrusted"]);

/** A tool whose results carry a label. */
export const FlowSourceSchema = z.strictObject({
    tool: ToolSelectorSchema,
    label: FlowLabelSchema,
    /** Only calls whose path argument resolves inside these directories are sources. */
    paths: z.strictObject({
        argument: z.string().min(1),
        within: z.array(z.string().min(1)).min(1),
        base_dir: z.string().optional(),
        case_insensitive: z.boolean().optional()
    }).optional()
});

/** Secret-flow tracking across tool calls. */
export const FlowSchema = z.strictObject({
    sources: z.array(FlowSourceSchema).default([]),
    /** Tools whose arguments are checked for protected data. "*" (default) means every tool. */
    sinks: z.union([z.literal("*"), z.array(z.string().min(1)).min(1)]).default("*"),
    /** Tools never checked as sinks (e.g. a tool that only writes to a private scratch area). */
    exempt_sinks: z.array(z.string().min(1)).default([]),
    /** Treat well-known credential formats in ANY tool result as secret. */
    detect_secrets: z.boolean().default(true),
    /** Action when a sink call carries protected data. */
    on_leak: ViolationActionSchema.default("block"),
    /**
     * Action for sink calls once the session has both read protected data and taken in untrusted
     * content (the "lethal trifecta"), even if no protected data is visible in the call. "allow"
     * turns the check off.
     */
    lethal_trifecta: z.union([ViolationActionSchema, z.literal("allow")]).default("warn"),
    /** k-gram length for fingerprints (normalised characters). */
    kgram: z.number().int().min(8).max(64).default(16),
    /** Winnowing window. Shared runs of kgram + window - 1 characters are always detected. */
    window: z.number().int().min(1).max(64).default(5),
    max_fingerprints: z.number().int().positive().default(500_000),
    /** Characters of one result fingerprinted; a longer protected result taints all sinks (fail closed). */
    max_source_chars: z.number().int().positive().default(8 * 1024 * 1024),
    /** Sink calls whose arguments are longer than this are refused (fail closed). */
    max_sink_chars: z.number().int().positive().default(1024 * 1024)
});

export type FlowConfig = z.infer<typeof FlowSchema>;
export type FlowSource = z.infer<typeof FlowSourceSchema>;

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
            /** Fraction of max_cost at which a warning is logged (0 < x <= 1). */
            warn_threshold: z.number().gt(0).max(1).default(0.8),
            /** Estimated cost of one forwarded call, unless tool_costs names the tool. */
            cost_per_call: z.number().min(0).default(0.01),
            tool_costs: z.record(z.string(), z.number().min(0)).optional()
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
        granular_rules: z.array(GranularRuleSchema).optional(),
        argument_rules: z.array(ArgumentRuleSchema).optional()
    }).optional().default({}),

    flow: FlowSchema.optional()
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
