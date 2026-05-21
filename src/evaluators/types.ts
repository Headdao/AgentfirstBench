import type { AgentTaskResult } from '../adapters/types.js';
import type { Task } from '../scenarios/types.js';

export interface EvaluationInput {
  task: Task;
  result: AgentTaskResult;
}

export interface EvaluationOutput {
  taskId: string;
  /** 0..1. For binary evaluators this is just 0 or 1. */
  score: number;
  /** Did this task meet the bar? Used to compute eval_pass_rate. */
  passed: boolean;
  /** Free-form text for the report when passed=false. Keep short. */
  detail?: string;
}

export interface Evaluator {
  /** Stable id used in scenario YAML (`evaluator: <name>`). */
  readonly name: string;
  /** §14 reproducibility marker — bump when scoring semantics change. */
  readonly version: string;
  evaluate(input: EvaluationInput): Promise<EvaluationOutput>;
}
