import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScenario } from '../src/runners/runner.js';
import { mockCoordinatorAdapter } from '../src/adapters/mock-coordinator.js';
import type { LoadedScenario } from '../src/scenarios/loader.js';
import type { AgentRuntimeAdapter, AgentTaskInput, AgentTaskResult } from '../src/adapters/types.js';

const baseOrchestration: LoadedScenario = {
  name: 'orch-test',
  kind: 'orchestration_research',
  retries: 0,
  scenario_hash: 'sh',
  dataset_hash: 'dh',
  network_policy: { mode: 'disabled' },
  evaluator: 'contains',
  prompt_template_version: 'inline/v1',
  scoring_profile_version: 'default/v1',
  orchestration: {
    coordinator: {
      prompt:
        'Break the topic into 3 subtopics. Respond with JSON {"subtopics":[...]}. Topic: "{{topic}}"',
    },
    worker_template: {
      prompt: 'Summarize the subtopic. Subtopic: {{subtopic}}',
    },
    merge: {
      prompt: 'Synthesize the worker summaries: {{worker_outputs}}',
    },
  },
  tasks: [
    {
      id: 't1',
      prompt: 'ignored',
      payload: { topic: 'async runtimes' },
      expect: { needles: ['synthesis'] },
    },
  ],
};

describe('orchestration runner', () => {
  it('runs coordinator → workers → merge end-to-end with mock-coordinator', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-orch-'));
    const result = await runScenario({
      scenario: baseOrchestration,
      adapter: mockCoordinatorAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock-coordinator',
      maxConcurrency: 4,
      apply: false,
    });

    // Top-level: 1 orchestration cycle, success
    expect(result.workersTotal).toBe(1);
    expect(result.workersCompleted).toBe(1);

    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8'));
    expect(metrics.scenario_kind).toBe('orchestration_research');

    // 3 subworkers, all succeeded
    expect(metrics.workers_total).toBe(3);
    expect(metrics.workers_succeeded).toBe(3);

    // Orchestration metrics populated
    expect(metrics.coordinator_latency_ms).toBeGreaterThan(0);
    expect(metrics.merge_latency_ms).toBeGreaterThan(0);
    expect(metrics.worker_latency_ms_total).toBeGreaterThan(0);
    expect(metrics.coordination_overhead_pct).toBeGreaterThan(0);
    expect(metrics.worker_utilization_pct).toBeGreaterThan(0);
  });

  it('emits all six v0.2 event types in order', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-orch-'));
    const result = await runScenario({
      scenario: baseOrchestration,
      adapter: mockCoordinatorAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock-coordinator',
      maxConcurrency: 4,
      apply: false,
    });
    const log = await readFile(join(result.runDir, 'events.jsonl'), 'utf8');
    const lines = log.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string });
    const events = lines.map((l) => l.event);

    expect(events).toContain('coordinator_started');
    expect(events).toContain('coordinator_planned');
    expect(events).toContain('worker_assigned');
    expect(events).toContain('artifact_created');
    expect(events).toContain('merge_started');
    expect(events).toContain('merge_completed');
    expect(events).toContain('coordinator_completed');

    // Order check: coordinator_started must come before coordinator_completed.
    const startIdx = events.indexOf('coordinator_started');
    const planIdx = events.indexOf('coordinator_planned');
    const mergeStartIdx = events.indexOf('merge_started');
    const completedIdx = events.indexOf('coordinator_completed');
    expect(startIdx).toBeLessThan(planIdx);
    expect(planIdx).toBeLessThan(mergeStartIdx);
    expect(mergeStartIdx).toBeLessThan(completedIdx);
  });

  it('emits coordinator_failed when the plan is unparseable', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-orch-'));
    const badAdapter: AgentRuntimeAdapter = {
      name: 'bad-coordinator',
      async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
        return {
          taskId: input.taskId,
          ok: true,
          output: 'not json at all',
          usage: { input_tokens: 1, output_tokens: 1 },
          latencyMs: 1,
        };
      },
    };
    const result = await runScenario({
      scenario: baseOrchestration,
      adapter: badAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'bad-coordinator',
      maxConcurrency: 1,
      apply: false,
    });
    const log = await readFile(join(result.runDir, 'events.jsonl'), 'utf8');
    expect(log).toMatch(/"event":"coordinator_failed".*"error_type":"invalid_plan"/);
    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8'));
    expect(metrics.success_rate).toBe(0);
  });

  it('treats a thrown adapter exception as a task failure, not a run abort', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-orch-'));
    const throwingAdapter: AgentRuntimeAdapter = {
      name: 'throws',
      async runTask() {
        throw new Error('boom');
      },
    };
    const result = await runScenario({
      scenario: baseOrchestration,
      adapter: throwingAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'throws',
      maxConcurrency: 1,
      apply: false,
    });
    // Coordinator call threw → cycle fails, but the run still produces metrics.
    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8'));
    expect(metrics.success_rate).toBe(0);
    const log = await readFile(join(result.runDir, 'events.jsonl'), 'utf8');
    expect(log).toMatch(/"event":"coordinator_failed"/);
    expect(log).toMatch(/"event":"run_completed"/);
  });

  it('tracks real active concurrency via worker_started/completed (P1 fix)', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-orch-'));
    const result = await runScenario({
      scenario: baseOrchestration,
      adapter: mockCoordinatorAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock-coordinator',
      maxConcurrency: 4,
      apply: false,
    });
    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8'));
    // Was 0 in the broken version — EventLog only updates active on
    // worker_started/completed and those weren't emitted.
    expect(metrics.peak_concurrency).toBeGreaterThan(0);
    expect(metrics.peak_concurrency).toBeLessThanOrEqual(3); // 3 subworkers in the plan
    const log = await readFile(join(result.runDir, 'events.jsonl'), 'utf8');
    expect(log).toMatch(/"event":"worker_started"/);
    expect(log).toMatch(/"event":"worker_completed"/);
  });

  it('reports cycles and subworkers as separate metrics (P1 fix)', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-orch-'));
    const result = await runScenario({
      scenario: baseOrchestration,
      adapter: mockCoordinatorAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock-coordinator',
      maxConcurrency: 4,
      apply: false,
    });
    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8'));
    // 1 cycle, 3 subworkers — two separate units.
    expect(metrics.cycles_total).toBe(1);
    expect(metrics.cycles_succeeded).toBe(1);
    expect(metrics.workers_total).toBe(3);
    expect(metrics.workers_succeeded).toBe(3);
    expect(metrics.success_rate).toBe(1); // = workers_succeeded / workers_total
    expect(metrics.final_success_rate).toBe(1); // = cycles_succeeded / cycles_total
    // CLI's RunnerResult uses cycle-level for the user-facing count.
    expect(result.workersTotal).toBe(1);
    expect(result.workersCompleted).toBe(1);
  });

  it('flat scenarios mirror workers_* into cycles_* (back-compat)', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-orch-'));
    const flatScenario: LoadedScenario = {
      name: 'flat',
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
      ],
    };
    const echoAdapter: AgentRuntimeAdapter = {
      name: 'echo',
      async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
        return { taskId: input.taskId, ok: true, output: 'x', latencyMs: 1 };
      },
    };
    const result = await runScenario({
      scenario: flatScenario,
      adapter: echoAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'echo',
      maxConcurrency: 2,
      apply: false,
    });
    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8'));
    expect(metrics.workers_total).toBe(metrics.cycles_total);
    expect(metrics.workers_succeeded).toBe(metrics.cycles_succeeded);
    expect(metrics.success_rate).toBe(metrics.final_success_rate);
  });

  it('orchestration_research bundled scenario passes its own evaluator (P2 fix)', async () => {
    // The bundled scenarios/orchestration_research.yaml has needles
    // scheduler/recall/latency for its 3 tasks; mock-coordinator's merge
    // output must include all three so the offline smoke run reports 100%.
    const outDir = await mkdtemp(join(tmpdir(), 'afb-orch-'));
    const realisticScenario: LoadedScenario = {
      ...baseOrchestration,
      tasks: [
        { id: 't1', prompt: 'ignored', payload: { topic: 'async' }, expect: { needles: ['scheduler'] } },
        { id: 't2', prompt: 'ignored', payload: { topic: 'vector' }, expect: { needles: ['recall'] } },
        { id: 't3', prompt: 'ignored', payload: { topic: 'edge' }, expect: { needles: ['latency'] } },
      ],
    };
    const result = await runScenario({
      scenario: realisticScenario,
      adapter: mockCoordinatorAdapter,
      outDir,
      provider: 'mock',
      model: 'mock-model',
      runtime: 'mock-coordinator',
      maxConcurrency: 4,
      apply: false,
    });
    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8'));
    expect(metrics.eval_pass_rate).toBe(1); // was 0.333 before the merge text fix
  });

  it('refuses to run an orchestration scenario missing the orchestration block', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'afb-orch-'));
    const broken: LoadedScenario = { ...baseOrchestration, orchestration: undefined };
    await expect(
      runScenario({
        scenario: broken,
        adapter: mockCoordinatorAdapter,
        outDir,
        provider: 'mock',
        model: 'mock-model',
        runtime: 'mock-coordinator',
        maxConcurrency: 1,
        apply: false,
      }),
    ).rejects.toThrow(/requires an 'orchestration' block/);
  });
});
