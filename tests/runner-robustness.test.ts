import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScenario } from '../src/runners/runner.js';
import { mockAdapter } from '../src/adapters/mock.js';
import type { AgentRuntimeAdapter } from '../src/adapters/types.js';
import type { LoadedScenario } from '../src/scenarios/loader.js';

const baseScenario = (overrides: Partial<LoadedScenario> = {}): LoadedScenario => ({
  name: 'rob',
  kind: 'research_synthesis',
  retries: 0,
  scenario_hash: 'sh',
  dataset_hash: 'dh',
  network_policy: { mode: 'disabled' },
  prompt_template_version: 'inline/v1',
  scoring_profile_version: 'default/v1',
  tasks: [
    { id: 't1', prompt: 'one' },
    { id: 't2', prompt: 'two' },
    { id: 't3', prompt: 'three' },
  ],
  ...overrides,
});

describe('adapter exception isolation (fix for high-severity finding)', () => {
  it('a thrown adapter exception becomes a task failure, not a run abort', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-rob-'));
    let calls = 0;
    const throwingAdapter: AgentRuntimeAdapter = {
      name: 'throwing',
      async runTask(input) {
        calls++;
        if (input.taskId === 't2') {
          throw new Error('simulated adapter crash');
        }
        return {
          taskId: input.taskId,
          ok: true,
          output: 'ok',
          usage: { input_tokens: 1, output_tokens: 1 },
          latencyMs: 1,
        };
      },
    };

    // Should not throw — the run completes and writes metrics/events.
    const result = await runScenario({
      scenario: baseScenario(),
      adapter: throwingAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'throwing',
      maxConcurrency: 2,
      apply: false,
    });

    expect(calls).toBe(3); // all three tasks attempted
    expect(result.workersTotal).toBe(3);
    expect(result.workersCompleted).toBe(2); // t1 and t3 succeeded
    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8'));
    expect(metrics.workers_failed).toBe(1);
    // The event log should still close cleanly with a run_completed line.
    const log = await readFile(join(result.runDir, 'events.jsonl'), 'utf8');
    expect(log).toMatch(/"event":"run_completed"/);
    expect(log).toMatch(/"error_type":"adapter_threw"/);
  });
});

describe('reproducible failure injection (fix for medium-severity finding)', () => {
  it('records the effective seed when the scenario does not specify one', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-seed-'));
    const result = await runScenario({
      scenario: baseScenario(),
      adapter: mockAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock',
      maxConcurrency: 1,
      apply: false,
    });
    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8'));
    expect(typeof metrics.seed).toBe('number');
    expect(metrics.seed).toBeGreaterThanOrEqual(0);
  });

  it('same seed → same injected task IDs', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-seed-'));
    const scenario = baseScenario({
      kind: 'failure_containment',
      inject_failure_rate: 0.5,
      seed: 42,
      tasks: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, prompt: `p${i}` })),
    });

    const r1 = await runScenario({
      scenario,
      adapter: mockAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock',
      maxConcurrency: 1, // sequential so the rng draw order is deterministic
      apply: false,
    });
    const r2 = await runScenario({
      scenario,
      adapter: mockAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock',
      maxConcurrency: 1,
      apply: false,
    });

    const m1 = JSON.parse(await readFile(join(r1.runDir, 'metrics.json'), 'utf8'));
    const m2 = JSON.parse(await readFile(join(r2.runDir, 'metrics.json'), 'utf8'));
    expect(m1.seed).toBe(42);
    expect(m2.seed).toBe(42);
    expect(m1.injected_failure_task_ids).toEqual(m2.injected_failure_task_ids);
    expect(m1.injected_failure_task_ids?.length).toBeGreaterThan(0);
  });

  it('different seeds → typically different injected task IDs', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-seed-'));
    const tasks = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, prompt: `p${i}` }));
    const r1 = await runScenario({
      scenario: baseScenario({
        kind: 'failure_containment',
        inject_failure_rate: 0.5,
        seed: 1,
        tasks,
      }),
      adapter: mockAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock',
      maxConcurrency: 1,
      apply: false,
    });
    const r2 = await runScenario({
      scenario: baseScenario({
        kind: 'failure_containment',
        inject_failure_rate: 0.5,
        seed: 999,
        tasks,
      }),
      adapter: mockAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock',
      maxConcurrency: 1,
      apply: false,
    });
    const m1 = JSON.parse(await readFile(join(r1.runDir, 'metrics.json'), 'utf8'));
    const m2 = JSON.parse(await readFile(join(r2.runDir, 'metrics.json'), 'utf8'));
    expect(m1.injected_failure_task_ids).not.toEqual(m2.injected_failure_task_ids);
  });
});
