export interface RunMetrics {
  // Reproducibility (spec §14)
  afb_version: string;
  node_version: string;
  os: string;
  provider: string;
  model: string;
  runtime: string;
  scenario_hash: string;
  dataset_hash: string;
  scenario_name: string;
  scenario_kind: string;
  prompt_template_version: string;
  scoring_profile_version: string;
  evaluator: { name: string; version: string };
  temperature: number;
  started_at: string;
  completed_at: string;
  run_id: string;

  // Safety §13
  network_policy: { mode: string; hosts?: string[] };
  apply: boolean;

  /** Effective seed used by the runner (always recorded, even if the scenario didn't supply one). */
  seed: number;
  /** Task IDs that had failure injected this run — derivable from the seed but recorded for fast diffing. */
  injected_failure_task_ids?: string[];

  // Aggregates
  workers_total: number;
  workers_succeeded: number;
  workers_failed: number;
  workers_retried: number;
  success_rate: number;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  peak_concurrency: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  wall_time_ms: number;

  // Evaluator scoring (populated for all runs; only meaningful when
  // evaluator.name !== 'success' since otherwise it duplicates success_rate)
  eval_pass_rate: number;
  eval_mean_score: number;

  /**
   * v0.2 orchestration metrics. All zero/undefined for non-orchestration
   * scenarios. For orchestration scenarios these are averaged across the
   * top-level coordinator cycles in the run.
   */
  coordinator_latency_ms?: number;
  worker_latency_ms_total?: number;
  merge_latency_ms?: number;
  /** (Σ coordinator + Σ merge) / wall_time × 100. The "coordination tax". */
  coordination_overhead_pct?: number;
  /** Σ worker latency / wall_time × 100. Higher means workers were busy. */
  worker_utilization_pct?: number;

  // Cost
  total_cost_usd: number;
  /**
   * 'pricing_table': computed from src/pricing/table.ts (preferred)
   * 'adapter':       fell back to adapter.estimateCost (no table entry)
   * 'none':          neither was available — total_cost_usd is 0 and unreliable
   */
  cost_source: 'pricing_table' | 'adapter' | 'none';
  pricing_as_of?: string;

  // Per-level results when the scenario sweeps concurrency.
  per_level?: Array<{
    concurrency: number;
    workers_total: number;
    workers_succeeded: number;
    avg_latency_ms: number;
    p95_latency_ms: number;
    throughput_per_sec: number;
    wall_time_ms: number;
  }>;
}
