import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

/**
 * Path canonicalisation for policy checks.
 *
 * Regexes on raw strings are bypassable: "/tmp/../etc/passwd" matches "^/tmp/". Here a path is
 * first turned into one absolute, normalised form, the way the target server will see it, and
 * only then compared with directory boundaries (never with string prefixes).
 */

export type Platform = "posix" | "win32";

export interface PathOptions {
    platform?: Platform;
    /** Directory relative paths are resolved against (the wrapped server's working directory). */
    baseDir?: string;
    /** Compare case-insensitively (default: true on win32, false on posix). */
    caseInsensitive?: boolean;
    /** Resolve symlinks of the longest existing prefix with realpath (default false). */
    resolveSymlinks?: boolean;
    homeDir?: string;
}

export type CanonicalPath = { ok: true; path: string } | { ok: false; reason: string };

export function canonicalizePath(input: string, options: PathOptions = {}): CanonicalPath {
    const platform = options.platform ?? (process.platform === "win32" ? "win32" : "posix");
    const impl = platform === "win32" ? path.win32 : path.posix;

    if (typeof input !== "string" || input.length === 0) return { ok: false, reason: "empty path" };
    if (input.includes("\0")) return { ok: false, reason: "path contains a NUL byte" };

    let p = input;

    // file:// URLs name local paths; anything else with a scheme is not a path.
    if (/^file:/i.test(p)) {
        try {
            p = fileURLToPath(p, { windows: platform === "win32" } as any);
        } catch {
            return { ok: false, reason: "invalid file: URL" };
        }
    }

    if (platform === "win32") {
        // Device / extended-length prefixes (\\?\C:\x, \\.\C:\x) name the same files.
        p = p.replace(/^[\\/]{2}[?.][\\/](?=[a-zA-Z]:)/, "");
        if (/^[\\/]{2}[?.][\\/]/.test(p)) return { ok: false, reason: "device path" };
        // A colon anywhere but after the drive letter selects an alternate data stream.
        if (p.slice(2).includes(":")) return { ok: false, reason: "alternate data stream or invalid path" };
    }

    const home = options.homeDir ?? os.homedir();
    if (p === "~" || p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\"))) {
        p = impl.join(home, p.slice(1));
    }

    const base = options.baseDir ?? process.cwd();
    p = impl.resolve(base, p);

    if (platform === "win32") {
        // Windows ignores trailing dots and spaces in each component ("secret.txt. " == "secret.txt").
        p = p.split("\\").map((part, i) => (i === 0 ? part : part.replace(/[. ]+$/, "") || part)).join("\\");
    }

    if (options.resolveSymlinks) p = realpathOfExistingPrefix(p, impl);

    // Drop a trailing separator (except for a root).
    const root = impl.parse(p).root;
    while (p.length > root.length && (p.endsWith("/") || p.endsWith("\\"))) p = p.slice(0, -1);

    return { ok: true, path: p };
}

/** realpath of the longest prefix that exists, with the rest appended (files may not exist yet). */
function realpathOfExistingPrefix(p: string, impl: typeof path.posix): string {
    let head = p;
    const tail: string[] = [];
    for (;;) {
        try {
            const real = fs.realpathSync.native(head);
            return tail.length ? impl.join(real, ...tail.reverse()) : real;
        } catch {
            const parent = impl.dirname(head);
            if (parent === head) return p;
            tail.push(impl.basename(head));
            head = parent;
        }
    }
}

/** True if candidate is root itself or inside it (component-wise, not a string prefix). */
export function isWithin(candidate: string, root: string, options: PathOptions = {}): boolean {
    const platform = options.platform ?? (process.platform === "win32" ? "win32" : "posix");
    const impl = platform === "win32" ? path.win32 : path.posix;
    const fold = options.caseInsensitive ?? platform === "win32";
    const c = fold ? candidate.toLowerCase() : candidate;
    const r = fold ? root.toLowerCase() : root;
    if (c === r) return true;
    const rel = impl.relative(r, c);
    return rel !== "" && !rel.startsWith("..") && !impl.isAbsolute(rel);
}
