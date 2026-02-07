export class Logger {
    static logEvent(event: string, details: Record<string, any>) {
        console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            event,
            ...details
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
