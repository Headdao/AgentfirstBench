import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookupPricing, estimateUsd, listKnownModels } from '../src/pricing/table.js';
import { runScenario } from '../src/runners/runner.js';
import { mockAdapter } from '../src/adapters/mock.js';
import type { AgentRuntimeAdapter } from '../src/adapters/types.js';
import type { LoadedScenario } from '../src/scenarios/loader.js';

const baseScenario: LoadedScenario = {
  name: 'cost',
  kind: 'research_synthesis',
  retries: 0,
  scenario_hash: 't',
  dataset_hash: 'td',
  network_policy: { mode: 'disabled' },
  prompt_template_version: 'inline/v1',
  scoring_profile_version: 'default/v1',
  tasks: [{ id: 't1', prompt: 'hi' }],
};

describe('pricing table', () => {
  it('looks up a known model', () => {
    const p = lookupPricing('anthropic', 'claude-sonnet-4-6');
    expect(p).toBeDefined();
    expect(p!.input_per_mtok).toBeGreaterThan(0);
    expect(p!.output_per_mtok).toBeGreaterThan(p!.input_per_mtok);
  });

  it('returns undefined for unknown models', () => {
    expect(lookupPricing('nonexistent', 'fake-model')).toBeUndefined();
  });

  it('estimates USD correctly for a known input/output mix', () => {
    const p = lookupPricing('anthropic', 'claude-sonnet-4-6')!;
    const usd = estimateUsd(p, { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(usd).toBeCloseTo(p.input_per_mtok + p.output_per_mtok, 6);
  });

  it('lists known models in sorted order', () => {
    const all = listKnownModels();
    expect(all.length).toBeGreaterThan(3);
    const sorted = [...all].sort();
    expect(all).toEqual(sorted);
  });
});

describe('runner cost wiring', () => {
  it('uses pricing_table when provider/model are in the table', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-cost-'));
    const result = await runScenario({
      scenario: baseScenario,
      adapter: mockAdapter,
      outDir,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      runtime: 'mock',
      maxConcurrency: 1,
      apply: false,
    });
    expect(result.costSource).toBe('pricing_table');
    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8'));
    expect(metrics.cost_source).toBe('pricing_table');
    expect(metrics.pricing_as_of).toBeDefined();
    expect(metrics.total_cost_usd).toBeGreaterThan(0);
  });

  it('falls back to adapter estimate when no table entry exists', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-cost-'));
    // Adapter with explicit cost estimator; provider/model not in table.
    const adapter: AgentRuntimeAdapter = {
      name: 'custom',
      runTask: mockAdapter.runTask,
      estimateCost: () => ({ usd: 0.42, currency: 'USD' }),
    };
    const result = await runScenario({
      scenario: baseScenario,
      adapter,
      outDir,
      provider: 'unknown-provider',
      model: 'unknown-model',
      runtime: 'custom',
      maxConcurrency: 1,
      apply: false,
    });
    expect(result.costSource).toBe('adapter');
    expect(result.totalCostUsd).toBe(0.42);
  });

  it('reports none when neither pricing nor adapter estimator is available', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-cost-'));
    const adapter: AgentRuntimeAdapter = {
      name: 'bare',
      runTask: mockAdapter.runTask,
      // no estimateCost
    };
    const result = await runScenario({
      scenario: baseScenario,
      adapter,
      outDir,
      provider: 'unknown-provider',
      model: 'unknown-model',
      runtime: 'bare',
      maxConcurrency: 1,
      apply: false,
    });
    expect(result.costSource).toBe('none');
    expect(result.totalCostUsd).toBe(0);
  });
});
