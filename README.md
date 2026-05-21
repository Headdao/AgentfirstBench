# Agent First Bench

> [English version](./README.en.md)

一個**為 AI agent 時代設計**的開源命令列 benchmark 工具。

傳統 LLM benchmark 問：**「這個 model 答得對嗎？」**

Agent First Bench 問：**「這個 model + runtime 組合，能不能當一個可靠的 worker，在平行、會用工具的工作流裡好好做事？」**

它量的是 concurrency、throughput、reliability、coordination overhead、cost、failure containment、human review burden — 不只是答案品質。

---

## 為什麼做這個

不去跟 SWE-bench、LMSYS、Artificial Analysis 拼「model 排行榜」。切一個新分類：

> **Agent runtime observability benchmark.**

- Model 多聰明，不夠。
- 下一個問題是 agent runtime 能不能規模化工作。
- Worker 越多 ≠ 越好。真正要測的是 **邊際效益何時轉負**。

---

## 1. 安裝

```bash
git clone https://github.com/Headdao/AgentfirstBench.git
cd AgentfirstBench
npm install
npm run build
npm link
```

`npm link` 之後就能在任何目錄輸入 `afb`。

驗證：

```bash
afb doctor
```

應該看到所有 adapter 都註冊好。

---

## 2. 跑第一個測試（單一 model）

新開一個資料夾，初始化：

```bash
mkdir my-bench && cd my-bench
afb init
```

互動式問你要哪個 provider，貼 API key（自動寫進 `.env` 並加進 `.gitignore`）。

然後跑：

```bash
afb run scenarios/research_synthesis.yaml --runtime raw-google
```

`--runtime raw-google` 一個 flag 就夠了 — 會自動推 `--provider google --model gemini-3.5-flash`。要換 model 就加 `--model xxx`。

跑的時候會看到 spinner：

```
⠹ 32/96 done · 8 in flight · level 4/6 (N=8)
```

跑完顯示：

```
Run complete: runs/run_xxxxx
Workers: 96/96 succeeded
Cost:    $0.0048 (google/gemini-3.5-flash, 4.0k in + 5.8k out)
Report:  runs/run_xxxxx/report.md
```

`report.md` 同時自動生好。

---

## 3. 報告怎麼讀

報告有 **7 個 section**，從白話到技術，由上而下展開：

| Section | 內容 | 給誰看 |
|---|---|---|
| `## 重點 / Summary` | 一段白話：跑多久、花多少、做完幾個、有沒有奇怪的地方 | 任何人 |
| `## 結論 / Bottom line` | 一句話：根據數據，**你下一步該做什麼** | 任何人 |
| `### 技術指標 / Metrics` | Reliability / Accuracy / Consistency / Cost / Scaling bullet 列表 | 工程師 |
| `### 操作上限 / Operating limits` | 「並發超過 N=X 會掉效能」這類限制 | DevOps / 部署者 |
| `### 真的別用 / Avoid` | 只有 reliability < 95% 或 accuracy < 50% 才會出現 | 任何人 |

外加：完整 metric table（worker total、p50/p95/p99、token、cost、運行時資訊）跟 `concurrency_ramp` 的 sweep table 在更下面。

「**Avoid**」很嚴格 — 只列真的不能用的。**「我看 model X 在 Avoid 區」≠「不要用 model X」**，要看「真的別用」這節而不是「操作上限」這節。

---

## 4. 比多個 model（`afb matrix`）

要在同一場景上比好幾個 model — 這是最常見的用法。

### 看可以測什麼 model

```bash
afb models
```

列出所有 model 跟費率、API key 有沒有設好。

### 跑（互動式）

```bash
afb matrix scenarios/reasoning_chain.yaml
```

跳出編號清單，輸入 `1,3,5` 或 `all`。

### 跑（一行搞定）

```bash
afb matrix scenarios/reasoning_chain.yaml \
  --models anthropic/claude-haiku-4-5,google/gemini-3.5-flash,openai/gpt-5.4-mini \
  --yes
```

### 進階：model + runtime 配對

要比「**同一個 model 用不同 runtime**」（驗證 §18 — runtime overhead 是否值得），用 `@runtime` 後綴：

```bash
afb matrix scenarios/orchestration_research.yaml \
  --models anthropic/claude-sonnet-4-6,anthropic/claude-sonnet-4-6@claude-code \
  --yes
```

第一個用預設的 `raw-anthropic`，第二個用 `claude-code` agent runtime。報告會自動加 `Class` 欄區分。

### Matrix 輸出

```
Model                       OK         Avg    p95    Cost        $/OK
-----------------------------------------------------------------------
anthropic/claude-haiku-4-5  5/5 100%   985    1446   $0.0016     $0.00033
google/gemini-3.5-flash     5/5 100%   3045   5175   $0.0028     $0.00056
openai/gpt-5.4-mini         5/5 100%   5052   18085  $0.0009     $0.00019

## 結論
想最便宜選 `openai/gpt-5.4-mini`，想最快選 `anthropic/claude-haiku-4-5`。
```

跑前自動檢查 API key、列出費率、要求確認（`--yes` 跳過）。

---

## 5. 七個 scenario 全列

| Scenario | 量什麼 | 何時用 |
|---|---|---|
| `research_synthesis` | N 個 worker 平行寫摘要 | 看 throughput、coordination overhead |
| `concurrency_ramp` | 同批 task 跑 1→32 並發 | **找飽和點** — §18 頭號 KPI |
| `failure_containment` | 注入失敗看隔離性 | 確認壞 worker 不會拖垮整批 |
| `structured_output` | 5 個 JSON schema 抽取任務 | 看 model 守不守格式 |
| `long_context_recall` | needle-in-haystack 長文檢索（3 篇 ~2k tokens 文件） | 量「行銷 1M context vs 實際能用多少」 |
| `reasoning_chain` | 8 個多步推理題（math / logic） | 量「夠不夠聰明」的硬指標 |
| `orchestration_research` | coordinator 拆任務 → 多 worker → 合併（v0.2） | 量 agent runtime 的協調成本（coordination tax） |

每個 scenario 的 YAML 在 `scenarios/` 目錄，可以打開看 task 內容 + 自訂衍生版。

Coding scenario（會改檔案的）延後到 v0.2 後續，因為需要 sandbox。

---

## 6. 支援的 runtime

| Runtime | Class | 說明 | API Key |
|---|---|---|---|
| `mock` | `raw_model_baseline` | 離線、有確定性，不需要 key | — |
| `mock-coordinator` | `coordinator_enabled` | 離線、可測 orchestration flow | — |
| `raw-anthropic` | `raw_model_baseline` | Anthropic Messages API | `ANTHROPIC_API_KEY` |
| `raw-openai` | `raw_model_baseline` | OpenAI Chat Completions | `OPENAI_API_KEY` |
| `raw-google` | `raw_model_baseline` | Google Gemini generateContent | `GOOGLE_API_KEY` 或 `GEMINI_API_KEY` |
| `claude-code` | `agent_runtime` | Anthropic Claude Code CLI（no-tools） | `ANTHROPIC_API_KEY` + 安裝 `claude` CLI |
| `custom-http` | `external` | 你自己的 server（POST/JSON 合約） | `AFB_CUSTOM_HTTP_TOKEN`（選用） |

**Runtime class** 是給報告區分用的。Matrix 同時比 raw + agent runtime 會自動加 cross-class warning，提醒 raw API 沒有 coordination tax、agent runtime 有 — 比 $/success 要把這層 asymmetry 放在心上。

---

## 7. API Key 怎麼設

afb 啟動時會自動讀當前目錄的 `.env`（已存在的環境變數不會被覆蓋）。三種方式：

### `.env` 檔（最推薦）

```bash
cat > .env <<'EOF'
GOOGLE_API_KEY=AIza...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
EOF
chmod 600 .env
```

`.env` 已在 `.gitignore` 裡，不會誤 push。

### 命令前綴（一次性）

```bash
GOOGLE_API_KEY=AIza... afb run scenarios/concurrency_ramp.yaml --runtime raw-google
```

### shell session

```bash
export GOOGLE_API_KEY=AIza...
afb run ...
```

驗證：`afb doctor` 會列出每個 env var 是 set 還是 not set。

---

## 8. 命令一覽

| 命令 | 做什麼 |
|---|---|
| `afb init [dir]` | 互動式初始化（問 provider 跟 API key） |
| `afb doctor` | 檢查 Node 版本、adapter、API key |
| `afb models` | 列出所有可測的 model（含費率跟 key 狀態） |
| `afb run <scenario>` | 跑單一 model，產出 `events.jsonl` + `metrics.json` + `report.md` |
| `afb matrix <scenario>` | 一次跑多個 model，輸出並排比較 `matrix.md`，每個 model 也有自己的 `report.md` |
| `afb compare <a> <b>` | 並排比較兩次既有 run（含 sweep 對照） |
| `afb report <runDir>` | 從現成的 `metrics.json` 重新產生 `report.md` |

---

## 9. Run 輸出結構

```
runs/run_xxxxxxx/                    # 單一 run（afb run）
├── events.jsonl                     # 事件日誌（每行一個 JSON）
├── metrics.json                     # 聚合指標 + 可重現性 metadata
└── report.md                        # 人類可讀報告（七節結構）

runs/matrix_yyyyyyy/                 # 多 model 比較（afb matrix）
├── matrix.md                        # 並排比較
├── matrix.json
├── run_aaaa/                        # 每個 model 一個子目錄
│   ├── events.jsonl
│   ├── metrics.json
│   └── report.md                    # 該 model 的完整報告
└── run_bbbb/
    └── ...
```

---

## 10. 價格

`src/pricing/table.ts` 內建主要 model 的價格，每次 run 把計算來源（`cost_source`）跟價格表日期（`pricing_as_of`）寫進 `metrics.json`。即使日後牌價變，舊 run 的成本還能重現。

| Provider | Models |
|---|---|
| Anthropic | claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5 (+ legacy 4.5, 4.6) |
| Google | gemini-3.5-flash, gemini-2.5-flash, gemini-3.1-pro-preview |
| OpenAI | gpt-5.5, gpt-5.5-pro, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5.4-pro, gpt-5.3-codex |

⚠️ 牌價會變。對外引用前去原廠頁面再確認一次，過期就 PR 更新 `src/pricing/table.ts` 並 bump `as_of`。

---

## 11. 可重現性

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

`failure_containment` 的失敗注入用 seeded PRNG（mulberry32）。沒設 seed 的話 runner 自動生一個並記錄。要重現上一次的失敗組合，把 `metrics.json` 裡的 `seed` 抄進 scenario.yaml。

### 兩種 hash

- **`dataset_hash`** — 只看輸入（task `id` + `prompt` + `payload` + `expect`），順序無關。問「同一份資料嗎？」
- **`scenario_hash`** — 整個 YAML 檔的 hash，連 `max_concurrency`、temperature、comment 都算。問「完全同一個檔案嗎？」

---

## 12. 安全預設值

| 預設 | 意思 | 狀態 |
|---|---|---|
| Coding scenario 預設 patch-only | `kind: coding_*` 不加 `--apply` 拒跑 | **強制執行** |
| 檔案改動只在 run 目錄內 | 走 `ScopedFS` helper 的 adapter 受限 | **強制執行** |
| 預設禁止 task 連網 | scenario 的 `network_policy` 預設 `disabled` | 契約 + 記錄 |
| API key 永不寫入 log | `events.jsonl` 跟 `metrics.json` 都不會出現 key | **強制執行**（regression test 守住）|

---

## 13. Custom HTTP — 包自己的 runtime

`custom-http` 把 task POST 給任何一個你指定的 endpoint，20 行 Node 就能包好。

```bash
export AFB_CUSTOM_HTTP_URL=http://localhost:8787
afb run scenarios/concurrency_ramp.yaml --runtime custom-http \
  --provider google --model gemini-3.5-flash
```

完整契約跟參考實作 (`examples/echo-server.mjs`) 見 [English README](./README.en.md#13-custom-http--benchmark-your-own-runtime-without-writing-ts)。

---

## 揭露

我不是專業開發者。這個專案是用 **Claude Opus 4.7**（Anthropic）為主要 code author 從手寫 spec 出發完成。預期會有粗糙的地方、缺少的 convention，跟資深工程師會 push back 的設計選擇 — 非常歡迎 PR 與批評。

目標是先讓 MVP 端到端跑得通；硬化跟 idiomatic 優化會慢慢補。

---

## License

MIT
