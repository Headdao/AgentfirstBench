import type { RunMetrics } from '../metrics/types.js';
import type { MatrixRow } from './matrix.js';
import { summarizeSweep } from '../metrics/sweep.js';
import { formatUsd } from '../utils/format.js';

/**
 * Rule-based plain-language interpretation of a run. Goal: a user who
 * doesn't know "what's p95?" or "is 800ms good?" can still read the
 * report and decide what to do next.
 *
 * No AI involved — just deterministic thresholds derived from the data
 * itself. If the rules change later, behavior is reviewable in git.
 */
export function verdictForRun(m: RunMetrics): string {
  const lines: string[] = ['## Verdict', ''];

  // Reliability (did the adapter return ok?)
  const sr = m.success_rate;
  if (sr >= 0.999) {
    lines.push(`- **Reliability**: ✓ 100% adapter success (${m.workers_succeeded}/${m.workers_total})`);
  } else if (sr >= 0.95) {
    lines.push(
      `- **Reliability**: ⚠️ ${(sr * 100).toFixed(1)}% adapter success — ${m.workers_failed} task(s) failed`,
    );
  } else {
    lines.push(
      `- **Reliability**: ✗ ${(sr * 100).toFixed(1)}% adapter success — ${m.workers_failed} failures, investigate before trusting numbers below`,
    );
  }

  // Accuracy (did the model produce a correct/well-formed output?)
  // Only surface when a real evaluator was used — otherwise it duplicates Reliability.
  if (m.evaluator.name !== 'success') {
    const ap = m.eval_pass_rate;
    const apPct = (ap * 100).toFixed(1);
    const apIcon = ap >= 0.95 ? '✓' : ap >= 0.7 ? '⚠️' : '✗';
    lines.push(
      `- **Accuracy** (${m.evaluator.name}): ${apIcon} ${apPct}% passed — mean score ${m.eval_mean_score.toFixed(2)}`,
    );
  }

  // Latency consistency (p95 vs p50)
  const ratio = m.p50_latency_ms > 0 ? m.p95_latency_ms / m.p50_latency_ms : 0;
  const p50 = Math.round(m.p50_latency_ms);
  const p95 = Math.round(m.p95_latency_ms);
  if (ratio === 0) {
    // no signal
  } else if (ratio <= 1.5) {
    lines.push(`- **Consistency**: ✓ p95 (${p95}ms) close to p50 (${p50}ms)`);
  } else if (ratio <= 3) {
    lines.push(
      `- **Consistency**: ⚠️ p95 (${p95}ms) is ${ratio.toFixed(1)}× p50 (${p50}ms) — some tasks much slower than typical`,
    );
  } else {
    lines.push(
      `- **Consistency**: ✗ p95 (${p95}ms) is ${ratio.toFixed(1)}× p50 (${p50}ms) — long-tail latency, expect occasional very slow responses`,
    );
  }

  // Cost
  const perOk = m.workers_succeeded > 0 ? m.total_cost_usd / m.workers_succeeded : 0;
  if (m.cost_source === 'none') {
    lines.push(`- **Cost**: unavailable — no pricing entry for ${m.provider}/${m.model}`);
  } else {
    lines.push(
      `- **Cost**: ${formatUsd(m.total_cost_usd)} total, ${formatUsd(perOk)} per successful task`,
    );
  }

  // Scaling (only for sweep scenarios)
  if (m.per_level && m.per_level.length > 1) {
    const sum = summarizeSweep(m.per_level);
    if (sum) {
      if (!sum.inflection) {
        lines.push(
          `- **Scaling**: still scaling at N=${sum.peak_throughput.at_concurrency} (${sum.peak_throughput.value.toFixed(2)}/s) — try higher concurrency to find the ceiling`,
        );
      } else if (sum.inflection.next_gain_pct < 0) {
        lines.push(
          `- **Scaling**: ✗ throughput drops ${sum.inflection.next_gain_pct.toFixed(1)}% past N=${sum.inflection.at_concurrency} — server overload, don't go higher`,
        );
      } else {
        lines.push(
          `- **Scaling**: saturated at N=${sum.inflection.at_concurrency} (next step only adds ${sum.inflection.next_gain_pct.toFixed(1)}%) — diminishing returns above this`,
        );
      }
    }
  }

  lines.push('');
  lines.push('### What this tells you');
  if (m.per_level && m.per_level.length > 1) {
    lines.push(
      `- This sweep shows where ${m.provider}/${m.model} stops benefiting from more concurrency.`,
    );
    lines.push(
      '- To compare against other models at the same concurrency, use `afb matrix` with this scenario.',
    );
  } else {
    lines.push("- A single run doesn't tell you whether the numbers are *good* — there's no baseline.");
    lines.push('- To answer "is this the right model?": `afb matrix <this scenario>`');
    lines.push('- To answer "how many parallel workers can I use?": run `scenarios/concurrency_ramp.yaml`');
  }

  return lines.join('\n') + '\n';
}

/**
 * Multi-model verdict. Picks winners across three axes (cost, speed,
 * scale) from the reliable subset, then flags any model worth avoiding.
 */
export function verdictForMatrix(rows: MatrixRow[]): string {
  if (rows.length === 0) return '';
  const lines: string[] = ['## Verdict', ''];

  // "Reliable" = adapter usually returns ok AND, when a real evaluator
  // is in use, accuracy is at least 70%. Picking the cheapest model that
  // gets the wrong answer cheaply is the wrong recommendation.
  const reliable = rows.filter((r) => {
    if (r.metrics.success_rate < 0.95) return false;
    if (r.metrics.evaluator.name !== 'success' && r.metrics.eval_pass_rate < 0.7) return false;
    return true;
  });
  const hasAccuracy = rows.some((r) => r.metrics.evaluator.name !== 'success');

  if (rows.length === 1) {
    lines.push(
      '- Only one model in this matrix — there is nothing to compare. Re-run with `--models a,b,c` for a real comparison.',
    );
    return lines.join('\n') + '\n';
  }

  if (reliable.length === 0) {
    lines.push('- No model in this matrix was reliable (<95% success). All flagged below.');
  } else {
    // Cheapest reliable (min $/success)
    const cheapestWinners = pickWinners(reliable, (r) => costPerSuccess(r.metrics), 'min');
    lines.push(
      formatWinner(
        'Cheapest reliable',
        cheapestWinners,
        reliable.length,
        (r) => `${formatUsd(costPerSuccess(r.metrics))} per success`,
        (v) => `${formatUsd(v)} per success`,
      ),
    );

    // Most accurate (only when a real evaluator was used)
    if (hasAccuracy) {
      const accuracyWinners = pickWinners(reliable, (r) => r.metrics.eval_pass_rate, 'max');
      const evName = reliable[0].metrics.evaluator.name;
      lines.push(
        formatWinner(
          'Most accurate',
          accuracyWinners,
          reliable.length,
          (r) => `${(r.metrics.eval_pass_rate * 100).toFixed(1)}% pass — ${evName}`,
          (v) =>
            `${(v * 100).toFixed(1)}% pass — accuracy doesn't separate them, decide by cost/speed`,
        ),
      );
    }

    // Fastest avg
    const fastestWinners = pickWinners(reliable, (r) => r.metrics.avg_latency_ms, 'min');
    lines.push(
      formatWinner(
        'Fastest avg',
        fastestWinners,
        reliable.length,
        (r) => `${Math.round(r.metrics.avg_latency_ms)}ms`,
        (v) => `${Math.round(v)}ms`,
      ),
    );

    // Best for scale (sweep scenarios only)
    const sweepReliable = reliable.filter(
      (r) => r.metrics.per_level && r.metrics.per_level.length > 1,
    );
    if (sweepReliable.length > 0) {
      const stillScaling = sweepReliable.filter((r) => {
        const s = summarizeSweep(r.metrics.per_level!);
        return s && !s.inflection;
      });
      const pool = stillScaling.length > 0 ? stillScaling : sweepReliable;
      const scaleWinners = pickWinners(
        pool,
        (r) => summarizeSweep(r.metrics.per_level!)?.peak_throughput.value ?? 0,
        'max',
      );
      lines.push(
        formatWinner(
          'Best for scale',
          scaleWinners,
          pool.length,
          (r) => {
            const sum = summarizeSweep(r.metrics.per_level!)!;
            return sum.inflection
              ? `peaks ${sum.peak_throughput.value.toFixed(2)}/s @ N=${sum.peak_throughput.at_concurrency}`
              : `${sum.peak_throughput.value.toFixed(2)}/s @ N=${sum.peak_throughput.at_concurrency}, still scaling — try higher N`;
          },
          (v) => `${v.toFixed(2)}/s peak — throughput doesn't separate them`,
        ),
      );
    }
  }

  // Avoid list
  const avoid: string[] = [];
  for (const r of rows) {
    const reasons: string[] = [];
    const m = r.metrics;
    if (m.success_rate < 0.95) reasons.push(`${(m.success_rate * 100).toFixed(1)}% success`);
    if (m.evaluator.name !== 'success' && m.eval_pass_rate < 0.5) {
      reasons.push(`${(m.eval_pass_rate * 100).toFixed(1)}% accuracy (${m.evaluator.name})`);
    }
    if (m.per_level && m.per_level.length > 1) {
      const s = summarizeSweep(m.per_level);
      if (s?.inflection && s.inflection.next_gain_pct < 0) {
        reasons.push(
          `throughput dropped ${s.inflection.next_gain_pct.toFixed(1)}% past N=${s.inflection.at_concurrency}`,
        );
      }
    }
    if (reasons.length > 0) {
      avoid.push(`\`${r.label}\` (${reasons.join('; ')})`);
    }
  }
  if (avoid.length > 0) {
    lines.push('');
    lines.push(`### Avoid in this scenario`);
    for (const a of avoid) lines.push(`- ${a}`);
  }

  lines.push('');
  return lines.join('\n') + '\n';
}

function costPerSuccess(m: RunMetrics): number {
  return m.workers_succeeded > 0 ? m.total_cost_usd / m.workers_succeeded : 0;
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
    // Everyone tied — useless as a winner pick, redirect the user.
    return `- **${category}** (all ${totalCandidates} tied): ${formatAllTied(value)}`;
  }
  // Some tied, but not all — list them.
  const labels = winners.map((w) => `\`${w.label}\``).join(', ');
  return `- **${category}** (tied, ${winners.length}/${totalCandidates}): ${labels} — ${formatOne(winners[0])}`;
}
