import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { BrakeProxy } from "../src/proxy/interceptor.js";
import { Policy } from "../src/policy/types.js";
import { callTool } from "./world.js";
import { Scenario } from "./scenarios.js";

export interface StepOutcome {
    tool: string;
    malicious: boolean;
    forwarded: boolean;
    /** Policy that refused the call, if any. */
    policy?: string;
    /** The proxy's error message for a refused call. */
    message?: string;
}

export interface ScenarioOutcome {
    id: string;
    steps: StepOutcome[];
    /** Attacks: a malicious step reached the server. Benign: every step reached the server. */
    succeeded: boolean;
}

/** A policy that allows everything (the "no proxy" arm still runs the same code path). */
export const allowAll: Policy = { name: "AllowAll", validate: async () => null };

/**
 * Run one scenario through a real BrakeProxy whose child process is the in-memory mock tool
 * server. The scripted agent stops at the first refused step (it never got what it needed).
 */
export async function runScenario(scenario: Scenario, policies: Policy[]): Promise<ScenarioOutcome> {
    const input = new PassThrough();
    const output = new PassThrough();
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => undefined;

    const forwardedIds = new Set<number>();
    let serverBuf = "";
    child.stdin.on("data", (d: Buffer) => {
        serverBuf += d.toString();
        const lines = serverBuf.split("\n");
        serverBuf = lines.pop() as string;
        for (const line of lines) {
            const msg = JSON.parse(line);
            if (msg.method !== "tools/call") continue;
            forwardedIds.add(msg.id);
            const result = callTool(msg.params.name, msg.params.arguments ?? {});
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
        }
    });

    const waiting = new Map<number, (msg: any) => void>();
    let clientBuf = "";
    output.on("data", (d: Buffer) => {
        clientBuf += d.toString();
        const lines = clientBuf.split("\n");
        clientBuf = lines.pop() as string;
        for (const line of lines) {
            const msg = JSON.parse(line);
            waiting.get(msg.id)?.(msg);
        }
    });

    let exited = false;
    const proxy = new BrakeProxy("mock", [], policies, {
        input, output, spawnFn: () => child, exit: () => { exited = true; }
    });
    proxy.start();

    const steps: StepOutcome[] = [];
    let id = 0;
    for (const step of scenario.steps) {
        if (exited) {
            steps.push({ tool: step.tool, malicious: !!step.malicious, forwarded: false, policy: "(session killed)" });
            continue;
        }
        id++;
        const reply = await new Promise<any>(resolve => {
            const timer = setTimeout(() => resolve(null), 2000); // a killed session never answers
            waiting.set(id, msg => { clearTimeout(timer); resolve(msg); });
            input.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: step.tool, arguments: step.args } }) + "\n");
        });
        waiting.delete(id);
        const forwarded = forwardedIds.has(id);
        steps.push({ tool: step.tool, malicious: !!step.malicious, forwarded, policy: reply?.error?.data?.policy, message: reply?.error?.message });
        if (!forwarded) break; // the agent cannot continue without the result
    }
    input.end();

    const succeeded = scenario.kind === "attack"
        ? steps.some(s => s.malicious && s.forwarded)
        : steps.length === scenario.steps.length && steps.every(s => s.forwarded);
    return { id: scenario.id, steps, succeeded };
}
