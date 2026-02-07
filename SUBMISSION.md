# Hackathon Submission Details

**Project Name:** AgentBrake
**Tagline:** Run AI agents at full throttle — without losing control.

## Project Description (The Pitch)
In the race to build autonomous agents, everyone is building faster engines. We built the brakes.

**AgentBrake** is an infrastructure-grade safety layer for the Model Context Protocol (MCP). It acts as a transparent proxy between your Agent Runtime (like Archestra) and your tools, enforcing real-time policies to prevent rogue behavior, infinite loops, and cost explosions.

While other tools observe failures *after* they happen, AgentBrake intervenes *during* execution. If an agent tries to call a forbidden tool or exceeds its budget, AgentBrake cuts the connection instantly, returning a structured policy violation error.

It is designed as a drop-in middleware: zero code changes to your agent, zero code changes to your tools. Just pure, scalable governance.

> **AgentBrake applies Kubernetes-style guardrails—quotas, policies, and kill-switches—to MCP-based AI agents.**

## How we address the Judging Criteria

### 🎯 Potential Impact
As agents move from "demo" to "production", safety is the #1 blocker. AgentBrake solves the critical pain points of **Runaway Costs** and **Unintended Actions**, making it safe for enterprises to deploy MCP agents at scale.

### 💡 Creativity & Originality
Most participants are building *agents*. We built *infrastructure* for agents. We realized that for Archestra to become the "Kubernetes of Agents", it needs a Sidebar/Proxy pattern for governance. AgentBrake is that missing piece.

### 🛠️ Technical Implementation
We built a robust **MCP JSON-RPC Interceptor** in TypeScript.
- **Proxy Architecture**: Manages stdio streams between parent and child processes.
- **Policy-as-Code (V2)**: Integrated **Zod-validated YAML configuration engine** (`agent-brake.yml`). No more hardcoded env vars; policies are versionable artifacts.
- **Configurable Trust Levels**: Support for `sandbox`, `trusted`, and `privileged` execution tiers.
- **Observability**: Emits structured JSON logs compatible with enterprise monitoring stacks (Datadog/ELK).

### 🤝 Best Use of Archestra
AgentBrake is built *for* the Archestra ecosystem. It leverages the open nature of MCP to provide a universal "Control Plane" that Archestra can orchestrate. It proves that Archestra isn't just for running agents—it's for running them *safely*.

## Tech Stack
- TypeScript
- Model Context Protocol (MCP) SDK
- Node.js (Child Processes & Streams)
- Docker (ready)

## Demo Instructions
1. Clone the repo.
2. Run `npm install && npm run build`.
3. Run `node dist/demo/rogue-run.js` to see a simulated "Rogue Agent" get caught in a loop and blocked by AgentBrake in real-time.
