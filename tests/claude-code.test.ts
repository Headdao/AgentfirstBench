import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import type { AgentTaskInput } from '../src/adapters/types.js';

/**
 * Minimal stand-in for ChildProcessWithoutNullStreams. The adapter only
 * uses .stdout / .stderr (data events), .on('error'/'close'), and .kill.
 */
function makeFakeChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
  error?: Error;
  hang?: boolean; // never emits close — caller must kill
}): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {
    proc.emit('close', -1);
  };

  setTimeout(() => {
    if (opts.error) {
      proc.emit('error', opts.error);
      return;
    }
    if (opts.stdout) (proc.stdout as EventEmitter).emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) (proc.stderr as EventEmitter).emit('data', Buffer.from(opts.stderr));
    if (!opts.hang) proc.emit('close', opts.exitCode ?? 0);
  }, opts.delayMs ?? 0);

  return proc;
}

const baseInput: AgentTaskInput = {
  taskId: 't1',
  prompt: 'hello',
  model: 'claude-sonnet-4-6',
  temperature: 0.2,
  networkPolicy: { mode: 'disabled' },
  runDir: '/tmp/fake',
  apply: false,
};

describe('claude-code adapter', () => {
  it('parses successful JSON result into ok=true', async () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'the answer',
      session_id: 'sess-123',
      duration_ms: 42,
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    const adapter = createClaudeCodeAdapter({
      spawnFn: () => makeFakeChild({ stdout: json, exitCode: 0 }) as never,
    });
    const r = await adapter.runTask(baseInput);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('the answer');
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
    expect(r.data).toMatchObject({ session_id: 'sess-123', cli_reported_duration_ms: 42 });
  });

  it('returns cli_not_found when binary is missing (ENOENT)', async () => {
    const err = new Error('spawn claude ENOENT') as Error & { code?: string };
    err.code = 'ENOENT';
    const adapter = createClaudeCodeAdapter({
      spawnFn: () => makeFakeChild({ error: err }) as never,
    });
    const r = await adapter.runTask(baseInput);
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('cli_not_found');
  });

  it('returns cli_crashed on non-zero exit without JSON', async () => {
    const adapter = createClaudeCodeAdapter({
      spawnFn: () => makeFakeChild({ stderr: 'something broke', exitCode: 2 }) as never,
    });
    const r = await adapter.runTask(baseInput);
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('cli_crashed');
  });

  it('maps "api key" stderr to auth failure', async () => {
    const adapter = createClaudeCodeAdapter({
      spawnFn: () => makeFakeChild({ stderr: 'Error: missing API key', exitCode: 1 }) as never,
    });
    const r = await adapter.runTask(baseInput);
    expect(r.error?.type).toBe('auth');
  });

  it('maps "rate limit" stderr to rate_limited', async () => {
    const adapter = createClaudeCodeAdapter({
      spawnFn: () => makeFakeChild({ stderr: 'Error: rate limit exceeded', exitCode: 1 }) as never,
    });
    const r = await adapter.runTask(baseInput);
    expect(r.error?.type).toBe('rate_limited');
  });

  it('returns cli_parse on exit 0 with unparseable stdout', async () => {
    const adapter = createClaudeCodeAdapter({
      spawnFn: () => makeFakeChild({ stdout: 'not json at all', exitCode: 0 }) as never,
    });
    const r = await adapter.runTask(baseInput);
    expect(r.error?.type).toBe('cli_parse');
  });

  it('parses the last JSON line when stdout has noise above it', async () => {
    const stdout = 'some preamble\n{"type":"result","is_error":false,"result":"ok"}';
    const adapter = createClaudeCodeAdapter({
      spawnFn: () => makeFakeChild({ stdout, exitCode: 0 }) as never,
    });
    const r = await adapter.runTask(baseInput);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('ok');
  });

  it('honors timeoutMs by killing the child', async () => {
    const adapter = createClaudeCodeAdapter({
      spawnFn: () => makeFakeChild({ hang: true }) as never,
    });
    const r = await adapter.runTask({ ...baseInput, timeoutMs: 50 });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('timeout');
  });

  it('surfaces is_error=true with subtype mapping', async () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'rate_limited',
      is_error: true,
    });
    const adapter = createClaudeCodeAdapter({
      spawnFn: () => makeFakeChild({ stdout: json, exitCode: 0 }) as never,
    });
    const r = await adapter.runTask(baseInput);
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('rate_limited');
  });

  it('declares runtimeClass=agent_runtime', () => {
    const adapter = createClaudeCodeAdapter({ spawnFn: () => undefined as never });
    expect(adapter.runtimeClass).toBe('agent_runtime');
    expect(adapter.name).toBe('claude-code');
  });
});
