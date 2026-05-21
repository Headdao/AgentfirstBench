import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pLimit from 'p-limit';
import type { AgentRuntimeAdapter, AgentTaskResult } from '../adapters/types.js';
import type { LoadedScenario } from '../scenarios/loader.js';
import { EventLog } from '../metrics/event-log.js';
import type { RunMetrics } from '../metrics/types.js';
import { newRunId } from '../utils/run-id.js';
import { mean, percentile } from '../utils/stats.js';
import { version as afbVersion } from '../version.js';
import { lookupPricing, estimateUsd } from '../pricing/table.js';
import { successEvaluator } from '../evaluators/types.js';
import { mulberry32, randomSeed } from '../utils/prng.js';

export interface ProgressInfo {
  /** Total task executions planned across all concurrency levels. */
  total: number;
  /** Cumulative successful task completions so far. */
  completed: number;
  /** Cumulative failed task completions so far. */
  failed: number;
  /** Workers currently in flight. */
  active: number;
  /** Current concurrency level (for sweep scenarios), else the configured max. */
  currentLevel: number;
  /** 1-indexed position of the current level in the sweep, e.g. "3/6". */
  currentLevelIndex: number;
  totalLevels: number;
}

export interface RunnerOptions {
  scenario: LoadedScenario;
  adapter: AgentRuntimeAdapter;
  outDir: string;
  provider: string;
  model: string;
  runtime: string;
  maxConcurrency: number;
  apply: boolean;
  /** Called after each worker completes/fails so the CLI can render progress. */
  onProgress?: (info: ProgressInfo) => void;
}

export interface RunnerResult {
  runDir: string;
  workersTotal: number;
  workersCompleted: number;
  totalCostUsd: number;
  costSource: RunMetrics['cost_source'];
  totalInputTokens: number;
  totalOutputTokens: number;
}

export async function runScenario(opts: RunnerOptions): Promise<RunnerResult> {
  // Safety §13: coding scenarios mutate the host repo. Refuse unless explicit.
  if (opts.scenario.kind.startsWith('coding') && !opts.apply) {
    throw new Error(
      `Scenario kind '${opts.scenario.kind}' performs host mutations. ` +
        `Re-run with --apply to authorize, or use a non-coding scenario.`,
    );
  }

  const runId = newRunId();
  const runDir = join(opts.outDir, runId);
  await mkdir(runDir, { recursive: true });

  const log = new EventLog(join(runDir, 'events.jsonl'), runId);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // Seeded PRNG: any randomness the runner introduces (failure injection,
  // jitter, etc.) goes through this so the same scenario + seed reproduces
  // the same outcome. The effective seed is recorded in metrics.json.
  const seed = opts.scenario.seed ?? randomSeed();
  const rng = mulberry32(seed);
  const injectedIds: string[] = [];

  log.emit('run_started', {
    scenario: opts.scenario.name,
    scenario_kind: opts.scenario.kind,
    provider: opts.provider,
    model: opts.model,
    runtime: opts.runtime,
    max_concurrency: opts.maxConcurrency,
  });

  // Concurrency-ramp scenarios sweep through levels; everything else runs once.
  const levels =
    opts.scenario.kind === 'concurrency_ramp' && opts.scenario.concurrency_levels?.length
      ? opts.scenario.concurrency_levels
      : [opts.maxConcurrency];

  const allResults: AgentTaskResult[] = [];
  const perLevel: NonNullable<RunMetrics['per_level']> = [];
  let workersRetried = 0;

  // Progress tracking — handed to the CLI via opts.onProgress so it can
  // render a spinner. The runner itself doesn't render anything.
  const totalPlanned = opts.scenario.tasks.length * levels.length;
  const progress = {
    total: totalPlanned,
    completed: 0,
    failed: 0,
    active: 0,
    currentLevel: levels[0],
    currentLevelIndex: 1,
    totalLevels: levels.length,
  };
  const emitProgress = (): void => {
    opts.onProgress?.({ ...progress });
  };
  emitProgress();

  for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
    const concurrency = levels[levelIdx];
    progress.currentLevel = concurrency;
    progress.currentLevelIndex = levelIdx + 1;
    const levelStart = Date.now();
    const limit = pLimit(concurrency);
    const levelResults = await Promise.all(
      opts.scenario.tasks.map((task) =>
        limit(async () => {
          // For failure_containment: injectable failures simulated by short-circuiting the adapter.
          // Uses the seeded rng so the same seed + scenario reproduces the same failure set.
          const shouldInject =
            opts.scenario.kind === 'failure_containment' &&
            opts.scenario.inject_failure_rate !== undefined &&
            rng() < opts.scenario.inject_failure_rate;
          if (shouldInject) injectedIds.push(task.id);

          log.emit('worker_scheduled', { task_id: task.id, concurrency });
          progress.active += 1;
          emitProgress();

          const maxAttempts = (opts.scenario.retries ?? 0) + 1;
          let last: AgentTaskResult | undefined;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            log.emit('worker_started', { task_id: task.id, attempt });

            if (shouldInject && attempt === 1) {
              last = {
                taskId: task.id,
                ok: false,
                output: '',
                error: { type: 'injected_failure', message: 'failure_containment injection' },
                latencyMs: 0,
              };
            } else {
              // Wrap so that a thrown exception (network parser bug, custom
              // runtime crash, etc.) becomes a *task* failure rather than
              // aborting the whole run — without this, one bad task can
              // skip metrics.json and leave the event log truncated.
              const callStart = Date.now();
              try {
                last = await opts.adapter.runTask({
                  taskId: task.id,
                  prompt: task.prompt,
                  payload: task.payload,
                  model: opts.model,
                  temperature: opts.scenario.temperature,
                  timeoutMs: opts.scenario.timeout_ms,
                  networkPolicy: opts.scenario.network_policy,
                  runDir,
                  apply: opts.apply,
                });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                last = {
                  taskId: task.id,
                  ok: false,
                  output: '',
                  error: { type: 'adapter_threw', message },
                  latencyMs: Date.now() - callStart,
                };
              }
            }

            if (last.ok) {
              log.emit('worker_completed', {
                task_id: task.id,
                attempt,
                latency_ms: last.latencyMs,
                input_tokens: last.usage?.input_tokens,
                output_tokens: last.usage?.output_tokens,
              });
              break;
            }

            log.emit('worker_failed', {
              task_id: task.id,
              attempt,
              error_type: last.error?.type,
              error_message: last.error?.message,
              latency_ms: last.latencyMs,
            });

            if (last.error?.type === 'rate_limited') {
              log.emit('rate_limited', { task_id: task.id, attempt });
            }

            if (attempt < maxAttempts) {
              workersRetried += 1;
              log.emit('worker_retried', { task_id: task.id, next_attempt: attempt + 1 });
            }
          }

          progress.active -= 1;
          if (last!.ok) progress.completed += 1;
          else progress.failed += 1;
          emitProgress();
          return last!;
        }),
      ),
    );

    const wallMs = Date.now() - levelStart;
    if (levels.length > 1) {
      const succeeded = levelResults.filter((r) => r.ok).length;
      const latencies = levelResults.map((r) => r.latencyMs);
      perLevel.push({
        concurrency,
        workers_total: levelResults.length,
        workers_succeeded: succeeded,
        avg_latency_ms: mean(latencies),
        p95_latency_ms: percentile(latencies, 95),
        throughput_per_sec: levelResults.length / (wallMs / 1000),
        wall_time_ms: wallMs,
      });
    }
    allResults.push(...levelResults);
  }

  const completedAt = new Date().toISOString();
  const wallMs = Date.now() - startMs;

  const succeeded = allResults.filter((r) => r.ok);
  const latencies = allResults.map((r) => r.latencyMs);
  const totalInput = allResults.reduce((s, r) => s + (r.usage?.input_tokens ?? 0), 0);
  const totalOutput = allResults.reduce((s, r) => s + (r.usage?.output_tokens ?? 0), 0);

  // Cost: prefer the central pricing table for reproducibility; fall back to
  // the adapter's own estimator only if no table entry exists.
  const pricing = lookupPricing(opts.provider, opts.model);
  let totalCostUsd = 0;
  let costSource: RunMetrics['cost_source'] = 'none';
  let pricingAsOf: string | undefined;
  if (pricing) {
    totalCostUsd = estimateUsd(pricing, { input_tokens: totalInput, output_tokens: totalOutput });
    costSource = 'pricing_table';
    pricingAsOf = pricing.as_of;
  } else if (opts.adapter.estimateCost) {
    totalCostUsd = opts.adapter.estimateCost({
      input_tokens: totalInput,
      output_tokens: totalOutput,
    }).usd;
    costSource = 'adapter';
  }

  const metrics: RunMetrics = {
    afb_version: afbVersion,
    node_version: process.versions.node,
    os: `${process.platform} ${process.arch}`,
    provider: opts.provider,
    model: opts.model,
    runtime: opts.runtime,
    scenario_hash: opts.scenario.scenario_hash,
    dataset_hash: opts.scenario.dataset_hash,
    scenario_name: opts.scenario.name,
    scenario_kind: opts.scenario.kind,
    prompt_template_version: opts.scenario.prompt_template_version,
    scoring_profile_version: opts.scenario.scoring_profile_version,
    evaluator: { name: successEvaluator.name, version: successEvaluator.version },
    temperature: opts.scenario.temperature ?? 0.2,
    started_at: startedAt,
    completed_at: completedAt,
    run_id: runId,
    network_policy: opts.scenario.network_policy,
    apply: opts.apply,
    seed,
    injected_failure_task_ids: injectedIds.length > 0 ? injectedIds : undefined,
    workers_total: allResults.length,
    workers_succeeded: succeeded.length,
    workers_failed: allResults.length - succeeded.length,
    workers_retried: workersRetried,
    success_rate: allResults.length ? succeeded.length / allResults.length : 0,
    avg_latency_ms: mean(latencies),
    p50_latency_ms: percentile(latencies, 50),
    p95_latency_ms: percentile(latencies, 95),
    p99_latency_ms: percentile(latencies, 99),
    peak_concurrency: log.peakConcurrency,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_tokens: totalInput + totalOutput,
    wall_time_ms: wallMs,
    total_cost_usd: totalCostUsd,
    cost_source: costSource,
    pricing_as_of: pricingAsOf,
    per_level: perLevel.length ? perLevel : undefined,
  };

  log.emit('run_completed', {
    workers_total: metrics.workers_total,
    workers_succeeded: metrics.workers_succeeded,
    workers_failed: metrics.workers_failed,
    wall_time_ms: wallMs,
  });

  await writeFile(join(runDir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');
  await log.close();

  return {
    runDir,
    workersTotal: metrics.workers_total,
    workersCompleted: metrics.workers_succeeded,
    totalCostUsd: metrics.total_cost_usd,
    costSource: metrics.cost_source,
    totalInputTokens: metrics.total_input_tokens,
    totalOutputTokens: metrics.total_output_tokens,
  };
}
