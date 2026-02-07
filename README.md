# AgentBrake 🛡️

**A safety, cost, and control layer for MCP-based AI agents.**

> *Run AI agents at full throttle — without losing control.*

> **"AgentBrake applies Kubernetes-style guardrails—quotas, policies, and kill-switches—to MCP-based AI agents."**

AgentBrake is an infrastructure-grade **MCP Proxy** that provides runtime monitoring, policy enforcement, and live intervention for AI agents. It works with any MCP-compliant platform (like Archestra) to prevent runaway loops, tool abuse, and cost explosions.

```yaml
# Quick Look: Policy-as-Code
agent: rogue-agent
trust_level: sandbox
policies:
  max_tool_calls: 5
  allowed_tools:
    - read_file
  on_violation: block
```

---

## 🏗️ Architecture

AgentBrake sits as a middleware between your Agent Runtime (Archestra) and the Tool Servers. It intercepts every JSON-RPC message to enforce policies in real-time.

```ascii
   [ Agent Runtime ]           [ AgentBrake Proxy ]             [ Tool Server ]
   (Archestra Client)          (Governance Layer)               (MCP Service)
          |                            |                              |
          |  call_tool()               |                              |
          | -------------------------> |  intercept()                 |
          |                            |  + Check Policies            |
          |                            |  + Log Metrics               |
          |                            |                              |
          |                            |  (If Allowed)                |
          |                            | ---------------------------> |  Execute
          |                            | <--------------------------- |
          |                            |                              |
          | <------------------------- |                              |
          |                            |                              |
          |                            |  (If Violated)               |
          | <------------------------- X  BLOCK REQUEST               |
                                       |  Return Error:               |
                                       |  "Policy Violation"          |
```

## 🚀 Key Features

### 1. 🛑 Live Intervention
Most monitoring tools just alert you *after* a disaster. AgentBrake **stops the request** before it happens.
- **MaxToolCalls**: Prevents infinite loops.
- **AllowedTools**: Restricted execution for untrusted agents.
- **MaxRuntime**: Hard time limit for execution.

## Configuration (V2: Policy-as-Code)
AgentBrake uses a YAML/JSON configuration file (`agent-brake.yml`) to define policies, trust levels, and limits.

```yaml
version: "2.0"
agent:
  name: "analyzer-agent"
  trust_level: "sandbox" # sandbox | limited | trusted

policies:
  global:
    on_violation: "block" # warn | block | kill
  
  limits:
    max_tool_calls: 20
    max_runtime_seconds: 60
  
  security:
    allowed_tools: 
      - "read_file"
      - "calculator"
    # All other tools are blocked by default if allowed_tools is set
```

### Usage
```bash
# Start the proxy (auto-loads agent-brake.yml from CWD)
npx agent-brake --target "node my-mcp-server.js"
```

### 3. 📊 Observability
Emits structured JSON events for every intervention, ready for ELK/Datadog ingestion.
```json
{
  "timestamp": "2026-02-03T18:00:00Z",
  "event": "POLICY_VIOLATION",
  "policy": "AllowedToolsPolicy",
  "reason": "Tool 'delete_file' is not in the allowed list",
  "action": "BLOCKED"
}
```

---

## 🛠️ Installation & Usage

### 1. Build
```bash
npm install
npm run build
```

### 2. Run with Archestra / Any MCP Client
Wrap your existing tool server command with AgentBrake:

```bash
# Before
node my-tools-server.js

# With AgentBrake
export MAX_TOOL_CALLS=10
node dist/proxy/index.js node my-tools-server.js
```

### 3. Run Demo "Rogue Agent"
We include a simulation of a rogue agent attempting to break policies.

```bash
node dist/demo/rogue-run.js
```

## 🔮 Future Roadmap (V3)
We are already designing **AgentBrake V3: The Semantic Firewall**.
Planned features include:
- **Granular Argument Filtering**: Regex-based DLP (e.g., allow `read_file` only for `/tmp/*`).
- **Interactive Sudo Mode**: Human-in-the-loop approval for blocked actions.
- **Auto-Profiling**: Record "Gold Standard" runs to auto-generate policies.

[View the full V3 Roadmap](./ROADMAP_V3.md)

