<p align="center">
  <h1 align="center">🛡️ AgentBrake</h1>
  <p align="center"><strong>The Control Plane for AI Agents</strong></p>
  <p align="center">
    <em>Run AI agents at full throttle — without losing control.</em>
  </p>
</p>

<p align="center">
  <a href="#-what-is-agentbrake">What</a> •
  <a href="#-the-problem">Why</a> •
  <a href="#-key-features">Features</a> •
  <a href="#-how-it-works">How</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-configuration">Config</a> •
  <a href="#-roadmap">Roadmap</a>
</p>

---

> **"AgentBrake applies Kubernetes-style guardrails—quotas, policies, and kill-switches—to MCP-based AI agents."**

---

## 🤖 What is AgentBrake?

**AgentBrake** is an infrastructure-grade **safety proxy** for AI agents using the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). 

It sits between your agent orchestrator (like Archestra, LangChain, or any MCP client) and your tool servers, intercepting every tool call to enforce policies in **real-time**.

Think of it as a **firewall for AI agents** — but smarter.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Agent Runtime  │ ──▶ │   AgentBrake    │ ──▶ │   Tool Server   │
│   (Archestra)   │     │  (Proxy Layer)  │     │   (MCP APIs)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  Policy Engine  │
                    │  • MaxToolCalls │
                    │  • AllowedTools │
                    │  • MaxRuntime   │
                    │  • Granular DLP │
                    └─────────────────┘
```

---

## 🔥 The Problem

AI agents are powerful. **Too powerful.**

When you give an agent access to tools like `read_file`, `execute_code`, or `send_email`, you're trusting it to behave. But agents can:

| Problem | Real-World Impact |
|---------|-------------------|
| 🔄 **Infinite Loops** | Agent calls the same tool forever, burning API credits |
| 💸 **Cost Explosions** | Unchecked execution racks up $1000+ bills in minutes |
| 🔓 **Tool Abuse** | Agent accesses sensitive tools it shouldn't touch |
| 📂 **Data Exfiltration** | Agent reads `/etc/passwd` or database credentials |
| ⏰ **Runaway Sessions** | Agent runs for hours with no supervision |

**Current solutions?** Hope and pray. Or manually babysit every agent run.

**AgentBrake?** Declarative policies that enforce guardrails automatically.

---

## ✨ Key Features

### 1. 🛑 Live Intervention (Not Just Logging)
Most monitoring tools alert you *after* the damage is done. AgentBrake **blocks the request before it executes**.

### 2. 📜 Policy-as-Code
Define all your safety rules in a single `agent-brake.yml` file. No code changes. Version-controlled. Auditable.

```yaml
version: "3.0"
agent:
  name: "data-analyst"
  trust_level: "sandbox"

policies:
  limits:
    max_tool_calls: 50
    max_runtime_seconds: 300
  
  security:
    allowed_tools:
      - "read_file"
      - "calculator"
```

### 3. 🧬 Semantic Firewall (Unique to AgentBrake)
Go beyond "allow this tool" to **"allow this tool with these arguments"**.

```yaml
granular_rules:
  - tool: "read_file"
    allow_if:
      arguments:
        path: "^/tmp/.*"        # ✅ Only allow /tmp paths
  
  - tool: "read_file"
    deny_if:
      arguments:
        path: ".*(passwd|secret|\.env).*"  # 🛑 Block sensitive files
    action: "kill"
```

**This is Data Loss Prevention (DLP) for AI agents.**

### 4. ⚡ Action Engine
Not just "allow" or "deny". AgentBrake supports **graded responses**:

| Action | Behavior |
|--------|----------|
| `warn` | Log the violation, but let the request through |
| `block` | Reject this specific request |
| `kill` | Terminate the entire agent session |
| `sandbox` | Downgrade trust level (coming soon) |

### 5. 📊 Structured Observability
Every intervention emits a JSON log, ready for ELK, Datadog, or any monitoring stack:

```json
{
  "timestamp": "2026-02-07T12:00:00Z",
  "event": "POLICY_VIOLATION",
  "policy": "GranularAccessPolicy",
  "action": "BLOCK",
  "tool": "read_file",
  "reason": "Arguments match DENY pattern: /etc/passwd"
}
```

### 6. 🔐 Trust Levels
Assign agents a trust tier that determines their capabilities:

| Level | Use Case |
|-------|----------|
| `sandbox` | Untested agents, strict limits |
| `limited` | Dev/staging agents |
| `trusted` | Production-vetted agents |
| `privileged` | Admin-level agents (use sparingly) |

---

## ⚙️ How It Works

AgentBrake is a **transparent MCP proxy**. It intercepts JSON-RPC messages between your agent and tools.

```
1. Agent sends: tools/call { name: "read_file", arguments: { path: "/etc/passwd" } }
2. AgentBrake intercepts ─────────────────────────────────────────────────────┐
3. Policy Engine evaluates:                                                    │
   - MaxToolCallsPolicy: ✅ Under limit                                       │
   - AllowedToolsPolicy: ✅ "read_file" is allowed                            │
   - GranularAccessPolicy: ❌ Path matches deny pattern!                      │
4. Action: BLOCK ◀───────────────────────────────────────────────────────────┘
5. Agent receives: error { code: -32000, message: "[AgentBrake] BLOCK: ..." }
```

The tool server **never sees the dangerous request**. The agent is stopped at the gate.

---

## 🚀 Quick Start

### Installation
```bash
# Clone the repository
git clone https://github.com/Ujjwaljain16/AgentBrake.git
cd AgentBrake

# Install dependencies
npm install

# Build
npm run build
```

### Run with Your Tool Server
```bash
# Wrap your existing MCP tool server
node dist/proxy/index.js node my-tools-server.js
```

### Run the Demo (See AgentBrake in Action)
```bash
# V3 Demo: Watch a rogue agent get blocked by the Semantic Firewall
node dist/demo/rogue-run-v3.js
```

---

## 📝 Configuration

Create an `agent-brake.yml` in your project root:

```yaml
version: "3.0"

agent:
  name: "my-agent"
  trust_level: "sandbox"

policies:
  global:
    on_violation: "block"
  
  limits:
    max_tool_calls: 100
    max_runtime_seconds: 600
  
  security:
    allowed_tools:
      - "calculator"
      - "read_file"
      - "write_file"
    
    # V3: Semantic Firewall
    granular_rules:
      - tool: "read_file"
        deny_if:
          arguments:
            path: ".*(passwd|shadow|\.env|secret).*"
        action: "kill"
      
      - tool: "write_file"
        allow_if:
          arguments:
            path: "^/tmp/.*"
```

---

## 🎯 What Problems Does AgentBrake Solve?

| Use Case | Without AgentBrake | With AgentBrake |
|----------|-------------------|-----------------|
| **Cost Control** | Agent burns $500 in API calls | Hard limit at N tool calls |
| **Security** | Agent reads secrets.env | DLP blocks sensitive patterns |
| **Compliance** | No audit trail | JSON logs for every action |
| **Reliability** | Agent loops forever | Auto-kill after timeout |
| **Governance** | Trust everything blindly | Trust levels + policies |

---

## 🛤️ Roadmap

### ✅ V1 (Complete)
- MCP Proxy with stdio piping
- MaxToolCalls, AllowedTools, MaxRuntime policies
- Structured JSON logging

### ✅ V2 (Complete)
- Policy-as-Code (YAML configuration)
- Zod-validated schema
- Trust Levels
- Action Engine (warn/block/kill)

### ✅ V3 (Complete)
- **Semantic Firewall**: Regex-based argument filtering
- Granular Access Policy for DLP

### 🔜 V4 (Planned)
- **Rate Limiting**: Throttle with exponential backoff instead of hard block
- **Webhook Alerts**: Real-time Slack/Discord notifications
- **Interactive Sudo Mode**: Human-in-the-loop approval for blocked actions
- **Observation Mode**: Auto-generate policies from "gold standard" runs

---

## 🏆 Why Use AgentBrake?

| Other Tools | AgentBrake |
|-------------|------------|
| Log after the fact | **Block before execution** |
| Tool-level control | **Argument-level control (DLP)** |
| Hardcoded policies | **Policy-as-Code (YAML)** |
| Binary allow/deny | **Graded actions (warn/block/kill)** |
| One-size-fits-all | **Trust levels per agent** |

**AgentBrake is the only MCP proxy that does Data Loss Prevention.**

---

## 📄 License

MIT

---

## 🤝 Contributing

PRs welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

<p align="center">
  <strong>Built for the Archestra Hackathon 2026</strong><br>
  <em>Because agents need brakes too.</em>
</p>
