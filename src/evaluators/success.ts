import type { Evaluator } from './types.js';

/**
 * Trivial evaluator: a task "passes" if the adapter didn't error.
 * This is the default, used by infra-focused scenarios where the
 * quality of the model's response isn't being scored.
 */
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
