/**
 * Detectors for well-known credential formats in tool results. Anything found is treated as
 * secret data even when the tool that returned it is not configured as a source.
 */

export interface SecretFinding {
    kind: string;
    value: string;
}

const DETECTORS: Array<{ kind: string; re: RegExp; group?: number }> = [
    { kind: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{16,}?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
    { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
    { kind: "aws-secret-access-key", re: /aws_secret_access_key\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})\b/gi, group: 1 },
    { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
    { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
    { kind: "api-key-sk", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
    { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { kind: "stripe-key", re: /\b[rs]k_live_[0-9a-zA-Z]{20,}\b/g },
    { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
    {
        kind: "env-assignment",
        re: /^[ \t]*(?:export[ \t]+)?[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]*[ \t]*[=:][ \t]*["']?([^\s"'#]{8,})/gim,
        group: 1
    }
];

/** At most this many findings per text (bounded work and memory). */
const MAX_FINDINGS = 256;

export function findSecrets(text: string): SecretFinding[] {
    const out: SecretFinding[] = [];
    for (const { kind, re, group } of DETECTORS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const value = group ? m[group] : m[0];
            if (value) out.push({ kind, value });
            if (out.length >= MAX_FINDINGS) return out;
            if (m[0].length === 0) re.lastIndex++;
        }
    }
    return out;
}
