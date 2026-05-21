import { z } from 'zod';

export const TaskSpec = z.object({
  id: z.string(),
  prompt: z.string(),
  payload: z.record(z.unknown()).optional(),
  expect: z.record(z.unknown()).optional(),
});

export const NetworkPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('disabled') }),
  z.object({ mode: z.literal('adapter_only') }),
  z.object({ mode: z.literal('allowlist'), hosts: z.array(z.string()).min(1) }),
]);
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;

export const ScenarioSchema = z.object({
  name: z.string(),
  kind: z.enum([
    'research_synthesis',
    'concurrency_ramp',
    'failure_containment',
    'coding_patch',
    'structured_output',
    'long_context_recall',
    'reasoning_chain',
  ]),
  description: z.string().optional(),

  provider: z.string().optional(),
  model: z.string().optional(),
  runtime: z.string().optional(),

  max_concurrency: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeout_ms: z.number().int().positive().optional(),
  retries: z.number().int().min(0).default(0),

  /**
   * Safety §13: controls what the *task* (the worker's tools/agent) may reach.
   * Does not constrain the adapter's own API call to its provider — that's
   * implicit in choosing the adapter. Default `disabled` means: scenario
   * workers must not initiate additional network calls.
   */
  network_policy: NetworkPolicySchema.default({ mode: 'disabled' }),

  /**
   * Which evaluator to use for scoring task outputs. Defaults to "success"
   * which just checks the adapter call didn't error. For quality scenarios,
   * pick "exact_match", "contains", or "json_schema" (or register your own).
   */
  evaluator: z.string().default('success'),

  /**
   * §14 reproducibility marker. "inline/v1" means prompts are stored
   * verbatim in this scenario file (no templating). When prompt templates
   * land (referenced by id from a templates/ directory), set this to the
   * template+version that was used, e.g. "research_summary/v3".
   */
  prompt_template_version: z.string().default('inline/v1'),

  /**
   * §14 reproducibility marker. "default/v1" is the built-in pass/fail
   * scoring. Becomes meaningful once richer scoring profiles exist.
   */
  scoring_profile_version: z.string().default('default/v1'),

  /** For concurrency_ramp: step through these concurrency levels. */
  concurrency_levels: z.array(z.number().int().positive()).optional(),

  /** For failure_containment: inject failures at this rate (0..1). */
  inject_failure_rate: z.number().min(0).max(1).optional(),

  /**
   * Seed for any randomness the runner introduces (e.g. failure injection).
   * Optional in the scenario file; the runner generates one if absent and
   * records the effective seed in metrics.json so the run can be replayed.
   */
  seed: z.number().int().nonnegative().optional(),

  tasks: z.array(TaskSpec).min(1),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type Task = z.infer<typeof TaskSpec>;
