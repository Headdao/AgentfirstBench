import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { formatUsd } from '../utils/format.js';
import { summarizeSweep, type PerLevel } from '../metrics/sweep.js';

interface Metrics {
  provider: string;
  model: string;
  runtime: string;
  workers_total: number;
  workers_succeeded: number;
  workers_failed: number;
  success_rate: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  peak_concurrency: number;
  total_tokens: number;
  wall_time_ms: number;
  total_cost_usd: number;
  per_level?: PerLevel[];
}

const COL = 32;

export async function compareCommand(runDirA: string, runDirB: string): Promise<void> {
  const a = await loadMetrics(runDirA);
  const b = await loadMetrics(runDirB);

  // Aggregate metrics
  printSection('Aggregate metrics', [
    ['metric', labelFor(a), labelFor(b)],
    ['workers_total', String(a.workers_total), String(b.workers_total)],
    ['workers_succeeded', String(a.workers_succeeded), String(b.workers_succeeded)],
    ['workers_failed', String(a.workers_failed), String(b.workers_failed)],
    ['success_rate', pct(a.success_rate), pct(b.success_rate)],
    ['avg_latency_ms', String(Math.round(a.avg_latency_ms)), String(Math.round(b.avg_latency_ms))],
    ['p95_latency_ms', String(Math.round(a.p95_latency_ms)), String(Math.round(b.p95_latency_ms))],
    ['peak_concurrency', String(a.peak_concurrency), String(b.peak_concurrency)],
    ['total_tokens', String(a.total_tokens), String(b.total_tokens)],
    ['wall_time_ms', String(a.wall_time_ms), String(b.wall_time_ms)],
    ['total_cost', formatUsd(a.total_cost_usd), formatUsd(b.total_cost_usd)],
    ['cost_per_success', formatUsd(costPerSuccess(a)), formatUsd(costPerSuccess(b))],
  ]);

  // Sweep summary + per-level detail (only if at least one side has a sweep)
  if (a.per_level || b.per_level) {
    printSweep(a, b);
  }
}

function printSection(title: string, rows: Array<string[]>): void {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  for (const row of rows) {
    console.log(row.map((c) => c.padEnd(COL)).join(''));
  }
}

function printSweep(a: Metrics, b: Metrics): void {
  const sumA = a.per_level ? summarizeSweep(a.per_level) : null;
  const sumB = b.per_level ? summarizeSweep(b.per_level) : null;

  const sweepRows: Array<string[]> = [['', labelFor(a), labelFor(b)]];
  sweepRows.push([
    'peak_throughput',
    sumA ? `${sumA.peak_throughput.value.toFixed(2)}/s @ N=${sumA.peak_throughput.at_concurrency}` : '—',
    sumB ? `${sumB.peak_throughput.value.toFixed(2)}/s @ N=${sumB.peak_throughput.at_concurrency}` : '—',
  ]);
  sweepRows.push([
    'peak_success_rate',
    sumA ? `${pct(sumA.peak_success_rate.value)} @ N=${sumA.peak_success_rate.at_concurrency}` : '—',
    sumB ? `${pct(sumB.peak_success_rate.value)} @ N=${sumB.peak_success_rate.at_concurrency}` : '—',
  ]);
  sweepRows.push([
    'scaling_inflection',
    formatInflection(sumA),
    formatInflection(sumB),
  ]);
  printSection('Sweep summary (§18: where do marginal returns turn negative?)', sweepRows);

  // Per-level detail. Merge concurrency levels from both sides.
  const aMap = new Map((a.per_level ?? []).map((r) => [r.concurrency, r]));
  const bMap = new Map((b.per_level ?? []).map((r) => [r.concurrency, r]));
  const allLevels = [...new Set([...aMap.keys(), ...bMap.keys()])].sort((x, y) => x - y);

  const header = ['N', 'A: ok/total', 'A: avg ms', 'A: p95', 'A: thru/s', 'B: ok/total', 'B: avg ms', 'B: p95', 'B: thru/s'];
  const rows: Array<string[]> = [header];
  for (const n of allLevels) {
    const ra = aMap.get(n);
    const rb = bMap.get(n);
    rows.push([
      String(n),
      ra ? `${ra.workers_succeeded}/${ra.workers_total}` : '—',
      ra ? String(Math.round(ra.avg_latency_ms)) : '—',
      ra ? String(Math.round(ra.p95_latency_ms)) : '—',
      ra ? ra.throughput_per_sec.toFixed(2) : '—',
      rb ? `${rb.workers_succeeded}/${rb.workers_total}` : '—',
      rb ? String(Math.round(rb.avg_latency_ms)) : '—',
      rb ? String(Math.round(rb.p95_latency_ms)) : '—',
      rb ? rb.throughput_per_sec.toFixed(2) : '—',
    ]);
  }
  const narrowCol = 12;
  console.log('\nPer-level detail');
  console.log('-'.repeat('Per-level detail'.length));
  for (const row of rows) {
    console.log(row.map((c) => c.padEnd(narrowCol)).join(''));
  }

  if (aMap.size > 0 && bMap.size > 0 && (aMap.size !== bMap.size || ![...aMap.keys()].every((k) => bMap.has(k)))) {
    console.log('\nNote: sweep concurrency levels differ between runs — cells marked — were not measured on that side.');
  }
}

function formatInflection(s: ReturnType<typeof summarizeSweep>): string {
  if (!s) return '—';
  if (!s.inflection) return 'no inflection in tested range';
  return `N=${s.inflection.at_concurrency} (next +${s.inflection.next_gain_pct.toFixed(1)}%)`;
}

async function loadMetrics(runDir: string): Promise<Metrics> {
  const path = join(resolve(process.cwd(), runDir), 'metrics.json');
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as Metrics;
}

function labelFor(m: Metrics): string {
  return `${m.provider}/${m.model}@${m.runtime}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function costPerSuccess(m: Metrics): number {
  return m.workers_succeeded > 0 ? m.total_cost_usd / m.workers_succeeded : 0;
}
