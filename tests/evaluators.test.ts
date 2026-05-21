import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { successEvaluator } from '../src/evaluators/success.js';
import { exactMatchEvaluator } from '../src/evaluators/exact-match.js';
import { containsEvaluator } from '../src/evaluators/contains.js';
import { jsonSchemaEvaluator } from '../src/evaluators/json-schema.js';
import { getEvaluator, listEvaluators } from '../src/evaluators/registry.js';
import { runScenario } from '../src/runners/runner.js';
import type { LoadedScenario } from '../src/scenarios/loader.js';
import type { AgentRuntimeAdapter, AgentTaskInput, AgentTaskResult } from '../src/adapters/types.js';

const baseScenario = (overrides: Partial<LoadedScenario> = {}): LoadedScenario => ({
  name: 'ev',
  kind: 'reasoning_chain',
  retries: 0,
  scenario_hash: 'sh',
  dataset_hash: 'dh',
  network_policy: { mode: 'disabled' },
  evaluator: 'success',
  prompt_template_version: 'inline/v1',
  scoring_profile_version: 'default/v1',
  tasks: [{ id: 't1', prompt: 'ignored' }],
  ...overrides,
});

function deterministicAdapter(replies: Record<string, string>): AgentRuntimeAdapter {
  return {
    name: 'deterministic',
    async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
      const output = replies[input.taskId] ?? '';
      return {
        taskId: input.taskId,
        ok: true,
        output,
        usage: { input_tokens: 10, output_tokens: output.length },
        latencyMs: 1,
      };
    },
  };
}

describe('registry', () => {
  it('registers all four built-in evaluators', () => {
    expect(listEvaluators().sort()).toEqual(['contains', 'exact_match', 'json_schema', 'success']);
  });
  it('lookup returns the same instance', () => {
    expect(getEvaluator('success')).toBe(successEvaluator);
  });
  it('unknown name returns undefined', () => {
    expect(getEvaluator('not-a-thing')).toBeUndefined();
  });
});

describe('exact_match', () => {
  const task = { id: 't', prompt: 'x', expect: { answer: '42' } };
  const ok = (output: string): AgentTaskResult => ({
    taskId: 't', ok: true, output, latencyMs: 1,
  });

  it('passes on exact match (after trim)', async () => {
    const r = await exactMatchEvaluator.evaluate({ task, result: ok('  42  \n') });
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  it('fails on mismatch', async () => {
    const r = await exactMatchEvaluator.evaluate({ task, result: ok('41') });
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.detail).toMatch(/got/);
  });

  it('case_insensitive matches when set', async () => {
    const r = await exactMatchEvaluator.evaluate({
      task: { id: 't', prompt: 'x', expect: { answer: 'TAIPEI', case_insensitive: true } },
      result: ok('taipei'),
    });
    expect(r.passed).toBe(true);
  });

  it('pattern matches when set', async () => {
    const r = await exactMatchEvaluator.evaluate({
      task: { id: 't', prompt: 'x', expect: { pattern: '\\b42\\b' } },
      result: ok('the answer is 42 of course'),
    });
    expect(r.passed).toBe(true);
  });

  it('fails on adapter error', async () => {
    const r = await exactMatchEvaluator.evaluate({
      task,
      result: { taskId: 't', ok: false, output: '', error: { type: 'x', message: 'y' }, latencyMs: 0 },
    });
    expect(r.passed).toBe(false);
  });
});

describe('contains', () => {
  const task = { id: 't', prompt: 'x', expect: { needles: ['RHINO-7421', '42%'] } };

  it('passes when all needles present (case-insensitive default)', async () => {
    const r = await containsEvaluator.evaluate({
      task,
      result: { taskId: 't', ok: true, output: 'the code is rhino-7421 and value is 42%', latencyMs: 1 },
    });
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  it('scores partial when some needles missing', async () => {
    const r = await containsEvaluator.evaluate({
      task,
      result: { taskId: 't', ok: true, output: 'the code is rhino-7421', latencyMs: 1 },
    });
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0.5); // 1 of 2
  });

  it('case_sensitive: true distinguishes', async () => {
    const r = await containsEvaluator.evaluate({
      task: { id: 't', prompt: 'x', expect: { needles: ['RHINO'], case_sensitive: true } },
      result: { taskId: 't', ok: true, output: 'rhino', latencyMs: 1 },
    });
    expect(r.passed).toBe(false);
  });
});

describe('json_schema', () => {
  const ok = (output: string): AgentTaskResult => ({
    taskId: 't', ok: true, output, latencyMs: 1,
  });

  it('passes on valid JSON with all required keys and matching types', async () => {
    const r = await jsonSchemaEvaluator.evaluate({
      task: {
        id: 't', prompt: 'x',
        expect: {
          schema: {
            required: ['name', 'age'],
            properties: { name: { type: 'string' }, age: { type: 'integer' } },
          },
        },
      },
      result: ok('{"name": "Alice", "age": 30}'),
    });
    expect(r.passed).toBe(true);
  });

  it('strips markdown code fences', async () => {
    const r = await jsonSchemaEvaluator.evaluate({
      task: {
        id: 't', prompt: 'x',
        expect: { schema: { required: ['x'] } },
      },
      result: ok('```json\n{"x": 1}\n```'),
    });
    expect(r.passed).toBe(true);
  });

  it('fails on invalid JSON', async () => {
    const r = await jsonSchemaEvaluator.evaluate({
      task: { id: 't', prompt: 'x', expect: { schema: { required: [] } } },
      result: ok('not json at all'),
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/not valid JSON/);
  });

  it('fails when required key missing', async () => {
    const r = await jsonSchemaEvaluator.evaluate({
      task: {
        id: 't', prompt: 'x',
        expect: { schema: { required: ['name', 'age'] } },
      },
      result: ok('{"name": "Alice"}'),
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/missing.*age/);
  });

  it('fails on type mismatch', async () => {
    const r = await jsonSchemaEvaluator.evaluate({
      task: {
        id: 't', prompt: 'x',
        expect: {
          schema: {
            required: ['age'],
            properties: { age: { type: 'integer' } },
          },
        },
      },
      result: ok('{"age": "thirty"}'),
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/age: expected integer/);
  });

  it('fails on value mismatch when expect.values is set', async () => {
    const r = await jsonSchemaEvaluator.evaluate({
      task: {
        id: 't', prompt: 'x',
        expect: {
          schema: { required: ['name'], properties: { name: { type: 'string' } } },
          values: { name: 'Alice' },
        },
      },
      result: ok('{"name": "Bob"}'),
    });
    expect(r.passed).toBe(false);
  });

  it('deep-compares array values', async () => {
    const r = await jsonSchemaEvaluator.evaluate({
      task: {
        id: 't', prompt: 'x',
        expect: {
          schema: { required: ['items'], properties: { items: { type: 'array' } } },
          values: { items: [] },
        },
      },
      result: ok('{"items": []}'),
    });
    expect(r.passed).toBe(true);
  });
});

describe('runner integration', () => {
  it('uses the scenario-declared evaluator and records eval_pass_rate', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-ev-'));
    const result = await runScenario({
      scenario: baseScenario({
        evaluator: 'exact_match',
        tasks: [
          { id: 'ok', prompt: '?', expect: { answer: '42' } },
          { id: 'bad', prompt: '?', expect: { answer: '999' } },
        ],
      }),
      adapter: deterministicAdapter({ ok: '42', bad: 'not the answer' }),
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock',
      maxConcurrency: 2,
      apply: false,
    });
    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8'));
    expect(metrics.evaluator).toEqual({ name: 'exact_match', version: '1.0.0' });
    expect(metrics.eval_pass_rate).toBe(0.5);
    expect(metrics.eval_mean_score).toBe(0.5);
    // success_rate (adapter ok) should still be 100% — both adapter calls succeeded.
    expect(metrics.success_rate).toBe(1);
  });

  it('emits evaluation_started and evaluation_completed events', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-ev-'));
    const result = await runScenario({
      scenario: baseScenario({
        evaluator: 'contains',
        tasks: [{ id: 'n', prompt: '?', expect: { needles: ['hello'] } }],
      }),
      adapter: deterministicAdapter({ n: 'hello world' }),
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock',
      maxConcurrency: 1,
      apply: false,
    });
    const log = await readFile(join(result.runDir, 'events.jsonl'), 'utf8');
    expect(log).toMatch(/"event":"evaluation_started"/);
    expect(log).toMatch(/"event":"evaluation_completed".*"passed":true/);
  });
});
