import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { customHttpAdapter } from '../src/adapters/custom-http.js';
import type { AgentTaskInput } from '../src/adapters/types.js';

interface ServerHarness {
  url: string;
  lastRequest: unknown;
  setResponder: (
    fn: (req: Record<string, unknown>) => { status?: number; body: unknown },
  ) => void;
  close: () => Promise<void>;
}

function startServer(): Promise<ServerHarness> {
  return new Promise((resolve) => {
    const harness: Partial<ServerHarness> = {};
    let responder: (req: Record<string, unknown>) => { status?: number; body: unknown } = (
      req,
    ) => ({
      status: 200,
      body: {
        ok: true,
        output: `echo: ${(req.prompt as string).slice(0, 30)}`,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });

    const server: Server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      harness.lastRequest = body;
      const r = responder(body);
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });

    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      harness.url = `http://127.0.0.1:${addr.port}`;
      harness.setResponder = (fn) => {
        responder = fn;
      };
      harness.close = () =>
        new Promise((r) => {
          server.close(() => r());
        });
      resolve(harness as ServerHarness);
    });
  });
}

const baseInput: AgentTaskInput = {
  taskId: 't1',
  prompt: 'hello custom-http',
  model: 'test-model',
  temperature: 0.2,
  networkPolicy: { mode: 'disabled' },
  runDir: '/tmp/fake-run-dir',
  apply: false,
};

describe('custom-http adapter', () => {
  let server: ServerHarness;
  let prevUrl: string | undefined;
  let prevTok: string | undefined;

  beforeAll(async () => {
    server = await startServer();
    prevUrl = process.env.AFB_CUSTOM_HTTP_URL;
    prevTok = process.env.AFB_CUSTOM_HTTP_TOKEN;
    process.env.AFB_CUSTOM_HTTP_URL = server.url;
  });

  afterAll(async () => {
    if (prevUrl === undefined) delete process.env.AFB_CUSTOM_HTTP_URL;
    else process.env.AFB_CUSTOM_HTTP_URL = prevUrl;
    if (prevTok === undefined) delete process.env.AFB_CUSTOM_HTTP_TOKEN;
    else process.env.AFB_CUSTOM_HTTP_TOKEN = prevTok;
    await server.close();
  });

  it('returns ok=false when URL is missing', async () => {
    const url = process.env.AFB_CUSTOM_HTTP_URL;
    delete process.env.AFB_CUSTOM_HTTP_URL;
    try {
      const r = await customHttpAdapter.runTask(baseInput);
      expect(r.ok).toBe(false);
      expect(r.error?.type).toBe('config');
    } finally {
      process.env.AFB_CUSTOM_HTTP_URL = url;
    }
  });

  it('POSTs the documented contract fields', async () => {
    await customHttpAdapter.runTask(baseInput);
    const req = server.lastRequest as Record<string, unknown>;
    expect(req.task_id).toBe('t1');
    expect(req.prompt).toBe('hello custom-http');
    expect(req.model).toBe('test-model');
    expect(req.temperature).toBe(0.2);
    expect(req.network_policy).toEqual({ mode: 'disabled' });
    expect(req.run_dir).toBe('/tmp/fake-run-dir');
    expect(req.apply).toBe(false);
  });

  it('returns ok=true with the server output and usage', async () => {
    const r = await customHttpAdapter.runTask(baseInput);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('echo:');
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('treats non-200 responses as failures with http_<status>', async () => {
    server.setResponder(() => ({ status: 503, body: { msg: 'overloaded' } }));
    const r = await customHttpAdapter.runTask(baseInput);
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('http_503');
  });

  it('treats ok=false in body as a failure with the server-supplied error', async () => {
    server.setResponder(() => ({
      body: {
        ok: false,
        error: { type: 'tool_failed', message: 'boom' },
      },
    }));
    const r = await customHttpAdapter.runTask(baseInput);
    expect(r.ok).toBe(false);
    expect(r.error).toEqual({ type: 'tool_failed', message: 'boom' });
  });

  it('sends bearer token when AFB_CUSTOM_HTTP_TOKEN is set', async () => {
    process.env.AFB_CUSTOM_HTTP_TOKEN = 'secret-xyz';
    let seenAuth: string | undefined;
    server.setResponder((req) => {
      // capture the auth header via a follow-up request inspection
      return { body: { ok: true, output: 'ok' } };
    });
    // Re-server the auth check via a fresh wrapper request
    const { createServer } = await import('node:http');
    const wrap = createServer((req, res) => {
      seenAuth = req.headers['authorization'] ?? undefined;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, output: 'auth-test' }));
    });
    await new Promise<void>((r) => wrap.listen(0, () => r()));
    const wrapAddr = wrap.address() as AddressInfo;
    const wrapUrl = `http://127.0.0.1:${wrapAddr.port}`;
    const prev = process.env.AFB_CUSTOM_HTTP_URL;
    process.env.AFB_CUSTOM_HTTP_URL = wrapUrl;
    try {
      await customHttpAdapter.runTask(baseInput);
      expect(seenAuth).toBe('Bearer secret-xyz');
    } finally {
      process.env.AFB_CUSTOM_HTTP_URL = prev;
      await new Promise<void>((r) => wrap.close(() => r()));
      delete process.env.AFB_CUSTOM_HTTP_TOKEN;
    }
  });
});
