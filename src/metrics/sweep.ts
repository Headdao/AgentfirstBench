import type { RunMetrics } from './types.js';

export type PerLevel = NonNullable<RunMetrics['per_level']>[number];

export interface SweepSummary {
  peak_throughput: { value: number; at_concurrency: number };
  peak_success_rate: { value: number; at_concurrency: number };
  /**
   * §18: the headline number — the concurrency level at which the **next**
   * step's throughput gain falls below `inflectionThreshold` (default 10%).
   * `null` if throughput kept scaling through the largest tested level
   * (caller should try higher concurrency to find the cliff).
   */
  inflection: { at_concurrency: number; next_gain_pct: number } | null;
}

/**
 * Detect where marginal returns turn negative (or flat enough to count as
 * negative). We walk the levels in order and look for the first transition
 * where `(throughput[i+1] - throughput[i]) / throughput[i] < threshold`.
 *
 * Why "next gain" and not "current gain": the inflection report should
 * answer "at what point did adding more workers stop paying off?". The
 * concurrency level we name is the one *before* the disappointing step —
 * i.e. "you got the most value at N=16; stepping up to N=32 only added
 * 0.5%, so 16 is the sweet spot".
 */
export function summarizeSweep(
  perLevel: PerLevel[],
  inflectionThreshold = 0.1,
): SweepSummary | null {
  if (perLevel.length === 0) return null;
  const sorted = [...perLevel].sort((a, b) => a.concurrency - b.concurrency);

  let peakT = sorted[0];
  let peakS = sorted[0];
  for (const r of sorted) {
    if (r.throughput_per_sec > peakT.throughput_per_sec) peakT = r;
    const rate = r.workers_total ? r.workers_succeeded / r.workers_total : 0;
    const peakRate = peakS.workers_total ? peakS.workers_succeeded / peakS.workers_total : 0;
    if (rate > peakRate) peakS = r;
  }

  let inflection: SweepSummary['inflection'] = null;
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i].throughput_per_sec;
    const next = sorted[i + 1].throughput_per_sec;
    if (cur <= 0) continue;
    const gain = (next - cur) / cur;
    if (gain < inflectionThreshold) {
      inflection = { at_concurrency: sorted[i].concurrency, next_gain_pct: gain * 100 };
      break;
    }
  }

  const peakSRate = peakS.workers_total ? peakS.workers_succeeded / peakS.workers_total : 0;

  return {
    peak_throughput: {
      value: peakT.throughput_per_sec,
      at_concurrency: peakT.concurrency,
    },
    peak_success_rate: {
      value: peakSRate,
      at_concurrency: peakS.concurrency,
    },
    inflection,
  };
}
