import { listAdapters } from '../adapters/registry.js';

export async function doctorCommand(): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  checks.push({
    name: 'Node version',
    ok: parseInt(process.versions.node.split('.')[0], 10) >= 20,
    detail: `node ${process.versions.node} (requires >= 20)`,
  });

  const adapters = listAdapters();
  checks.push({
    name: 'Registered adapters',
    ok: adapters.length > 0,
    detail: adapters.join(', ') || '(none)',
  });

  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY']) {
    checks.push({
      name: `env: ${name}`,
      ok: !!process.env[name],
      detail: process.env[name] ? 'set' : 'not set',
    });
  }

  let allOk = true;
  for (const c of checks) {
    const mark = c.ok ? 'OK' : '--';
    console.log(`[${mark}] ${c.name}: ${c.detail}`);
    if (!c.ok && c.name.startsWith('Node')) allOk = false;
  }

  if (!allOk) {
    process.exit(1);
  }
}
