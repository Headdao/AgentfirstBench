# Agent First Bench

> [English version](./README.en.md)

一個**為 AI agent 時代設計**的開源命令列 benchmark 工具。

傳統 LLM benchmark 問的是：**「這個 model 答得對嗎？」**

Agent First Bench 問的是：**「這個 model + runtime 組合，能不能當一個可靠的 worker，在平行、會用工具的工作流裡好好做事？」**

它量的是 concurrency、throughput、reliability、coordination overhead、cost、failure containment、human review burden — 不只是答案品質。

---

## 為什麼做這個

不去跟 SWE-bench、LMSYS、Artificial Analysis 拼「model 排行榜」。切一個新分類：

> **Agent runtime observability benchmark.**

- Model 多聰明，不夠。
- 下一個問題是 agent runtime 能不能規模化工作。
- Worker 越多 ≠ 越好。真正要測的是 **邊際效益何時轉負**。

---

## 快速上手（5 分鐘從零到跑）

### 第一步：clone + 裝

```bash
git clone https://github.com/Headdao/AgentfirstBench.git
cd AgentfirstBench
npm install
npm run build
npm link
```

`npm link` 之後就能在任何地方輸入 `afb`。

### 第二步：互動式初始化

新開一個資料夾（或就在現有的）：

```bash
mkdir my-bench && cd my-bench
afb init
```

會問你：

```
Pick a provider:
  1. Google Gemini
  2. Anthropic Claude
  3. OpenAI
  4. Mock (offline, no key needed — recommended for first try)

Choice [1]:
```

如果選 Google / Anthropic / OpenAI，會接著問 API key（會自動幫你寫進 `.env`，並加進 `.gitignore`）。

### 第三步：跑

```bash
afb run scenarios/research_synthesis.yaml --runtime raw-google
```

就這樣。沒寫 `--provider` 跟 `--model` 是因為 `--runtime raw-google` 已經預設用 `google` + `gemini-3.5-flash`。

跑的時候會看到動態 spinner：

```
⠹ 32/96 done · 8 in flight · level 4/6 (N=8)
```

跑完顯示：

```
Run complete: runs/run_xxxxxxx
Workers: 96/96 succeeded
Cost:    $0.0048 (google/gemini-3.5-flash, 1.6k in + 258 out)
```

---

## API Key 怎麼設

afb 啟動時會自動讀當前目錄的 `.env`（已存在的環境變數不會被覆蓋）。三種方式：

### 1. `.env` 檔（最推薦）

`afb init` 會幫你建。手動建也行：

```bash
cat > .env <<'EOF'
GOOGLE_API_KEY=AIza...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
EOF
chmod 600 .env
```

`.env` 已在 `.gitignore` 裡，不會誤 push。

### 2. 當下命令前綴（一次性）

```bash
GOOGLE_API_KEY=AIza... afb run scenarios/concurrency_ramp.yaml --runtime raw-google
```

### 3. shell session 內 export

```bash
export GOOGLE_API_KEY=AIza...
afb run ...
```

驗證 key 有沒有讀到：

```bash
afb doctor
```

---

## 三個 MVP 場景（v0.1）

| Scenario | 量什麼 | 用途 |
|---|---|---|
| `research_synthesis` | N 個 worker 平行寫摘要，一個 coordinator 彙整 | 看 throughput 跟 coordination overhead |
| `concurrency_ramp` | 同一批 task，在 1/2/4/8/16/32 個 concurrency 下各跑一遍 | **找飽和點** — §18 的頭號 KPI |
| `failure_containment` | 注入失敗，看 runtime 會不會被一個壞 worker 拖垮 | 隔離性測試 |

Coding scenarios（會改動檔案的）延後到 v0.2，因為涉及安全跟可重現性的複雜度。

---

## 支援的 runtime

| Runtime | 說明 | API Key 環境變數 |
|---|---|---|
| `mock` | 離線、有確定性，不需要 key — 第一次跑用這個 | — |
| `raw-anthropic` | Anthropic Messages API | `ANTHROPIC_API_KEY` |
| `raw-openai` | OpenAI Chat Completions | `OPENAI_API_KEY` |
| `raw-google` | Google Gemini generateContent | `GOOGLE_API_KEY` 或 `GEMINI_API_KEY` |
| `custom-http` | 你自己的 server（POST/JSON 合約見下面） | `AFB_CUSTOM_HTTP_TOKEN`（選用） |

`--runtime <名稱>` 會自動推 `--provider` 跟 `--model` 預設值。例如：

| 你打的 | 自動填的 |
|---|---|
| `--runtime raw-google` | `--provider google --model gemini-3.5-flash` |
| `--runtime raw-anthropic` | `--provider anthropic --model claude-sonnet-4-6` |
| `--runtime raw-openai` | `--provider openai --model gpt-5.4-mini` |

要換 model 就加 `--model xxx` 覆寫。

---

## 命令一覽

| 命令 | 做什麼 |
|---|---|
| `afb init [dir]` | 互動式初始化（會問 provider 跟 API key） |
| `afb doctor` | 檢查 Node 版本、adapter、API key |
| `afb models` | 列出所有可測的 model（按 provider 分組，含費率跟 key 狀態） |
| `afb run <scenario>` | 跑單一 model，產出 `events.jsonl` + `metrics.json` + `report.md` |
| `afb matrix <scenario>` | 一次跑多個 model，輸出並排比較 `matrix.md` |
| `afb compare <a> <b>` | 並排比較兩次 run（含 sweep 對照） |
| `afb report <runDir>` | 從 `metrics.json` 重新產生 `report.md` |

---

## 多 Model 比評（`afb matrix`）

要在同一場景上比好幾個 model — 這是最常見的用法。

### 看可以測什麼

```bash
afb models
```

會列出所有 model（含費率，並標出每個 provider 的 API key 有沒有設）。

### 互動模式

```bash
afb matrix scenarios/concurrency_ramp.yaml
```

跳出編號清單，輸入 `1,3,5` 之類的選擇，或 `all` 全選。

### 腳本模式

```bash
afb matrix scenarios/concurrency_ramp.yaml --models google/gemini-3.5-flash,google/gemini-2.5-flash,anthropic/claude-haiku-4-5 --yes
```

跑前會：
1. **檢查 API key** — 缺哪個就拒跑（不會跑到一半才發現）
2. **列出 model + 費率** 等你確認 `Proceed? [Y/n]`（`--yes` 跳過）
3. **依序執行**（避免同 provider rate limit），每個 model 有獨立 spinner

跑完輸出：

```
Model                       OK         Avg    p95    Cost      $/OK
-----------------------------------------------------------------------
google/gemini-3.5-flash     8/8 100%   412    678    $0.052    $0.0065
google/gemini-2.5-flash     8/8 100%   287    489    $0.018    $0.0023
anthropic/claude-haiku-4-5  8/8 100%   523    812    $0.124    $0.0155

Matrix written to: runs/matrix_xxxxx/matrix.md
```

`matrix.md` 還包含 sweep scenario 的 **per-level throughput 對照表**，可以直接看到誰先到飽和點。

---

## Run 輸出結構

```
runs/run_xxxxxxx/
  events.jsonl     # 事件日誌（每行一個 JSON）
  metrics.json     # 聚合指標 + 可重現性 metadata
  report.md        # afb report 產出的人類可讀報告
```

---

## 價格

`src/pricing/table.ts` 內建主要 model 的價格，每次 run 會把計算來源（`cost_source`）跟價格表日期（`pricing_as_of`）寫進 `metrics.json`。即使日後牌價變了，舊 run 的成本還能重現。

| Provider | Models（部分） |
|---|---|
| Anthropic | claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5 |
| Google | gemini-3.5-flash, gemini-2.5-flash, gemini-3.1-pro-preview |
| OpenAI | gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano |

⚠️ 牌價會變。對外引用前去原廠頁面再確認一次，過期就 PR 更新 `src/pricing/table.ts` 並 bump `as_of`。

---

## 可重現性

每次 run 會記錄：

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

`failure_containment` 的失敗注入用 seeded PRNG（mulberry32）。沒設 seed 的話 runner 會自動生一個 32-bit 並記錄。要重現上一次的失敗組合，把 `metrics.json` 裡的 `seed` 抄進 scenario.yaml 就好。

### 兩種 hash

- **`dataset_hash`** — 只看輸入（task `id` + `prompt` + `payload` + `expect`），順序無關。問「這是同一份資料嗎？」用這個。
- **`scenario_hash`** — 整個 YAML 檔的 hash，連 `max_concurrency`、temperature、comment 都算。問「這是完全同一個檔案嗎？」用這個。

---

## 安全預設值

| 預設 | 意思 | 狀態 |
|---|---|---|
| Coding scenario 預設 patch-only | `kind: coding_*` 不加 `--apply` 拒跑 | **強制執行** |
| 檔案改動只在 run 目錄內 | 走 `ScopedFS` helper 的 adapter 受限 | **強制執行** |
| 預設禁止 task 連網 | scenario 的 `network_policy` 預設 `disabled` | 契約 + 記錄 |
| API key 永不寫入 log | `events.jsonl` 跟 `metrics.json` 都不會出現 key | **強制執行**（有 regression test 守住） |

---

## Custom HTTP — 包自己的 runtime

`custom-http` 把 task POST 給任何一個你指定的 endpoint。20 行 Node 就能包好。

```bash
export AFB_CUSTOM_HTTP_URL=http://localhost:8787
afb run scenarios/concurrency_ramp.yaml --runtime custom-http --provider google --model gemini-3.5-flash
```

完整契約跟參考實作 (`examples/echo-server.mjs`) 見 [English README](./README.en.md#custom-http--benchmark-your-own-runtime-without-writing-ts)。

---

## 揭露

我不是專業開發者。這個專案是用 **Claude Opus 4.7**（Anthropic）為主要 code author 從手寫 spec 出發完成。預期會有粗糙的地方、缺少的 convention，跟資深工程師會 push back 的設計選擇 — 非常歡迎 PR 與批評。

目標是先讓 MVP 端到端跑得通；硬化跟 idiomatic 優化會慢慢補。

---

## License

MIT
