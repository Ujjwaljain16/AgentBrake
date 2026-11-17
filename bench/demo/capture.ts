/**
 * Records the real proxy output used by the README demo GIF.
 *
 * Runs selected Gauntlet scenarios through the real proxy with the baseline and AgentBrake
 * configs, and writes what each call returned to docs/media/demo-transcript.json. The GIF is
 * rendered from that file by render_gif.py, so every line in it comes from an actual run.
 *
 *   npm run build && node dist/bench/demo/capture.js && python bench/demo/render_gif.py
 */
import * as fs from "fs";
import * as path from "path";
import { ConfigLoader } from "../../src/config/loader.js";
import { buildPolicies } from "../../src/proxy/build.js";
import { SCENARIOS } from "../scenarios.js";
import { runScenario } from "../driver.js";
import { HOME } from "../world.js";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const config = (file: string) => () =>
    buildPolicies(ConfigLoader.load(path.join(ROOT, "bench", "configs", file)), { platform: "posix", homeDir: HOME });

/** Scenarios shown in the GIF, in order, with a one-line caption each. */
const SHOWN: Array<{ id: string; caption: string }> = [
    { id: "E02", caption: "read customer data, then POST it base64-encoded" },
    { id: "E10", caption: "a web page injects instructions; agent paraphrases the data out" },
    { id: "A05", caption: "fetch the cloud metadata service as a decimal IP" },
    { id: "A01", caption: "path traversal out of the data directory" }
];

/** Short, readable rendering of a tool call's arguments. */
function summarize(tool: string, args: Record<string, unknown>): string {
    if (typeof args.path === "string") return args.path;
    if (typeof args.url === "string") {
        const url = args.url.length > 46 ? args.url.slice(0, 43) + "..." : args.url;
        return tool === "http_post" ? `${url}  body=<${String(args.body ?? "").length} bytes>` : url;
    }
    if (typeof args.to === "string") return `to=${args.to}`;
    return "";
}

async function main() {
    console.error = () => undefined;
    const baseline = config("baseline.yml");
    const agentbrake = config("agentbrake.yml");

    const scenes = [];
    for (const { id, caption } of SHOWN) {
        const scenario = SCENARIOS.find(s => s.id === id)!;
        const base = await runScenario(scenario, baseline());
        const ab = await runScenario(scenario, agentbrake());
        scenes.push({
            id,
            caption,
            steps: scenario.steps.map((step, i) => ({
                tool: step.tool,
                args: summarize(step.tool, step.args),
                malicious: !!step.malicious,
                baseline: base.steps[i] ? { forwarded: base.steps[i].forwarded } : null,
                agentbrake: ab.steps[i]
                    ? { forwarded: ab.steps[i].forwarded, policy: ab.steps[i].policy ?? null, message: ab.steps[i].message ?? null }
                    : null
            }))
        });
    }

    const gauntlet = JSON.parse(fs.readFileSync(path.join(ROOT, "bench", "results", "gauntlet.json"), "utf8"));
    const out = { scenes, summary: gauntlet.summary };
    const file = path.join(ROOT, "docs", "media", "demo-transcript.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
    console.log(`Wrote ${path.relative(ROOT, file)}`);
}

main().catch(err => {
    process.stderr.write(String(err) + "\n");
    process.exitCode = 1;
});
