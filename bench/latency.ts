/**
 * Latency benchmark.
 *
 * 1. Per-call overhead: round trips through an in-process BrakeProxy whose "server" answers
 *    immediately, with no policy vs the full Gauntlet config (flow store already holding
 *    protected data). Measures the proxy's own cost, not pipe or server time.
 * 2. Flow check cost vs outgoing payload size.
 *
 *   npm run bench           # prints tables, writes bench/results/latency.{json,md}
 */
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { BrakeProxy } from "../src/proxy/interceptor.js";
import { Policy } from "../src/policy/types.js";
import { ConfigLoader } from "../src/config/loader.js";
import { buildPolicies } from "../src/proxy/build.js";
import { TaintStore } from "../src/flow/taint.js";
import { allowAll } from "./driver.js";
import { callTool, HOME } from "./world.js";

const ROOT = path.resolve(__dirname, "..", "..");
const RESULTS = path.join(ROOT, "bench", "results");

function percentile(sorted: number[], p: number): number {
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function roundTrips(policies: Policy[], warmup: number, n: number, args: Record<string, unknown>): Promise<number[]> {
    const input = new PassThrough();
    const output = new PassThrough();
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => undefined;

    let serverBuf = "";
    child.stdin.on("data", (d: Buffer) => {
        serverBuf += d.toString();
        const lines = serverBuf.split("\n");
        serverBuf = lines.pop() as string;
        for (const line of lines) {
            const msg = JSON.parse(line);
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: callTool(msg.params.name, msg.params.arguments) }) + "\n");
        }
    });
    let resolveNext: (() => void) | null = null;
    let clientBuf = "";
    output.on("data", (d: Buffer) => {
        clientBuf += d.toString();
        const lines = clientBuf.split("\n");
        clientBuf = lines.pop() as string;
        for (let i = 0; i < lines.length; i++) resolveNext?.();
    });

    new BrakeProxy("mock", [], policies, { input, output, spawnFn: () => child, exit: () => undefined }).start();

    const send = (id: number, name: string, a: Record<string, unknown>) => new Promise<void>(resolve => {
        resolveNext = resolve;
        input.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: a } }) + "\n");
    });

    // Load protected data into the flow store, as in a real session.
    await send(1, "read_file", { path: "/srv/app/data/customers.csv" });
    await send(2, "debug_env", {});

    const times: number[] = [];
    for (let i = 0; i < warmup + n; i++) {
        const t0 = process.hrtime.bigint();
        await send(10 + i, "http_post", args);
        const dt = Number(process.hrtime.bigint() - t0) / 1000; // microseconds
        if (i >= warmup) times.push(dt);
    }
    input.end();
    return times.sort((a, b) => a - b);
}

function randomText(n: number, seed: number): string {
    let x = seed >>> 0;
    const words = ["the", "deploy", "report", "metrics", "latency", "customer", "team", "update", "weekly", "region", "alert", "budget"];
    const out: string[] = [];
    let len = 0;
    while (len < n) {
        x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
        const w = words[x % words.length] + (x % 7 === 0 ? String(x % 1000) : "");
        out.push(w);
        len += w.length + 1;
    }
    return out.join(" ").slice(0, n);
}

function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

async function main() {
    const realError = console.error;
    console.error = () => undefined;

    const agentbrake = () => buildPolicies(ConfigLoader.load(path.join(ROOT, "bench", "configs", "agentbrake.yml")), { platform: "posix", homeDir: HOME });
    const body = { url: "https://hooks.chat.example/ops", body: randomText(1024, 7) };
    const N = 3000;
    const base = await roundTrips([allowAll], 300, N, body);
    const full = await roundTrips(agentbrake(), 300, N, body);

    // Flow check scaling.
    const store = new TaintStore();
    const src = store.addSource("read_file", "secret", "bench");
    store.addText(src, randomText(256 * 1024, 99)); // 256 KiB of protected text
    const sizes = [1024, 10 * 1024, 100 * 1024, 1024 * 1024];
    const scaling = sizes.map(size => {
        const payload = randomText(size, size);
        const runs: number[] = [];
        for (let i = 0; i < 9; i++) {
            const t0 = process.hrtime.bigint();
            store.check(payload);
            runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
        }
        return { bytes: size, medianMs: Number(median(runs).toFixed(3)) };
    });
    const storeStats = store.stats();
    console.error = realError;

    const row = (times: number[]) => ({
        p50: Number(percentile(times, 50).toFixed(1)),
        p95: Number(percentile(times, 95).toFixed(1)),
        p99: Number(percentile(times, 99).toFixed(1))
    });
    const result = {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        calls: N,
        payloadBytes: 1024,
        roundTripMicros: { noPolicy: row(base), agentbrake: row(full) },
        overheadMicros: {
            p50: Number((percentile(full, 50) - percentile(base, 50)).toFixed(1)),
            p99: Number((percentile(full, 99) - percentile(base, 99)).toFixed(1))
        },
        flowCheck: { protectedBytes: 256 * 1024, fingerprints: storeStats.fingerprints, scaling }
    };

    console.log("\nPer-call round trip through the proxy (microseconds, 1 KiB argument, in-process)\n");
    console.log("                    p50      p95      p99");
    for (const [name, r] of [["no policy", result.roundTripMicros.noPolicy], ["AgentBrake", result.roundTripMicros.agentbrake]] as const) {
        console.log(`${name.padEnd(18)}${String(r.p50).padStart(6)}   ${String(r.p95).padStart(6)}   ${String(r.p99).padStart(6)}`);
    }
    console.log(`\nAdded by AgentBrake: p50 ${result.overheadMicros.p50} us, p99 ${result.overheadMicros.p99} us`);
    console.log(`\nFlow check vs outgoing payload (store: 256 KiB protected text, ${storeStats.fingerprints} fingerprints)`);
    for (const s of scaling) console.log(`  ${String(s.bytes).padStart(8)} bytes   ${s.medianMs} ms`);

    fs.mkdirSync(RESULTS, { recursive: true });
    fs.writeFileSync(path.join(RESULTS, "latency.json"), JSON.stringify(result, null, 2) + "\n");
    fs.writeFileSync(path.join(RESULTS, "latency.md"), [
        "# Latency",
        "",
        `Generated by \`npm run bench\` on Node ${result.node} (${result.platform}). In-process: measures the proxy's own work, not pipes or the tool server. Numbers vary by machine.`,
        "",
        "| per call, 1 KiB argument | p50 (µs) | p95 (µs) | p99 (µs) |",
        "|---|---|---|---|",
        `| No policy | ${result.roundTripMicros.noPolicy.p50} | ${result.roundTripMicros.noPolicy.p95} | ${result.roundTripMicros.noPolicy.p99} |`,
        `| AgentBrake (Gauntlet config) | ${result.roundTripMicros.agentbrake.p50} | ${result.roundTripMicros.agentbrake.p95} | ${result.roundTripMicros.agentbrake.p99} |`,
        "",
        `Flow check against 256 KiB of protected text (${storeStats.fingerprints} fingerprints):`,
        "",
        "| outgoing payload | median (ms) |",
        "|---|---|",
        ...scaling.map(s => `| ${s.bytes >= 1048576 ? "1 MiB" : `${s.bytes / 1024} KiB`} | ${s.medianMs} |`),
        ""
    ].join("\n"));
    console.log("\nWrote bench/results/latency.md and latency.json");
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
