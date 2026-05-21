import { mkdir, writeFile, readFile, access, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

interface InitOptions {
  force?: boolean;
  yes?: boolean; // skip prompts; non-interactive setup
}

interface ProviderChoice {
  key: string;
  label: string;
  envVar: string;
  runtime: string;
  defaultModel: string;
  signupUrl: string;
}

const PROVIDERS: ProviderChoice[] = [
  {
    key: 'google',
    label: 'Google Gemini',
    envVar: 'GOOGLE_API_KEY',
    runtime: 'raw-google',
    defaultModel: 'gemini-3.5-flash',
    signupUrl: 'https://aistudio.google.com/app/apikey',
  },
  {
    key: 'anthropic',
    label: 'Anthropic Claude',
    envVar: 'ANTHROPIC_API_KEY',
    runtime: 'raw-anthropic',
    defaultModel: 'claude-sonnet-4-6',
    signupUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    runtime: 'raw-openai',
    defaultModel: 'gpt-5.4-mini',
    signupUrl: 'https://platform.openai.com/api-keys',
  },
  {
    key: 'mock',
    label: 'Mock (offline, no key needed — recommended for first try)',
    envVar: '',
    runtime: 'mock',
    defaultModel: 'mock-model',
    signupUrl: '',
  },
];

const CONFIG_TEMPLATE = (provider: string, model: string, runtime: string): string =>
  `# Agent First Bench configuration
# Edit to change defaults; CLI flags still override per-run.

defaults:
  provider: ${provider}
  model: ${model}
  runtime: ${runtime}
  max_concurrency: 8
  temperature: 0.2
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

  // Interactive setup unless the user passed --yes (CI / scripted use).
  const choice = opts.yes ? PROVIDERS[3] : await promptProvider();
  if (!opts.yes && choice.envVar) {
    await promptAndWriteApiKey(target, choice);
  }

  await writeFile(configPath, CONFIG_TEMPLATE(choice.key, choice.defaultModel, choice.runtime), 'utf8');

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

  // Ensure .env (if we wrote one) is gitignored.
  await ensureGitignoreLine(target, '.env');

  console.log('');
  console.log(`✓ Initialized at ${target}`);
  console.log('');
  console.log('Next:');
  if (choice.key === 'mock') {
    console.log(`  afb run scenarios/research_synthesis.yaml`);
  } else {
    console.log(`  afb run scenarios/research_synthesis.yaml --runtime ${choice.runtime}`);
  }
}

async function promptProvider(): Promise<ProviderChoice> {
  const rl = createInterface({ input, output });
  try {
    console.log('');
    console.log('Pick a provider (you can change later in afb.config.yaml):');
    PROVIDERS.forEach((p, i) => console.log(`  ${i + 1}. ${p.label}`));
    while (true) {
      const ans = (await rl.question('\nChoice [1]: ')).trim() || '1';
      const idx = parseInt(ans, 10);
      if (Number.isInteger(idx) && idx >= 1 && idx <= PROVIDERS.length) {
        return PROVIDERS[idx - 1];
      }
      console.log('Please enter a number from the list.');
    }
  } finally {
    rl.close();
  }
}

async function promptAndWriteApiKey(target: string, choice: ProviderChoice): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    console.log('');
    console.log(`Get a ${choice.label} API key here:`);
    console.log(`  ${choice.signupUrl}`);
    const key = (await rl.question(`Paste ${choice.envVar} (or press Enter to skip): `)).trim();
    if (!key) {
      console.log(`(skipped — set ${choice.envVar} in your shell or .env later)`);
      return;
    }
    const envPath = join(target, '.env');
    const line = `${choice.envVar}=${key}\n`;
    if (await exists(envPath)) {
      const existing = await readFile(envPath, 'utf8');
      if (existing.split('\n').some((l) => l.startsWith(`${choice.envVar}=`))) {
        console.log(`(${choice.envVar} already in .env; not overwriting)`);
        return;
      }
      await appendFile(envPath, line, 'utf8');
    } else {
      await writeFile(envPath, line, 'utf8');
    }
    console.log(`✓ Wrote ${choice.envVar} to .env`);
  } finally {
    rl.close();
  }
}

async function ensureGitignoreLine(target: string, line: string): Promise<void> {
  const gi = join(target, '.gitignore');
  let current = '';
  try {
    current = await readFile(gi, 'utf8');
  } catch {
    // no .gitignore yet
  }
  if (current.split('\n').some((l) => l.trim() === line)) return;
  const updated = (current.endsWith('\n') || current === '' ? current : current + '\n') + line + '\n';
  await writeFile(gi, updated, 'utf8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
