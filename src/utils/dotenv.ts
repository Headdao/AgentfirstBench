import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Tiny .env loader. No `dotenv` dependency — we don't need the kitchen
 * sink (multiline values, expansion, etc.). Just KEY=VALUE per line,
 * optional quotes, comments starting with `#`.
 *
 * Already-set env vars are NOT overwritten so the user's shell still wins.
 */
export function loadDotenv(cwd: string = process.cwd(), filename = '.env'): void {
  const path = resolve(cwd, filename);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // .env is optional
  }
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding single or double quotes if balanced.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
