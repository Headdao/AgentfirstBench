import { describe, it, expect } from 'vitest';
import { verdictForRun, verdictForMatrix } from '../src/reports/verdict.js';
import type { RunMetrics } from '../src/metrics/types.js';
import type { MatrixRow } from '../src/reports/matrix.js';

function metrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    afb_version: '0.1.0',
    node_version: '22',
    os: 'darwin arm64',
    provider: 'mock',
    model: 'mock-model',
    runtime: 'mock',
    scenario_hash: 'sh',
    dataset_hash: 'dh',
    scenario_name: 'test',
    scenario_kind: 'research_synthesis',
    prompt_template_version: 'inline/v1',
    scoring_profile_version: 'default/v1',
    evaluator: { name: 'success', version: '1.0.0' },
    temperature: 0.2,
    started_at: '2026-05-21T00:00:00Z',
    completed_at: '2026-05-21T00:00:10Z',
    run_id: 'run_test',
    network_policy: { mode: 'disabled' },
    apply: false,
    seed: 1,
    workers_total: 10,
    workers_succeeded: 10,
    workers_failed: 0,
    workers_retried: 0,
    success_rate: 1,
    avg_latency_ms: 150,
    p50_latency_ms: 140,
    p95_latency_ms: 200,
    p99_latency_ms: 220,
    peak_concurrency: 4,
    total_input_tokens: 1000,
    total_output_tokens: 500,
    total_tokens: 1500,
    wall_time_ms: 1500,
    total_cost_usd: 0.01,
    cost_source: 'pricing_table',
    pricing_as_of: '2026-05-21',
    ...overrides,
  };
}

describe('verdictForRun — reliability', () => {
  it('emits ✓ for 100% success', () => {
    expect(verdictForRun(metrics())).toMatch(/✓ 100% adapter success/);
  });
  it('emits ⚠️ for 95–99.9% success', () => {
    const v = verdictForRun(metrics({ success_rate: 0.97, workers_failed: 3, workers_succeeded: 97, workers_total: 100 }));
    expect(v).toMatch(/⚠️ 97.0% adapter success/);
  });
  it('emits ✗ for <95% success and lists it in the Avoid section', () => {
    const v = verdictForRun(metrics({ success_rate: 0.5, workers_failed: 5, workers_succeeded: 5, workers_total: 10 }));
    expect(v).toMatch(/✗ 50.0% adapter success/);
    expect(v).toMatch(/Avoid/);
    expect(v).toMatch(/Reliability only 50.0%/);
  });
});

describe('verdictForRun — consistency (p95/p50)', () => {
  it('✓ when p95 ≤ 1.5× p50', () => {
    const v = verdictForRun(metrics({ p50_latency_ms: 100, p95_latency_ms: 140 }));
    expect(v).toMatch(/Consistency.*✓/);
  });
  it('⚠️ when 1.5× < ratio ≤ 3×', () => {
    const v = verdictForRun(metrics({ p50_latency_ms: 100, p95_latency_ms: 250 }));
    expect(v).toMatch(/Consistency.*⚠️/);
    expect(v).toMatch(/2\.5×/);
  });
  it('✗ when ratio > 3×', () => {
    const v = verdictForRun(metrics({ p50_latency_ms: 100, p95_latency_ms: 600 }));
    expect(v).toMatch(/Consistency.*✗/);
    expect(v).toMatch(/long tail/);
  });
});

describe('verdictForRun — scaling (sweep)', () => {
  it('says "still scaling" when no inflection', () => {
    const v = verdictForRun(
      metrics({
        per_level: [
          { concurrency: 1, workers_total: 4, workers_succeeded: 4, avg_latency_ms: 100, p95_latency_ms: 120, throughput_per_sec: 10, wall_time_ms: 400 },
          { concurrency: 2, workers_total: 4, workers_succeeded: 4, avg_latency_ms: 100, p95_latency_ms: 120, throughput_per_sec: 20, wall_time_ms: 200 },
          { concurrency: 4, workers_total: 4, workers_succeeded: 4, avg_latency_ms: 100, p95_latency_ms: 120, throughput_per_sec: 40, wall_time_ms: 100 },
        ],
      }),
    );
    expect(v).toMatch(/still scaling/);
  });

  it('routes degrading scaling to Operating limits, not Avoid', () => {
    const v = verdictForRun(
      metrics({
        per_level: [
          { concurrency: 1, workers_total: 4, workers_succeeded: 4, avg_latency_ms: 100, p95_latency_ms: 120, throughput_per_sec: 10, wall_time_ms: 400 },
          { concurrency: 2, workers_total: 4, workers_succeeded: 4, avg_latency_ms: 200, p95_latency_ms: 250, throughput_per_sec: 5, wall_time_ms: 800 },
        ],
      }),
    );
    expect(v).toMatch(/Operating limits/);
    expect(v).toMatch(/Cap concurrency at \*\*N=1\*\*/);
    // Negative inflection alone shouldn't trigger the Avoid section
    expect(v).not.toMatch(/真的別用/);
  });

  it('reports saturation with positive-but-tiny gain', () => {
    const v = verdictForRun(
      metrics({
        per_level: [
          { concurrency: 1, workers_total: 4, workers_succeeded: 4, avg_latency_ms: 100, p95_latency_ms: 120, throughput_per_sec: 10, wall_time_ms: 400 },
          { concurrency: 2, workers_total: 4, workers_succeeded: 4, avg_latency_ms: 100, p95_latency_ms: 120, throughput_per_sec: 10.5, wall_time_ms: 380 },
        ],
      }),
    );
    expect(v).toMatch(/saturated at N=1/);
  });
});

describe('verdictForMatrix', () => {
  function row(label: string, overrides: Partial<RunMetrics> = {}): MatrixRow {
    return { label, metrics: metrics(overrides) };
  }

  it('picks cheapest reliable correctly', () => {
    const v = verdictForMatrix([
      row('cheap/a', { total_cost_usd: 0.001, workers_succeeded: 10 }),
      row('pricey/b', { total_cost_usd: 0.1, workers_succeeded: 10 }),
    ]);
    expect(v).toMatch(/Cheapest reliable.*cheap\/a/);
  });

  it('picks fastest avg correctly', () => {
    const v = verdictForMatrix([
      row('slow/x', { avg_latency_ms: 500 }),
      row('fast/y', { avg_latency_ms: 50 }),
    ]);
    expect(v).toMatch(/Fastest avg.*fast\/y/);
  });

  it('flags models with <95% reliability in the Avoid section', () => {
    const v = verdictForMatrix([
      row('good/a'),
      row('bad/b', { success_rate: 0.5, workers_succeeded: 5, workers_failed: 5 }),
    ]);
    expect(v).toMatch(/真的別用 \/ Avoid/);
    expect(v).toMatch(/bad\/b/);
    expect(v).toMatch(/50.0% reliability/);
  });

  it('routes degrading throughput to Operating limits, not Avoid', () => {
    const v = verdictForMatrix([
      row('a/scaling', {
        per_level: [
          { concurrency: 1, workers_total: 4, workers_succeeded: 4, avg_latency_ms: 100, p95_latency_ms: 120, throughput_per_sec: 10, wall_time_ms: 400 },
          { concurrency: 2, workers_total: 4, workers_succeeded: 4, avg_latency_ms: 100, p95_latency_ms: 120, throughput_per_sec: 20, wall_time_ms: 200 },
        ],
      }),
      row('b/overload', {
        per_level: [
          { concurrency: 1, workers_total: 4, workers_succeeded: 4, avg_latency_ms: 100, p95_latency_ms: 120, throughput_per_sec: 10, wall_time_ms: 400 },
          { concurrency: 2, workers_total: 4, workers_succeeded: 4, avg_latency_ms: 200, p95_latency_ms: 250, throughput_per_sec: 5, wall_time_ms: 800 },
        ],
      }),
    ]);
    expect(v).toMatch(/Operating limits/);
    expect(v).toMatch(/b\/overload.*cap concurrency at \*\*N=1\*\*/);
    // Negative inflection alone (without reliability/accuracy issue) shouldn't appear in Avoid
    expect(v).not.toMatch(/真的別用 \/ Avoid[\s\S]*b\/overload/);
  });

  it('handles single-model matrix gracefully', () => {
    const v = verdictForMatrix([row('only/one')]);
    expect(v).toMatch(/Only one model/);
  });

  it('handles all-unreliable matrix', () => {
    const v = verdictForMatrix([
      row('bad1', { success_rate: 0.5, workers_succeeded: 5, workers_failed: 5 }),
      row('bad2', { success_rate: 0.3, workers_succeeded: 3, workers_failed: 7 }),
    ]);
    expect(v).toMatch(/No model in this matrix was reliable/);
  });

  it('emits bilingual narrative + bottom line for run', () => {
    const v = verdictForRun(metrics());
    expect(v).toMatch(/## 重點/);
    expect(v).toMatch(/## Summary/);
    expect(v).toMatch(/## 結論/);
    expect(v).toMatch(/## Bottom line/);
    expect(v).toMatch(/### 技術指標 \/ Metrics/);
  });

  it('emits bilingual narrative + bottom line for matrix', () => {
    const v = verdictForMatrix([row('a/x'), row('b/y')]);
    expect(v).toMatch(/## 重點/);
    expect(v).toMatch(/## Summary/);
    expect(v).toMatch(/## 結論/);
    expect(v).toMatch(/## Bottom line/);
  });

  it('flags ties on accuracy explicitly when all models tie', () => {
    const v = verdictForMatrix([
      row('a', {
        evaluator: { name: 'exact_match', version: '1.0.0' },
        eval_pass_rate: 0.75,
        avg_latency_ms: 500,
      }),
      row('b', {
        evaluator: { name: 'exact_match', version: '1.0.0' },
        eval_pass_rate: 0.75,
        avg_latency_ms: 1000,
      }),
      row('c', {
        evaluator: { name: 'exact_match', version: '1.0.0' },
        eval_pass_rate: 0.75,
        avg_latency_ms: 1500,
      }),
    ]);
    expect(v).toMatch(/Most accurate.*all 3 tied/);
    expect(v).toMatch(/doesn't separate them/);
    // Should NOT name a single winner.
    expect(v).not.toMatch(/Most accurate.*`a`.*75/);
  });

  it('lists tied subset when 2 of 3 tie (all reliable)', () => {
    const v = verdictForMatrix([
      row('a', {
        evaluator: { name: 'exact_match', version: '1.0.0' },
        eval_pass_rate: 0.9,
      }),
      row('b', {
        evaluator: { name: 'exact_match', version: '1.0.0' },
        eval_pass_rate: 0.9,
      }),
      row('c', {
        evaluator: { name: 'exact_match', version: '1.0.0' },
        eval_pass_rate: 0.8, // above 0.7 reliability threshold but below the tied pair
      }),
    ]);
    expect(v).toMatch(/Most accurate.*tied, 2\/3.*`a`.*`b`/);
  });
});
