import type { Evaluator } from './types.js';

/**
 * Pass iff the model's output contains every string in `task.expect.needles`
 * (case-insensitive by default).
 *
 * Best for long-context recall tests ("needle in haystack"), where you
 * just want to know whether the model retrieved the planted fact —
 * surrounding text variation is fine.
 */
export const containsEvaluator: Evaluator = {
  name: 'contains',
  version: '1.0.0',
  async evaluate({ task, result }) {
    if (!result.ok) {
      return {
        taskId: task.id,
        score: 0,
        passed: false,
        detail: `adapter failed: ${result.error?.message ?? 'unknown'}`,
      };
    }
    const expect = (task.expect ?? {}) as {
      needles?: string[];
      case_sensitive?: boolean;
    };
    if (!expect.needles || expect.needles.length === 0) {
      return {
        taskId: task.id,
        score: 0,
        passed: false,
        detail: 'task.expect.needles is required for contains evaluator',
      };
    }
    const haystack = expect.case_sensitive ? result.output : result.output.toLowerCase();
    const missing: string[] = [];
    for (const n of expect.needles) {
      const needle = expect.case_sensitive ? n : n.toLowerCase();
      if (!haystack.includes(needle)) missing.push(n);
    }
    const found = expect.needles.length - missing.length;
    const score = found / expect.needles.length;
    const passed = missing.length === 0;
    return {
      taskId: task.id,
      score,
      passed,
      detail: passed ? undefined : `missing ${missing.length}/${expect.needles.length}: ${JSON.stringify(missing.slice(0, 3))}`,
    };
  },
};
