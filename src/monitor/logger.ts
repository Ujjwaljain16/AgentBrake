const SENSITIVE_KEY = /pass(word|wd)?|secret|token|api[-_]?key|auth|cred|cookie|private[-_]?key|bearer|session/i;
const MAX_DEPTH = 6;
const MAX_STRING = 500;

/**
 * Redact values of sensitive-looking keys and truncate long strings before logging.
 * Tool call arguments are never logged by the proxy; this is a second line of defence.
 */
export function redact(value: unknown, depth = 0): unknown {
    if (typeof value === "string") {
        return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[truncated ${value.length - MAX_STRING} chars]` : value;
    }
    if (value === null || typeof value !== "object") return value;
    if (depth >= MAX_DEPTH) return "[depth limit]";
    if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(val, depth + 1);
    }
    return out;
}

export class Logger {
    static logEvent(event: string, details: Record<string, any>) {
        console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            event,
            ...(redact(details) as Record<string, unknown>)
        }));
    }

    static violation(policyName: string, reason: string, context: Record<string, any> = {}) {
        Logger.logEvent("POLICY_VIOLATION", {
            policy: policyName,
            reason,
            action: "BLOCKED",
            ...context
        });
    }

    static info(message: string, context: Record<string, any> = {}) {
        Logger.logEvent("INFO", {
            message,
            ...context
        });
    }
}
