import { listKnownModels, lookupPricing } from '../pricing/table.js';
import { formatUsd } from '../utils/format.js';

const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  mock: '',
};

export async function modelsCommand(): Promise<void> {
  const all = listKnownModels();
  const byProvider = new Map<string, Array<{ id: string; model: string }>>();
  for (const key of all) {
    const slash = key.indexOf('/');
    const provider = key.slice(0, slash);
    const model = key.slice(slash + 1);
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider)!.push({ id: key, model });
  }

  console.log('Models known to the pricing table (use any of these with `afb matrix`):');
  for (const [provider, entries] of byProvider) {
    const envVar = PROVIDER_KEY_ENV[provider];
    const keyStatus = envVar ? (process.env[envVar] ? 'set' : 'NOT SET') : 'no key needed';
    console.log(`\n  ${provider}  (${envVar || 'mock'}: ${keyStatus})`);
    for (const e of entries) {
      const p = lookupPricing(provider, e.model)!;
      const rate = `${formatUsd(p.input_per_mtok)} in / ${formatUsd(p.output_per_mtok)} out per Mtok`;
      console.log(`    ${e.id.padEnd(40)}  ${rate}`);
    }
  }
  console.log('');
  console.log('Pricing as recorded in src/pricing/table.ts — verify against vendor pages before billing.');
}
