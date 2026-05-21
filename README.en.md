# Agent First Bench

> [繁體中文](./README.md)

An open-source CLI benchmark for the agent era.

Traditional LLM benchmarks ask: **"Can the model answer the question?"**

Agent First Bench asks: **"Can this model/runtime act as a reliable worker inside a parallel, tool-using workflow?"**

It measures concurrency, throughput, reliability, coordination overhead, cost, failure containment, and human-review burden — not just answer quality.

---

## Why this exists

Don't try to out-rank SWE-bench, LMSYS, or Artificial Analysis on raw model quality. Carve a different category:

> **Agent runtime observability benchmark.**

- Model intelligence alone isn't enough.
- The next question is whether an agent runtime can scale work.
- More workers ≠ better. What you actually want to know is **where marginal returns turn negative**.

---

## 1. Install

```bash
git clone https://github.com/Headdao/AgentfirstBench.git
cd AgentfirstBench
npm install
npm run build
npm link
```

After `npm link`, `afb` is available globally. Verify with:

```bash
afb doctor
```

You should see every adapter registered.

---

## 2. First run (single model)

In a new directory:

```bash
mkdir my-bench && cd my-bench
afb init
```

Interactive prompts ask for your provider and API key, then write `.env`
and add it to `.gitignore`.

Then run:

```bash
afb run scenarios/research_synthesis.yaml --runtime raw-google
```

One flag is enough — `--runtime raw-google` infers `--provider google` and
`--model gemini-3.5-flash`. Override with `--model X`.

A spinner shows live progress:

```
⠹ 32/96 done · 8 in flight · level 4/6 (N=8)
```

When done:

```
Run complete: runs/run_xxxxx
Workers: 96/96 succeeded
Cost:    $0.0048 (google/gemini-3.5-flash, 4.0k in + 5.8k out)
Report:  runs/run_xxxxx/report.md
```

`report.md` is generated automatically.

---

## 3. Reading the report

Every report has **7 sections**, plain language at the top, technical
detail underneath:

| Section | What it has | Audience |
|---|---|---|
| `## 重點 / Summary` | One paragraph: how long, how much, how many succeeded, anything weird | Anyone |
| `## 結論 / Bottom line` | One sentence: **what to do next**, based on the data | Anyone |
| `### 技術指標 / Metrics` | Reliability / Accuracy / Consistency / Cost / Scaling bullets | Engineers |
| `### 操作上限 / Operating limits` | "Cap concurrency at N=X" — sweep-derived deployment limits | DevOps |
| `### 真的別用 / Avoid` | Only appears when reliability < 95% or accuracy < 50% | Anyone |

Plus: full metric table (worker counts, p50/p95/p99, tokens, cost,
runtime metadata) and a sweep table for `concurrency_ramp` scenarios
further down.

**"Avoid" is strict.** It only lists models that are genuinely broken
for the scenario. A model in "Operating limits" is fine — it just has a
concurrency ceiling you need to respect.

---

## 4. Comparing models (`afb matrix`)

The headline workflow — compare several models on the same scenario at once.

### See what's available

```bash
afb models
```

Lists every model with its rate and whether the required API key is set.

### Interactive picker

```bash
afb matrix scenarios/reasoning_chain.yaml
```

You get a numbered list; type `1,3,5` or `all`.

### Scripted

```bash
afb matrix scenarios/reasoning_chain.yaml \
  --models anthropic/claude-haiku-4-5,google/gemini-3.5-flash,openai/gpt-5.4-mini \
  --yes
```

### Pairing model with runtime

To compare **the same model under different runtimes** (the §18 test —
does the runtime overhead pay for itself?), use the `@runtime` suffix:

```bash
afb matrix scenarios/orchestration_research.yaml \
  --models anthropic/claude-sonnet-4-6,anthropic/claude-sonnet-4-6@claude-code \
  --yes
```

First row uses the default `raw-anthropic`; second uses `claude-code`.
The report auto-adds a `Class` column to label them.

### Output

```
Model                       OK         Avg    p95    Cost        $/OK
-----------------------------------------------------------------------
anthropic/claude-haiku-4-5  5/5 100%   985    1446   $0.0016     $0.00033
google/gemini-3.5-flash     5/5 100%   3045   5175   $0.0028     $0.00056
openai/gpt-5.4-mini         5/5 100%   5052   18085  $0.0009     $0.00019

## Bottom line
Pick `openai/gpt-5.4-mini` for cost, `anthropic/claude-haiku-4-5` for speed.
```

Pre-flights API keys, lists rates, asks for confirmation (`--yes` skips).

---

## 5. The seven scenarios

| Scenario | What it measures | When to use |
|---|---|---|
| `research_synthesis` | N parallel summary workers | Throughput, coordination overhead |
| `concurrency_ramp` | Same batch at 1→32 concurrency | **Find the saturation point** — §18 headline KPI |
| `failure_containment` | Inject failures, watch isolation | Confirm one bad worker doesn't take the swarm down |
| `structured_output` | 5 JSON-schema extraction tasks | Does the model follow format under pressure |
| `long_context_recall` | Needle-in-haystack on ~2k-token docs | Marketed 1M context vs. usable context |
| `reasoning_chain` | 8 multi-step math/logic problems | Hard signal on "is this model smart enough" |
| `orchestration_research` | Coordinator → workers → merge (v0.2) | The coordination tax of an agent runtime |

Each scenario's YAML lives in `scenarios/` — open one to see the actual
tasks or to derive your own variant.

Coding scenarios (which would mutate files) are deferred until a real
sandbox lands.

---

## 6. Supported runtimes

| Runtime | Class | What it does | API key |
|---|---|---|---|
| `mock` | `raw_model_baseline` | Offline, deterministic | — |
| `mock-coordinator` | `coordinator_enabled` | Offline; for testing orchestration flow | — |
| `raw-anthropic` | `raw_model_baseline` | Anthropic Messages API | `ANTHROPIC_API_KEY` |
| `raw-openai` | `raw_model_baseline` | OpenAI Chat Completions | `OPENAI_API_KEY` |
| `raw-google` | `raw_model_baseline` | Google Gemini generateContent | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| `claude-code` | `agent_runtime` | Anthropic Claude Code CLI (no-tools) | `ANTHROPIC_API_KEY` + `claude` CLI installed |
| `custom-http` | `external` | Your own HTTP endpoint | `AFB_CUSTOM_HTTP_TOKEN` (optional) |

**Runtime class** drives how reports label rows. When a matrix mixes
classes, the verdict adds a cross-class warning: raw-API rows have no
coordination tax; agent-runtime rows do. Read $/success and latency with
that asymmetry in mind.

---

## 7. API keys

`afb` auto-loads `./.env` on startup (without overwriting already-set
env vars). Three options:

### `.env` file (recommended)

```bash
cat > .env <<'EOF'
GOOGLE_API_KEY=AIza...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
EOF
chmod 600 .env
```

`.env` is already in `.gitignore`.

### Inline prefix (one-shot)

```bash
GOOGLE_API_KEY=AIza... afb run scenarios/concurrency_ramp.yaml --runtime raw-google
```

### Shell export

```bash
export GOOGLE_API_KEY=AIza...
afb run ...
```

Verify with `afb doctor`.

---

## 8. Commands

| Command | What it does |
|---|---|
| `afb init [dir]` | Interactive project scaffold (provider + API key) |
| `afb doctor` | Check Node version, adapters, API keys |
| `afb models` | List every model in the pricing table |
| `afb run <scenario>` | Run one model; emits `events.jsonl` + `metrics.json` + `report.md` |
| `afb matrix <scenario>` | Run many models; emits `matrix.md` + per-model reports |
| `afb compare <a> <b>` | Side-by-side metrics for two existing runs |
| `afb report <runDir>` | Regenerate `report.md` from an existing `metrics.json` |

---

## 9. Run output layout

```
runs/run_xxxxxxx/                    # single run (afb run)
├── events.jsonl                     # event-sourced log
├── metrics.json                     # aggregates + reproducibility metadata
└── report.md                        # human-readable, 7-section structure

runs/matrix_yyyyyyy/                 # multi-model comparison (afb matrix)
├── matrix.md                        # side-by-side
├── matrix.json
├── run_aaaa/                        # one subdir per model
│   ├── events.jsonl
│   ├── metrics.json
│   └── report.md                    # full per-model report
└── run_bbbb/
    └── ...
```

---

## 10. Pricing

`src/pricing/table.ts` ships rates for the Anthropic / Google / OpenAI
models people are most likely to benchmark. Every run records the table
date as `pricing_as_of` in `metrics.json` so historical comparisons stay
reproducible even when list prices change.

| Provider | Models |
|---|---|
| Anthropic | claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5 (+ legacy 4.5, 4.6) |
| Google | gemini-3.5-flash, gemini-2.5-flash, gemini-3.1-pro-preview |
| OpenAI | gpt-5.5, gpt-5.5-pro, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5.4-pro, gpt-5.3-codex |

⚠️ Prices drift. Verify against the vendor's pricing page before relying
on a number for billing. PRs welcome — bump `as_of` and include the source URL.

---

## 11. Reproducibility

Every run records:

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
  "injected_failure_task_ids": ["f-03", "f-07"]
}
```

### Seed

`failure_containment` injections go through a seeded PRNG (mulberry32).
If you don't set one, the runner generates one and **always records the
effective seed** in `metrics.json` so the run can be replayed: copy
`seed` back into the scenario YAML.

### Two hashes

- **`dataset_hash`** — inputs only (task `id` + `prompt` + `payload` + `expect`), order-independent. Use this to ask "same data?".
- **`scenario_hash`** — the whole YAML file, including `max_concurrency`, temperature, comments. Use this to ask "exact same file?".

---

## 12. Safety defaults

| Default | Meaning | Status |
|---|---|---|
| Coding scenarios are patch-only | `kind: coding_*` refuses to run without `--apply` | **Enforced** |
| File writes confined to run dir | Adapters that use `ScopedFS` are scoped | **Enforced for opt-in adapters** |
| Network access disabled by default | Scenarios declare `network_policy`; recorded in `metrics.json` | Contractual + recorded |
| API keys never logged | Neither `events.jsonl` nor `metrics.json` ever contain key values | **Enforced** (regression test) |

---

## 13. Custom HTTP — benchmark your own runtime without writing TS

`custom-http` POSTs each task to an HTTP endpoint of your choice. Point
it at any service implementing the contract below.

### Config

```bash
export AFB_CUSTOM_HTTP_URL=http://localhost:8787
export AFB_CUSTOM_HTTP_TOKEN=optional-bearer-token
afb run scenarios/concurrency_ramp.yaml --runtime custom-http \
  --provider google --model gemini-3.5-flash
```

### Request (POST `application/json`)

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

### Response (200, `application/json`)

```json
{
  "ok": true,
  "output": "model output here",
  "usage": { "input_tokens": 123, "output_tokens": 45 },
  "data": { "...": "optional structured payload" }
}
```

Set `ok: false` and include `error: { type, message }` to report a task
failure. Non-200 status codes become `error.type: "http_<status>"`.

A 30-line reference server lives at `examples/echo-server.mjs`:

```bash
node examples/echo-server.mjs &
AFB_CUSTOM_HTTP_URL=http://localhost:8787 \
  afb run scenarios/concurrency_ramp.yaml --runtime custom-http
```

---

## Disclosure

I'm not a professional developer. This project was scaffolded and written
with **Claude Opus 4.7** (Anthropic) as the primary code author, working
from a hand-written spec. Expect rough edges, missing conventions, and
design choices a seasoned engineer would push back on — PRs and critique
are very welcome.

The goal was to land a working MVP that matches the spec end-to-end;
hardening and idiomatic polish will follow.

---

## License

MIT
