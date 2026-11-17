# Design

AgentBrake is a reference monitor for MCP tool calls: every `tools/call` from the client passes
through it, and every response from the server is observed by it. This document describes how
each part works and why it is built that way.

## Architecture

```
client ──stdin──▶ LineFramer ──▶ parse & validate JSON-RPC ──▶ policy chain ──▶ child stdin
client ◀─stdout── filter tools/list ◀── observe result ◀── LineFramer ◀── child stdout
```

| Module | Responsibility |
|---|---|
| `src/proxy/framing.ts` | Newline framing on raw bytes, size limits, strict UTF-8 decoding |
| `src/proxy/interceptor.ts` | JSON-RPC handling, the two-phase policy chain, response observation |
| `src/policy/policies/` | One class per policy |
| `src/policy/semantic/` | Path and URL canonicalisation |
| `src/flow/` | Fingerprinting, decoders, credential detectors, taint store |
| `src/config/` | Zod schema and fail-closed loader |

## Enforcement pipeline

**Framing.** Client input is split on the `0x0A` byte before decoding, so a multi-byte character
split across reads is reassembled, and a line is only acted on once complete. Oversized lines are
rejected once and the framer resynchronises on the next newline.

**Parsing.** Batches, non-objects, invalid UTF-8 and malformed `tools/call` parameters are refused.
The forwarded message is re-serialised from the parsed value, so the server receives exactly what
the policies inspected (no duplicate-key or parser-differential tricks).

**Two-phase evaluation.** Each policy's `validate()` decides without side effects. Only when every
policy passes does each `commit()` record usage: a rate-limit slot, budget spend, a consumed
approval. A call refused by a later policy therefore costs nothing. Any exception in either phase
refuses the call.

**Decision traces.** Every refusal is logged with the verdict of each policy that ran, and logs
carry fixed-size counters rather than session history, so log lines do not grow over time.

**Observation.** Server responses are matched to forwarded calls by id. Outcomes feed the circuit
breaker; result content feeds flow tracking; `tools/list` responses are filtered through each
policy's `isToolVisible()` so refused tools are never offered to the model.

## Typed argument rules

String patterns are a poor fit for structured values: `/tmp/../etc/passwd` matches `^/tmp/`, and an
IP address has many spellings.

**Paths** are canonicalised the way the target server will interpret them: `file:` URLs decoded,
`~` expanded, resolved against a base directory, `.` and `..` removed. On Windows, device prefixes
are stripped, alternate data streams rejected, trailing dots and spaces dropped, and comparison is
case-insensitive. Containment is tested component by component, so `/tmpfoo` is not inside `/tmp`.
`resolve_symlinks` applies `realpath` to the longest existing prefix.

**URLs** are parsed with the WHATWG parser used by `fetch()`, which lower-cases hosts, converts IDN
to punycode and normalises decimal, hex and octal IPv4. Hosts are then classified against loopback,
RFC 1918, carrier-grade NAT, link-local (including `169.254.169.254`), multicast and reserved IPv4
ranges, and loopback, unique-local, link-local, IPv4-mapped and NAT64 IPv6 ranges. Host patterns
are exact or `*.domain` (subdomains only). With `resolve_dns`, a host that resolves to any private
address, or does not resolve, is refused.

Arguments that are neither strings nor lists of strings fail closed.

## Secret-flow tracking

The goal is to notice when data returned by one call leaves through another, including partial,
reformatted and encoded copies, without storing the data itself.

**Normalisation.** NFKC, lower case, then only `[a-z0-9]` is kept. Whitespace, punctuation, case and
full-width characters no longer matter.

**Fingerprints.** Every k-gram (default k = 16) is hashed with two independent 32-bit polynomial
rolling hashes combined into a 53-bit value, which is exact in a JavaScript number and makes random
collisions negligible at the stored volumes. Winnowing (Schleimer, Wilkerson and Aiken, 2003) keeps
the minimum hash of each window of w = 5 consecutive k-grams. Any shared normalised run of
k + w − 1 = 20 characters is guaranteed to share a fingerprint, while only about 2/(w+1) of the
hashes are stored. The guarantee is property-tested over random inputs.

**Credentials.** Results of any tool are scanned for private-key blocks, AWS keys, GitHub, Slack and
Stripe tokens, `sk-` keys, Google API keys, JWTs and `*_SECRET=` / `*_PASSWORD=` style assignments.
Values long enough for the guarantee are fingerprinted; shorter ones are kept as exact literals.

**Checking sinks.** The string leaves of a call's arguments are joined and checked as-is, and after
base64, base64url, hex and percent decoding (applied recursively to depth 2 under an output budget)
and reversal. The best match reports its source call, label and decoding.

**Session escalation.** Untrusted sources do not add fingerprints. Instead, once the session holds
protected data and has taken in untrusted content, sink calls receive the `lethal_trifecta` action,
covering paraphrased leaks that leave no verbatim trace.

**Bounds.** The fingerprint store is capped and evicts whole sources, oldest first. A protected
result too large to fingerprint completely, or a sink argument above `max_sink_chars`, refuses the
sink call rather than checking it partially.

**Trade-offs.** Matching is lexical: paraphrase without untrusted input and drip-fed fragments under
20 characters are not detected, and shared boilerplate can produce false positives. Narrow sources
and `exempt_sinks` keep the latter rare.

## Evaluation

**Gauntlet** (`bench/gauntlet.ts`). Scripted tool-call sequences run through the real `BrakeProxy`
against an in-memory MCP server (`bench/world.ts`), under three configurations: no policy, an
allow-list with regex rules (`bench/configs/baseline.yml`), and AgentBrake
(`bench/configs/agentbrake.yml`). An attack succeeds if any malicious call reaches the server; a
benign task fails if any of its calls is refused. Results are deterministic and byte-reproducible;
CI fails if any verdict changes. Known misses are recorded as expected outcomes.

**Latency** (`bench/latency.ts`). Round trips through an in-process proxy with an immediately
answering server, with and without the full Gauntlet configuration, plus the cost of a flow check
against payloads of 1 KiB to 1 MiB. Numbers exclude pipes and server time and vary by machine.

**Demo** (`bench/demo/`). `capture.ts` records real proxy responses for selected scenarios to
`docs/media/demo-transcript.json`; `render_gif.py` draws `docs/media/demo.gif` from that file.
