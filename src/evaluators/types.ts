import type { AgentTaskResult } from '../adapters/types.js';
import type { Task } from '../scenarios/types.js';

export interface EvaluationInput {
  task: Task;
  result: AgentTaskResult;
}

export interface EvaluationOutput {
  taskId: string;
  score: number; // 0..1
  passed: boolean;
  detail?: string;
}

export interface Evaluator {
  readonly name: string;
  /** §14 reproducibility marker — bump when scoring semantics change. */
  readonly version: string;
  evaluate(input: EvaluationInput): Promise<EvaluationOutput>;
}

/** Trivial evaluator: succeeded == passed. Replace per-scenario when richer scoring is needed. */
export const successEvaluator: Evaluator = {
  name: 'success',
  version: '1.0.0',
  async evaluate({ task, result }) {
    return {
      taskId: task.id,
      score: result.ok ? 1 : 0,
      passed: result.ok,
      detail: result.ok ? undefined : result.error?.message,
    };
  },
};
