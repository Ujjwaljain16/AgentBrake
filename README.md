# AgentBrake 🛡️

**The Safety Control Plane for AI Agents.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker Image](https://img.shields.io/badge/docker-pull-blue)](https://hub.docker.com/r/ujjwaljain16/agentbrake)

> **"Run AI agents at full throttle — without losing control."**

AgentBrake is a transparent **Model Context Protocol (MCP)** proxy that enforces safety policies on AI tool calls in real-time. It sits between your agent (Archestra, LangChain, etc.) and your tools, blocking dangerous actions before they happen.

---

## 🚀 Quick Demo: Stop a Rogue Agent

See AgentBrake intercept a simulated "Rogue Agent" trying to steal secrets.

### Option 1: Docker (Recommended)

```bash
# 1. Start the proxy
docker compose up -d

# 2. Run the Rogue Agent Attack simulation
docker compose run agent-brake node dist/examples/rogue-agent-attack.js
```

### Option 2: Local (Node.js)

```bash
npm install
npm run build
npm run demo:rogue
```

**What you'll see:**
- ✅ **Allow:** Safe tools (calculator) pass through.
- 🛡️ **Block:** DLP rules stop access to `/app/.env`.
- ⏳ **HITL:** Critical actions trigger Human-in-the-Loop approval.

---

## ✨ Features

- **🛡️ Semantic Firewall:** Block tools based on arguments (regex), not just names.
  - *Example:* Allow `read_file` only for `/tmp/*`. Block `*.env`.
- **💰 Budget Enforcement:** Limit spending per session (Mock currency or token counts).
- **🔌 Circuit Breaker:** Auto-cut connection if tools fail repeatedly (e.g., 5 errors in 60s).
- **👮 Human-in-the-Loop:** Pause execution for approval via Slack/Webhook for sensitive actions.
- **📜 Policy-as-Code:** Configure everything via a single YAML file (`enterprise-config.yml`).
- **📊 JSON Logging:** Structured logs for every decision (`ALLOW`, `BLOCK`, `KILL`).

---

## ⚙️ Configuration

Create an `enterprise-config.yml` (or mount it in Docker):

```yaml
version: "3.0"
agent:
  name: "production-agent"
  trust_level: "sandbox"

policies:
  global:
    on_violation: "block"

  limits:
    budget:
      max_cost: 50.0
      warn_threshold: 0.8
    circuit_breaker:
      failure_threshold: 5
      reset_timeout_seconds: 60

  security:
    allowed_tools:
      - "read_file"
      - "search_web"
    
    # Granular DLP Rules
    granular_rules:
      - tool: "read_file"
        deny_if:
          arguments:
            path: ".*(password|secret|\\.env).*"
        action: "kill"
```

---

## 📦 Installation

### Docker
```yaml
services:
  agent-brake:
    image: ujjwaljain16/agentbrake:latest
    volumes:
      - ./my-config.yml:/app/enterprise-config.yml:ro
    ports:
      - "3000:3000"
```

### NPM
```bash
npm install
npm run build
# Wrap your MCP server
node dist/proxy/index.js node path/to/your/server.js
```

---

## 🛣️ Roadmap

- [x] **V1:** Basic Allow/Block Policies
- [x] **V2:** Regex DLP & Logging
- [x] **V3:** Resilience (Circuit Breaker, Budget, HITL)
- [ ] **V4:** Sandbox isolation & Multi-agent orchestration support

---

## 🤝 Contributing

Pull requests are welcome! Please run `npm test` before submitting.

## 📄 License

MIT © Ujjwal Jain
