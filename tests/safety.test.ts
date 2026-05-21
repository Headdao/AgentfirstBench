import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScopedFS, ScopeViolationError } from '../src/utils/scoped-fs.js';
import { runScenario } from '../src/runners/runner.js';
import { mockAdapter } from '../src/adapters/mock.js';
import type { LoadedScenario } from '../src/scenarios/loader.js';

describe('ScopedFS', () => {
  it('allows writes inside the run directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afb-scope-'));
    const fs = createScopedFS(dir);
    await fs.writeFile('hello.txt', 'hi');
    const back = await readFile(join(dir, 'hello.txt'), 'utf8');
    expect(back).toBe('hi');
  });

  it('rejects parent-traversal paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afb-scope-'));
    const fs = createScopedFS(dir);
    expect(() => fs.resolve('../escape.txt')).toThrow(ScopeViolationError);
  });

  it('rejects absolute paths outside the run dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afb-scope-'));
    const fs = createScopedFS(dir);
    expect(() => fs.resolve('/tmp/elsewhere.txt')).toThrow(ScopeViolationError);
  });

  it('rejects writes that resolve to the run dir itself', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afb-scope-'));
    const fs = createScopedFS(dir);
    expect(() => fs.resolve('.')).toThrow(ScopeViolationError);
  });
});

describe('runScenario safety gates', () => {
  it('refuses coding scenarios without --apply', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-apply-'));
    const coding: LoadedScenario = {
      name: 'c',
      kind: 'coding_patch',
      retries: 0,
      scenario_hash: 't',
      dataset_hash: 'td',
      network_policy: { mode: 'disabled' },
      prompt_template_version: 'inline/v1',
      scoring_profile_version: 'default/v1',
      tasks: [{ id: 't1', prompt: 'do thing' }],
    };
    await expect(
      runScenario({
        scenario: coding,
        adapter: mockAdapter,
        outDir,
        provider: 'mock',
        model: 'mock-model',
        runtime: 'mock',
        maxConcurrency: 1,
        apply: false,
      }),
    ).rejects.toThrow(/Re-run with --apply/);
  });

  it('records network_policy and apply flag in metrics.json', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-record-'));
    const scenario: LoadedScenario = {
      name: 'rec',
      kind: 'research_synthesis',
      retries: 0,
      scenario_hash: 't',
      dataset_hash: 'td',
      network_policy: { mode: 'allowlist', hosts: ['example.com'] },
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
    expect(metrics.network_policy).toEqual({ mode: 'allowlist', hosts: ['example.com'] });
    expect(metrics.apply).toBe(false);
  });

  it('never writes API keys into events.jsonl', async () => {
    // Simulate a secret in env and verify it doesn't surface in the run log.
    const secret = 'sk-fakeSECRET_12345_DO_NOT_LEAK';
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = secret;
    try {
      const outDir = await mkdtemp(join(tmpdir(), 'afb-secret-'));
      const scenario: LoadedScenario = {
        name: 's',
        kind: 'research_synthesis',
        retries: 0,
        scenario_hash: 't',
        dataset_hash: 'td',
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
      const log = await readFile(join(result.runDir, 'events.jsonl'), 'utf8');
      const metrics = await readFile(join(result.runDir, 'metrics.json'), 'utf8');
      expect(log).not.toContain(secret);
      expect(metrics).not.toContain(secret);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe('extra: ensure scenario passes a synthetic write through ScopedFS', () => {
  it('writeFile + appendFile + mkdir succeed inside the dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afb-scope-w-'));
    const fs = createScopedFS(dir);
    await fs.mkdir('sub');
    await fs.writeFile('sub/a.txt', 'one');
    await fs.appendFile('sub/a.txt', '/two');
    // and confirm via the real fs:
    const got = await readFile(join(dir, 'sub', 'a.txt'), 'utf8');
    expect(got).toBe('one/two');
    // sanity: ensure writeFile via the helper is what we used (not raw fs)
    await writeFile(join(dir, 'manual.txt'), 'x'); // not via scope, but inside dir → fine
  });
});
