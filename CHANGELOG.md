# Changelog

## 2.0.0 (not yet published; released by CI when pushed to main)

### Added
- **Secret-flow tracking** (`policies.flow`): results of protected sources, and any result containing a
  known credential format, are remembered as winnowed fingerprints; tool calls that would carry
  that data out (also after base64, hex, percent decoding or reversal) are refused, naming the source.
- **Lethal-trifecta check**: outgoing calls are escalated once a session has read protected data and
  taken in untrusted content.
- **Typed argument rules** (`security.argument_rules`): `path` rules compare by directory boundary after
  resolving `..`, `~` and `file:` URLs (optional realpath); `url` rules use WHATWG parsing, host allow and
  deny lists, and block loopback, private, link-local and metadata targets in any spelling (optional DNS check).
- `tools/list` responses hide tools that allow or deny lists would refuse.
- Decision traces on every refusal.
- Budget: `cost_per_call`, `tool_costs`; `warn_threshold` and `currency` now take effect.
- `global.on_violation` is the default action for rules that do not set one.
- The Gauntlet (`npm run gauntlet`): 21 attacks and 10 benign tasks, three configurations, CI regression gate.
- Latency benchmark (`npm run bench`).
- README demo GIF drawn from recorded proxy output (`npm run demo:gif`).

### Fixed
- Calls blocked by a later policy no longer use up rate-limit quota, budget or approval tokens
  (policies now validate, then commit only when the call is forwarded).
- `max_runtime_seconds` starts at session start and is enforced by a timer, not only when a call arrives.
- Approval keys ignore argument order.
- Runtime history is bounded; violation logs no longer grow with the session.
- Circuit breaker: half-open state reopens after one failed trial call.
- Rate limit reports the real retry-after time.

### Changed
- **Breaking:** `require("agentbrake")` now loads a library entry (`dist/src/index.js`) exporting the proxy, policies and flow-tracking primitives; in 1.0.0 `main` pointed at the CLI, which ran on import. The `agent-brake` binary is unchanged.
- **Breaking (library API):** `Policy.observeResult` now receives one `ToolOutcome` object; policies record usage in a new `commit()` hook instead of `validate()`; `AgentRuntimeState` drops `estimatedCost` and `history`.
- **Breaking:** requires Node 20 or newer; CI tests Node 20, 22 and 24.
- Docker base image `node:22-alpine`; CI builds and smoke-tests the image on every push, and skips
  publishing when Docker Hub credentials are not configured.
- `agent.trust_level` and `policies.global.max_retries` log a warning (accepted, not enforced).

## 1.0.0 (2026-02-10)

First npm release (built from commit 0fc99c8). Does not include the fail-closed fixes of commit 373adcd (2026-09-28), which ship in 2.0.0.
