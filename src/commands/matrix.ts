import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadScenario } from '../scenarios/loader.js';
import { loadConfig } from '../config/loader.js';
import { runScenario } from '../runners/runner.js';
import { getAdapter } from '../adapters/registry.js';
import { Spinner } from '../utils/spinner.js';
import { formatUsd, formatTokens } from '../utils/format.js';
import { listKnownModels, lookupPricing } from '../pricing/table.js';
import type { RunMetrics } from '../metrics/types.js';
import { renderMatrixMarkdown, renderMatrixStdout, type MatrixRow } from '../reports/matrix.js';
import { verdictForMatrix } from '../reports/verdict.js';
import { renderMarkdown } from '../reports/markdown.js';

interface MatrixOptions {
  out: string;
  models?: string;
  apply?: boolean;
  maxConcurrency?: string | number;
  yes?: boolean; // skip confirmation
}

const PROVIDER_TO_RUNTIME: Record<string, string> = {
  anthropic: 'raw-anthropic',
  openai: 'raw-openai',
  google: 'raw-google',
  mock: 'mock',
};

const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  mock: '',
};

export async function matrixCommand(scenarioPath: string, opts: MatrixOptions): Promise<void> {
  const absScenario = resolve(process.cwd(), scenarioPath);
  const scenario = await loadScenario(absScenario);
  const config = await loadConfig();

  // 1. Pick models
  const picked = opts.models ? parseModelList(opts.models) : await pickModels();
  if (picked.length === 0) {
    console.log('No models selected. Nothing to do.');
    return;
  }

  // 2. Pre-flight: validate API keys
  const missing = checkKeys(picked);
  if (missing.length > 0) {
    console.error('');
    console.error('Missing API keys for these providers:');
    for (const m of missing) console.error(`  ${m.provider}: set ${m.envVar} (or add to .env)`);
    process.exit(1);
  }

  // 3. Cost preview
  console.log('');
  console.log(`Scenario: ${scenario.name} (${scenario.tasks.length} tasks × ` +
    `${scenario.kind === 'concurrency_ramp' && scenario.concurrency_levels ? scenario.concurrency_levels.length : 1} level(s))`);
  console.log(`Models to run (${picked.length}):`);
  for (const p of picked) {
    const pricing = lookupPricing(p.provider, p.model);
    const rate = pricing ? `${formatUsd(pricing.input_per_mtok)}/${formatUsd(pricing.output_per_mtok)} per Mtok` : 'no pricing';
    const runtimeNote = p.runtimeOverride
      ? `  via ${p.runtimeOverride}`
      : `  via ${PROVIDER_TO_RUNTIME[p.provider] ?? '(no default)'}`;
    console.log(`  ${p.provider}/${p.model}${runtimeNote}  [${rate}]`);
  }

  if (!opts.yes) {
    const rl = createInterface({ input, output });
    try {
      const ans = (await rl.question('\nProceed? [Y/n]: ')).trim().toLowerCase();
      if (ans === 'n' || ans === 'no') {
        console.log('Aborted.');
        return;
      }
    } finally {
      rl.close();
    }
  }

  // 4. Run each model sequentially
  const matrixId = `matrix_${Date.now().toString(36)}`;
  const matrixDir = resolve(process.cwd(), opts.out, matrixId);
  await mkdir(matrixDir, { recursive: true });

  const rows: MatrixRow[] = [];
  for (let i = 0; i < picked.length; i++) {
    const p = picked[i];
    const runtime = p.runtimeOverride ?? PROVIDER_TO_RUNTIME[p.provider];
    if (!runtime) {
      console.error(`No runtime mapped for provider '${p.provider}'; pass an explicit @runtime suffix`);
      continue;
    }
    const adapter = getAdapter(runtime);
    if (!adapter) {
      console.error(`No adapter registered for runtime ${runtime} (provider ${p.provider})`);
      continue;
    }

    const label = p.runtimeOverride
      ? `${p.provider}/${p.model}@${runtime}`
      : `${p.provider}/${p.model}`;
    const spinner = new Spinner();
    spinner.start(`[${i + 1}/${picked.length}] ${label}…`);

    const maxConcurrency = parsePositive(opts.maxConcurrency)
      ?? scenario.max_concurrency
      ?? config.max_concurrency
      ?? 8;

    let result;
    try {
      result = await runScenario({
        scenario,
        adapter,
        outDir: matrixDir,
        provider: p.provider,
        model: p.model,
        runtime,
        maxConcurrency,
        apply: opts.apply ?? false,
        onProgress: (pr) => {
          const levelInfo = pr.totalLevels > 1
            ? ` · level ${pr.currentLevelIndex}/${pr.totalLevels} (N=${pr.currentLevel})`
            : '';
          spinner.update(`[${i + 1}/${picked.length}] ${label} · ${pr.completed + pr.failed}/${pr.total} done${levelInfo}`);
        },
      });
    } catch (err) {
      spinner.stop(`✗ ${label} crashed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const tokens = `${formatTokens(result.totalInputTokens)}/${formatTokens(result.totalOutputTokens)} tok`;
    spinner.stop(`✓ ${label} · ${result.workersCompleted}/${result.workersTotal} ok · ${formatUsd(result.totalCostUsd)} · ${tokens}`);

    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8')) as RunMetrics;
    // Mirror what `afb run` does: drop a per-model report.md alongside
    // metrics.json so users can drill into one row of the matrix without
    // re-running `afb report`.
    await writeFile(join(result.runDir, 'report.md'), renderMarkdown(metrics), 'utf8');
    rows.push({ label, metrics });
  }

  if (rows.length === 0) {
    console.error('All runs failed.');
    process.exit(1);
  }

  // 5. Render matrix report
  const md = renderMatrixMarkdown(scenario.name, rows);
  const matrixMdPath = join(matrixDir, 'matrix.md');
  await writeFile(matrixMdPath, md, 'utf8');
  await writeFile(join(matrixDir, 'matrix.json'), JSON.stringify(rows, null, 2), 'utf8');

  console.log('');
  console.log(renderMatrixStdout(rows));
  console.log('');
  console.log(verdictForMatrix(rows));
  console.log(`Matrix written to: ${matrixMdPath}`);
}

interface PickedModel {
  provider: string;
  model: string;
  /** Explicit `@runtime` suffix, or undefined → inferred from provider. */
  runtimeOverride?: string;
  /** Display key including @runtime if any (used as the matrix row label). */
  key: string;
}

/**
 * Parses entries like:
 *   anthropic/claude-sonnet-4-6                  → infer runtime from provider
 *   anthropic/claude-sonnet-4-6@raw-anthropic    → explicit
 *   anthropic/claude-sonnet-4-6@claude-code      → explicit, different runtime
 */
function parseModelList(raw: string): PickedModel[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf('@');
      const head = at >= 0 ? entry.slice(0, at) : entry;
      const runtimeOverride = at >= 0 ? entry.slice(at + 1).trim() : undefined;
      const slash = head.indexOf('/');
      if (slash < 1) {
        console.error(
          `Invalid model id: ${JSON.stringify(entry)} (expected "provider/model" or "provider/model@runtime")`,
        );
        process.exit(2);
      }
      if (at >= 0 && (!runtimeOverride || runtimeOverride.length === 0)) {
        console.error(
          `Invalid model id: ${JSON.stringify(entry)} (empty runtime after "@")`,
        );
        process.exit(2);
      }
      return {
        provider: head.slice(0, slash),
        model: head.slice(slash + 1),
        runtimeOverride,
        key: entry,
      };
    });
}

async function pickModels(): Promise<PickedModel[]> {
  const all = listKnownModels();
  console.log('Pick models to compare:');
  all.forEach((key, i) => {
    const slash = key.indexOf('/');
    const provider = key.slice(0, slash);
    const model = key.slice(slash + 1);
    const p = lookupPricing(provider, model)!;
    console.log(`  ${(i + 1).toString().padStart(2)}. ${key.padEnd(38)} ${formatUsd(p.input_per_mtok)}/${formatUsd(p.output_per_mtok)} Mtok`);
  });
  console.log('');
  console.log('Enter numbers separated by comma (e.g. "1,3,5") or "all".');

  const rl = createInterface({ input, output });
  try {
    const ans = (await rl.question('Selection: ')).trim();
    if (!ans) return [];
    let picks: string[];
    if (ans.toLowerCase() === 'all') {
      picks = all;
    } else {
      const indices = ans.split(',').map((s) => parseInt(s.trim(), 10) - 1);
      picks = indices
        .filter((i) => Number.isInteger(i) && i >= 0 && i < all.length)
        .map((i) => all[i]);
    }
    return parseModelList(picks.join(','));
  } finally {
    rl.close();
  }
}

function checkKeys(picked: PickedModel[]): Array<{ provider: string; envVar: string }> {
  const seen = new Set<string>();
  const missing: Array<{ provider: string; envVar: string }> = [];
  for (const p of picked) {
    const envVar = PROVIDER_KEY_ENV[p.provider];
    if (!envVar) continue; // mock
    if (seen.has(p.provider)) continue;
    seen.add(p.provider);
    // raw-google falls back to GEMINI_API_KEY too.
    if (p.provider === 'google' && !process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY) {
      missing.push({ provider: p.provider, envVar: 'GOOGLE_API_KEY (or GEMINI_API_KEY)' });
    } else if (p.provider !== 'google' && !process.env[envVar]) {
      missing.push({ provider: p.provider, envVar });
    }
  }
  return missing;
}

function parsePositive(raw: string | number | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
