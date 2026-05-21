import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rawGoogleAdapter } from '../src/adapters/raw-google.js';
import type { AgentTaskInput } from '../src/adapters/types.js';

interface Harness {
  baseUrl: string;
  lastRequest: { method: string; url: string; headers: Record<string, string>; body: unknown };
  setResponder: (fn: (body: unknown) => { status?: number; body: unknown }) => void;
  close: () => Promise<void>;
}

function startServer(): Promise<Harness> {
  return new Promise((resolve) => {
    const h: Partial<Harness> = {};
    let responder: (body: unknown) => { status?: number; body: unknown } = () => ({
      status: 200,
      body: {
        candidates: [{ content: { parts: [{ text: 'gemini says hi' }], role: 'model' } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 13 },
      },
    });

    const server: Server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const bodyText = Buffer.concat(chunks).toString('utf8');
      h.lastRequest = {
        method: req.method!,
        url: req.url!,
        headers: req.headers as Record<string, string>,
        body: bodyText ? JSON.parse(bodyText) : null,
      };
      const r = responder(h.lastRequest.body);
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });

    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      h.baseUrl = `http://127.0.0.1:${addr.port}/v1beta`;
      h.setResponder = (fn) => {
        responder = fn;
      };
      h.close = () =>
        new Promise<void>((r) => {
          server.close(() => r());
        });
      resolve(h as Harness);
    });
  });
}

const baseInput: AgentTaskInput = {
  taskId: 't1',
  prompt: 'hello gemini',
  model: 'gemini-3.5-flash',
  temperature: 0.2,
  networkPolicy: { mode: 'disabled' },
  runDir: '/tmp/fake',
  apply: false,
};

describe('raw-google adapter', () => {
  let server: Harness;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    server = await startServer();
    saved.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    saved.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    saved.AFB_GOOGLE_BASE_URL = process.env.AFB_GOOGLE_BASE_URL;
    process.env.AFB_GOOGLE_BASE_URL = server.baseUrl;
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await server.close();
  });

  it('returns auth failure when no API key is set', async () => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const r = await rawGoogleAdapter.runTask(baseInput);
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('auth');
  });

  it('sends the API key as x-goog-api-key header (not query param)', async () => {
    process.env.GOOGLE_API_KEY = 'test-key-12345';
    await rawGoogleAdapter.runTask(baseInput);
    expect(server.lastRequest.headers['x-goog-api-key']).toBe('test-key-12345');
    expect(server.lastRequest.url).not.toContain('test-key-12345');
    expect(server.lastRequest.url).toContain(':generateContent');
  });

  it('falls back to GEMINI_API_KEY when GOOGLE_API_KEY is absent', async () => {
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = 'gemini-fallback';
    await rawGoogleAdapter.runTask(baseInput);
    expect(server.lastRequest.headers['x-goog-api-key']).toBe('gemini-fallback');
  });

  it('parses candidates + usageMetadata into ok result', async () => {
    process.env.GOOGLE_API_KEY = 'k';
    const r = await rawGoogleAdapter.runTask(baseInput);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('gemini says hi');
    expect(r.usage).toEqual({ input_tokens: 7, output_tokens: 13 });
  });

  it('encodes the model name into the URL path', async () => {
    process.env.GOOGLE_API_KEY = 'k';
    await rawGoogleAdapter.runTask({ ...baseInput, model: 'gemini-3.5-flash' });
    expect(server.lastRequest.url).toContain('/models/gemini-3.5-flash:generateContent');
  });

  it('returns rate_limited on 429', async () => {
    process.env.GOOGLE_API_KEY = 'k';
    server.setResponder(() => ({ status: 429, body: { error: { message: 'slow down' } } }));
    const r = await rawGoogleAdapter.runTask(baseInput);
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('rate_limited');
  });

  it('returns http_<status> on other non-200 codes', async () => {
    process.env.GOOGLE_API_KEY = 'k';
    server.setResponder(() => ({ status: 500, body: { error: { message: 'oops' } } }));
    const r = await rawGoogleAdapter.runTask(baseInput);
    expect(r.error?.type).toBe('http_500');
  });

  it('surfaces safety blocks as ok=false with type=blocked', async () => {
    process.env.GOOGLE_API_KEY = 'k';
    server.setResponder(() => ({
      body: { promptFeedback: { blockReason: 'SAFETY' } },
    }));
    const r = await rawGoogleAdapter.runTask(baseInput);
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('blocked');
  });

  it('estimateCost returns a non-negative USD figure', () => {
    const cost = rawGoogleAdapter.estimateCost!({ input_tokens: 1000, output_tokens: 500 });
    expect(cost.usd).toBeGreaterThan(0);
    expect(cost.currency).toBe('USD');
  });
});
