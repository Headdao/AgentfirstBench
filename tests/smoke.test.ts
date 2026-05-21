import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScenario } from '../src/runners/runner.js';
import { mockAdapter } from '../src/adapters/mock.js';
import type { LoadedScenario } from '../src/scenarios/loader.js';

const scenario: LoadedScenario = {
  name: 'smoke',
  kind: 'research_synthesis',
  retries: 0,
  scenario_hash: 'test',
  dataset_hash: 'test-dataset',
  network_policy: { mode: 'disabled' },
  prompt_template_version: 'inline/v1',
  scoring_profile_version: 'default/v1',
  tasks: [
    { id: 't1', prompt: 'hello one' },
    { id: 't2', prompt: 'hello two' },
    { id: 't3', prompt: 'hello three' },
  ],
};

describe('runner', () => {
  it('runs tasks with the mock adapter and writes metrics.json', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-smoke-'));
    const result = await runScenario({
      scenario,
      adapter: mockAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock',
      maxConcurrency: 2,
      apply: false,
    });

    expect(result.workersTotal).toBe(3);
    const metricsRaw = await readFile(join(result.runDir, 'metrics.json'), 'utf8');
    const metrics = JSON.parse(metricsRaw);
    expect(metrics.scenario_name).toBe('smoke');
    expect(metrics.workers_total).toBe(3);
    expect(metrics.peak_concurrency).toBeGreaterThan(0);
    expect(metrics.peak_concurrency).toBeLessThanOrEqual(2);
  });

  it('counts retried workers when an attempt fails then succeeds', async () => {
    // Inject 100% failure on first attempt via failure_containment, with 1 retry.
    const outDir = await mkdtemp(join(tmpdir(), 'afb-retry-'));
    const retryScenario: LoadedScenario = {
      ...scenario,
      kind: 'failure_containment',
      inject_failure_rate: 1,
      retries: 1,
    };
    const result = await runScenario({
      scenario: retryScenario,
      adapter: mockAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock',
      maxConcurrency: 2,
      apply: false,
    });
    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8'));
    expect(metrics.workers_retried).toBe(3); // 3 tasks, all injected once → all retried once
  });

  it('sweeps concurrency levels when kind=concurrency_ramp', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-sweep-'));
    const sweep: LoadedScenario = {
      ...scenario,
      kind: 'concurrency_ramp',
      concurrency_levels: [1, 2],
    };
    const result = await runScenario({
      scenario: sweep,
      adapter: mockAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock',
      maxConcurrency: 4,
      apply: false,
    });

    expect(result.workersTotal).toBe(6); // 3 tasks × 2 levels
    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8'));
    expect(metrics.per_level).toHaveLength(2);
    expect(metrics.per_level[0].concurrency).toBe(1);
    expect(metrics.per_level[1].concurrency).toBe(2);
  });
});
