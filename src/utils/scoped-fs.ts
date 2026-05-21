import { writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';

/**
 * Safety §13: file mutations may only happen inside the run directory.
 *
 * Adapters that produce files MUST go through this helper rather than the
 * raw `fs` module. The helper resolves the target path and throws if it
 * escapes the run directory (including via `..` traversal or absolute
 * paths). It's not a sandbox — a malicious adapter could just `import
 * fs/promises` directly — but it makes the policy auditable and the
 * default-correct path easy.
 */
export interface ScopedFS {
  readonly runDir: string;
  resolve(relPath: string): string;
  writeFile(relPath: string, contents: string | Uint8Array): Promise<void>;
  appendFile(relPath: string, contents: string | Uint8Array): Promise<void>;
  mkdir(relPath: string): Promise<void>;
}

export class ScopeViolationError extends Error {
  constructor(path: string, runDir: string) {
    super(`Refusing to write outside run directory: ${path} (run dir: ${runDir})`);
    this.name = 'ScopeViolationError';
  }
}

export function createScopedFS(runDir: string): ScopedFS {
  const root = resolve(runDir);

  const guard = (relPath: string): string => {
    const target = isAbsolute(relPath) ? resolve(relPath) : resolve(root, relPath);
    const rel = relative(root, target);
    if (rel === '' || rel.startsWith('..') || rel.split(sep)[0] === '..') {
      throw new ScopeViolationError(target, root);
    }
    return target;
  };

  return {
    runDir: root,
    resolve: guard,
    async writeFile(relPath, contents) {
      const target = guard(relPath);
      await writeFile(target, contents);
    },
    async appendFile(relPath, contents) {
      const target = guard(relPath);
      await appendFile(target, contents);
    },
    async mkdir(relPath) {
      const target = guard(relPath);
      await mkdir(target, { recursive: true });
    },
  };
}
