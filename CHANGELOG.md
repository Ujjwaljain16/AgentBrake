# Changelog

## 2.0.1 (2026-11-17)

- Documentation: rewritten README and a new design document (`docs/DESIGN.md`).
- Removed unused webhook notifier and demo modules from the package.

## 2.0.0 (2026-11-17)

### Added

- Secret-flow tracking (`policies.flow`): protected results and detected credentials are
  fingerprinted, and calls that would send that data out, also when encoded, reversed or
  reformatted, are refused with the source named.
- Lethal-trifecta check: outgoing calls are escalated once a session holds protected data and has
  taken in untrusted content.
- Typed argument rules (`security.argument_rules`) for paths and URLs.
- `tools/list` responses omit tools that policy would refuse.
- Decision traces on every refusal.
- Budget `cost_per_call` and per-tool `tool_costs`; `warn_threshold` and `currency` take effect.
- `global.on_violation` sets the default action for rules.
- Library entry point exporting the proxy, policies and flow-tracking primitives.
- Gauntlet attack benchmark, latency benchmark and demo recorder under `bench/`.

### Fixed

- Calls refused by a later policy no longer consume rate-limit, budget or approval state.
- `max_runtime_seconds` is enforced by a timer from session start.
- Approval keys no longer depend on argument order.
- Runtime history is bounded and log lines no longer grow during a session.
- The circuit breaker reopens after a failed trial call.
- Rate-limit errors report the real retry time.

### Changed

- **Breaking:** requires Node.js 20 or later.
- **Breaking:** `require("agentbrake")` loads the library instead of starting the CLI. The
  `agent-brake` command is unchanged.
- **Breaking:** `Policy.observeResult` receives a `ToolOutcome`; usage is recorded in the new
  `commit()` hook; `AgentRuntimeState` no longer has `estimatedCost` or `history`.
- Settings that are accepted but not enforced log a warning at startup.

## 1.0.0 (2026-02-10)

- Initial release: stdio MCP proxy with allow and deny lists, regex argument rules, call, runtime,
  rate and budget limits, circuit breaker, and fail-closed configuration.
