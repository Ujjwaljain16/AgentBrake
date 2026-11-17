import { DEFAULT_WINNOW, WinnowParams, kgramHashes, normalize, winnow } from "./fingerprint.js";
import { decodedViews, DecodeLimits, DEFAULT_DECODE_LIMITS } from "./decoders.js";

export type FlowLabel = "secret" | "pii" | "internal";

/** Where a piece of protected data came from. */
export interface SourceRecord {
    id: number;
    tool: string;
    label: FlowLabel;
    /** What made it protected: a configured source, or a detector such as "aws-access-key-id". */
    origin: string;
    at: string;
}

export interface LeakMatch {
    source: SourceRecord;
    /** Decoding that exposed the match, e.g. "plain", "base64", "hex>reversed". */
    via: string;
    /** Number of fingerprints (or 1 for a literal) that matched. */
    hits: number;
    /** "fingerprint" for winnowed content, "literal" for a detected credential. */
    kind: "fingerprint" | "literal";
}

export interface TaintStoreOptions extends WinnowParams {
    /** Total fingerprints kept; the oldest sources are evicted beyond this. */
    maxFingerprints: number;
    /** Normalised literals shorter than this are ignored (too likely to collide). */
    minLiteralChars: number;
    maxLiterals: number;
    decode: DecodeLimits;
}

export const DEFAULT_TAINT_OPTIONS: TaintStoreOptions = {
    ...DEFAULT_WINNOW,
    maxFingerprints: 500_000,
    minLiteralChars: 8,
    maxLiterals: 10_000,
    decode: DEFAULT_DECODE_LIMITS
};

interface StoredSource {
    record: SourceRecord;
    hashes: number[];
    literals: string[];
}

/**
 * Remembers protected data only as fingerprints (never the text itself) and answers whether an
 * outgoing text contains any of it, including after base64 / hex / percent decoding or reversal.
 */
export class TaintStore {
    private index = new Map<number, number>();     // fingerprint -> source id
    /** Short credentials (too short for the fingerprint guarantee), bucketed by length. */
    private literals = new Map<number, Map<string, number>>();
    private literalCount = 0;
    private sources = new Map<number, StoredSource>();
    private nextId = 1;
    private fingerprintCount = 0;
    private evicted = 0;
    readonly options: TaintStoreOptions;

    constructor(options: Partial<TaintStoreOptions> = {}) {
        this.options = { ...DEFAULT_TAINT_OPTIONS, ...options };
        if (this.options.k < 4 || this.options.w < 1) throw new Error("fingerprint k must be >= 4 and w >= 1");
    }

    /** Register a new source; returns its record. */
    addSource(tool: string, label: FlowLabel, origin: string): SourceRecord {
        const record: SourceRecord = { id: this.nextId++, tool, label, origin, at: new Date().toISOString() };
        this.sources.set(record.id, { record, hashes: [], literals: [] });
        return record;
    }

    /** Fingerprint text as belonging to a source. Returns the number of fingerprints added. */
    addText(source: SourceRecord, text: string): number {
        const stored = this.sources.get(source.id);
        if (!stored) return 0;
        const fps = winnow(kgramHashes(normalize(text), this.options.k), this.options.w);
        let added = 0;
        for (const fp of fps) {
            if (!this.index.has(fp)) {
                this.index.set(fp, source.id);
                stored.hashes.push(fp);
                added++;
            }
        }
        this.fingerprintCount += added;
        this.evictIfNeeded();
        return added;
    }

    /**
     * Remember an exact credential. Values long enough for the winnowing guarantee
     * (k + w - 1 normalised characters) are fingerprinted, which also catches fragments;
     * shorter ones are kept as exact literals.
     */
    addLiteral(source: SourceRecord, value: string): boolean {
        const stored = this.sources.get(source.id);
        const norm = normalize(value);
        if (!stored || norm.length < this.options.minLiteralChars) return false;
        if (norm.length >= this.options.k + this.options.w - 1) return this.addText(source, value) > 0;

        let bucket = this.literals.get(norm.length);
        if (!bucket) this.literals.set(norm.length, (bucket = new Map()));
        if (bucket.has(norm)) return false;
        if (this.literalCount >= this.options.maxLiterals) return false;
        bucket.set(norm, source.id);
        stored.literals.push(norm);
        this.literalCount++;
        return true;
    }

    /** The best match of protected data in text, or null. */
    check(text: string): LeakMatch | null {
        let best: LeakMatch | null = null;
        for (const view of decodedViews(text, this.options.decode)) {
            const norm = normalize(view.text);

            for (const [length, bucket] of this.literals) {
                for (let i = 0; i + length <= norm.length; i++) {
                    const id = bucket.get(norm.slice(i, i + length));
                    const source = id === undefined ? undefined : this.sources.get(id);
                    if (source) return { source: source.record, via: view.via, hits: 1, kind: "literal" };
                }
            }

            const hitsBySource = new Map<number, number>();
            for (const h of kgramHashes(norm, this.options.k)) {
                const id = this.index.get(h);
                if (id !== undefined) hitsBySource.set(id, (hitsBySource.get(id) ?? 0) + 1);
            }
            for (const [id, hits] of hitsBySource) {
                const source = this.sources.get(id);
                if (source && (!best || hits > best.hits)) {
                    best = { source: source.record, via: view.via, hits, kind: "fingerprint" };
                }
            }
        }
        return best;
    }

    stats(): { sources: number; fingerprints: number; literals: number; evictedSources: number } {
        return { sources: this.sources.size, fingerprints: this.fingerprintCount, literals: this.literalCount, evictedSources: this.evicted };
    }

    /** Drop whole sources, oldest first, until under the fingerprint cap. */
    private evictIfNeeded(): void {
        while (this.fingerprintCount > this.options.maxFingerprints && this.sources.size > 1) {
            const oldestId = this.sources.keys().next().value as number;
            const oldest = this.sources.get(oldestId)!;
            for (const h of oldest.hashes) {
                if (this.index.get(h) === oldestId) this.index.delete(h);
            }
            for (const lit of oldest.literals) {
                const bucket = this.literals.get(lit.length);
                if (bucket?.get(lit) === oldestId) {
                    bucket.delete(lit);
                    this.literalCount--;
                }
            }
            this.fingerprintCount -= oldest.hashes.length;
            this.sources.delete(oldestId);
            this.evicted++;
        }
    }
}

/** All human-readable text in an MCP tool result (text content, embedded resources, structured content). */
export function resultText(result: unknown, maxChars: number): { text: string; truncated: boolean } {
    const parts: string[] = [];
    let total = 0;
    let truncated = false;
    const push = (s: string) => {
        if (truncated) return;
        if (total + s.length > maxChars) {
            parts.push(s.slice(0, Math.max(0, maxChars - total)));
            truncated = true;
            total = maxChars;
            return;
        }
        parts.push(s);
        total += s.length;
    };

    const visit = (value: unknown, depth: number) => {
        if (truncated || depth > 32) return;
        if (typeof value === "string") push(value);
        else if (Array.isArray(value)) value.forEach(v => visit(v, depth + 1));
        else if (value !== null && typeof value === "object") {
            for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
                // Binary payloads (images, audio, blobs) are not text a model can copy verbatim.
                if (key === "data" || key === "blob") continue;
                visit(v, depth + 1);
            }
        }
    };
    visit(result, 0);
    return { text: parts.join("\n"), truncated };
}

/** All string leaves of tool arguments, keys included, joined by newlines. */
export function argumentText(args: Record<string, unknown>): string {
    const parts: string[] = [];
    const visit = (value: unknown, depth: number) => {
        if (depth > 32) return;
        if (typeof value === "string") parts.push(value);
        else if (typeof value === "number" || typeof value === "boolean") parts.push(String(value));
        else if (Array.isArray(value)) value.forEach(v => visit(v, depth + 1));
        else if (value !== null && typeof value === "object") {
            for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
                parts.push(key);
                visit(v, depth + 1);
            }
        }
    };
    visit(args, 0);
    return parts.join("\n");
}
