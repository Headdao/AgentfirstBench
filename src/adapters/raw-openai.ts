import type {
  AgentRuntimeAdapter,
  AgentTaskInput,
  AgentTaskResult,
  CostEstimate,
  TokenUsage,
} from './types.js';

/**
 * Minimal raw-API adapter for OpenAI Chat Completions.
 *
 * Mirrors `raw-anthropic` in shape so the interface assumption — "an agent
 * runtime is something that takes a prompt and returns text + usage" —
 * holds across providers. Replace the fetch call with the official SDK
 * downstream if desired.
 */
export const rawOpenAIAdapter: AgentRuntimeAdapter = {
  name: 'raw-openai',
  async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
    const start = Date.now();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        taskId: input.taskId,
        ok: false,
        output: '',
        error: { type: 'auth', message: 'OPENAI_API_KEY not set' },
        latencyMs: Date.now() - start,
      };
    }

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: input.model,
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
        choices: Array<{ message: { content: string | null } }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };
      const text = json.choices.map((c) => c.message.content ?? '').join('');

      const usage: TokenUsage | undefined = json.usage
        ? {
            input_tokens: json.usage.prompt_tokens,
            output_tokens: json.usage.completion_tokens,
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
    // Placeholder pricing — replace with model-specific rates.
    const usd = (usage.input_tokens * 0.5 + usage.output_tokens * 1.5) / 1_000_000;
    return { usd, currency: 'USD' };
  },
};
