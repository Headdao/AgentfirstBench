import type { AgentRuntimeAdapter, AgentTaskInput, AgentTaskResult } from './types.js';

/**
 * Generic HTTP agent-runtime adapter.
 *
 * Lets people benchmark **their own agent runtime** without writing TypeScript:
 * point `AFB_CUSTOM_HTTP_URL` at any HTTP endpoint that implements the
 * request/response contract below, and `afb run --runtime custom-http` will
 * drive it.
 *
 * This is the adapter that makes the §18 narrative ("model + runtime, not
 * model alone") empirically testable — compare a raw-API run against the
 * same model wrapped in a real agent runtime and the overhead becomes
 * visible in `afb compare`'s sweep summary.
 *
 * Request (POST application/json):
 * {
 *   task_id: string,
 *   prompt: string,
 *   model: string,
 *   temperature?: number,
 *   timeout_ms?: number,
 *   payload?: Record<string, unknown>,
 *   network_policy: { mode: "disabled" | "adapter_only" | "allowlist"; hosts?: string[] },
 *   run_dir: string,
 *   apply: boolean
 * }
 *
 * Response (200, application/json):
 * {
 *   ok: boolean,
 *   output: string,
 *   usage?: { input_tokens: number; output_tokens: number },
 *   data?: Record<string, unknown>,
 *   error?: { type: string; message: string }
 * }
 *
 * Auth: optional bearer token via `AFB_CUSTOM_HTTP_TOKEN`.
 * Non-200 responses are treated as failures with error.type = `http_<status>`.
 */
export const customHttpAdapter: AgentRuntimeAdapter = {
  name: 'custom-http',
  runtimeClass: 'external',
  async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
    const start = Date.now();
    const url = process.env.AFB_CUSTOM_HTTP_URL;
    if (!url) {
      return {
        taskId: input.taskId,
        ok: false,
        output: '',
        error: { type: 'config', message: 'AFB_CUSTOM_HTTP_URL not set' },
        latencyMs: Date.now() - start,
      };
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (process.env.AFB_CUSTOM_HTTP_TOKEN) {
      headers.authorization = `Bearer ${process.env.AFB_CUSTOM_HTTP_TOKEN}`;
    }

    const body = JSON.stringify({
      task_id: input.taskId,
      prompt: input.prompt,
      model: input.model,
      temperature: input.temperature,
      timeout_ms: input.timeoutMs,
      payload: input.payload,
      network_policy: input.networkPolicy,
      run_dir: input.runDir,
      apply: input.apply,
    });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined,
      });

      if (!res.ok) {
        const text = await res.text();
        return {
          taskId: input.taskId,
          ok: false,
          output: '',
          error: { type: `http_${res.status}`, message: text.slice(0, 500) },
          latencyMs: Date.now() - start,
        };
      }

      const json = (await res.json()) as {
        ok?: boolean;
        output?: string;
        usage?: { input_tokens: number; output_tokens: number };
        data?: Record<string, unknown>;
        error?: { type: string; message: string };
      };

      if (json.ok === false) {
        return {
          taskId: input.taskId,
          ok: false,
          output: json.output ?? '',
          error: json.error ?? { type: 'unknown', message: 'server reported ok=false' },
          data: json.data,
          latencyMs: Date.now() - start,
        };
      }

      return {
        taskId: input.taskId,
        ok: true,
        output: json.output ?? '',
        usage: json.usage,
        data: json.data,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const type = message.includes('Timeout') ? 'timeout' : 'network';
      return {
        taskId: input.taskId,
        ok: false,
        output: '',
        error: { type, message },
        latencyMs: Date.now() - start,
      };
    }
  },
};
