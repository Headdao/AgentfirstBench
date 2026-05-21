import type { AgentRuntimeAdapter, AgentTaskInput, AgentTaskResult } from './types.js';

/**
 * Deterministic offline adapter. Used by tests and `afb run` when no API
 * keys are configured — lets people kick the tires without spending money.
 */
export const mockAdapter: AgentRuntimeAdapter = {
  name: 'mock',
  async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
    const start = Date.now();
    // Simulate work: 50–200ms based on the prompt hash so it's deterministic per input.
    const jitter = hash(input.taskId + input.prompt) % 150;
    await sleep(50 + jitter);

    // Simulate ~5% failure rate based on hash.
    const fail = hash(input.taskId) % 20 === 0;
    if (fail) {
      return {
        taskId: input.taskId,
        ok: false,
        output: '',
        error: { type: 'mock_error', message: 'Simulated failure' },
        latencyMs: Date.now() - start,
      };
    }

    return {
      taskId: input.taskId,
      ok: true,
      output: `mock(${input.taskId}): processed ${input.prompt.slice(0, 32)}`,
      usage: { input_tokens: input.prompt.length, output_tokens: 64 },
      latencyMs: Date.now() - start,
    };
  },
  estimateCost() {
    return { usd: 0, currency: 'USD' };
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
