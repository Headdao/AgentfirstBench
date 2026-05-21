import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface InitOptions {
  force?: boolean;
}

const CONFIG_TEMPLATE = `# Agent First Bench configuration
# See https://github.com/anthropics/agent-first-bench

defaults:
  provider: anthropic
  model: claude-sonnet-4-6
  runtime: raw-anthropic
  max_concurrency: 8
  temperature: 0.2

# scenarios are loaded from ./scenarios/*.yaml by default
`;

export async function initCommand(dir: string | undefined, opts: InitOptions): Promise<void> {
  const target = resolve(process.cwd(), dir ?? '.');
  await mkdir(target, { recursive: true });
  await mkdir(join(target, 'scenarios'), { recursive: true });
  await mkdir(join(target, 'runs'), { recursive: true });

  const configPath = join(target, 'afb.config.yaml');
  if (!opts.force && (await exists(configPath))) {
    console.error(`afb.config.yaml already exists. Use --force to overwrite.`);
    process.exit(1);
  }
  await writeFile(configPath, CONFIG_TEMPLATE, 'utf8');

  // Copy bundled sample scenarios alongside the user's project.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const bundled = resolve(here, '..', '..', 'scenarios');
  for (const name of ['research_synthesis.yaml', 'concurrency_ramp.yaml', 'failure_containment.yaml']) {
    try {
      const contents = await readFile(join(bundled, name), 'utf8');
      const dest = join(target, 'scenarios', name);
      if (opts.force || !(await exists(dest))) {
        await writeFile(dest, contents, 'utf8');
      }
    } catch {
      // Bundled scenarios not found (running from source without install) — skip.
    }
  }

  console.log(`Initialized Agent First Bench project at ${target}`);
  console.log(`Next: afb doctor && afb run scenarios/research_synthesis.yaml`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
