import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { datasetHash } from '../src/utils/dataset-hash.js';
import { loadScenario } from '../src/scenarios/loader.js';
import { runScenario } from '../src/runners/runner.js';
import { mockAdapter } from '../src/adapters/mock.js';
import type { LoadedScenario } from '../src/scenarios/loader.js';

describe('dataset hash', () => {
  it('is stable across task reordering', () => {
    const a = datasetHash([
      { id: 'a', prompt: 'one' },
      { id: 'b', prompt: 'two' },
      { id: 'c', prompt: 'three' },
    ]);
    const b = datasetHash([
      { id: 'c', prompt: 'three' },
      { id: 'a', prompt: 'one' },
      { id: 'b', prompt: 'two' },
    ]);
    expect(a).toBe(b);
  });

  it('is stable across payload key reordering', () => {
    const a = datasetHash([{ id: 'x', prompt: 'p', payload: { foo: 1, bar: 2 } }]);
    const b = datasetHash([{ id: 'x', prompt: 'p', payload: { bar: 2, foo: 1 } }]);
    expect(a).toBe(b);
  });

  it('changes when a prompt changes', () => {
    const a = datasetHash([{ id: 'x', prompt: 'p1' }]);
    const b = datasetHash([{ id: 'x', prompt: 'p2' }]);
    expect(a).not.toBe(b);
  });

  it('changes when a task id changes', () => {
    const a = datasetHash([{ id: 'x', prompt: 'p' }]);
    const b = datasetHash([{ id: 'y', prompt: 'p' }]);
    expect(a).not.toBe(b);
  });
});

describe('loader populates both hashes', () => {
  it('scenario_hash differs when config changes, dataset_hash does not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afb-repro-'));
    const tasksYaml =
      `tasks:\n` +
      `  - { id: t1, prompt: "hello" }\n` +
      `  - { id: t2, prompt: "world" }\n`;

    const aPath = join(dir, 'a.yaml');
    const bPath = join(dir, 'b.yaml');
    await writeFile(
      aPath,
      `name: a\nkind: research_synthesis\nmax_concurrency: 2\n${tasksYaml}`,
      'utf8',
    );
    await writeFile(
      bPath,
      `name: a\nkind: research_synthesis\nmax_concurrency: 8\n${tasksYaml}`,
      'utf8',
    );

    const a = await loadScenario(aPath);
    const b = await loadScenario(bPath);
    expect(a.scenario_hash).not.toBe(b.scenario_hash);
    expect(a.dataset_hash).toBe(b.dataset_hash);
  });
});

describe('metrics records all §14 versioning fields', () => {
  it('writes dataset_hash, template/profile/evaluator versions', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-repro-'));
    const scenario: LoadedScenario = {
      name: 's',
      kind: 'research_synthesis',
      retries: 0,
      scenario_hash: 'sh',
      dataset_hash: 'dh-xyz',
      network_policy: { mode: 'disabled' },
      prompt_template_version: 'inline/v1',
      scoring_profile_version: 'default/v1',
      tasks: [{ id: 't1', prompt: 'hi' }],
    };
    const result = await runScenario({
      scenario,
      adapter: mockAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock',
      maxConcurrency: 1,
      apply: false,
    });
    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8'));
    expect(metrics.dataset_hash).toBe('dh-xyz');
    expect(metrics.prompt_template_version).toBe('inline/v1');
    expect(metrics.scoring_profile_version).toBe('default/v1');
    expect(metrics.evaluator).toEqual({ name: 'success', version: '1.0.0' });
  });
});
