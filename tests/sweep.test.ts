import { describe, it, expect } from 'vitest';
import { summarizeSweep, type PerLevel } from '../src/metrics/sweep.js';

function level(c: number, thru: number, succ = c, total = c): PerLevel {
  return {
    concurrency: c,
    workers_total: total,
    workers_succeeded: succ,
    avg_latency_ms: 100,
    p95_latency_ms: 150,
    throughput_per_sec: thru,
    wall_time_ms: Math.round((total / thru) * 1000),
  };
}

describe('summarizeSweep', () => {
  it('returns null for an empty sweep', () => {
    expect(summarizeSweep([])).toBeNull();
  });

  it('finds the inflection at the first step under threshold', () => {
    // Throughput doubles then flattens: 10 → 20 → 21 → 22
    // 10 → 20 is +100% (above threshold, keep going)
    // 20 → 21 is +5% (below 10% threshold) → inflection at N=2
    const s = summarizeSweep([level(1, 10), level(2, 20), level(4, 21), level(8, 22)]);
    expect(s).not.toBeNull();
    expect(s!.inflection).toEqual({ at_concurrency: 2, next_gain_pct: expect.closeTo(5, 1) });
  });

  it('reports null inflection when throughput keeps scaling above threshold', () => {
    const s = summarizeSweep([level(1, 10), level(2, 20), level(4, 40), level(8, 80)]);
    expect(s!.inflection).toBeNull();
  });

  it('picks the highest throughput as the peak', () => {
    const s = summarizeSweep([level(1, 10), level(8, 80), level(16, 70)]);
    expect(s!.peak_throughput).toEqual({ value: 80, at_concurrency: 8 });
  });

  it('picks the highest success rate as peak_success_rate', () => {
    const s = summarizeSweep([
      level(1, 10, 1, 1), // 100%
      level(2, 18, 1, 2), // 50%
      level(4, 35, 2, 4), // 50%
    ]);
    expect(s!.peak_success_rate.value).toBe(1);
    expect(s!.peak_success_rate.at_concurrency).toBe(1);
  });

  it('treats unsorted input the same as sorted', () => {
    const a = summarizeSweep([level(8, 22), level(1, 10), level(2, 20), level(4, 21)]);
    const b = summarizeSweep([level(1, 10), level(2, 20), level(4, 21), level(8, 22)]);
    expect(a).toEqual(b);
  });

  it('handles a single-level sweep (no inflection possible)', () => {
    const s = summarizeSweep([level(4, 30)]);
    expect(s!.inflection).toBeNull();
    expect(s!.peak_throughput).toEqual({ value: 30, at_concurrency: 4 });
  });

  it('uses a configurable threshold', () => {
    // 10 → 12 is +20%. With default 10% threshold: no inflection.
    // With 25% threshold: inflection at N=1.
    const levels = [level(1, 10), level(2, 12), level(4, 14.5)];
    expect(summarizeSweep(levels, 0.1)!.inflection).toBeNull();
    expect(summarizeSweep(levels, 0.25)!.inflection!.at_concurrency).toBe(1);
  });
});
