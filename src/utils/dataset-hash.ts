import { createHash } from 'node:crypto';
import type { Task } from '../scenarios/types.js';

/**
 * §14: hash the *inputs* of a scenario, independent of execution config.
 *
 * Two scenarios with the same tasks (regardless of order) and the same
 * payloads/expectations share a dataset_hash. Two scenarios that differ
 * only in `max_concurrency` or `temperature` keep the same dataset_hash
 * but different scenario_hash — that distinction lets us answer "did we
 * benchmark on the same data?" separately from "did we run with the
 * same settings?".
 */
export function datasetHash(tasks: Task[]): string {
  const canonical = tasks
    .map((t) => ({
      id: t.id,
      prompt: t.prompt,
      payload: sortKeys(t.payload),
      expect: sortKeys(t.expect),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
  return out;
}
