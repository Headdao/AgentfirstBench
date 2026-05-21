# Agent First Bench

An open-source CLI benchmark for the agent era.

Traditional LLM benchmarks ask: **"Can the model answer the question?"**

Agent First Bench asks: **"Can this model/runtime act as a reliable worker inside a parallel, tool-using workflow?"**

It measures concurrency, throughput, reliability, coordination overhead, cost, failure containment, and human-review burden — not just answer quality.

## Why this exists

Don't try to out-rank SWE-bench, LMSYS, or Artificial Analysis on raw model quality. Carve a different category:

> **Agent runtime observability benchmark.**

- Model intelligence alone isn't enough.
- The next question is whether an agent runtime can scale work.
- More workers ≠ better. What you actually want to know is **where marginal returns turn negative**.

## Install

```bash
npm install -g agent-first-bench   # once published
# or, from source:
git clone <repo> && cd agent-first-bench
npm install
npm run build
npm link
```

## Quickstart

```bash
afb init my-bench && cd my-bench
afb doctor
afb run scenarios/concurrency_ramp.yaml --runtime mock
afb report runs/run_xxxxxx
```

The `mock` adapter is offline and deterministic — useful for kicking the tires
without API keys. Switch to `--runtime raw-anthropic` (and set
`ANTHROPIC_API_KEY`) for real measurements.

## Commands

| Command | What it does |
| --- | --- |
| `afb init [dir]` | Scaffolds a new bench project with sample scenarios |
| `afb doctor` | Checks Node version, adapters, and provider credentials |
| `afb run <scenario>` | Runs a scenario, emits `events.jsonl` + `metrics.json` |
| `afb compare <a> <b>` | Side-by-side metrics for two run directories |
| `afb report <runDir>` | Renders `report.md` from `metrics.json` |

## MVP scenarios (v0.1)

- **`research_synthesis`** — N parallel workers summarize topics; a coordinator merges.
- **`concurrency_ramp`** — Same task batch at increasing concurrency levels. Reveals where throughput plateaus.
- **`failure_containment`** — Inject failures and observe whether one bad worker takes the swarm down.

Coding-swarm scenarios are deferred to v0.2 because they introduce safety and
reproducibility complexity (see spec §15).

## Run output layout

```
runs/run_xxxxxx/
  events.jsonl     # event-sourced log (spec §11)
  metrics.json     # aggregates + reproducibility metadata (spec §14)
  report.md        # produced by `afb report`
```

## Pricing

`afb` ships a central pricing table at `src/pricing/table.ts` covering the
Anthropic and OpenAI models people are most likely to benchmark. Every run
records the table date as `pricing_as_of` in `metrics.json` so historical
comparisons remain reproducible even when list prices change.

If a provider/model isn't in the table, `afb` falls back to the adapter's
own `estimateCost()` (placeholder rates) and marks `cost_source: "adapter"`
in `metrics.json`. If neither is available, `cost_source: "none"` and the
cost line is omitted from `afb run` output.

To add or correct a rate: edit `src/pricing/table.ts`, bump `as_of`, and
open a PR with the source URL.

## Adapter interface

Add a runtime by implementing `AgentRuntimeAdapter` (see `src/adapters/types.ts`):

```ts
export interface AgentRuntimeAdapter {
  name: string;
  runTask(input: AgentTaskInput): Promise<AgentTaskResult>;
  estimateCost?(usage: TokenUsage): CostEstimate;
  getRateLimitStatus?(): Promise<RateLimitStatus>;
}
```

Built-in: `mock`, `raw-anthropic`, `raw-openai`, `custom-http`.
Planned: `raw-google`, `raw-openrouter`, `claude-code`, `codex`, `antigravity`, `openclaw`.

### `custom-http` — benchmark your own runtime without writing TS

`custom-http` POSTs each task to an HTTP endpoint of your choice. Point
it at any service that implements the contract below — your own agent
runtime, a wrapper around a managed agent, a fixture for testing.

**Config**

```bash
export AFB_CUSTOM_HTTP_URL=http://localhost:8787
export AFB_CUSTOM_HTTP_TOKEN=optional-bearer-token
afb run scenarios/concurrency_ramp.yaml --runtime custom-http
```

**Request** (POST `application/json`)

```json
{
  "task_id": "q-01",
  "prompt": "...",
  "model": "claude-sonnet-4-6",
  "temperature": 0.2,
  "timeout_ms": 30000,
  "payload": { "...": "..." },
  "network_policy": { "mode": "disabled" },
  "run_dir": "/abs/path/to/runs/run_xxxx",
  "apply": false
}
```

**Response** (200, `application/json`)

```json
{
  "ok": true,
  "output": "model output here",
  "usage": { "input_tokens": 123, "output_tokens": 45 },
  "data": { "...": "optional structured payload" }
}
```

Set `ok: false` and include `error: { type, message }` to report a task
failure. Non-200 status codes are treated as failures with
`error.type: "http_<status>"`.

A 30-line reference server lives at `examples/echo-server.mjs`:

```bash
node examples/echo-server.mjs &
AFB_CUSTOM_HTTP_URL=http://localhost:8787 \
  afb run scenarios/concurrency_ramp.yaml --runtime custom-http
```

## Safety defaults

Per spec §13. The table below distinguishes **enforced** (refuses to run if
violated) from **contractual** (adapter promises to honor it; runner records
the policy in `metrics.json` for audit but cannot prevent a malicious adapter
from breaking the rule).

| Default | What it means | Status |
| --- | --- | --- |
| Coding scenarios are patch-only | `kind: coding_*` refuses to run without `--apply` | **Enforced** (pre-flight check in runner) |
| File mutations stay in run dir | Adapters write only inside `runs/<run_id>/` | **Enforced for adapters that use `ScopedFS`**; contractual for those that don't |
| Network access disabled by default | Scenario tasks (not the adapter's own API call) cannot reach the network unless `network_policy` opts in | Contractual + recorded — raw-API adapters have no separate network surface, so they ignore this; agent-runtime adapters MUST honor it |
| API keys never logged | `events.jsonl` and `metrics.json` never contain env-var key values | **Enforced** (the runner never reads env vars into log fields; covered by a regression test) |

`network_policy` modes (set per scenario, default `disabled`):

```yaml
network_policy:
  mode: disabled         # task workers may not initiate network calls
# or
  mode: adapter_only     # only the adapter's provider API call is allowed
# or
  mode: allowlist
  hosts: [ "example.com", "raw.githubusercontent.com" ]
```

Every run records the effective `network_policy` and `apply` flag in
`metrics.json` so a reviewer can verify what was in force.

## Disclosure

I'm not a professional developer. This project was scaffolded and written with
**Claude Opus 4.7** (Anthropic) as the primary code author, working from a
hand-written spec. Expect rough edges, missing conventions, and design choices
that a seasoned engineer might push back on — PRs and critique are very welcome.

The goal was to land a working MVP that matches the spec end-to-end; hardening
and idiomatic polish will follow.

## License

MIT
