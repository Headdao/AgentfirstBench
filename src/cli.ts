#!/usr/bin/env node
import { cac } from 'cac';
import { loadDotenv } from './utils/dotenv.js';
import { initCommand } from './commands/init.js';

// Load .env from cwd before any command runs so adapters see the keys.
loadDotenv();

import { doctorCommand } from './commands/doctor.js';
import { runCommand } from './commands/run.js';
import { compareCommand } from './commands/compare.js';
import { reportCommand } from './commands/report.js';
import { modelsCommand } from './commands/models.js';
import { matrixCommand } from './commands/matrix.js';
import { version } from './version.js';

const cli = cac('afb');

cli
  .command('init [dir]', 'Scaffold a new Agent First Bench project (interactive)')
  .option('--force', 'Overwrite existing files')
  .option('--yes', 'Skip prompts; use mock defaults (for CI / scripts)')
  .action(initCommand);

cli
  .command('doctor', 'Check environment, adapters, credentials, and rate limits')
  .action(doctorCommand);

cli
  .command('run <scenario>', 'Run a scenario file')
  .option('--out <dir>', 'Output directory for the run', { default: 'runs' })
  .option('--provider <name>', 'Override provider')
  .option('--model <name>', 'Override model')
  .option('--runtime <name>', 'Override runtime adapter')
  .option('--apply', 'Allow file mutations outside the run directory (off by default)')
  .option('--max-concurrency <n>', 'Override max concurrent workers')
  .action(runCommand);

cli
  .command('compare <runDirA> <runDirB>', 'Compare two run directories')
  .action(compareCommand);

cli
  .command('models', 'List all models known to the pricing table')
  .action(modelsCommand);

cli
  .command('matrix <scenario>', 'Run a scenario across multiple models and produce a comparison')
  .option('--out <dir>', 'Output directory for the matrix run', { default: 'runs' })
  .option('--models <list>', 'Comma-separated provider/model ids (skip the interactive picker)')
  .option('--max-concurrency <n>', 'Override max concurrent workers (applies to every model)')
  .option('--apply', 'Allow file mutations outside the run directory')
  .option('--yes', 'Skip the "Proceed?" confirmation')
  .action(matrixCommand);

cli
  .command('report <runDir>', 'Generate a markdown report from a run directory')
  .action(reportCommand);

cli.help();
cli.version(version);

try {
  cli.parse();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
