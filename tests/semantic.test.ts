import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { canonicalizePath, isWithin } from "../src/policy/semantic/paths";
import { canonicalizeUrl, hostMatches, isPrivateHost, resolvesToPrivate } from "../src/policy/semantic/urls";
import { ArgumentRulesPolicy } from "../src/policy/policies/ArgumentRulesPolicy";
import { GranularAccessPolicy } from "../src/policy/policies/GranularAccessPolicy";
import { ArgumentRuleSchema, ArgumentRule } from "../src/config/schema";
import { toolCallRequest } from "../src/policy/types";
import { ConfigLoader } from "../src/config/loader";

const state = {} as any;
const rule = (r: unknown): ArgumentRule => ArgumentRuleSchema.parse(r);

describe("path canonicalisation (posix)", () => {
    const opts = { platform: "posix" as const, baseDir: "/srv/app", homeDir: "/home/u" };
    const canon = (p: string) => {
        const c = canonicalizePath(p, opts);
        return c.ok ? c.path : `!${c.reason}`;
    };

    it.each([
        ["/tmp/../etc/passwd", "/etc/passwd"],
        ["/tmp/./a//b/", "/tmp/a/b"],
        ["data/../../../etc/shadow", "/etc/shadow"],
        ["data/../../etc/shadow", "/srv/etc/shadow"],
        ["~/.ssh/id_rsa", "/home/u/.ssh/id_rsa"],
        ["file:///etc/passwd", "/etc/passwd"],
        ["file:///tmp/%2e%2e/etc/passwd", "/etc/passwd"],
        ["/", "/"]
    ])("%s -> %s", (input, expected) => {
        expect(canon(input)).toBe(expected);
    });

    it("rejects NUL bytes and empty paths", () => {
        expect(canon("/tmp/a\0.txt")).toMatch(/^!/);
        expect(canon("")).toMatch(/^!/);
    });

    it("compares by directory boundary, not string prefix", () => {
        expect(isWithin("/tmp/a", "/tmp", opts)).toBe(true);
        expect(isWithin("/tmp", "/tmp", opts)).toBe(true);
        expect(isWithin("/tmpfoo/a", "/tmp", opts)).toBe(false);
        expect(isWithin("/etc/passwd", "/tmp", opts)).toBe(false);
        expect(isWithin("/TMP/a", "/tmp", opts)).toBe(false); // posix is case-sensitive
    });
});

describe("path canonicalisation (win32)", () => {
    const opts = { platform: "win32" as const, baseDir: "C:\\work", homeDir: "C:\\Users\\u" };
    const canon = (p: string) => {
        const c = canonicalizePath(p, opts);
        return c.ok ? c.path : `!${c.reason}`;
    };

    it.each([
        ["C:/work/../Windows/System32", "C:\\Windows\\System32"],
        ["sub\\..\\..\\secrets.txt", "C:\\secrets.txt"],
        ["\\\\?\\C:\\work\\a", "C:\\work\\a"],
        ["C:\\work\\secret.txt. . ", "C:\\work\\secret.txt"],
        ["~\\.aws\\credentials", "C:\\Users\\u\\.aws\\credentials"]
    ])("%s -> %s", (input, expected) => {
        expect(canon(input)).toBe(expected);
    });

    it("rejects alternate data streams and raw device paths", () => {
        expect(canon("C:\\work\\a.txt:hidden")).toMatch(/^!/);
        expect(canon("\\\\.\\PhysicalDrive0")).toMatch(/^!/);
    });

    it("compares case-insensitively by default", () => {
        expect(isWithin("c:\\WORK\\x", "C:\\work", opts)).toBe(true);
        expect(isWithin("C:\\workshop\\x", "C:\\work", opts)).toBe(false);
    });
});

describe("symlink resolution", () => {
    const linkTest = process.platform === "win32" ? it.skip : it;
    linkTest("follows a symlink out of an allowed directory", async () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ab-")));
        const allowed = path.join(dir, "allowed");
        const secret = path.join(dir, "secret");
        fs.mkdirSync(allowed);
        fs.mkdirSync(secret);
        fs.symlinkSync(secret, path.join(allowed, "link"));

        const make = (resolve: boolean) => new ArgumentRulesPolicy([rule({
            type: "path", tool: "read", argument: "path", within: [allowed], resolve_symlinks: resolve
        })]);
        const target = path.join(allowed, "link", "key.pem");
        expect(await make(false).validate(toolCallRequest("read", { path: target }), state)).toBeNull();
        expect((await make(true).validate(toolCallRequest("read", { path: target }), state))?.action).toBe("block");
    });
});

describe("URL canonicalisation and classification", () => {
    it.each([
        "http://127.0.0.1/",
        "http://2130706433/",            // decimal
        "http://0x7f.1/",                // hex + short form
        "http://0177.0.0.1/",            // octal
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[::ffff:a9fe:a9fe]/",    // mapped 169.254.169.254
        "http://[fd00::1]/",
        "http://[fe80::1]/",
        "http://localhost./",
        "http://LOCALHOST/",
        "http://api.localhost/",
        "http://metadata.google.internal/",
        "http://10.1.2.3/",
        "http://172.31.255.255/",
        "http://192.168.0.1/",
        "http://100.64.0.1/",
        "http://0.0.0.0/",
        "http://[64:ff9b::7f00:1]/"      // NAT64 of 127.0.0.1
    ])("%s is private", (url) => {
        const c = canonicalizeUrl(url);
        expect(c.ok && isPrivateHost(c.host)).toBe(true);
    });

    it.each(["https://example.com/", "http://8.8.8.8/", "http://172.32.0.1/", "http://[2606:4700::1111]/"])("%s is public", (url) => {
        const c = canonicalizeUrl(url);
        expect(c.ok && isPrivateHost(c.host)).toBe(false);
    });

    it("normalises hosts: case, trailing dot, IDN to punycode, userinfo is not the host", () => {
        const host = (u: string) => { const c = canonicalizeUrl(u); return c.ok ? c.host : null; };
        expect(host("https://API.GitHub.com./x")).toBe("api.github.com");
        expect(host("https://bücher.example/")).toBe("xn--bcher-kva.example");
        expect(host("https://api.github.com@evil.com/")).toBe("evil.com");
        expect(host("not a url")).toBeNull();
    });

    it("host patterns: exact, and *.x for subdomains only", () => {
        expect(hostMatches("api.github.com", "*.github.com")).toBe(true);
        expect(hostMatches("github.com", "*.github.com")).toBe(false);
        expect(hostMatches("evilgithub.com", "*.github.com")).toBe(false);
        expect(hostMatches("github.com", "github.com")).toBe(true);
    });

    it("DNS check fails closed and flags names that resolve to private addresses", async () => {
        expect(await resolvesToPrivate("rebind.test", async () => [{ address: "10.0.0.5" }])).toBe(true);
        expect(await resolvesToPrivate("ok.test", async () => [{ address: "93.184.216.34" }])).toBe(false);
        expect(await resolvesToPrivate("gone.test", async () => { throw new Error("ENOTFOUND"); })).toBe(true);
    });
});

describe("ArgumentRulesPolicy", () => {
    const pathPolicy = () => new ArgumentRulesPolicy([rule({
        type: "path", tool: ["read_file", "write_file"], argument: "path",
        within: ["/srv/app/data", "/tmp"], not_within: ["/srv/app/data/keys"]
    })], "block", { platform: "posix", homeDir: "/home/u" });

    it.each([
        ["/tmp/../etc/passwd"],
        ["/tmpx/a"],
        ["/srv/app/data/keys/id_rsa"],
        ["/srv/app/data/../data/keys/./id_rsa"],
        ["~/.ssh/id_rsa"],
        ["file:///etc/passwd"]
    ])("blocks %s", async (p) => {
        expect((await pathPolicy().validate(toolCallRequest("read_file", { path: p }), state))?.action).toBe("block");
    });

    it.each([["/tmp/report.txt"], ["/srv/app/data/a/b.csv"]])("allows %s", async (p) => {
        expect(await pathPolicy().validate(toolCallRequest("read_file", { path: p }), state)).toBeNull();
    });

    it("the regex rule the old README warned about is bypassed; the path rule is not", async () => {
        const regex = new GranularAccessPolicy([{ tool: "read_file", allow_if: { arguments: { path: "^/tmp/" } }, action: "block" }]);
        const attack = toolCallRequest("read_file", { path: "/tmp/../etc/passwd" });
        expect(await regex.validate(attack, state)).toBeNull();
        expect((await pathPolicy().validate(attack, state))?.action).toBe("block");
    });

    it("checks every element of a list argument and fails closed on other types", async () => {
        const p = pathPolicy();
        expect((await p.validate(toolCallRequest("write_file", { path: ["/tmp/a", "/etc/x"] }), state))?.action).toBe("block");
        expect((await p.validate(toolCallRequest("write_file", { path: { p: "/tmp/a" } }), state))?.action).toBe("block");
        expect(await p.validate(toolCallRequest("write_file", {}), state)).toBeNull();
        expect(await p.validate(toolCallRequest("other_tool", { path: "/etc/x" }), state)).toBeNull();
    });

    const urlPolicy = (extra: Record<string, unknown> = {}) => new ArgumentRulesPolicy([rule({
        type: "url", tool: "fetch", argument: "url", allowed_schemes: ["https"], ...extra
    })], "block", { lookup: async () => [{ address: "10.9.9.9" }] });

    it.each([
        ["http://example.com/", "scheme"],
        ["https://169.254.169.254/latest/meta-data/iam/", "private"],
        ["https://2130706433/", "private"],
        ["https://user:pw@example.com/", "credentials"],
        ["javascript:alert(1)", "scheme"],
        ["/relative/path", "URL"]
    ])("blocks %s (%s)", async (url, why) => {
        const r = await urlPolicy().validate(toolCallRequest("fetch", { url }), state);
        expect(r?.action).toBe("block");
        expect(r?.reason).toContain(why);
    });

    it("enforces host allow and deny lists", async () => {
        const p = urlPolicy({ allowed_hosts: ["*.github.com"], denied_hosts: ["gist.github.com"] });
        expect(await p.validate(toolCallRequest("fetch", { url: "https://api.github.com/x" }), state)).toBeNull();
        expect((await p.validate(toolCallRequest("fetch", { url: "https://gist.github.com/" }), state))?.action).toBe("block");
        expect((await p.validate(toolCallRequest("fetch", { url: "https://api.github.com.evil.io/" }), state))?.action).toBe("block");
        expect((await p.validate(toolCallRequest("fetch", { url: "https://api.github.com@evil.io/" }), state))?.action).toBe("block");
    });

    it("optionally resolves DNS to catch public names pointing at internal hosts", async () => {
        const plain = urlPolicy();
        const resolving = urlPolicy({ resolve_dns: true });
        const req = toolCallRequest("fetch", { url: "https://innocent.example/" });
        expect(await plain.validate(req, state)).toBeNull();
        expect((await resolving.validate(req, state))?.reason).toContain("resolves");
    });

    it("is configured from YAML and refuses rules without boundaries", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrake-"));
        const good = path.join(dir, "good.yml");
        fs.writeFileSync(good, [
            "policies:",
            "  security:",
            "    argument_rules:",
            "      - { type: path, tool: read_file, argument: path, within: [/tmp] }",
            "      - { type: url, tool: fetch, argument: url, allowed_hosts: ['*.github.com'] }"
        ].join("\n"));
        expect(ConfigLoader.load(good).policies.security.argument_rules).toHaveLength(2);

        const bad = path.join(dir, "bad.yml");
        fs.writeFileSync(bad, "policies:\n  security:\n    argument_rules:\n      - { type: path, tool: t, argument: p }\n");
        expect(() => ConfigLoader.load(bad)).toThrow(/within or not_within/);
    });
});
