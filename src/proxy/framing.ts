/**
 * Newline-delimited framing for JSON-RPC over stdio.
 *
 * Splits on the raw 0x0A byte (never on decoded text) so that multi-byte UTF-8
 * sequences split across chunks are reassembled before decoding. A complete line
 * is only ever emitted once its terminating newline has been seen (or at end of
 * stream via end()).
 */

export type FrameEvent =
    | { type: "line"; line: string }
    | { type: "invalid"; reason: "too_long" | "invalid_utf8" };

const NEWLINE = 0x0a;

export class LineFramer {
    private pending: Buffer[] = [];
    private pendingLength = 0;
    private discarding = false;

    constructor(private readonly maxLineBytes: number) {
        if (!Number.isFinite(maxLineBytes) || maxLineBytes <= 0) {
            throw new Error("maxLineBytes must be a positive number");
        }
    }

    /** Feed a chunk; returns every event completed by it, in order. */
    push(chunk: Buffer | string): FrameEvent[] {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf-8");
        const events: FrameEvent[] = [];
        let offset = 0;

        while (offset < data.length) {
            const idx = data.indexOf(NEWLINE, offset);

            if (idx === -1) {
                this.append(data.subarray(offset), events);
                break;
            }

            const segment = data.subarray(offset, idx);
            offset = idx + 1;

            if (this.discarding) {
                // The oversized line finally ended; it was already reported.
                this.discarding = false;
                continue;
            }

            if (this.pendingLength + segment.length > this.maxLineBytes) {
                events.push({ type: "invalid", reason: "too_long" });
                this.reset();
                continue;
            }

            const raw = this.pending.length > 0
                ? Buffer.concat([...this.pending, segment])
                : segment;
            this.reset();
            events.push(this.decode(raw));
        }

        return events;
    }

    /** Flush a trailing line that had no terminating newline. */
    end(): FrameEvent[] {
        const events: FrameEvent[] = [];
        if (this.discarding) {
            this.discarding = false;
            this.reset();
            return events;
        }
        if (this.pendingLength > 0) {
            const raw = Buffer.concat(this.pending);
            this.reset();
            events.push(this.decode(raw));
        }
        return events;
    }

    private append(rest: Buffer, events: FrameEvent[]): void {
        if (this.discarding) return;

        if (this.pendingLength + rest.length > this.maxLineBytes) {
            events.push({ type: "invalid", reason: "too_long" });
            this.discarding = true;
            this.reset();
            return;
        }

        this.pending.push(Buffer.from(rest));
        this.pendingLength += rest.length;
    }

    private reset(): void {
        this.pending = [];
        this.pendingLength = 0;
    }

    private decode(raw: Buffer): FrameEvent {
        let end = raw.length;
        if (end > 0 && raw[end - 1] === 0x0d) end--; // CRLF

        try {
            const line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
                .decode(raw.subarray(0, end));
            return { type: "line", line };
        } catch {
            return { type: "invalid", reason: "invalid_utf8" };
        }
    }
}
