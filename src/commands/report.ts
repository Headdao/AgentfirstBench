import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { renderMarkdown } from '../reports/markdown.js';

export async function reportCommand(runDir: string): Promise<void> {
  const abs = resolve(process.cwd(), runDir);
  const metrics = JSON.parse(await readFile(join(abs, 'metrics.json'), 'utf8'));
  const md = renderMarkdown(metrics);
  const out = join(abs, 'report.md');
  await writeFile(out, md, 'utf8');
  console.log(`Wrote ${out}`);
}
