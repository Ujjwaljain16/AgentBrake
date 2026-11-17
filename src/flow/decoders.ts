/**
 * Views of outgoing text after undoing common laundering: base64 / base64url, hex, percent
 * encoding, and reversal. Decoding is applied recursively (e.g. base64 of hex) up to a depth,
 * with a total output budget so a hostile argument cannot make the check expensive.
 */

export interface DecodedView {
    /** How this view was produced, e.g. "plain", "base64", "hex>base64", "reversed". */
    via: string;
    text: string;
}

const BASE64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const HEX_RUN = /(?:[0-9a-fA-F]{2}){8,}/g;

/** Mostly printable text? (Rejects random bytes that happen to decode.) */
function plausibleText(s: string): boolean {
    if (s.length === 0) return false;
    let printable = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13 || c >= 160) printable++;
    }
    return printable / s.length >= 0.85;
}

function decodeBase64(run: string): string | null {
    const clean = run.replace(/=+$/, "");
    if (clean.length % 4 === 1) return null;
    const bytes = Buffer.from(clean.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const text = bytes.toString("utf8");
    return plausibleText(text) ? text : null;
}

function decodeHex(run: string): string | null {
    const text = Buffer.from(run, "hex").toString("utf8");
    return plausibleText(text) ? text : null;
}

/** Decode every run of %XX escapes in the text (linear; invalid UTF-8 runs decode as Latin-1). */
function decodePercent(text: string): string | null {
    if ((text.match(/%[0-9a-fA-F]{2}/g)?.length ?? 0) < 3) return null;
    return text.replace(/(?:%[0-9a-fA-F]{2})+/g, seq => {
        try {
            return decodeURIComponent(seq);
        } catch {
            return Buffer.from(seq.replace(/%/g, ""), "hex").toString("latin1");
        }
    });
}

export interface DecodeLimits {
    maxDepth: number;
    /** Total characters across all decoded views. */
    maxTotalChars: number;
}

export const DEFAULT_DECODE_LIMITS: DecodeLimits = { maxDepth: 2, maxTotalChars: 4 * 1024 * 1024 };

export function decodedViews(text: string, limits: DecodeLimits = DEFAULT_DECODE_LIMITS): DecodedView[] {
    const views: DecodedView[] = [{ via: "plain", text }];
    let budget = limits.maxTotalChars;
    const seen = new Set<string>([text]);

    const add = (via: string, decoded: string | null) => {
        if (decoded === null || decoded.length < 8 || seen.has(decoded) || decoded.length > budget) return false;
        budget -= decoded.length;
        seen.add(decoded);
        views.push({ via, text: decoded });
        return true;
    };

    let frontier: DecodedView[] = [views[0]];
    for (let depth = 0; depth < limits.maxDepth && frontier.length > 0; depth++) {
        const next: DecodedView[] = [];
        for (const view of frontier) {
            const prefix = view.via === "plain" ? "" : `${view.via}>`;
            for (const [name, re, decode] of [
                ["base64", BASE64_RUN, decodeBase64],
                ["hex", HEX_RUN, decodeHex]
            ] as const) {
                for (const match of view.text.match(re) ?? []) {
                    if (add(`${prefix}${name}`, decode(match))) next.push(views[views.length - 1]);
                }
            }
            if (add(`${prefix}percent`, decodePercent(view.text))) next.push(views[views.length - 1]);
        }
        frontier = next;
    }

    // Reversal of every view gathered so far.
    for (const view of [...views]) {
        add(view.via === "plain" ? "reversed" : `${view.via}>reversed`, [...view.text].reverse().join(""));
    }
    return views;
}
