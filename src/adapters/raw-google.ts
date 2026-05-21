import type {
  AgentRuntimeAdapter,
  AgentTaskInput,
  AgentTaskResult,
  CostEstimate,
  TokenUsage,
} from './types.js';

/**
 * Raw-API adapter for Google's Gemini (generateContent endpoint, v1beta).
 *
 * Auth: `GOOGLE_API_KEY` (or `GEMINI_API_KEY` as a fallback) sent via
 * `x-goog-api-key` header — *not* the `?key=` query param, so the key
 * doesn't end up in URL-style logs.
 *
 * Base URL is overridable via `AFB_GOOGLE_BASE_URL` so users can point at
 * Vertex AI, a regional endpoint, or a test fixture without rebuilding.
 */
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export const rawGoogleAdapter: AgentRuntimeAdapter = {
  name: 'raw-google',
  async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
    const start = Date.now();
    const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return {
        taskId: input.taskId,
        ok: false,
        output: '',
        error: { type: 'auth', message: 'GOOGLE_API_KEY (or GEMINI_API_KEY) not set' },
        latencyMs: Date.now() - start,
      };
    }

    const baseUrl = process.env.AFB_GOOGLE_BASE_URL ?? DEFAULT_BASE_URL;
    const url = `${baseUrl}/models/${encodeURIComponent(input.model)}:generateContent`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
          generationConfig: {
            temperature: input.temperature ?? 0.2,
            maxOutputTokens: 1024,
          },
        }),
        signal: input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined,
      });

      if (!res.ok) {
        const body = await res.text();
        const errType = res.status === 429 ? 'rate_limited' : `http_${res.status}`;
        return {
          taskId: input.taskId,
          ok: false,
          output: '',
          error: { type: errType, message: body.slice(0, 500) },
          latencyMs: Date.now() - start,
        };
      }

      const json = (await res.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          finishReason?: string;
        }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
        };
        promptFeedback?: { blockReason?: string };
      };

      // Gemini sometimes returns no candidates (safety block, etc.) with a 200.
      if (json.promptFeedback?.blockReason) {
        return {
          taskId: input.taskId,
          ok: false,
          output: '',
          error: {
            type: 'blocked',
            message: `prompt blocked: ${json.promptFeedback.blockReason}`,
          },
          latencyMs: Date.now() - start,
        };
      }

      const text =
        json.candidates
          ?.flatMap((c) => c.content?.parts ?? [])
          .map((p) => p.text ?? '')
          .join('') ?? '';

      const usage: TokenUsage | undefined = json.usageMetadata
        ? {
            input_tokens: json.usageMetadata.promptTokenCount ?? 0,
            output_tokens: json.usageMetadata.candidatesTokenCount ?? 0,
          }
        : undefined;

      return {
        taskId: input.taskId,
        ok: true,
        output: text,
        usage,
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
  estimateCost(usage: TokenUsage): CostEstimate {
    // Placeholder fallback — central pricing table is preferred when the
    // model is known (see src/pricing/table.ts).
    const usd = (usage.input_tokens * 0.15 + usage.output_tokens * 0.6) / 1_000_000;
    return { usd, currency: 'USD' };
  },
};
