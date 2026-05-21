import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Black-box tests for the `--models provider/model@runtime` syntax added
 * in Phase 2. Calls the built CLI binary so we exercise the real parse
 * + dispatch path, not a unit-tested-in-isolation parser.
 *
 * Uses the mock runtimes (no network, no API key) so this is offline.
 */

const cli = join(process.cwd(), 'dist', 'cli.js');

function runCli(args: string[], cwd: string): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync('node', [cli, ...args], {
      cwd,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      code: e.status ?? -1,
    };
  }
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'afb-matrix-'));
  mkdirSync(join(dir, 'scenarios'));
  writeFileSync(
    join(dir, 'scenarios', 'tiny.yaml'),
    [
      'name: tiny',
      'kind: research_synthesis',
      'max_concurrency: 1',
      'tasks:',
      '  - { id: t1, prompt: "say hi" }',
    ].join('\n'),
  );
  return dir;
}

describe('matrix --models @runtime suffix', () => {
  it('runs two rows of the same provider/model with different runtimes', () => {
    const project = makeProject();
    const r = runCli(
      [
        'matrix',
        'scenarios/tiny.yaml',
        '--models',
        'mock/mock-model@mock,mock/mock-model@mock-coordinator',
        '--yes',
        '--out',
        'runs',
      ],
      project,
    );
    expect(r.code).toBe(0);
    // Both rows present in stdout summary table.
    expect(r.stdout).toMatch(/mock\/mock-model@mock\b/);
    expect(r.stdout).toMatch(/mock\/mock-model@mock-coordinator\b/);

    // matrix.json should reflect different runtimes per row.
    const subdir = readdirSync(join(project, 'runs')).find((d) => d.startsWith('matrix_'));
    expect(subdir).toBeTruthy();
    const matrix = JSON.parse(
      readFileSync(join(project, 'runs', subdir!, 'matrix.json'), 'utf8'),
    ) as Array<{ label: string; metrics: { runtime: string; runtime_class: string } }>;
    expect(matrix).toHaveLength(2);
    expect(matrix[0].metrics.runtime).toBe('mock');
    expect(matrix[1].metrics.runtime).toBe('mock-coordinator');
    expect(matrix[0].metrics.runtime_class).toBe('raw_model_baseline');
    expect(matrix[1].metrics.runtime_class).toBe('coordinator_enabled');
  });

  it('plain provider/model still works (back-compat — infers runtime)', () => {
    const project = makeProject();
    const r = runCli(
      ['matrix', 'scenarios/tiny.yaml', '--models', 'mock/mock-model', '--yes', '--out', 'runs'],
      project,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/mock\/mock-model\b/);
  });

  it('rejects empty runtime after @', () => {
    const project = makeProject();
    const r = runCli(
      ['matrix', 'scenarios/tiny.yaml', '--models', 'mock/mock-model@', '--yes', '--out', 'runs'],
      project,
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/empty runtime after "@"/);
  });
});
