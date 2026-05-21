# Agent First Bench

> [繁體中文](./README.md)

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
mkdir my-bench && cd my-bench
afb init                # interactive: pick provider, paste API key → writes .env
afb run scenarios/research_synthesis.yaml --runtime raw-google
```

`afb init` walks you through provider selection and API-key setup. Pick
`mock` if you just want to try without keys.

`afb` auto-loads `./.env` on startup, so you don't need to prefix every
command with `KEY=…`. Setting `--runtime raw-google` is also enough —
provider and a default model (`gemini-3.5-flash`) are inferred:

```bash
afb run scenarios/concurrency_ramp.yaml --runtime raw-anthropic
afb run scenarios/concurrency_ramp.yaml --runtime raw-openai
afb run scenarios/concurrency_ramp.yaml --runtime raw-google
```

Override the model with `--model <name>`.

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

Built-in: `mock`, `raw-anthropic`, `raw-openai`, `raw-google`, `custom-http`.
Planned: `raw-openrouter`, `claude-code`, `codex`, `antigravity`, `openclaw`.

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

## Reproducibility

Every run records enough to reproduce it. The relevant fields in
`metrics.json`:

```json
{
  "scenario_hash":            "5c19b5fae7fc…",
  "dataset_hash":             "fa5c225ada1b…",
  "prompt_template_version":  "inline/v1",
  "scoring_profile_version":  "default/v1",
  "evaluator":                { "name": "success", "version": "1.0.0" },
  "temperature":              0.2,
  "network_policy":           { "mode": "disabled" },
  "seed":                     2718281828,
  "injected_failure_task_ids": ["f-03", "f-07", "f-11"]
}
```

### Seed

Anything random the runner does — currently just `failure_containment`'s
failure injection — goes through a seeded PRNG (mulberry32). The seed
is optional in the scenario file; if absent, the runner generates a
32-bit seed and **always records the effective seed** in `metrics.json`
so the run can be replayed.

```yaml
# scenarios/my_failure.yaml
name: my_failure
kind: failure_containment
inject_failure_rate: 0.25
seed: 42        # optional — omit to auto-generate (still recorded)
```

To **replay** a previous run's exact failure set, copy `seed` out of
that run's `metrics.json` and put it in the scenario file:

```bash
# original run
afb run scenarios/my_failure.yaml --runtime mock --out runs
# → metrics.json contains "seed": 2718281828

# add `seed: 2718281828` to the scenario, then re-run:
afb run scenarios/my_failure.yaml --runtime mock --out runs
# → same injected_failure_task_ids as the original
```

### `injected_failure_task_ids`

For `failure_containment` runs, this lists every task ID that had a
failure injected on its first attempt. Derivable from the seed but
recorded for fast diffing — to confirm two runs exercised the same
failure modes, diff the arrays directly:

```bash
jq '.injected_failure_task_ids' runs/run_A/metrics.json
jq '.injected_failure_task_ids' runs/run_B/metrics.json
```

### What changes which hash

| Change | `dataset_hash` | `scenario_hash` |
| --- | :---: | :---: |
| Task `prompt` / `payload` / `expect` edit | ✓ | ✓ |
| Task `id` rename | ✓ | ✓ |
| Reorder tasks (same `id`s) | — | ✓ |
| Edit `max_concurrency` / `temperature` / `retries` | — | ✓ |
| Edit a comment in the YAML | — | ✓ |

Use `dataset_hash` when you want to ask "is this the **same data**,
regardless of settings?". Use `scenario_hash` for "is this the **exact
same file**?".

A reproducible re-run requires: same `dataset_hash` + same `seed` +
same `temperature` + same `prompt_template_version` +
`scoring_profile_version` + `evaluator.version`. Provider non-determinism
(server-side sampling, even at `temperature: 0`) is the remaining
uncontrollable — that's why every adapter response is also written to
`events.jsonl`, so a "did we get a different answer this time?" diff
is always possible.

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
