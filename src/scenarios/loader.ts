import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { createHash } from 'node:crypto';
import { ScenarioSchema, type Scenario } from './types.js';
import { datasetHash } from '../utils/dataset-hash.js';

export interface LoadedScenario extends Scenario {
  /** Hash of the raw scenario file contents — covers config + data. */
  scenario_hash: string;
  /** Hash of the input data only (tasks, order-insensitive). */
  dataset_hash: string;
}

export async function loadScenario(path: string): Promise<LoadedScenario> {
  const raw = await readFile(path, 'utf8');
  const parsed = parse(raw);
  const result = ScenarioSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid scenario file ${path}:\n  ${issues}`);
  }
  const scenarioHashValue = createHash('sha256').update(raw).digest('hex');
  return {
    ...result.data,
    scenario_hash: scenarioHashValue,
    dataset_hash: datasetHash(result.data.tasks),
  };
}
