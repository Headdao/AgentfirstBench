import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';

describe('config loader', () => {
  it('returns empty defaults when afb.config.yaml is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afb-cfg-'));
    const defaults = await loadConfig(dir);
    expect(defaults).toEqual({});
  });

  it('parses defaults from afb.config.yaml', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afb-cfg-'));
    await writeFile(
      join(dir, 'afb.config.yaml'),
      `defaults:\n  provider: anthropic\n  model: claude-sonnet-4-6\n  max_concurrency: 4\n`,
      'utf8',
    );
    const defaults = await loadConfig(dir);
    expect(defaults.provider).toBe('anthropic');
    expect(defaults.model).toBe('claude-sonnet-4-6');
    expect(defaults.max_concurrency).toBe(4);
  });

  it('rejects unknown top-level keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afb-cfg-'));
    await writeFile(join(dir, 'afb.config.yaml'), `bogus: true\n`, 'utf8');
    await expect(loadConfig(dir)).rejects.toThrow(/Invalid afb.config.yaml/);
  });
});
