import { describe, it, expect } from 'vitest';
import { renderMatrixMarkdown, renderMatrixStdout, type MatrixRow } from '../src/reports/matrix.js';
import type { RunMetrics } from '../src/metrics/types.js';

function fakeMetrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
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

describe('renderMatrixMarkdown', () => {
  it('produces a header row and one row per model', () => {
    const rows: MatrixRow[] = [
      { label: 'google/gemini-3.5-flash', metrics: fakeMetrics({ total_cost_usd: 0.005 }) },
      { label: 'anthropic/claude-haiku-4-5', metrics: fakeMetrics({ total_cost_usd: 0.012 }) },
    ];
    const md = renderMatrixMarkdown('research_synthesis', rows);
    expect(md).toContain('# Matrix — research_synthesis across 2 models');
    expect(md).toContain('google/gemini-3.5-flash');
    expect(md).toContain('anthropic/claude-haiku-4-5');
    expect(md).toContain('| Model |');
  });

  it('includes a throughput-per-level section when at least one row has a sweep', () => {
    const sweepRow: MatrixRow = {
      label: 'a/x',
      metrics: fakeMetrics({
        scenario_kind: 'concurrency_ramp',
        per_level: [
          { concurrency: 1, workers_total: 4, workers_succeeded: 4, avg_latency_ms: 100, p95_latency_ms: 150, throughput_per_sec: 10, wall_time_ms: 400 },
          { concurrency: 2, workers_total: 4, workers_succeeded: 4, avg_latency_ms: 100, p95_latency_ms: 150, throughput_per_sec: 18, wall_time_ms: 220 },
        ],
      }),
    };
    const md = renderMatrixMarkdown('concurrency_ramp', [sweepRow]);
    expect(md).toContain('Throughput per concurrency level');
    expect(md).toContain('| N |');
    expect(md).toContain('| 1 |');
    expect(md).toContain('| 2 |');
    expect(md).toContain('10.00');
    expect(md).toContain('18.00');
  });

  it('omits the per-level section for non-sweep scenarios', () => {
    const md = renderMatrixMarkdown('research_synthesis', [
      { label: 'a/x', metrics: fakeMetrics() },
    ]);
    expect(md).not.toContain('Throughput per concurrency level');
  });

  it('handles zero rows', () => {
    const md = renderMatrixMarkdown('x', []);
    expect(md).toContain('# Matrix — x across 0 models');
  });
});

describe('renderMatrixStdout', () => {
  it('emits one fixed-width row per model', () => {
    const out = renderMatrixStdout([
      { label: 'google/gemini-3.5-flash', metrics: fakeMetrics({ total_cost_usd: 0.005 }) },
      { label: 'anthropic/claude-haiku-4-5', metrics: fakeMetrics({ total_cost_usd: 0.012 }) },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toContain('Model');
    expect(lines[0]).toContain('OK');
    expect(lines.find((l) => l.includes('google/gemini-3.5-flash'))).toBeTruthy();
    expect(lines.find((l) => l.includes('anthropic/claude-haiku-4-5'))).toBeTruthy();
  });

  it('returns (no rows) for an empty input', () => {
    expect(renderMatrixStdout([])).toBe('(no rows)');
  });
});
