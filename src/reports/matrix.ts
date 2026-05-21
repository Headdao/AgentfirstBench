import type { RunMetrics } from '../metrics/types.js';
import { summarizeSweep } from '../metrics/sweep.js';
import { formatUsd } from '../utils/format.js';
import { verdictForMatrix } from './verdict.js';

export interface MatrixRow {
  label: string; // provider/model
  metrics: RunMetrics;
}

/** Render a markdown matrix comparing N models side by side on the same scenario. */
export function renderMatrixMarkdown(scenarioName: string, rows: MatrixRow[]): string {
  const lines: string[] = [];
  lines.push(`# Matrix — ${scenarioName} across ${rows.length} models`);
  lines.push('');
  if (rows.length === 0) return lines.join('\n') + '\n';

  lines.push(verdictForMatrix(rows));

  const hasSweep = rows.some((r) => r.metrics.per_level && r.metrics.per_level.length > 1);
  const hasAccuracy = rows.some((r) => r.metrics.evaluator.name !== 'success');
  const classes = new Set(rows.map((r) => r.metrics.runtime_class));
  const showClassCol = classes.size > 1;

  // Headline table
  const headers = ['Model', 'Class', 'OK'];
  if (!showClassCol) headers.splice(1, 1); // drop Class column when all the same
  if (hasAccuracy) headers.push('Accuracy');
  headers.push('Avg ms', 'p95 ms', 'Total $', '$/success');
  if (hasSweep) headers.push('Peak thru/s', 'Inflection');
  lines.push('| ' + headers.join(' | ') + ' |');
  lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');

  for (const r of rows) {
    const m = r.metrics;
    const successPct = `${(m.success_rate * 100).toFixed(1)}%`;
    const costPerOk = m.workers_succeeded > 0 ? m.total_cost_usd / m.workers_succeeded : 0;
    const row: string[] = [`\`${r.label}\``];
    if (showClassCol) row.push(`\`${m.runtime_class}\``);
    row.push(`${m.workers_succeeded}/${m.workers_total} (${successPct})`);
    if (hasAccuracy) {
      row.push(
        m.evaluator.name === 'success'
          ? '—'
          : `${(m.eval_pass_rate * 100).toFixed(1)}%`,
      );
    }
    row.push(
      String(Math.round(m.avg_latency_ms)),
      String(Math.round(m.p95_latency_ms)),
      formatUsd(m.total_cost_usd),
      formatUsd(costPerOk),
    );
    if (hasSweep) {
      const sum = m.per_level ? summarizeSweep(m.per_level) : null;
      if (sum) {
        row.push(`${sum.peak_throughput.value.toFixed(2)} @ N=${sum.peak_throughput.at_concurrency}`);
        row.push(
          sum.inflection
            ? `N=${sum.inflection.at_concurrency} (+${sum.inflection.next_gain_pct.toFixed(1)}% next)`
            : 'none in range',
        );
      } else {
        row.push('—', '—');
      }
    }
    lines.push('| ' + row.join(' | ') + ' |');
  }

  // Per-level breakdown (when at least one model swept).
  if (hasSweep) {
    const levels = collectLevels(rows);
    if (levels.length > 0) {
      lines.push('');
      lines.push('## Throughput per concurrency level (/s)');
      lines.push('');
      const head = ['N', ...rows.map((r) => `\`${r.label}\``)];
      lines.push('| ' + head.join(' | ') + ' |');
      lines.push('| ' + head.map(() => '---').join(' | ') + ' |');
      for (const n of levels) {
        const cells = [String(n)];
        for (const r of rows) {
          const lvl = r.metrics.per_level?.find((x) => x.concurrency === n);
          cells.push(lvl ? lvl.throughput_per_sec.toFixed(2) : '—');
        }
        lines.push('| ' + cells.join(' | ') + ' |');
      }
    }
  }

  return lines.join('\n') + '\n';
}

/** Stdout-friendly fixed-width version of the headline table. */
export function renderMatrixStdout(rows: MatrixRow[]): string {
  if (rows.length === 0) return '(no rows)';
  const hasAccuracy = rows.some((r) => r.metrics.evaluator.name !== 'success');
  const classes = new Set(rows.map((r) => r.metrics.runtime_class));
  const showClassCol = classes.size > 1;

  const header = ['Model'];
  const widths = [42];
  if (showClassCol) {
    header.push('Class');
    widths.push(22);
  }
  header.push('OK');
  widths.push(11);
  if (hasAccuracy) {
    header.push('Accuracy');
    widths.push(10);
  }
  header.push('Avg', 'p95', 'Cost', '$/OK');
  widths.push(7, 7, 12, 12);

  const out: string[] = [];
  out.push(header.map((h, i) => h.padEnd(widths[i])).join(''));
  out.push('-'.repeat(widths.reduce((a, b) => a + b, 0)));
  for (const r of rows) {
    const m = r.metrics;
    const successPct = `${(m.success_rate * 100).toFixed(0)}%`;
    const costPerOk = m.workers_succeeded > 0 ? m.total_cost_usd / m.workers_succeeded : 0;
    const cells: string[] = [r.label];
    if (showClassCol) cells.push(m.runtime_class);
    cells.push(`${m.workers_succeeded}/${m.workers_total} ${successPct}`);
    if (hasAccuracy) {
      cells.push(
        m.evaluator.name === 'success' ? '—' : `${(m.eval_pass_rate * 100).toFixed(0)}%`,
      );
    }
    cells.push(
      String(Math.round(m.avg_latency_ms)),
      String(Math.round(m.p95_latency_ms)),
      formatUsd(m.total_cost_usd),
      formatUsd(costPerOk),
    );
    out.push(cells.map((c, i) => c.padEnd(widths[i])).join(''));
  }
  return out.join('\n');
}

function collectLevels(rows: MatrixRow[]): number[] {
  const set = new Set<number>();
  for (const r of rows) {
    for (const lvl of r.metrics.per_level ?? []) set.add(lvl.concurrency);
  }
  return [...set].sort((a, b) => a - b);
}
