# 🔮 AgentBrake V3 Roadmap: The Semantic Firewall

To move beyond "Infrastructure Controls" (Frequency/Cost) to "Data Security" (Semantics), AgentBrake V3 introduces context-aware enforcement.

## 1. Semantic Argument Filters ("The Data Firewall")
**Problem:** `AllowedTools: ["read_file"]` is too broad. It allows reading `/etc/passwd` just as easily as `/tmp/log.txt`.
**Solution:** Granular, regex-based argument validation.

```yaml
policies:
  security:
    granular_rules:
      - tool: "read_file"
        allow_if:
          arguments:
            path: "^/tmp/.*" # Only allow paths starting with /tmp/
      - tool: "sql_query"
        deny_if:
          arguments:
            query: "(?i)DROP TABLE" # Prevent destructive SQL 
```
**Why Unique?** No other MCP proxy inspects the *payload* to this depth. It turns AgentBrake into a **Data Loss Prevention (DLP)** tool.

---

## 2. Interactive "Sudo Mode" (JIT Escalation)
**Problem:** Blocking an agent kills the workflow. Sometimes the agent is *right*, but the policy is too strict.
**Solution:** A `REQUEST_APPROVAL` action.

1. Agent tries to call `delete_file`.
2. Policy triggers `action: request_approval`.
3. AgentBrake pauses the request.
4. Returns a special "Approval Needed" signal to the Orchestrator.
5. Human approves → Request resumes.

**Why Unique?** It bridges the gap between "Autonomy" and "Control". It's **sudo for AI agents**.

---

## 3. "Observation Mode" (Auto-Profiling)
**Problem:** Writing policies from scratch is hard.
**Solution:** Run AgentBrake in `mode: observe`. 
- It records every tool call an agent makes during a "Gold Standard" run.
- It generates a strict `agent-brake.yml` automatically based on that run.
- "Lock in" the profile for production.

**Why Unique?** Zero-config security. "Record & Replay" governance.

---

## 🚀 Recommendation for "Uniqueness" NOW
We can implement **#1 (Semantic Argument Filters)** *right now*. 
It requires adding a simple Regex Matcher to the Policy Engine. 

This would allow you to demo: **"Blocking an agent from reading sensitive files, while allowing it to read safe files."**
That is a **showstopper feature**.
