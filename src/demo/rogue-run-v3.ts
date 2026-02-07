import { spawn } from "child_process";
import path from "path";

async function run() {
    const proxyPath = path.resolve(__dirname, "../../dist/proxy/index.js");
    const toolsPath = path.resolve(__dirname, "../../dist/demo/tools-server.js");

    const child = spawn("node", [proxyPath, "node", toolsPath], {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env }
    });

    child.stdout.on("data", (data) => {
        console.log(`[Response]: ${data.toString().trim()}`);
    });

    let idCounter = 1;
    const send = (method: string, params: any) => {
        const msg = { jsonrpc: "2.0", id: idCounter++, method, params };
        console.log(`[Sending]: ${JSON.stringify(msg)}`);
        child.stdin.write(JSON.stringify(msg) + "\n");
    };

    console.log("--- Semantic Firewall Demo ---\n");

    setTimeout(() => {
        console.log("[Test 1] Reading /tmp/safe.txt (Should ALLOW)...");
        send("tools/call", { name: "read_file", arguments: { path: "/tmp/safe.txt" } });
    }, 1000);

    setTimeout(() => {
        console.log("\n[Test 2] Reading /etc/passwd (Should BLOCK)...");
        send("tools/call", { name: "read_file", arguments: { path: "/etc/passwd" } });
    }, 2500);

    setTimeout(() => {
        console.log("\n[Test 3] Reading /home/user/.secret (Should BLOCK)...");
        send("tools/call", { name: "read_file", arguments: { path: "/home/user/.secret" } });
    }, 4000);

    setTimeout(() => {
        console.log("\n[Done] Demo Complete.");
        child.kill();
        process.exit(0);
    }, 6000);
}

run().catch(console.error);
