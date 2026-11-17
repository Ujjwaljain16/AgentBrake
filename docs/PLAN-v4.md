# AgentBrake v4 plan

**Status (2026-11-15):** Phases 0-3 implemented. Gauntlet: 18/21 attacks blocked vs 2/21 for the
allow-list + regex baseline, 0/10 false positives; ~0.1 ms p50 overhead per call; demo GIF
rendered from real proxy output. Not yet verified: CI on GitHub, the Docker build.

**Goal:** one measured, reproducible claim a stranger remembers:

> AgentBrake blocks **N of M** scripted data-exfiltration attacks against MCP agents, versus
> **X of M** for a plain tool allow-list, adding **Y ms** p99 per call.

Scope is deliberately trimmed to what the sibling project *Warrant* does not already do.
Warrant checks whether an agent's "done" claim is true after the fact (hash-chained logs, a
run viewer, a fault-injection benchmark). AgentBrake controls what an agent can do *while it
runs*. No tamper-evident log, replay or dashboard here: that would duplicate Warrant.

## Phase 0: correctness and production hardening
- Policies only use up quota (rate limit, budget, approval tokens) when a call is actually
  forwarded: a `commit` step runs after every policy has passed.
- Each blocked call logs a decision trace (which policies ran and what each said).
- Runtime history is bounded; violation logs carry counters, not the whole history.
- `tools/list` responses hide tools the policy would refuse.
- Approval keys use canonical JSON (argument order no longer matters).
- `max_runtime_seconds` starts at session start and is enforced by a hard timer.
- One cost model (configurable per tool), `warn_threshold` wired; ignored config fields warn.
- No `as any` on the enforcement path.
- CI: supported Node versions only; the Docker publish job skips cleanly without secrets.

## Phase 1: argument checks that understand paths and URLs
Regexes on raw strings are bypassable (`/tmp/../etc/passwd` matches `^/tmp/`). Typed
argument rules normalise first:
- `path`: resolve `.`/`..`, unify separators, decode percent-escapes, case-fold on request;
  `within` / `not_within` lists.
- `url`: WHATWG parse, lower-case host, reject userinfo tricks; `allowed_hosts` (suffix match),
  `allowed_schemes`, `block_private_networks` (loopback, RFC 1918, link-local incl.
  `169.254.169.254`, IPv6 ULA, decimal/hex/octal IPv4 forms).

## Phase 2: secret-flow tracking across tool calls (the headline)
Stops the "lethal trifecta": private data + untrusted content + a way to send data out.
- **Sources**: tools (optionally with argument conditions) whose results carry a label
  (`secret`, `pii`, `untrusted`).
- **Fingerprints**: results from labelled sources are normalised and fingerprinted with
  **winnowing** over k-gram rolling hashes (the MOSS algorithm), so fragments are recognised
  later even when partial or embedded in other text.
- **Decoders**: sink arguments are also checked after base64, base64url, hex and percent
  decoding, so laundering by encoding is caught.
- **Sinks**: egress tools (`http_post`, `send_email`, ...). A sink call whose arguments
  contain tainted fingerprints is blocked; the error names the source call.
- **Session escalation**: once untrusted content has entered the session, sinks can be
  set to require approval or be blocked outright.
- Bounded memory (capped fingerprint store), measured in the benchmark.

## Phase 3: proof
- **Attack scoreboard**: about 20 deterministic, scripted attacks against a mock MCP
  server, run three ways: no proxy, allow-list only, full AgentBrake. CI prints the table.
  No API keys, no live client.
- **Latency benchmark**: p50/p99 overhead per call and fingerprinting cost vs payload size.
- README rewrite around the measured numbers; demo GIF.

## Out of scope (for now)
Tamper-evident logs, replay, dashboard (Warrant covers these ideas), learn mode,
Streamable HTTP transport, a real-LLM attack mode (would need a paid API key).
