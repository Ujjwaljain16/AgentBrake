import { promises as dns } from "dns";
import { isIP } from "net";

/**
 * URL canonicalisation and network classification for policy checks.
 *
 * Uses the WHATWG URL parser (the same one fetch() and most HTTP clients use), which already
 * lower-cases hosts, converts IDN to punycode and normalises numeric IPv4 forms
 * (http://2130706433/, http://0x7f.1/, http://0177.0.0.1/ all become 127.0.0.1).
 */

export type CanonicalUrl =
    | { ok: true; url: URL; host: string; hasCredentials: boolean }
    | { ok: false; reason: string };

export function canonicalizeUrl(input: string): CanonicalUrl {
    if (typeof input !== "string" || input.trim() === "") return { ok: false, reason: "empty URL" };
    let url: URL;
    try {
        url = new URL(input.trim());
    } catch {
        return { ok: false, reason: "not a valid absolute URL" };
    }
    let host = url.hostname.toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    host = host.replace(/\.+$/, ""); // "example.com." is example.com
    return { ok: true, url, host, hasCredentials: url.username !== "" || url.password !== "" };
}

/** "*.example.com" matches subdomains only; "example.com" matches exactly. */
export function hostMatches(host: string, pattern: string): boolean {
    const p = pattern.toLowerCase().replace(/\.+$/, "");
    if (p.startsWith("*.")) {
        const suffix = p.slice(1); // ".example.com"
        return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === p;
}

const PRIVATE_HOSTNAMES = [/^localhost$/, /\.localhost$/, /\.local$/, /\.internal$/, /^metadata\.google\.internal$/];

function ipv4ToInt(ip: string): number {
    return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const IPV4_PRIVATE: Array<[string, number]> = [
    ["0.0.0.0", 8],        // "this" network
    ["10.0.0.0", 8],       // RFC 1918
    ["100.64.0.0", 10],    // carrier-grade NAT
    ["127.0.0.0", 8],      // loopback
    ["169.254.0.0", 16],   // link-local, cloud metadata (169.254.169.254)
    ["172.16.0.0", 12],    // RFC 1918
    ["192.0.0.0", 24],     // IETF protocol assignments
    ["192.168.0.0", 16],   // RFC 1918
    ["198.18.0.0", 15],    // benchmarking
    ["224.0.0.0", 4],      // multicast
    ["240.0.0.0", 4]       // reserved, broadcast
];

function isPrivateIPv4(ip: string): boolean {
    const value = ipv4ToInt(ip);
    return IPV4_PRIVATE.some(([base, bits]) => {
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        return (value & mask) === (ipv4ToInt(base) & mask);
    });
}

/** Expand an IPv6 address to 8 16-bit groups (handles "::" and an embedded IPv4 tail). */
function ipv6Groups(ip: string): number[] | null {
    let s = ip.toLowerCase().split("%")[0];
    const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) {
        const n = ipv4ToInt(v4[1]);
        s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
    }
    const [head, tail] = s.split("::");
    const parse = (part: string | undefined) => (part ? part.split(":").map(h => parseInt(h, 16)) : []);
    const a = parse(head);
    const b = s.includes("::") ? parse(tail) : [];
    const fill = 8 - a.length - b.length;
    if (fill < 0 || (!s.includes("::") && fill !== 0)) return null;
    const groups = [...a, ...new Array(fill).fill(0), ...b];
    return groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function isPrivateIPv6(ip: string): boolean {
    const g = ipv6Groups(ip);
    if (!g) return true; // unparseable: fail closed
    const allZeroBefore = (n: number) => g.slice(0, n).every(x => x === 0);
    if (g.every(x => x === 0)) return true;                       // ::
    if (allZeroBefore(7) && g[7] === 1) return true;               // ::1
    if ((g[0] & 0xfe00) === 0xfc00) return true;                   // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true;                   // fe80::/10 link-local
    if ((g[0] & 0xff00) === 0xff00) return true;                   // multicast
    const embedded = (hi: number, lo: number) => `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
    if (allZeroBefore(5) && g[5] === 0xffff) return isPrivateIPv4(embedded(g[6], g[7]));   // ::ffff:a.b.c.d
    if (allZeroBefore(6)) return isPrivateIPv4(embedded(g[6], g[7]));                      // ::a.b.c.d (deprecated)
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isPrivateIPv4(embedded(g[6], g[7])); // NAT64
    return false;
}

/** True for loopback, private, link-local (incl. cloud metadata), and other non-public addresses or names. */
export function isPrivateHost(host: string): boolean {
    const kind = isIP(host);
    if (kind === 4) return isPrivateIPv4(host);
    if (kind === 6) return isPrivateIPv6(host);
    return PRIVATE_HOSTNAMES.some(re => re.test(host));
}

export type Lookup = (host: string) => Promise<Array<{ address: string }>>;

const systemLookup: Lookup = host => dns.lookup(host, { all: true, verbatim: true });

/**
 * Resolve a hostname and report whether any address is private (catches public names that point
 * at internal addresses). A name that cannot be resolved counts as private: fail closed.
 * The server resolves again later, so DNS rebinding between the two lookups is not prevented.
 */
export async function resolvesToPrivate(host: string, lookup: Lookup = systemLookup): Promise<boolean> {
    if (isIP(host)) return isPrivateHost(host);
    try {
        const addresses = await lookup(host);
        return addresses.length === 0 || addresses.some(a => isPrivateHost(a.address));
    } catch {
        return true;
    }
}
