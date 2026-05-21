import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const ConfigSchema = z
  .object({
    defaults: z
      .object({
        provider: z.string().optional(),
        model: z.string().optional(),
        runtime: z.string().optional(),
        max_concurrency: z.number().int().positive().optional(),
        temperature: z.number().min(0).max(2).optional(),
        timeout_ms: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict();

export type AfbConfig = z.infer<typeof ConfigSchema>;
export type AfbDefaults = NonNullable<AfbConfig['defaults']>;

/**
 * Look for afb.config.yaml in the cwd. Returns an empty object if absent —
 * the file is optional, scenarios stay self-contained without it.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<AfbDefaults> {
  const path = resolve(cwd, 'afb.config.yaml');
  try {
    await access(path);
  } catch {
    return {};
  }

  const raw = await readFile(path, 'utf8');
  const parsed = parse(raw);
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid afb.config.yaml:\n  ${issues}`);
  }
  return result.data.defaults ?? {};
}
