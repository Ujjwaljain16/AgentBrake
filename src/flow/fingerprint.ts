/**
 * Document fingerprinting by winnowing (Schleimer, Wilkerson & Aiken, SIGMOD 2003; the
 * algorithm behind the MOSS plagiarism detector).
 *
 * 1. Normalise text so cosmetic changes do not matter (case, punctuation, whitespace,
 *    full-width characters).
 * 2. Hash every k-gram of the normalised text with a rolling hash.
 * 3. From every window of w consecutive hashes keep the minimum (rightmost on ties).
 *
 * Guarantee: if two texts share a normalised substring of at least k + w - 1 characters, they
 * share at least one selected fingerprint. Only about 2/(w+1) of the hashes are stored, and
 * no original text is kept.
 *
 * Hashes are 53-bit (two independent 32-bit polynomial rolling hashes), so they fit a JS number
 * exactly and random collisions are negligible at the sizes stored here.
 */

export interface WinnowParams {
    /** k-gram length in normalised characters. */
    k: number;
    /** Window size (number of consecutive k-gram hashes). */
    w: number;
}

export const DEFAULT_WINNOW: WinnowParams = { k: 16, w: 5 };

/** Lower-case ASCII letters and digits only, after NFKC (folds full-width and other look-alikes). */
export function normalize(text: string): string {
    return text.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const B1 = 0x01000193; // FNV prime
const B2 = 0x5bd1e995; // MurmurHash2 multiplier
const LOW21 = 0x1fffff;
const TWO21 = 0x200000;

function powMod32(base: number, exp: number): number {
    let result = 1;
    for (let i = 0; i < exp; i++) result = Math.imul(result, base) >>> 0;
    return result;
}

/** Map [a-z0-9] to 1..36 (never 0, so leading characters still change the hash). */
function code(ch: number): number {
    return ch >= 97 ? ch - 96 : ch - 47 + 26;
}

/** Hash of every k-gram of an already-normalised string, in order. */
export function kgramHashes(norm: string, k: number): number[] {
    const n = norm.length;
    if (n < k) return [];
    const out = new Array<number>(n - k + 1);
    const p1 = powMod32(B1, k - 1);
    const p2 = powMod32(B2, k - 1);
    let h1 = 0;
    let h2 = 0;
    for (let i = 0; i < k; i++) {
        const c = code(norm.charCodeAt(i));
        h1 = (Math.imul(h1, B1) + c) >>> 0;
        h2 = (Math.imul(h2, B2) + c) >>> 0;
    }
    out[0] = h1 * TWO21 + (h2 & LOW21);
    for (let i = k; i < n; i++) {
        const cOut = code(norm.charCodeAt(i - k));
        const cIn = code(norm.charCodeAt(i));
        h1 = (Math.imul((h1 - Math.imul(cOut, p1)) | 0, B1) + cIn) >>> 0;
        h2 = (Math.imul((h2 - Math.imul(cOut, p2)) | 0, B2) + cIn) >>> 0;
        out[i - k + 1] = h1 * TWO21 + (h2 & LOW21);
    }
    return out;
}

/**
 * Robust winnowing: the minimum of each window (rightmost on ties); a position is emitted once
 * even when it stays the minimum across several windows. Texts shorter than one window still
 * produce their single minimum.
 */
export function winnow(hashes: number[], w: number): number[] {
    if (hashes.length === 0) return [];
    if (hashes.length <= w) {
        let min = 0;
        for (let i = 1; i < hashes.length; i++) if (hashes[i] <= hashes[min]) min = i;
        return [hashes[min]];
    }
    const out: number[] = [];
    let minPos = -1;
    for (let start = 0; start + w <= hashes.length; start++) {
        const end = start + w - 1;
        if (minPos < start) {
            // Previous minimum left the window: rescan it.
            minPos = start;
            for (let i = start + 1; i <= end; i++) if (hashes[i] <= hashes[minPos]) minPos = i;
            out.push(hashes[minPos]);
        } else if (hashes[end] <= hashes[minPos]) {
            minPos = end;
            out.push(hashes[minPos]);
        }
    }
    return out;
}

/** Winnowed fingerprints of raw text. */
export function fingerprints(text: string, params: WinnowParams = DEFAULT_WINNOW): number[] {
    return winnow(kgramHashes(normalize(text), params.k), params.w);
}
