#!/usr/bin/env node
// Tiny reference server for the `custom-http` adapter.
//
// Usage:
//   node examples/echo-server.mjs &
//   AFB_CUSTOM_HTTP_URL=http://localhost:8787 afb run scenarios/concurrency_ramp.yaml --runtime custom-http
//
// Replace the `handle(req)` body with whatever your agent runtime does.
// The contract is documented in src/adapters/custom-http.ts.

import { createServer } from 'node:http';

const PORT = parseInt(process.env.PORT ?? '8787', 10);

async function handle(req) {
  // Echo the prompt back as the "output" — replace with your runtime here.
  return {
    ok: true,
    output: `echo: ${req.prompt.slice(0, 80)}`,
    usage: {
      input_tokens: req.prompt.length,
      output_tokens: 32,
    },
  };
}

const server = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  try {
    const result = await handle(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { type: 'server', message: String(err) } }));
  }
});

server.listen(PORT, () => {
  console.log(`echo-server listening on http://localhost:${PORT}`);
});
