import type { RunMetrics } from '../metrics/types.js';
import { formatUsd } from '../utils/format.js';
import { verdictForRun } from './verdict.js';

export function renderMarkdown(m: RunMetrics): string {
  const lines: string[] = [];
  lines.push(`# Agent First Bench — Run Report`);
  lines.push('');
  lines.push(verdictForRun(m));
  lines.push(`- **Run id**: \`${m.run_id}\``);
  lines.push(`- **Scenario**: ${m.scenario_name} (${m.scenario_kind})`);
  lines.push(`- **Provider/Model/Runtime**: ${m.provider} / ${m.model} / ${m.runtime}`);
  lines.push(`- **Started**: ${m.started_at}`);
  lines.push(`- **Completed**: ${m.completed_at}`);
  lines.push(`- **afb**: ${m.afb_version} · node ${m.node_version} · ${m.os}`);
  lines.push(`- **Scenario hash**: \`${m.scenario_hash.slice(0, 12)}…\` (config + data)`);
  lines.push(`- **Dataset hash**: \`${m.dataset_hash.slice(0, 12)}…\` (inputs only)`);
  lines.push(`- **Prompt template**: ${m.prompt_template_version}`);
  lines.push(`- **Scoring profile**: ${m.scoring_profile_version}`);
  lines.push(`- **Evaluator**: ${m.evaluator.name}@${m.evaluator.version}`);
  lines.push('');
  lines.push(`## Aggregate metrics`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Workers total | ${m.workers_total} |`);
  lines.push(`| Workers succeeded | ${m.workers_succeeded} |`);
  lines.push(`| Workers failed | ${m.workers_failed} |`);
  lines.push(`| Workers retried | ${m.workers_retried} |`);
  lines.push(`| Success rate | ${(m.success_rate * 100).toFixed(1)}% |`);
  if (m.evaluator.name !== 'success') {
    lines.push(
      `| Accuracy (${m.evaluator.name}) | ${(m.eval_pass_rate * 100).toFixed(1)}% pass, mean score ${m.eval_mean_score.toFixed(2)} |`,
    );
  }
  lines.push(`| Avg latency | ${Math.round(m.avg_latency_ms)} ms |`);
  lines.push(`| p50 / p95 / p99 latency | ${Math.round(m.p50_latency_ms)} / ${Math.round(m.p95_latency_ms)} / ${Math.round(m.p99_latency_ms)} ms |`);
  lines.push(`| Peak concurrency | ${m.peak_concurrency} |`);
  lines.push(`| Total tokens (in + out) | ${m.total_input_tokens} + ${m.total_output_tokens} = ${m.total_tokens} |`);
  lines.push(`| Wall time | ${m.wall_time_ms} ms |`);
  const costNote =
    m.cost_source === 'pricing_table'
      ? `pricing table, as of ${m.pricing_as_of}`
      : m.cost_source === 'adapter'
        ? 'adapter estimate'
        : `unavailable — no pricing for ${m.provider}/${m.model}`;
  lines.push(`| Total cost | ${formatUsd(m.total_cost_usd)} (${costNote}) |`);
  lines.push('');

  if (m.coordinator_latency_ms !== undefined) {
    lines.push(`## Orchestration`);
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Cycles | ${m.cycles_succeeded}/${m.cycles_total} (${(m.final_success_rate * 100).toFixed(1)}% final) |`);
    lines.push(`| Subworkers | ${m.workers_succeeded}/${m.workers_total} (${(m.success_rate * 100).toFixed(1)}%) |`);
    lines.push(`| Coordinator avg latency | ${Math.round(m.coordinator_latency_ms)} ms |`);
    lines.push(`| Merge avg latency | ${Math.round(m.merge_latency_ms ?? 0)} ms |`);
    lines.push(`| Worker total latency | ${m.worker_latency_ms_total ?? 0} ms |`);
    lines.push(`| Coordination overhead | ${(m.coordination_overhead_pct ?? 0).toFixed(1)}% (of wall time) |`);
    lines.push(`| Worker utilization | ${(m.worker_utilization_pct ?? 0).toFixed(1)}% (of wall time) |`);
    lines.push('');
    lines.push(`> Coordination overhead = (Σ coordinator + Σ merge) / wall_time. The "tax" the runtime adds beyond worker execution.`);
    lines.push('');
  }

  if (m.per_level && m.per_level.length > 0) {
    lines.push(`## Concurrency sweep`);
    lines.push('');
    lines.push(`| Concurrency | Tasks | OK | Avg ms | p95 ms | Throughput/s | Wall ms |`);
    lines.push(`| ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
    for (const r of m.per_level) {
      lines.push(
        `| ${r.concurrency} | ${r.workers_total} | ${r.workers_succeeded} | ${Math.round(r.avg_latency_ms)} | ${Math.round(r.p95_latency_ms)} | ${r.throughput_per_sec.toFixed(2)} | ${r.wall_time_ms} |`,
      );
    }
    lines.push('');
    lines.push(`> Look for the point where throughput stops scaling — that's the marginal-return inflection.`);
  }

  return lines.join('\n') + '\n';
}
