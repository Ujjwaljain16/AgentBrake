import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { BrakeProxy, childEnvironment } from "../src/proxy/interceptor";
import { LineFramer } from "../src/proxy/framing";
import { AllowedToolsPolicy } from "../src/policy/policies/AllowedToolsPolicy";
import { GranularAccessPolicy } from "../src/policy/policies/GranularAccessPolicy";
import { MaxToolCallsPolicy } from "../src/policy/policies/MaxToolCallsPolicy";
import { CircuitBreakerPolicy } from "../src/policy/policies/CircuitBreakerPolicy";
import { ApprovalPolicy } from "../src/policy/policies/ApprovalPolicy";
import { Policy } from "../src/policy/types";

// Silence structured logs during tests.
beforeAll(() => { jest.spyOn(console, "error").mockImplementation(() => undefined); });
afterAll(() => { jest.restoreAllMocks(); });

const settle = () => new Promise(resolve => setTimeout(resolve, 5));

interface Harness {
    input: PassThrough;
    child: any;
    toServer: string[];
    toClient: string[];
    exit: jest.Mock;
    sendToClientRaw: (data: string | Buffer) => void;
}

function createHarness(policies: Policy[], options: { maxMessageBytes?: number } = {}): Harness {
    const input = new PassThrough();
    const output = new PassThrough();
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = jest.fn();

    const toServer: string[] = [];
    const toClient: string[] = [];
    let serverBuf = "";
    let clientBuf = "";
    child.stdin.on("data", (d: Buffer) => {
        serverBuf += d.toString();
        const parts = serverBuf.split("\n");
        serverBuf = parts.pop() as string;
        toServer.push(...parts);
    });
    output.on("data", (d: Buffer) => {
        clientBuf += d.toString();
        const parts = clientBuf.split("\n");
        clientBuf = parts.pop() as string;
        toClient.push(...parts);
    });

    const exit = jest.fn();
    const proxy = new BrakeProxy("fake", [], policies, {
        input,
        output,
        spawnFn: () => child,
        exit,
        maxMessageBytes: options.maxMessageBytes
    });
    proxy.start();

    return { input, child, toServer, toClient, exit, sendToClientRaw: d => input.write(d) };
}

const call = (id: number, name: string, args: unknown = {}) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

const policiesUnderTest = (): Policy[] => [
    new AllowedToolsPolicy(["ok"]),
    new GranularAccessPolicy([{ tool: "ok", deny_if: { arguments: { path: "\\.env" } }, action: "block" }])
];

describe("LineFramer", () => {
    it("reassembles a line split across chunks", () => {
        const f = new LineFramer(1024);
        expect(f.push(Buffer.from('{"a":'))).toEqual([]);
        expect(f.push(Buffer.from('1}\n'))).toEqual([{ type: "line", line: '{"a":1}' }]);
    });

    it("emits multiple lines from one chunk and keeps the partial tail", () => {
        const f = new LineFramer(1024);
        const events = f.push(Buffer.from("one\ntwo\nthr"));
        expect(events).toEqual([{ type: "line", line: "one" }, { type: "line", line: "two" }]);
        expect(f.push(Buffer.from("ee\n"))).toEqual([{ type: "line", line: "three" }]);
    });

    it("strips CRLF", () => {
        const f = new LineFramer(1024);
        expect(f.push(Buffer.from("abc\r\n"))).toEqual([{ type: "line", line: "abc" }]);
    });

    it("decodes multi-byte UTF-8 split at every byte boundary", () => {
        const bytes = Buffer.from("héllo € 😀\n", "utf-8");
        for (let i = 1; i < bytes.length; i++) {
            const f = new LineFramer(1024);
            const events = [...f.push(bytes.subarray(0, i)), ...f.push(bytes.subarray(i))];
            expect(events).toEqual([{ type: "line", line: "héllo € 😀" }]);
        }
    });

    it("reports invalid UTF-8", () => {
        const f = new LineFramer(1024);
        expect(f.push(Buffer.from([0xff, 0xfe, 0x0a]))).toEqual([{ type: "invalid", reason: "invalid_utf8" }]);
    });

    it("rejects an oversized line once and resynchronises on the next newline", () => {
        const f = new LineFramer(10);
        const events = [
            ...f.push(Buffer.from("x".repeat(8))),
            ...f.push(Buffer.from("x".repeat(8))),
            ...f.push(Buffer.from("x".repeat(8))),
            ...f.push(Buffer.from("xx\nok\n"))
        ];
        expect(events).toEqual([{ type: "invalid", reason: "too_long" }, { type: "line", line: "ok" }]);
    });

    it("rejects an oversized line delivered in a single chunk", () => {
        const f = new LineFramer(5);
        expect(f.push(Buffer.from("toolongline\nok\n"))).toEqual([
            { type: "invalid", reason: "too_long" },
            { type: "line", line: "ok" }
        ]);
    });

    it("flushes a trailing unterminated line on end()", () => {
        const f = new LineFramer(100);
        f.push(Buffer.from("tail"));
        expect(f.end()).toEqual([{ type: "line", line: "tail" }]);
    });
});

describe("BrakeProxy client -> server framing (fail closed)", () => {
    it("applies policy when a blocked tools/call is split at EVERY byte boundary", async () => {
        const bytes = Buffer.from(call(1, "evil_tool", { note: "café €" }) + "\n", "utf-8");
        for (let i = 1; i < bytes.length; i++) {
            const h = createHarness(policiesUnderTest());
            h.input.write(bytes.subarray(0, i));
            h.input.write(bytes.subarray(i));
            await settle();
            expect(h.toServer).toEqual([]);
            expect(h.toClient).toHaveLength(1);
            expect(JSON.parse(h.toClient[0]).error.data.policy).toBe("AllowedToolsPolicy");
        }
    });

    it("applies granular argument policy when split at every byte boundary", async () => {
        const bytes = Buffer.from(call(7, "ok", { path: "/app/.env" }) + "\n", "utf-8");
        for (let i = 1; i < bytes.length; i++) {
            const h = createHarness(policiesUnderTest());
            h.input.write(bytes.subarray(0, i));
            h.input.write(bytes.subarray(i));
            await settle();
            expect(h.toServer).toEqual([]);
            expect(JSON.parse(h.toClient[0]).error.data.policy).toBe("GranularAccessPolicy");
        }
    });

    it("blocks when the message is delivered one byte per chunk", async () => {
        const h = createHarness(policiesUnderTest());
        for (const byte of Buffer.from(call(2, "evil_tool") + "\n")) {
            h.input.write(Buffer.from([byte]));
        }
        await settle();
        expect(h.toServer).toEqual([]);
        expect(h.toClient).toHaveLength(1);
    });

    it("forwards an allowed tools/call exactly once at every split point", async () => {
        const bytes = Buffer.from(call(3, "ok", { path: "/tmp/a" }) + "\n");
        for (let i = 1; i < bytes.length; i++) {
            const h = createHarness(policiesUnderTest());
            h.input.write(bytes.subarray(0, i));
            h.input.write(bytes.subarray(i));
            await settle();
            expect(h.toServer).toHaveLength(1);
            expect(JSON.parse(h.toServer[0]).params.name).toBe("ok");
            expect(h.toClient).toEqual([]);
        }
    });

    it("handles several messages in one chunk, deciding each independently and in order", async () => {
        const h = createHarness(policiesUnderTest());
        h.input.write(Buffer.from([
            call(1, "ok", { path: "/tmp/a" }),
            call(2, "evil_tool"),
            call(3, "ok", { path: "/tmp/b" })
        ].join("\n") + "\n"));
        await settle();
        expect(h.toServer.map(l => JSON.parse(l).id)).toEqual([1, 3]);
        expect(h.toClient.map(l => JSON.parse(l).id)).toEqual([2]);
    });

    it("handles CRLF-terminated messages", async () => {
        const h = createHarness(policiesUnderTest());
        h.input.write(call(1, "evil_tool") + "\r\n");
        await settle();
        expect(h.toServer).toEqual([]);
        expect(h.toClient).toHaveLength(1);
    });

    it("does not forward a message whose newline never arrives until end of stream, but still enforces it", async () => {
        const h = createHarness(policiesUnderTest());
        h.input.write(call(1, "evil_tool"));
        await settle();
        expect(h.toServer).toEqual([]);
        h.input.end();
        await settle();
        expect(h.toServer).toEqual([]);
        expect(h.toClient).toHaveLength(1);
    });

    it("rejects unparseable input instead of passing it through", async () => {
        const h = createHarness(policiesUnderTest());
        h.input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"evil_tool"\n');
        h.input.write("not json at all\n");
        await settle();
        expect(h.toServer).toEqual([]);
        expect(h.toClient).toHaveLength(2);
        expect(JSON.parse(h.toClient[0]).error.code).toBe(-32700);
    });

    it("rejects invalid UTF-8 input", async () => {
        const h = createHarness(policiesUnderTest());
        h.input.write(Buffer.concat([Buffer.from('{"method":"x","a":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]));
        await settle();
        expect(h.toServer).toEqual([]);
        expect(h.toClient).toHaveLength(1);
    });

    it("rejects JSON-RPC batches (which would otherwise smuggle tools/call past the policy)", async () => {
        const h = createHarness(policiesUnderTest());
        h.input.write(`[${call(1, "evil_tool")},${call(2, "ok", { path: "/tmp/x" })}]\n`);
        await settle();
        expect(h.toServer).toEqual([]);
        expect(JSON.parse(h.toClient[0]).error.code).toBe(-32600);
    });

    it("rejects non-object JSON and messages that are neither request nor response", async () => {
        const h = createHarness(policiesUnderTest());
        h.input.write('42\n"str"\nnull\n{"id":1}\n{"jsonrpc":"2.0","id":2,"method":5}\n');
        await settle();
        expect(h.toServer).toEqual([]);
        expect(h.toClient).toHaveLength(5);
    });

    it("rejects malformed tools/call params (missing name, non-object arguments)", async () => {
        const h = createHarness(policiesUnderTest());
        h.input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n');
        h.input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"arguments":{}}}\n');
        h.input.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ok","arguments":"/etc/passwd"}}\n');
        h.input.write('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ok","arguments":[1]}}\n');
        await settle();
        expect(h.toServer).toEqual([]);
        expect(h.toClient.map(l => JSON.parse(l).error.code)).toEqual([-32602, -32602, -32602, -32602]);
    });

    it("treats call_tool and case/whitespace variants of the method as tool calls", async () => {
        const h = createHarness(policiesUnderTest());
        h.input.write('{"jsonrpc":"2.0","id":1,"method":"call_tool","params":{"name":"evil_tool"}}\n');
        h.input.write('{"jsonrpc":"2.0","id":2,"method":" Tools/Call ","params":{"name":"evil_tool"}}\n');
        await settle();
        expect(h.toServer).toEqual([]);
        expect(h.toClient).toHaveLength(2);
    });

    it("sends no response for a blocked notification (no id) and does not forward it", async () => {
        const h = createHarness(policiesUnderTest());
        h.input.write('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"evil_tool"}}\n');
        await settle();
        expect(h.toServer).toEqual([]);
        expect(h.toClient).toEqual([]);
    });

    it("defeats duplicate-key parser differentials by forwarding what was checked", async () => {
        const h = createHarness(policiesUnderTest());
        // First "name" is allowed, last (what JSON.parse uses) is not.
        h.input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ok","name":"evil_tool"}}\n');
        // Allowed by last-wins; forwarded text must not carry the shadowed key.
        h.input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"evil_tool","name":"ok"}}\n');
        await settle();
        expect(h.toServer).toHaveLength(1);
        expect(h.toServer[0]).not.toContain("evil_tool");
        expect(h.toClient).toHaveLength(1);
    });

    it("rejects oversized messages and recovers for the next one", async () => {
        const h = createHarness(policiesUnderTest(), { maxMessageBytes: 200 });
        h.input.write(call(1, "ok", { path: "/tmp/" + "a".repeat(500) }) + "\n");
        h.input.write(call(2, "ok", { path: "/tmp/a" }) + "\n");
        await settle();
        expect(h.toServer.map(l => JSON.parse(l).id)).toEqual([2]);
        expect(JSON.parse(h.toClient[0]).error.message).toContain("size limit");
    });

    it("passes ordinary non-tool messages through unchanged in meaning", async () => {
        const h = createHarness(policiesUnderTest());
        h.input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
        h.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
        h.input.write('{"jsonrpc":"2.0","id":9,"result":{}}\n');
        await settle();
        expect(h.toServer).toHaveLength(3);
        expect(h.toClient).toEqual([]);
    });

    it("fails closed when a policy throws", async () => {
        const throwing: Policy = { name: "Boom", validate: async () => { throw new Error("boom"); } };
        const h = createHarness([throwing]);
        h.input.write(call(1, "ok") + "\n");
        await settle();
        expect(h.toServer).toEqual([]);
        expect(JSON.parse(h.toClient[0]).error.data.policy).toBe("Boom");
    });

    it("enforces sandbox results as a block because sandboxing is not implemented", async () => {
        const sandboxing: Policy = { name: "Sbx", validate: async () => ({ policyName: "Sbx", action: "sandbox", reason: "r" }) };
        const h = createHarness([sandboxing]);
        h.input.write(call(1, "ok") + "\n");
        await settle();
        expect(h.toServer).toEqual([]);
        expect(JSON.parse(h.toClient[0]).error.data.action).toBe("block");
    });

    it("kill action responds, terminates the child and exits non-zero", async () => {
        const killer: Policy = { name: "K", validate: async () => ({ policyName: "K", action: "kill", reason: "bye" }) };
        const h = createHarness([killer]);
        h.input.write(call(1, "ok") + "\n" + call(2, "ok") + "\n");
        await settle();
        expect(h.toServer).toEqual([]);
        expect(h.toClient).toHaveLength(1);
        expect(h.child.kill).toHaveBeenCalled();
        expect(h.exit).toHaveBeenCalledWith(1);
    });

    it("counts only allowed calls toward max_tool_calls (no off-by-one)", async () => {
        const h = createHarness([new MaxToolCallsPolicy(2)]);
        h.input.write([call(1, "ok"), call(2, "ok"), call(3, "ok")].join("\n") + "\n");
        await settle();
        expect(h.toServer.map(l => JSON.parse(l).id)).toEqual([1, 2]);
        expect(h.toClient.map(l => JSON.parse(l).id)).toEqual([3]);
    });

    it("blocks approval-required tools (no approval channel exists) and returns the pending error code", async () => {
        const h = createHarness([new ApprovalPolicy(["send_email"])]);
        h.input.write(call(1, "send_email") + "\n" + call(2, "send_email") + "\n");
        await settle();
        expect(h.toServer).toEqual([]);
        expect(JSON.parse(h.toClient[0]).error.code).toBe(-32001);
        expect(JSON.parse(h.toClient[1]).error.data.action).toBe("block");
    });

    it("closes the child's stdin when the client closes", async () => {
        const h = createHarness(policiesUnderTest());
        h.input.end();
        await settle();
        expect(h.child.stdin.writableEnded).toBe(true);
    });
});

describe("BrakeProxy server -> client framing", () => {
    it("forwards whole lines even when the server output is split arbitrarily", async () => {
        const line = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "café €" }] } });
        const bytes = Buffer.from(line + "\n", "utf-8");

        const h = createHarness(policiesUnderTest());
        for (let i = 0; i < bytes.length; i += 3) {
            h.child.stdout.write(bytes.subarray(i, i + 3));
        }
        await settle();
        expect(h.toClient).toEqual([line]);
    });

    it("never interleaves a proxy error into the middle of a partial server line", async () => {
        const h = createHarness(policiesUnderTest());
        const line = JSON.stringify({ jsonrpc: "2.0", id: 99, result: { ok: true } });
        h.child.stdout.write(line.slice(0, 10));
        await settle();
        h.input.write(call(1, "evil_tool") + "\n");
        await settle();
        h.child.stdout.write(line.slice(10) + "\n");
        await settle();
        expect(h.toClient).toHaveLength(2);
        expect(h.toClient.map(l => JSON.parse(l).id).sort()).toEqual([1, 99]);
    });

    it("splits several server messages arriving in one chunk", async () => {
        const h = createHarness(policiesUnderTest());
        h.child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":2,"result":{}}\n');
        await settle();
        expect(h.toClient).toHaveLength(2);
    });

    it("drops non-JSON server output rather than forwarding it", async () => {
        const h = createHarness(policiesUnderTest());
        h.child.stdout.write('hello banner\n{"jsonrpc":"2.0","id":1,"result":{}}\n');
        await settle();
        expect(h.toClient).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);
    });
});

describe("Circuit breaker wired to real tool outcomes", () => {
    it("opens after consecutive real failures and blocks subsequent calls without reaching the server", async () => {
        const breaker = new CircuitBreakerPolicy(2, 60);
        const h = createHarness([breaker]);

        h.input.write(call(1, "flaky") + "\n");
        await settle();
        h.child.stdout.write('{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"fail"}}\n');
        await settle();

        h.input.write(call(2, "flaky") + "\n");
        await settle();
        h.child.stdout.write('{"jsonrpc":"2.0","id":2,"result":{"isError":true,"content":[]}}\n');
        await settle();

        expect(breaker.getStatus("flaky").isOpen).toBe(true);

        h.toServer.length = 0;
        h.toClient.length = 0;
        h.input.write(call(3, "flaky") + "\n");
        await settle();
        expect(h.toServer).toEqual([]);
        expect(JSON.parse(h.toClient[0]).error.data.policy).toBe("CircuitBreakerPolicy");
    });

    it("a success resets the failure count", async () => {
        const breaker = new CircuitBreakerPolicy(2, 60);
        const h = createHarness([breaker]);

        const roundTrip = async (id: number, response: string) => {
            h.input.write(call(id, "t") + "\n");
            await settle();
            h.child.stdout.write(response + "\n");
            await settle();
        };

        await roundTrip(1, '{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"x"}}');
        await roundTrip(2, '{"jsonrpc":"2.0","id":2,"result":{"content":[]}}');
        await roundTrip(3, '{"jsonrpc":"2.0","id":3,"error":{"code":1,"message":"x"}}');
        expect(breaker.getStatus("t").isOpen).toBe(false);
        expect(breaker.getStatus("t").failures).toBe(1);
    });

    it("does not count proxy-generated blocks as tool failures", async () => {
        const breaker = new CircuitBreakerPolicy(1, 60);
        const h = createHarness([new AllowedToolsPolicy(["ok"]), breaker]);
        h.input.write(call(1, "evil_tool") + "\n");
        await settle();
        expect(breaker.getStatus("evil_tool").failures).toBe(0);
    });
});

describe("childEnvironment", () => {
    it("strips AgentBrake configuration and webhook secrets but keeps everything else", () => {
        const env = childEnvironment({
            PATH: "/bin",
            API_KEY: "k",
            AGENT_BRAKE_CONFIG: "/x.yml",
            agent_brake_allow_invalid_config: "1",
            WEBHOOK_URL: "https://hook",
            SLACK_WEBHOOK_URL: "https://slack"
        });
        expect(env).toEqual({ PATH: "/bin", API_KEY: "k" });
    });
});
