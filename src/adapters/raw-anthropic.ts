import type {
  AgentRuntimeAdapter,
  AgentTaskInput,
  AgentTaskResult,
  CostEstimate,
  TokenUsage,
} from './types.js';

/**
 * Minimal raw-API adapter for Anthropic Messages.
 *
 * Skeleton only — the SDK is intentionally not imported so that `afb` can be
 * installed without pulling provider SDKs. Replace the fetch call with the
 * official SDK in a downstream package, or keep the raw HTTP version if you
 * want zero transitive deps.
 */
export const rawAnthropicAdapter: AgentRuntimeAdapter = {
  name: 'raw-anthropic',
  runtimeClass: 'raw_model_baseline',
  async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
    const start = Date.now();
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        taskId: input.taskId,
        ok: false,
        output: '',
        error: { type: 'auth', message: 'ANTHROPIC_API_KEY not set' },
        latencyMs: Date.now() - start,
      };
    }

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: 1024,
          temperature: input.temperature ?? 0.2,
          messages: [{ role: 'user', content: input.prompt }],
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
        content: Array<{ type: string; text?: string }>;
        usage?: { input_tokens: number; output_tokens: number };
      };
      const text = json.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');

      return {
        taskId: input.taskId,
        ok: true,
        output: text,
        usage: json.usage,
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
    // Placeholder pricing — replace with model-specific rates.
    const usd = (usage.input_tokens * 3 + usage.output_tokens * 15) / 1_000_000;
    return { usd, currency: 'USD' };
  },
};
