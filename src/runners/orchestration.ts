import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pLimit from 'p-limit';
import type { AgentRuntimeAdapter, AgentTaskResult } from '../adapters/types.js';
import { EventLog } from '../metrics/event-log.js';
import type { RunMetrics } from '../metrics/types.js';
import { newRunId } from '../utils/run-id.js';
import { mean, percentile } from '../utils/stats.js';
import { version as afbVersion } from '../version.js';
import { lookupPricing, estimateUsd } from '../pricing/table.js';
import { getEvaluator } from '../evaluators/registry.js';
import { successEvaluator } from '../evaluators/success.js';
import { mulberry32, randomSeed } from '../utils/prng.js';
import type { RunnerOptions, RunnerResult } from './runner.js';

/**
 * v0.2 orchestration runner. One top-level task = one full coordinator
 * → workers → merge cycle. Worker count comes from the coordinator's
 * plan output (parsed as JSON), not from a flat task list.
 *
 * Designed to live alongside the flat runner in `runner.ts`. Shares the
 * adapter/event/metric shape but doesn't reuse the flat loop — the
 * orchestration flow is different enough that branching inline would
 * be harder to read than duplicating the wrapper.
 */
export async function runOrchestrationScenario(opts: RunnerOptions): Promise<RunnerResult> {
  if (!opts.scenario.orchestration) {
    throw new Error(
      `Scenario kind '${opts.scenario.kind}' requires an 'orchestration' block`,
    );
  }
  const orch = opts.scenario.orchestration;

  const runId = newRunId();
  const runDir = join(opts.outDir, runId);
  await mkdir(runDir, { recursive: true });

  const log = new EventLog(join(runDir, 'events.jsonl'), runId);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const seed = opts.scenario.seed ?? randomSeed();
  // rng reserved for future failure injection in orchestration scenarios.
  void mulberry32(seed);

  const evaluatorName = opts.scenario.evaluator;
  const evaluator = (evaluatorName ? getEvaluator(evaluatorName) : undefined) ?? successEvaluator;
  if (evaluatorName && evaluator.name !== evaluatorName) {
    console.warn(
      `Warning: evaluator '${evaluatorName}' not registered, falling back to '${evaluator.name}'`,
    );
  }

  log.emit('run_started', {
    scenario: opts.scenario.name,
    scenario_kind: opts.scenario.kind,
    provider: opts.provider,
    model: opts.model,
    runtime: opts.runtime,
    max_concurrency: opts.maxConcurrency,
  });

  // Per-cycle aggregates
  const coordinatorLatencies: number[] = [];
  const mergeLatencies: number[] = [];
  let totalWorkerLatencyMs = 0;
  let totalWorkers = 0;
  let succeededWorkers = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Final-output evaluation (one per top-level cycle)
  const finalResults: AgentTaskResult[] = [];
  const evalScores: number[] = [];
  let evalPasses = 0;

  // Progress: top-level cycles, not subworkers, for the spinner.
  const progress = {
    total: opts.scenario.tasks.length,
    completed: 0,
    failed: 0,
    active: 0,
    currentLevel: opts.maxConcurrency,
    currentLevelIndex: 1,
    totalLevels: 1,
  };
  const emitProgress = (): void => opts.onProgress?.({ ...progress });
  emitProgress();

  for (const task of opts.scenario.tasks) {
    progress.active = 1;
    emitProgress();

    log.emit('coordinator_started', { task_id: task.id });

    // -- Step 1: coordinator --
    const coordPrompt = substitute(orch.coordinator.prompt, task.payload);
    const coordStart = Date.now();
    const coordResult = await safeRunTask(opts.adapter, {
      taskId: `${task.id}::coordinator`,
      prompt: coordPrompt,
      payload: task.payload,
      model: opts.model,
      temperature: opts.scenario.temperature,
      timeoutMs: opts.scenario.timeout_ms,
      networkPolicy: opts.scenario.network_policy,
      runDir,
      apply: opts.apply,
    });
    const coordLatency = Date.now() - coordStart;
    coordinatorLatencies.push(coordLatency);
    totalInputTokens += coordResult.usage?.input_tokens ?? 0;
    totalOutputTokens += coordResult.usage?.output_tokens ?? 0;

    if (!coordResult.ok) {
      log.emit('coordinator_failed', {
        task_id: task.id,
        stage: 'coordinator',
        error_type: coordResult.error?.type,
        error_message: coordResult.error?.message,
        latency_ms: coordLatency,
      });
      finalResults.push(coordResult);
      evalScores.push(0);
      progress.failed += 1;
      progress.active = 0;
      emitProgress();
      continue;
    }

    const plan = parsePlan(coordResult.output);
    if (!plan || plan.subtopics.length === 0) {
      log.emit('coordinator_failed', {
        task_id: task.id,
        stage: 'plan_parse',
        error_type: 'invalid_plan',
        error_message: 'coordinator output did not parse as { subtopics: string[] }',
        coordinator_output: coordResult.output.slice(0, 200),
      });
      finalResults.push({
        taskId: task.id,
        ok: false,
        output: coordResult.output,
        error: { type: 'invalid_plan', message: 'plan parse failed' },
        latencyMs: coordLatency,
      });
      evalScores.push(0);
      progress.failed += 1;
      progress.active = 0;
      emitProgress();
      continue;
    }

    log.emit('coordinator_planned', {
      task_id: task.id,
      subtopic_count: plan.subtopics.length,
      coordinator_latency_ms: coordLatency,
    });

    // -- Step 2: workers (parallel) --
    const limit = pLimit(opts.maxConcurrency);
    const workerResults = await Promise.all(
      plan.subtopics.map((subtopic, idx) =>
        limit(async () => {
          const workerId = `${task.id}::w${idx}`;
          // worker_assigned is the orchestration-level semantic event
          // (coordinator handed this subtopic to a worker). The
          // worker_started/worker_completed pair below is what EventLog
          // uses to track real active concurrency for peak_concurrency.
          log.emit('worker_assigned', {
            coordinator_task: task.id,
            worker_id: workerId,
            subtopic,
          });
          progress.active += 1;
          emitProgress();

          const workerPrompt = substitute(orch.worker_template.prompt, { subtopic });
          log.emit('worker_started', { task_id: workerId, attempt: 1 });
          const wStart = Date.now();
          const result = await safeRunTask(opts.adapter, {
            taskId: workerId,
            prompt: workerPrompt,
            payload: { subtopic },
            model: opts.model,
            temperature: opts.scenario.temperature,
            timeoutMs: opts.scenario.timeout_ms,
            networkPolicy: opts.scenario.network_policy,
            runDir,
            apply: opts.apply,
          });
          const wLatency = Date.now() - wStart;

          progress.active = Math.max(0, progress.active - 1);
          emitProgress();

          if (result.ok) {
            log.emit('worker_completed', {
              task_id: workerId,
              attempt: 1,
              latency_ms: wLatency,
              input_tokens: result.usage?.input_tokens,
              output_tokens: result.usage?.output_tokens,
            });
          } else {
            log.emit('worker_failed', {
              task_id: workerId,
              attempt: 1,
              error_type: result.error?.type,
              error_message: result.error?.message,
              latency_ms: wLatency,
            });
          }
          log.emit('artifact_created', {
            worker_id: workerId,
            ok: result.ok,
            output_chars: result.output.length,
            latency_ms: wLatency,
          });

          totalWorkers += 1;
          if (result.ok) succeededWorkers += 1;
          totalWorkerLatencyMs += wLatency;
          totalInputTokens += result.usage?.input_tokens ?? 0;
          totalOutputTokens += result.usage?.output_tokens ?? 0;
          return result;
        }),
      ),
    );

    // -- Step 3: merge --
    log.emit('merge_started', { task_id: task.id });
    const workerOutputs = workerResults
      .map((r, i) => `${i + 1}. ${r.ok ? r.output : `[worker failed: ${r.error?.message ?? 'unknown'}]`}`)
      .join('\n\n');
    const mergePrompt = substitute(orch.merge.prompt, { worker_outputs: workerOutputs });
    const mergeStart = Date.now();
    const mergeResult = await safeRunTask(opts.adapter, {
      taskId: `${task.id}::merge`,
      prompt: mergePrompt,
      payload: task.payload,
      model: opts.model,
      temperature: opts.scenario.temperature,
      timeoutMs: opts.scenario.timeout_ms,
      networkPolicy: opts.scenario.network_policy,
      runDir,
      apply: opts.apply,
    });
    const mergeLatency = Date.now() - mergeStart;
    mergeLatencies.push(mergeLatency);
    totalInputTokens += mergeResult.usage?.input_tokens ?? 0;
    totalOutputTokens += mergeResult.usage?.output_tokens ?? 0;
    log.emit('merge_completed', {
      task_id: task.id,
      ok: mergeResult.ok,
      latency_ms: mergeLatency,
    });

    // -- Step 4: evaluate the final merged output --
    log.emit('evaluation_started', { task_id: task.id });
    const evalOut = await evaluator.evaluate({ task, result: mergeResult });
    evalScores.push(evalOut.score);
    if (evalOut.passed) evalPasses += 1;
    log.emit('evaluation_completed', {
      task_id: task.id,
      score: evalOut.score,
      passed: evalOut.passed,
      detail: evalOut.detail,
    });

    finalResults.push(mergeResult);
    log.emit('coordinator_completed', {
      task_id: task.id,
      coordinator_latency_ms: coordLatency,
      worker_count: plan.subtopics.length,
      merge_latency_ms: mergeLatency,
    });
    if (mergeResult.ok) progress.completed += 1;
    else progress.failed += 1;
    progress.active = 0;
    emitProgress();
  }

  const completedAt = new Date().toISOString();
  const wallMs = Date.now() - startMs;

  // Cost
  const pricing = lookupPricing(opts.provider, opts.model);
  let totalCostUsd = 0;
  let costSource: RunMetrics['cost_source'] = 'none';
  let pricingAsOf: string | undefined;
  if (pricing) {
    totalCostUsd = estimateUsd(pricing, {
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
    });
    costSource = 'pricing_table';
    pricingAsOf = pricing.as_of;
  } else if (opts.adapter.estimateCost) {
    totalCostUsd = opts.adapter.estimateCost({
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
    }).usd;
    costSource = 'adapter';
  }

  // Latency stats over the per-cycle final outputs.
  const finalLatencies = finalResults.map((r) => r.latencyMs);
  const cyclesSucceeded = finalResults.filter((r) => r.ok).length;
  const cyclesTotal = finalResults.length;

  const sumCoord = coordinatorLatencies.reduce((a, b) => a + b, 0);
  const sumMerge = mergeLatencies.reduce((a, b) => a + b, 0);
  const coordOverheadPct = wallMs > 0 ? ((sumCoord + sumMerge) / wallMs) * 100 : 0;
  const workerUtilPct = wallMs > 0 ? (totalWorkerLatencyMs / wallMs) * 100 : 0;

  const metrics: RunMetrics = {
    afb_version: afbVersion,
    node_version: process.versions.node,
    os: `${process.platform} ${process.arch}`,
    provider: opts.provider,
    model: opts.model,
    runtime: opts.runtime,
    runtime_class: opts.adapter.runtimeClass,
    scenario_hash: opts.scenario.scenario_hash,
    dataset_hash: opts.scenario.dataset_hash,
    scenario_name: opts.scenario.name,
    scenario_kind: opts.scenario.kind,
    prompt_template_version: opts.scenario.prompt_template_version,
    scoring_profile_version: opts.scenario.scoring_profile_version,
    evaluator: { name: evaluator.name, version: evaluator.version },
    temperature: opts.scenario.temperature ?? 0.2,
    started_at: startedAt,
    completed_at: completedAt,
    run_id: runId,
    network_policy: opts.scenario.network_policy,
    apply: opts.apply,
    seed,
    workers_total: totalWorkers,
    workers_succeeded: succeededWorkers,
    workers_failed: totalWorkers - succeededWorkers,
    workers_retried: 0,
    success_rate: totalWorkers ? succeededWorkers / totalWorkers : 0,
    cycles_total: cyclesTotal,
    cycles_succeeded: cyclesSucceeded,
    cycles_failed: cyclesTotal - cyclesSucceeded,
    final_success_rate: cyclesTotal ? cyclesSucceeded / cyclesTotal : 0,
    avg_latency_ms: mean(finalLatencies),
    p50_latency_ms: percentile(finalLatencies, 50),
    p95_latency_ms: percentile(finalLatencies, 95),
    p99_latency_ms: percentile(finalLatencies, 99),
    peak_concurrency: log.peakConcurrency,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    total_tokens: totalInputTokens + totalOutputTokens,
    wall_time_ms: wallMs,
    eval_pass_rate: evalScores.length ? evalPasses / evalScores.length : 0,
    eval_mean_score: evalScores.length ? mean(evalScores) : 0,
    total_cost_usd: totalCostUsd,
    cost_source: costSource,
    pricing_as_of: pricingAsOf,
    coordinator_latency_ms: coordinatorLatencies.length ? mean(coordinatorLatencies) : 0,
    worker_latency_ms_total: totalWorkerLatencyMs,
    merge_latency_ms: mergeLatencies.length ? mean(mergeLatencies) : 0,
    coordination_overhead_pct: coordOverheadPct,
    worker_utilization_pct: workerUtilPct,
  };

  log.emit('run_completed', {
    workers_total: metrics.workers_total,
    workers_succeeded: metrics.workers_succeeded,
    workers_failed: metrics.workers_failed,
    wall_time_ms: wallMs,
    coordination_overhead_pct: coordOverheadPct,
  });

  await writeFile(join(runDir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');
  await log.close();

  return {
    runDir,
    workersTotal: cyclesTotal, // top-level cycles, what the user thinks of as "tasks"
    workersCompleted: cyclesSucceeded,
    totalCostUsd,
    costSource,
    totalInputTokens,
    totalOutputTokens,
  };
}

/**
 * Wraps adapter.runTask so a thrown exception becomes a task-level
 * failure rather than aborting the whole orchestration cycle. Same
 * shape as the flat runner uses internally.
 */
async function safeRunTask(
  adapter: AgentRuntimeAdapter,
  input: Parameters<AgentRuntimeAdapter['runTask']>[0],
): Promise<AgentTaskResult> {
  const callStart = Date.now();
  try {
    return await adapter.runTask(input);
  } catch (err) {
    return {
      taskId: input.taskId,
      ok: false,
      output: '',
      error: { type: 'adapter_threw', message: err instanceof Error ? err.message : String(err) },
      latencyMs: Date.now() - callStart,
    };
  }
}

function substitute(template: string, vars?: Record<string, unknown>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

interface Plan {
  subtopics: string[];
}

function parsePlan(raw: string): Plan | null {
  const stripped = stripCodeFence(raw);
  try {
    const parsed = JSON.parse(stripped);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as Plan).subtopics) &&
      (parsed as Plan).subtopics.every((s) => typeof s === 'string')
    ) {
      return parsed as Plan;
    }
  } catch {
    // fall through to null
  }
  return null;
}

function stripCodeFence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return m ? m[1] : s.trim();
}
