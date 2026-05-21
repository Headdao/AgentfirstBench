import { resolve } from 'node:path';
import { loadScenario } from '../scenarios/loader.js';
import { loadConfig } from '../config/loader.js';
import { runScenario } from '../runners/runner.js';
import { getAdapter, listAdapters } from '../adapters/registry.js';
import { formatUsd, formatTokens } from '../utils/format.js';
import { Spinner } from '../utils/spinner.js';

interface RunOptions {
  out: string;
  provider?: string;
  model?: string;
  runtime?: string;
  apply?: boolean;
  // cac auto-converts numeric strings to number; accept both shapes.
  maxConcurrency?: string | number;
}

const BUILTIN_DEFAULTS = {
  provider: 'mock',
  model: 'mock-model',
  runtime: 'mock',
  max_concurrency: 8,
  temperature: 0.2,
};

function parsePositiveInt(raw: string | number, flag: string): number {
  const reject = (): never => {
    console.error(`Invalid value for ${flag}: ${JSON.stringify(raw)} (expected a positive integer)`);
    process.exit(2);
  };
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else {
    // parseInt accepts "4abc" → 4; require the entire string to be digits.
    if (!/^\d+$/.test(raw)) reject();
    n = Number(raw);
  }
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) reject();
  return n;
}

export async function runCommand(scenarioPath: string, opts: RunOptions): Promise<void> {
  const absScenario = resolve(process.cwd(), scenarioPath);
  const scenario = await loadScenario(absScenario);
  const config = await loadConfig();

  // Merge order: CLI flags > scenario > config > built-in defaults.
  const provider = opts.provider ?? scenario.provider ?? config.provider ?? BUILTIN_DEFAULTS.provider;
  const model = opts.model ?? scenario.model ?? config.model ?? BUILTIN_DEFAULTS.model;
  const runtime = opts.runtime ?? scenario.runtime ?? config.runtime ?? BUILTIN_DEFAULTS.runtime;
  const maxConcurrency =
    opts.maxConcurrency != null
      ? parsePositiveInt(opts.maxConcurrency, '--max-concurrency')
      : scenario.max_concurrency ?? config.max_concurrency ?? BUILTIN_DEFAULTS.max_concurrency;
  const temperature = scenario.temperature ?? config.temperature ?? BUILTIN_DEFAULTS.temperature;

  const adapter = getAdapter(runtime);
  if (!adapter) {
    console.error(`Unknown runtime adapter: ${runtime}`);
    console.error(`Available: ${listAdapters().join(', ')}`);
    process.exit(1);
  }

  const spinner = new Spinner();
  spinner.start(`Starting ${scenario.name} on ${provider}/${model}@${runtime}…`);

  let result;
  try {
    result = await runScenario({
      scenario: { ...scenario, temperature },
      adapter,
      outDir: resolve(process.cwd(), opts.out),
      provider,
      model,
      runtime,
      maxConcurrency,
      apply: opts.apply ?? false,
      onProgress: (p) => {
        const levelInfo =
          p.totalLevels > 1 ? ` · level ${p.currentLevelIndex}/${p.totalLevels} (N=${p.currentLevel})` : '';
        const failedInfo = p.failed > 0 ? `, ${p.failed} failed` : '';
        spinner.update(
          `${p.completed + p.failed}/${p.total} done · ${p.active} in flight${levelInfo}${failedInfo}`,
        );
      },
    });
  } catch (err) {
    spinner.stop();
    throw err;
  }
  spinner.stop();

  console.log(`Run complete: ${result.runDir}`);
  console.log(`Workers: ${result.workersCompleted}/${result.workersTotal} succeeded`);
  const tokens = `${formatTokens(result.totalInputTokens)} in + ${formatTokens(result.totalOutputTokens)} out`;
  if (result.costSource === 'pricing_table') {
    console.log(`Cost:    ${formatUsd(result.totalCostUsd)} (${provider}/${model}, ${tokens})`);
  } else if (result.costSource === 'adapter') {
    console.log(`Cost:    ${formatUsd(result.totalCostUsd)} (adapter estimate, ${tokens})`);
  } else {
    console.log(`Cost:    unavailable — no pricing entry for ${provider}/${model} (${tokens})`);
  }
}
