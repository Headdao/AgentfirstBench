import type {
  AgentRuntimeAdapter,
  AgentTaskInput,
  AgentTaskResult,
} from './types.js';

/**
 * Deterministic offline adapter for v0.2 orchestration testing.
 *
 * The runner drives orchestration by calling adapter.runTask with three
 * different prompt shapes (coordinator → workers → merge). This adapter
 * inspects the prompt and returns an appropriate canned response:
 *
 *   - Looks like a coordinator prompt → returns `{"subtopics":[...]}` JSON
 *   - Looks like a worker prompt      → returns a short summary
 *   - Looks like a merge prompt       → returns a brief synthesis
 *
 * The heuristic is keyword-based and fragile by design; that's the point.
 * It lets us build and test the orchestration runner without depending
 * on a real agent runtime. Phase 2 replaces it with `claude-code`.
 *
 * Configurable simulated coordination tax via env vars (no-op if unset):
 *   AFB_MOCK_COORDINATOR_LATENCY_MS  — extra delay before coordinator response
 *   AFB_MOCK_MERGE_LATENCY_MS        — extra delay before merge response
 *
 * Useful for showing how coordination overhead changes the
 * coordination_overhead_pct metric across different runtimes.
 */
export const mockCoordinatorAdapter: AgentRuntimeAdapter = {
  name: 'mock-coordinator',
  async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
    const start = Date.now();
    const promptLower = input.prompt.toLowerCase();

    let output: string;
    let extraDelay = 0;

    if (promptLower.includes('subtopics') && promptLower.includes('json')) {
      // Coordinator step: derive subtopics from the topic in the prompt.
      // The topic is whatever follows "Topic:".
      const topicMatch = input.prompt.match(/Topic:\s*"?([^"\n]+)"?/);
      const topic = topicMatch ? topicMatch[1].trim() : 'the topic';
      output = JSON.stringify({
        subtopics: [
          `historical context of ${topic}`,
          `current state of ${topic}`,
          `practical tradeoffs in ${topic}`,
        ],
      });
      extraDelay = parseLatency(process.env.AFB_MOCK_COORDINATOR_LATENCY_MS);
    } else if (promptLower.includes('worker summaries:') || promptLower.includes('synthesize')) {
      // Merge step.
      output =
        'Synthesis: the three subtopics converge on the same practical conclusion. ' +
        'Historical context shapes the current approach; tradeoffs cluster around ' +
        'latency, cost, and operational complexity. No contradictions observed.';
      extraDelay = parseLatency(process.env.AFB_MOCK_MERGE_LATENCY_MS);
    } else if (promptLower.includes('subtopic:')) {
      // Worker step.
      const subMatch = input.prompt.match(/Subtopic:\s*([^\n]+)/);
      const sub = subMatch ? subMatch[1].trim() : 'this topic';
      output =
        `Summary of "${sub}": the practical considerations involve scheduler ` +
        `behavior, recall tradeoffs, and latency budgets. Most real-world choices ` +
        `come down to operational fit rather than peak performance.`;
    } else {
      // Fallback: treat as a generic task.
      output = `mock-coordinator(${input.taskId}): ${input.prompt.slice(0, 60)}`;
    }

    // Light per-call simulated work so latency numbers are realistic.
    const baseJitter = (hash(input.prompt) % 50) + 30; // 30..80ms
    await sleep(baseJitter + extraDelay);

    return {
      taskId: input.taskId,
      ok: true,
      output,
      usage: { input_tokens: input.prompt.length, output_tokens: output.length },
      latencyMs: Date.now() - start,
    };
  },
};

function parseLatency(raw: string | undefined): number {
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
