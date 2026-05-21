import type { RunMetrics } from '../metrics/types.js';
import type { MatrixRow } from './matrix.js';
import { summarizeSweep, type SweepSummary } from '../metrics/sweep.js';
import { formatUsd } from '../utils/format.js';

/**
 * Verdict layer — translates raw metrics into something a non-engineer
 * can read. Three layers per report:
 *
 *   重點 / Summary       — bilingual prose narrative
 *   結論 / Bottom line   — one-sentence "so what do I do?"
 *   Technical bullets    — the original metric breakdown for engineers
 *   Operating limits     — cap-at-N recommendations from sweep data
 *   Avoid                — only when the model is genuinely unusable
 *
 * Rule-based throughout (no LLM). Thresholds are explicit so anyone can
 * audit them in this file.
 */

const RELIABILITY_AVOID = 0.95; // success rate below this → really avoid
const ACCURACY_AVOID = 0.5; // accuracy below this → really avoid
const ACCURACY_RELIABLE = 0.7; // need this much to win a "cheapest reliable" pick

// =======================  RUN  =======================

export function verdictForRun(m: RunMetrics): string {
  const lines: string[] = [];

  // 1. Bilingual narrative
  lines.push('## 重點');
  lines.push('');
  lines.push(narrativeZh(m));
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(narrativeEn(m));
  lines.push('');

  // 2. Bilingual bottom line
  lines.push('## 結論');
  lines.push('');
  lines.push(bottomLineZh(m));
  lines.push('');
  lines.push('## Bottom line');
  lines.push('');
  lines.push(bottomLineEn(m));
  lines.push('');

  // 3. Technical bullets (kept English to match engineer-facing metric names)
  lines.push('### 技術指標 / Metrics');
  lines.push('');
  lines.push(...technicalBullets(m));

  // 4. Operating limits (sweep + neg inflection that isn't catastrophic enough to Avoid)
  const opLimits = operatingLimitsForRun(m);
  if (opLimits) {
    lines.push('');
    lines.push('### 操作上限 / Operating limits');
    lines.push('');
    lines.push(opLimits);
  }

  // 5. Avoid (only true failures)
  const avoid = avoidReasonsForRun(m);
  if (avoid.length > 0) {
    lines.push('');
    lines.push('### 真的別用 / Avoid');
    lines.push('');
    for (const a of avoid) lines.push(`- ${a}`);
  }

  return lines.join('\n') + '\n';
}

function narrativeZh(m: RunMetrics): string {
  const parts: string[] = [];
  parts.push(
    `這次跑了 ${formatDurationZh(m.wall_time_ms)}，花了 ${formatMoneyZh(m.total_cost_usd, m.cost_source)}。`,
  );

  // Reliability + accuracy
  if (m.evaluator.name === 'success') {
    if (m.success_rate >= 0.999) {
      parts.push(`全部 ${m.workers_total} 個任務都跑完、沒出錯。`);
    } else if (m.success_rate >= RELIABILITY_AVOID) {
      parts.push(
        `${m.workers_total} 個任務裡 ${m.workers_failed} 個失敗 — 不算多但要追原因。`,
      );
    } else {
      parts.push(
        `${m.workers_failed} 個任務失敗（${(m.success_rate * 100).toFixed(0)}% 成功率），失敗率太高，下面的指標先別當真。`,
      );
    }
  } else {
    parts.push(
      `${m.workers_total} 個任務裡 model 答對 ${m.workers_total === 0 ? 0 : Math.round(m.eval_pass_rate * m.workers_total)} 個（${(m.eval_pass_rate * 100).toFixed(0)}%）。`,
    );
  }

  // Latency feel
  const p50 = Math.round(m.p50_latency_ms);
  const p95 = Math.round(m.p95_latency_ms);
  const ratio = m.p50_latency_ms > 0 ? m.p95_latency_ms / m.p50_latency_ms : 0;
  if (ratio > 0) {
    if (ratio <= 1.5) {
      parts.push(`回應時間平穩，大多在 ${p50}ms 上下。`);
    } else {
      parts.push(`典型 ${p50}ms 回應，但偶爾會拉到 ${p95}ms（${ratio.toFixed(1)} 倍慢）— 偶發長尾。`);
    }
  }

  // Orchestration overhead
  if (m.coordinator_latency_ms !== undefined) {
    const overhead = m.coordination_overhead_pct ?? 0;
    if (overhead < 20) {
      parts.push(`只有 ${overhead.toFixed(0)}% 時間花在協調，效率好。`);
    } else if (overhead < 50) {
      parts.push(`${overhead.toFixed(0)}% 時間花在規劃跟整合（不是真的在做事）— 看起來是 agent runtime 的正常代價。`);
    } else {
      parts.push(
        `${overhead.toFixed(0)}% 時間花在規劃跟整合（不是真的在做事）— 比例偏高，做大量單次呼叫不划算。`,
      );
    }
  }
  return parts.join('');
}

function narrativeEn(m: RunMetrics): string {
  const parts: string[] = [];
  parts.push(
    `This run took ${formatDurationEn(m.wall_time_ms)} and cost ${formatMoneyEn(m.total_cost_usd, m.cost_source)}.`,
  );

  if (m.evaluator.name === 'success') {
    if (m.success_rate >= 0.999) {
      parts.push(`All ${m.workers_total} tasks completed without error.`);
    } else if (m.success_rate >= RELIABILITY_AVOID) {
      parts.push(
        `${m.workers_failed} of ${m.workers_total} tasks failed — minor, but worth investigating.`,
      );
    } else {
      parts.push(
        `${m.workers_failed} of ${m.workers_total} tasks failed (${(m.success_rate * 100).toFixed(0)}% success). The numbers below aren't trustworthy until you fix this.`,
      );
    }
  } else {
    const right = m.workers_total === 0 ? 0 : Math.round(m.eval_pass_rate * m.workers_total);
    parts.push(`The model got ${right} of ${m.workers_total} answers right (${(m.eval_pass_rate * 100).toFixed(0)}%).`);
  }

  const p50 = Math.round(m.p50_latency_ms);
  const p95 = Math.round(m.p95_latency_ms);
  const ratio = m.p50_latency_ms > 0 ? m.p95_latency_ms / m.p50_latency_ms : 0;
  if (ratio > 0) {
    if (ratio <= 1.5) {
      parts.push(`Response times were steady, around ${p50}ms.`);
    } else {
      parts.push(
        `Typical response was ${p50}ms, but some stretched to ${p95}ms (${ratio.toFixed(1)}× slower) — expect occasional long tails.`,
      );
    }
  }

  if (m.coordinator_latency_ms !== undefined) {
    const overhead = m.coordination_overhead_pct ?? 0;
    if (overhead < 20) {
      parts.push(`Only ${overhead.toFixed(0)}% of wall time went to coordination — efficient.`);
    } else if (overhead < 50) {
      parts.push(
        `${overhead.toFixed(0)}% of wall time went to planning and merging rather than working — normal for an agent runtime.`,
      );
    } else {
      parts.push(
        `${overhead.toFixed(0)}% of wall time went to planning and merging rather than working — high; not cost-effective for high-volume single calls.`,
      );
    }
  }
  return parts.join(' ');
}

function bottomLineZh(m: RunMetrics): string {
  if (m.success_rate < RELIABILITY_AVOID) {
    return `失敗率太高，先解決可靠性問題再看其他指標。`;
  }
  if (m.evaluator.name !== 'success' && m.eval_pass_rate < ACCURACY_AVOID) {
    return `Accuracy 太低，這個 model + scenario 組合不能用 — 換 model 或改 prompt。`;
  }
  const sum = m.per_level && m.per_level.length > 1 ? summarizeSweep(m.per_level) : null;
  if (sum?.inflection && sum.inflection.next_gain_pct < 0) {
    return `這個 model 跑得起來，但**並發超過 N=${sum.inflection.at_concurrency} 會掉效能**，部署時限制在這之內。`;
  }
  if (m.per_level && m.per_level.length > 1 && sum && !sum.inflection) {
    return `這個 model 還沒到飽和點 — 可以再往上加並發試試看。`;
  }
  return `單一 model 跑一次沒對照組，看不出「好不好」。想知道值不值得用，跑 \`afb matrix\` 跟其他 model 並排比。`;
}

function bottomLineEn(m: RunMetrics): string {
  if (m.success_rate < RELIABILITY_AVOID) {
    return `Reliability is too low. Fix the failures before reading anything else here.`;
  }
  if (m.evaluator.name !== 'success' && m.eval_pass_rate < ACCURACY_AVOID) {
    return `Accuracy too low — this model isn't fit for this scenario. Try a different model or improve the prompts.`;
  }
  const sum = m.per_level && m.per_level.length > 1 ? summarizeSweep(m.per_level) : null;
  if (sum?.inflection && sum.inflection.next_gain_pct < 0) {
    return `This model works, but **cap concurrency at N=${sum.inflection.at_concurrency}** — pushing higher degrades throughput.`;
  }
  if (m.per_level && m.per_level.length > 1 && sum && !sum.inflection) {
    return `Throughput hasn't saturated yet at the highest tested concurrency — try going higher.`;
  }
  return `A single run on one model doesn't tell you whether it's *good* — there's no baseline. Run \`afb matrix\` to compare.`;
}

function technicalBullets(m: RunMetrics): string[] {
  const out: string[] = [];

  if (m.success_rate >= 0.999) {
    out.push(`- **Reliability**: ✓ 100% adapter success (${m.workers_succeeded}/${m.workers_total})`);
  } else if (m.success_rate >= RELIABILITY_AVOID) {
    out.push(
      `- **Reliability**: ⚠️ ${(m.success_rate * 100).toFixed(1)}% adapter success — ${m.workers_failed} task(s) failed`,
    );
  } else {
    out.push(
      `- **Reliability**: ✗ ${(m.success_rate * 100).toFixed(1)}% adapter success — ${m.workers_failed} failures`,
    );
  }

  if (m.evaluator.name !== 'success') {
    const ap = m.eval_pass_rate;
    const icon = ap >= 0.95 ? '✓' : ap >= ACCURACY_RELIABLE ? '⚠️' : '✗';
    out.push(
      `- **Accuracy** (${m.evaluator.name}): ${icon} ${(ap * 100).toFixed(1)}% passed — mean score ${m.eval_mean_score.toFixed(2)}`,
    );
  }

  const ratio = m.p50_latency_ms > 0 ? m.p95_latency_ms / m.p50_latency_ms : 0;
  const p50 = Math.round(m.p50_latency_ms);
  const p95 = Math.round(m.p95_latency_ms);
  if (ratio > 0) {
    if (ratio <= 1.5) out.push(`- **Consistency**: ✓ p95 (${p95}ms) close to p50 (${p50}ms)`);
    else if (ratio <= 3)
      out.push(
        `- **Consistency**: ⚠️ p95 (${p95}ms) is ${ratio.toFixed(1)}× p50 (${p50}ms)`,
      );
    else
      out.push(
        `- **Consistency**: ✗ p95 (${p95}ms) is ${ratio.toFixed(1)}× p50 (${p50}ms) — long tail`,
      );
  }

  if (m.cost_source === 'none') {
    out.push(`- **Cost**: unavailable — no pricing entry for ${m.provider}/${m.model}`);
  } else {
    const perOk = m.workers_succeeded > 0 ? m.total_cost_usd / m.workers_succeeded : 0;
    out.push(`- **Cost**: ${formatUsd(m.total_cost_usd)} total · ${formatUsd(perOk)} per successful task`);
  }

  if (m.coordinator_latency_ms !== undefined) {
    const overhead = m.coordination_overhead_pct ?? 0;
    const icon = overhead < 20 ? '✓' : overhead < 50 ? '⚠️' : '✗';
    out.push(
      `- **Orchestration**: ${m.cycles_succeeded}/${m.cycles_total} cycles · ${m.workers_succeeded}/${m.workers_total} subworkers · ${icon} ${overhead.toFixed(1)}% coordination tax`,
    );
  }

  if (m.per_level && m.per_level.length > 1) {
    const sum = summarizeSweep(m.per_level);
    if (sum) {
      if (!sum.inflection) {
        out.push(
          `- **Scaling**: still scaling at N=${sum.peak_throughput.at_concurrency} (${sum.peak_throughput.value.toFixed(2)}/s)`,
        );
      } else if (sum.inflection.next_gain_pct < 0) {
        out.push(
          `- **Scaling**: peak at N=${sum.inflection.at_concurrency}, throughput ${sum.inflection.next_gain_pct.toFixed(1)}% at next step`,
        );
      } else {
        out.push(
          `- **Scaling**: saturated at N=${sum.inflection.at_concurrency} (next step +${sum.inflection.next_gain_pct.toFixed(1)}%)`,
        );
      }
    }
  }

  return out;
}

function operatingLimitsForRun(m: RunMetrics): string | null {
  if (!m.per_level || m.per_level.length <= 1) return null;
  const sum = summarizeSweep(m.per_level);
  if (!sum?.inflection || sum.inflection.next_gain_pct >= 0) return null;
  return `- Cap concurrency at **N=${sum.inflection.at_concurrency}** for this model — past that throughput drops by ${Math.abs(sum.inflection.next_gain_pct).toFixed(1)}%.`;
}

function avoidReasonsForRun(m: RunMetrics): string[] {
  const out: string[] = [];
  if (m.success_rate < RELIABILITY_AVOID) {
    out.push(
      `Reliability only ${(m.success_rate * 100).toFixed(1)}% (${m.workers_failed} of ${m.workers_total} failed). Don't rely on these numbers until you understand why.`,
    );
  }
  if (m.evaluator.name !== 'success' && m.eval_pass_rate < ACCURACY_AVOID) {
    out.push(
      `Accuracy only ${(m.eval_pass_rate * 100).toFixed(1)}% (${m.evaluator.name}). This model isn't fit for this scenario.`,
    );
  }
  return out;
}

// =======================  MATRIX  =======================

export function verdictForMatrix(rows: MatrixRow[]): string {
  if (rows.length === 0) return '';
  const lines: string[] = [];

  // 1. Bilingual narrative
  lines.push('## 重點');
  lines.push('');
  lines.push(matrixNarrativeZh(rows));
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(matrixNarrativeEn(rows));
  lines.push('');

  // 2. Bilingual bottom line
  lines.push('## 結論');
  lines.push('');
  lines.push(matrixBottomLineZh(rows));
  lines.push('');
  lines.push('## Bottom line');
  lines.push('');
  lines.push(matrixBottomLineEn(rows));
  lines.push('');

  // 3. Cross-class warning (kept English since it's a domain term)
  const classes = new Set(rows.map((r) => r.metrics.runtime_class));
  if (classes.size > 1) {
    lines.push(
      `> ⚠️ Mixed runtime classes (${[...classes].join(', ')}). Raw-API rows have no coordination tax; agent-runtime rows do. Read $/success and latency with that asymmetry in mind.`,
    );
    lines.push('');
  }

  // 4. Single-row guard
  if (rows.length === 1) {
    lines.push('- Only one model in this matrix — there is nothing to compare. Re-run with `--models a,b,c` for a real comparison.');
    return lines.join('\n') + '\n';
  }

  // 5. Winners (technical bullets)
  lines.push('### 技術指標 / Winners');
  lines.push('');
  const reliable = rows.filter(isReliable);
  const hasAccuracy = rows.some((r) => r.metrics.evaluator.name !== 'success');

  if (reliable.length === 0) {
    lines.push('- No model in this matrix was reliable enough to win. See Avoid below.');
  } else {
    const cheapest = pickWinners(reliable, (r) => costPerSuccess(r.metrics), 'min');
    lines.push(
      formatWinner('Cheapest reliable', cheapest, reliable.length,
        (r) => `${formatUsd(costPerSuccess(r.metrics))} per success`,
        (v) => `${formatUsd(v)} per success`,
      ),
    );
    if (hasAccuracy) {
      const acc = pickWinners(reliable, (r) => r.metrics.eval_pass_rate, 'max');
      const evName = reliable[0].metrics.evaluator.name;
      lines.push(
        formatWinner('Most accurate', acc, reliable.length,
          (r) => `${(r.metrics.eval_pass_rate * 100).toFixed(1)}% pass — ${evName}`,
          (v) => `${(v * 100).toFixed(1)}% pass — accuracy doesn't separate them, decide by cost/speed`,
        ),
      );
    }
    const fastest = pickWinners(reliable, (r) => r.metrics.avg_latency_ms, 'min');
    lines.push(
      formatWinner('Fastest avg', fastest, reliable.length,
        (r) => `${Math.round(r.metrics.avg_latency_ms)}ms`,
        (v) => `${Math.round(v)}ms`,
      ),
    );
    const sweepReliable = reliable.filter((r) => r.metrics.per_level && r.metrics.per_level.length > 1);
    if (sweepReliable.length > 0) {
      const stillScaling = sweepReliable.filter((r) => {
        const s = summarizeSweep(r.metrics.per_level!);
        return s && !s.inflection;
      });
      const pool = stillScaling.length > 0 ? stillScaling : sweepReliable;
      const scale = pickWinners(
        pool,
        (r) => summarizeSweep(r.metrics.per_level!)?.peak_throughput.value ?? 0,
        'max',
      );
      lines.push(
        formatWinner('Best for scale', scale, pool.length,
          (r) => {
            const s = summarizeSweep(r.metrics.per_level!)!;
            return s.inflection
              ? `peaks ${s.peak_throughput.value.toFixed(2)}/s @ N=${s.peak_throughput.at_concurrency}`
              : `${s.peak_throughput.value.toFixed(2)}/s @ N=${s.peak_throughput.at_concurrency}, still scaling`;
          },
          (v) => `${v.toFixed(2)}/s peak — throughput doesn't separate them`,
        ),
      );
    }
  }

  // 6. Operating limits (per-row)
  const opLimits = matrixOperatingLimits(rows);
  if (opLimits.length > 0) {
    lines.push('');
    lines.push('### 操作上限 / Operating limits');
    lines.push('');
    for (const l of opLimits) lines.push(`- ${l}`);
  }

  // 7. Avoid (only true failures)
  const avoid = matrixAvoidReasons(rows);
  if (avoid.length > 0) {
    lines.push('');
    lines.push('### 真的別用 / Avoid');
    lines.push('');
    for (const a of avoid) lines.push(`- ${a}`);
  }

  lines.push('');
  return lines.join('\n') + '\n';
}

function matrixNarrativeZh(rows: MatrixRow[]): string {
  if (rows.length === 1) return `這個 matrix 只有一個 model — 沒得比，要對照組就加 \`--models a,b\`。`;
  const n = rows.length;
  const accUsed = rows.some((r) => r.metrics.evaluator.name !== 'success');
  const allReliable = rows.every(isReliable);
  const accuracies = rows.map((r) => r.metrics.eval_pass_rate);
  const allTied = accUsed && accuracies.every((a) => a === accuracies[0]);

  const parts: string[] = [];
  parts.push(`比了 ${n} 個 model。`);
  if (allReliable) {
    parts.push(`沒有失敗的。`);
  } else {
    const failed = rows.filter((r) => !isReliable(r)).length;
    parts.push(`其中 ${failed} 個不可靠（會失敗或答錯）。`);
  }
  if (accUsed && allTied) {
    parts.push(`Accuracy 三家並列 ${(accuracies[0] * 100).toFixed(0)}% — 拼準確度分不出高下，要靠速度或成本來挑。`);
  } else if (accUsed) {
    const max = Math.max(...accuracies);
    const min = Math.min(...accuracies);
    parts.push(`Accuracy 從 ${(min * 100).toFixed(0)}% 到 ${(max * 100).toFixed(0)}%。`);
  }
  return parts.join('');
}

function matrixNarrativeEn(rows: MatrixRow[]): string {
  if (rows.length === 1)
    return `Only one model in this matrix — nothing to compare. Add more with \`--models a,b\`.`;
  const n = rows.length;
  const accUsed = rows.some((r) => r.metrics.evaluator.name !== 'success');
  const allReliable = rows.every(isReliable);
  const accuracies = rows.map((r) => r.metrics.eval_pass_rate);
  const allTied = accUsed && accuracies.every((a) => a === accuracies[0]);

  const parts: string[] = [];
  parts.push(`Compared ${n} models.`);
  if (allReliable) {
    parts.push(`None failed.`);
  } else {
    const failed = rows.filter((r) => !isReliable(r)).length;
    parts.push(`${failed} of them weren't reliable (failures or low accuracy).`);
  }
  if (accUsed && allTied) {
    parts.push(
      `Accuracy is tied at ${(accuracies[0] * 100).toFixed(0)}% — accuracy doesn't pick a winner here; choose by cost or speed.`,
    );
  } else if (accUsed) {
    const max = Math.max(...accuracies);
    const min = Math.min(...accuracies);
    parts.push(`Accuracy ranges from ${(min * 100).toFixed(0)}% to ${(max * 100).toFixed(0)}%.`);
  }
  return parts.join(' ');
}

function matrixBottomLineZh(rows: MatrixRow[]): string {
  if (rows.length === 1) return `加 model 再來。`;
  const reliable = rows.filter(isReliable);
  if (reliable.length === 0) return `沒有一個 model 算可靠 — 先處理失敗/低 accuracy 再說。`;
  const cheap = pickWinners(reliable, (r) => costPerSuccess(r.metrics), 'min');
  const fast = pickWinners(reliable, (r) => r.metrics.avg_latency_ms, 'min');
  if (cheap.winners.length === 1 && fast.winners.length === 1 && cheap.winners[0].label === fast.winners[0].label) {
    return `**${cheap.winners[0].label}** 同時最便宜跟最快，直接選它。`;
  }
  const cheapLabel = cheap.winners[0]?.label;
  const fastLabel = fast.winners[0]?.label;
  return `想最便宜選 \`${cheapLabel}\`，想最快選 \`${fastLabel}\`。其他指標看下方。`;
}

function matrixBottomLineEn(rows: MatrixRow[]): string {
  if (rows.length === 1) return `Add models and re-run.`;
  const reliable = rows.filter(isReliable);
  if (reliable.length === 0)
    return `No model in this matrix was reliable. Fix the failures/accuracy first.`;
  const cheap = pickWinners(reliable, (r) => costPerSuccess(r.metrics), 'min');
  const fast = pickWinners(reliable, (r) => r.metrics.avg_latency_ms, 'min');
  if (
    cheap.winners.length === 1 &&
    fast.winners.length === 1 &&
    cheap.winners[0].label === fast.winners[0].label
  ) {
    return `**${cheap.winners[0].label}** is both cheapest and fastest — pick it.`;
  }
  return `Pick \`${cheap.winners[0]?.label}\` for cost, \`${fast.winners[0]?.label}\` for speed. Other metrics below.`;
}

function matrixOperatingLimits(rows: MatrixRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const m = r.metrics;
    if (!m.per_level || m.per_level.length <= 1) continue;
    const s = summarizeSweep(m.per_level);
    if (!s?.inflection || s.inflection.next_gain_pct >= 0) continue;
    // If model is in Avoid anyway, don't double-list.
    if (m.success_rate < RELIABILITY_AVOID) continue;
    if (m.evaluator.name !== 'success' && m.eval_pass_rate < ACCURACY_AVOID) continue;
    out.push(
      `\`${r.label}\`: cap concurrency at **N=${s.inflection.at_concurrency}** — throughput drops ${Math.abs(s.inflection.next_gain_pct).toFixed(1)}% at the next step.`,
    );
  }
  return out;
}

function matrixAvoidReasons(rows: MatrixRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const m = r.metrics;
    const reasons: string[] = [];
    if (m.success_rate < RELIABILITY_AVOID) {
      reasons.push(`${(m.success_rate * 100).toFixed(1)}% reliability`);
    }
    if (m.evaluator.name !== 'success' && m.eval_pass_rate < ACCURACY_AVOID) {
      reasons.push(`${(m.eval_pass_rate * 100).toFixed(1)}% accuracy (${m.evaluator.name})`);
    }
    if (reasons.length > 0) out.push(`\`${r.label}\` — ${reasons.join('; ')}`);
  }
  return out;
}

// =======================  helpers  =======================

function isReliable(r: MatrixRow): boolean {
  const m = r.metrics;
  if (m.success_rate < RELIABILITY_AVOID) return false;
  if (m.evaluator.name !== 'success' && m.eval_pass_rate < ACCURACY_RELIABLE) return false;
  return true;
}

function costPerSuccess(m: RunMetrics): number {
  return m.workers_succeeded > 0 ? m.total_cost_usd / m.workers_succeeded : 0;
}

function formatDurationZh(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${(ms / 60_000).toFixed(1)} 分鐘`;
}

function formatDurationEn(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} seconds`;
  return `${(ms / 60_000).toFixed(1)} minutes`;
}

function formatMoneyZh(usd: number, source: string): string {
  if (source === 'none') return '無法計算（沒有 pricing）';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `不到一分美元（${formatUsd(usd)}）`;
  if (usd < 1) return formatUsd(usd);
  return `美金 ${formatUsd(usd)}`;
}

function formatMoneyEn(usd: number, source: string): string {
  if (source === 'none') return 'unknown (no pricing data)';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `less than a cent (${formatUsd(usd)})`;
  return formatUsd(usd);
}

interface Winners<T> {
  winners: T[];
  value: number;
}

function pickWinners<T>(items: T[], score: (t: T) => number, mode: 'min' | 'max'): Winners<T> {
  if (items.length === 0) return { winners: [], value: 0 };
  const scores = items.map((t) => score(t));
  const best = mode === 'min' ? Math.min(...scores) : Math.max(...scores);
  const winners: T[] = [];
  scores.forEach((s, i) => {
    if (s === best) winners.push(items[i]);
  });
  return { winners, value: best };
}

function formatWinner<T extends { label: string }>(
  category: string,
  result: Winners<T>,
  totalCandidates: number,
  formatOne: (t: T) => string,
  formatAllTied: (value: number) => string,
): string {
  const { winners, value } = result;
  if (winners.length === 0) return `- **${category}**: —`;
  if (winners.length === 1) {
    return `- **${category}**: \`${winners[0].label}\` (${formatOne(winners[0])})`;
  }
  if (winners.length === totalCandidates) {
    return `- **${category}** (all ${totalCandidates} tied): ${formatAllTied(value)}`;
  }
  const labels = winners.map((w) => `\`${w.label}\``).join(', ');
  return `- **${category}** (tied, ${winners.length}/${totalCandidates}): ${labels} — ${formatOne(winners[0])}`;
}

// Re-export for tests that previously imported summarizeSweep through this module.
export type { SweepSummary };
