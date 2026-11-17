/**
 * Library entry point. `require("agentbrake")` / `import ... from "agentbrake"` gives the proxy,
 * the policies and the flow-tracking primitives without starting the CLI (which lives in
 * ./proxy/index.ts and is exposed as the `agent-brake` binary).
 */

export { BrakeProxy, BrakeProxyOptions, childEnvironment, DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_RESPONSE_BYTES } from "./proxy/interceptor.js";
export { buildPolicies, bootstrap, BuildOptions } from "./proxy/build.js";
export { LineFramer, FrameEvent } from "./proxy/framing.js";

export { ConfigLoader, ConfigError, defaultConfig, ignoredSettings } from "./config/loader.js";
export * from "./config/schema.js";

export {
    Policy, PolicyResult, PolicyViolation, AgentRuntimeState, ToolOutcome, TraceEntry,
    toolCallRequest, canonicalJson
} from "./policy/types.js";
export { MaxToolCallsPolicy } from "./policy/policies/MaxToolCallsPolicy.js";
export { MaxRuntimePolicy } from "./policy/policies/MaxRuntimePolicy.js";
export { RateLimitPolicy } from "./policy/policies/RateLimitPolicy.js";
export { AllowedToolsPolicy } from "./policy/policies/AllowedToolsPolicy.js";
export { DeniedToolsPolicy } from "./policy/policies/DeniedToolsPolicy.js";
export { GranularAccessPolicy } from "./policy/policies/GranularAccessPolicy.js";
export { ArgumentRulesPolicy, ArgumentRulesOptions } from "./policy/policies/ArgumentRulesPolicy.js";
export { FlowPolicy, FlowPolicyOptions } from "./policy/policies/FlowPolicy.js";
export { ApprovalPolicy } from "./policy/policies/ApprovalPolicy.js";
export { CircuitBreakerPolicy } from "./policy/policies/CircuitBreakerPolicy.js";
export { BudgetPolicy, ToolCost } from "./policy/policies/BudgetPolicy.js";

export { canonicalizePath, isWithin, PathOptions, Platform, CanonicalPath } from "./policy/semantic/paths.js";
export { canonicalizeUrl, hostMatches, isPrivateHost, resolvesToPrivate, Lookup, CanonicalUrl } from "./policy/semantic/urls.js";

export { TaintStore, TaintStoreOptions, SourceRecord, LeakMatch, FlowLabel, resultText, argumentText } from "./flow/taint.js";
export { normalize, kgramHashes, winnow, fingerprints, WinnowParams, DEFAULT_WINNOW } from "./flow/fingerprint.js";
export { decodedViews, DecodedView, DecodeLimits } from "./flow/decoders.js";
export { findSecrets, SecretFinding } from "./flow/secrets.js";

export { Logger, redact } from "./monitor/logger.js";
