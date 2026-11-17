import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { BrakeProxy } from "../src/proxy/interceptor";
import { Policy } from "../src/policy/types";

export const settle = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

export interface Harness {
    proxy: BrakeProxy;
    input: PassThrough;
    child: any;
    toServer: string[];
    toClient: string[];
    exit: jest.Mock;
    sendToClientRaw: (data: string | Buffer) => void;
    /** Write one JSON-RPC line from the fake server. */
    serverSays: (message: unknown) => void;
}

/** A BrakeProxy wired to in-memory streams and a fake child process. */
export function createHarness(policies: Policy[], options: { maxMessageBytes?: number; now?: () => number } = {}): Harness {
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
        maxMessageBytes: options.maxMessageBytes,
        now: options.now
    });
    proxy.start();

    return {
        proxy,
        input,
        child,
        toServer,
        toClient,
        exit,
        sendToClientRaw: d => input.write(d),
        serverSays: message => child.stdout.write(JSON.stringify(message) + "\n")
    };
}

export const call = (id: number, name: string, args: unknown = {}) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
