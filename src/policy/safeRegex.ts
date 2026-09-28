/**
 * Guard rails for operator-supplied regular expressions.
 *
 * This is a best-effort defence against catastrophic backtracking (ReDoS), not a
 * proof of safety: it bounds pattern length, rejects the classic nested-quantifier
 * shapes such as (a+)+ or (.*)*, and callers bound the length of the input they test.
 */

export const MAX_PATTERN_LENGTH = 512;

// A group whose body contains a quantifier and which is itself quantified: (a+)+ (.*)* (a|b*){2,}
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/;

export function compileSafeRegex(pattern: string): RegExp {
    if (typeof pattern !== "string") {
        throw new Error("Regex pattern must be a string");
    }
    if (pattern.length > MAX_PATTERN_LENGTH) {
        throw new Error(`Regex pattern too long (${pattern.length} > ${MAX_PATTERN_LENGTH} characters)`);
    }
    if (NESTED_QUANTIFIER.test(pattern)) {
        throw new Error(`Regex pattern rejected as potentially catastrophic (nested quantifiers): ${pattern}`);
    }
    try {
        return new RegExp(pattern);
    } catch (err) {
        throw new Error(`Invalid regex pattern '${pattern}': ${err instanceof Error ? err.message : String(err)}`);
    }
}
