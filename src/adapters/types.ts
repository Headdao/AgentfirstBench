export type NetworkPolicy =
  | { mode: 'disabled' }
  | { mode: 'adapter_only' }
  | { mode: 'allowlist'; hosts: string[] };

export interface AgentTaskInput {
  /** Stable id for this task within the run. */
  taskId: string;
  /** Free-form prompt or instruction the worker should act on. */
  prompt: string;
  /** Optional structured payload from the scenario (e.g., URLs to read, files to inspect). */
  payload?: Record<string, unknown>;
  /** Per-task timeout in ms (the runner may also enforce a hard cap). */
  timeoutMs?: number;
  /** Model id resolved by the runner (so adapters don't re-parse config). */
  model: string;
  /** Sampling temperature resolved by the runner. */
  temperature?: number;
  /**
   * Safety §13: network policy for any tool / agent network access the
   * adapter exposes to the task. Adapter's own API call to its provider
   * is implicitly allowed regardless of this value.
   *
   * Raw-API adapters (raw-anthropic, raw-openai) have no separate tool
   * network surface, so they ignore this. Agent-runtime adapters MUST
   * honor it.
   */
  networkPolicy: NetworkPolicy;
  /**
   * Safety §13: the only directory the task is permitted to write to.
   * Adapters that produce files MUST scope writes here (see ScopedFS).
   */
  runDir: string;
  /**
   * Safety §13: whether mutations outside the run directory are allowed.
   * False by default; only true when the user passed `--apply` AND the
   * scenario is one that needs to mutate the host repo.
   */
  apply: boolean;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface CostEstimate {
  usd: number;
  currency: 'USD';
}

export interface RateLimitStatus {
  requests_remaining?: number;
  tokens_remaining?: number;
  reset_at?: string;
}

export interface AgentTaskResult {
  taskId: string;
  ok: boolean;
  /** Free-form text output the evaluator will score. */
  output: string;
  /** Optional structured result (tool calls, file paths produced, etc.). */
  data?: Record<string, unknown>;
  usage?: TokenUsage;
  /** Set when ok=false. */
  error?: { type: string; message: string };
  /** Wall-clock duration of this single task. */
  latencyMs: number;
}

export interface AgentRuntimeAdapter {
  /** Stable identifier used in scenario YAML and CLI flags (e.g., "raw-anthropic"). */
  readonly name: string;
  runTask(input: AgentTaskInput): Promise<AgentTaskResult>;
  estimateCost?(usage: TokenUsage): CostEstimate;
  getRateLimitStatus?(): Promise<RateLimitStatus>;
}
