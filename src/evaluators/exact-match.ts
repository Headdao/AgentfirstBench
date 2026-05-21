import type { Evaluator } from './types.js';

/**
 * Pass iff the model's output, after trimming + normalizing whitespace,
 * matches `task.expect.answer` (also normalized).
 *
 * Use `task.expect.case_insensitive: true` for case-insensitive match.
 * Use `task.expect.pattern: "..."` for regex match (alternative to `answer`).
 *
 * Best for reasoning tasks with a single canonical answer (math, code
 * golf, fact lookup) where output formatting can be constrained by the
 * prompt.
 */
export const exactMatchEvaluator: Evaluator = {
  name: 'exact_match',
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
      answer?: string;
      pattern?: string;
      case_insensitive?: boolean;
    };
    const normalize = (s: string): string => {
      const trimmed = s.trim().replace(/\s+/g, ' ');
      return expect.case_insensitive ? trimmed.toLowerCase() : trimmed;
    };
    const out = normalize(result.output);

    if (expect.pattern) {
      const re = new RegExp(expect.pattern);
      const passed = re.test(result.output);
      return {
        taskId: task.id,
        score: passed ? 1 : 0,
        passed,
        detail: passed ? undefined : `output did not match /${expect.pattern}/`,
      };
    }

    if (expect.answer == null) {
      return {
        taskId: task.id,
        score: 0,
        passed: false,
        detail: 'task.expect.answer (or .pattern) is required for exact_match',
      };
    }
    const expected = normalize(expect.answer);
    const passed = out === expected;
    return {
      taskId: task.id,
      score: passed ? 1 : 0,
      passed,
      detail: passed ? undefined : `got ${JSON.stringify(out.slice(0, 60))}, expected ${JSON.stringify(expected.slice(0, 60))}`,
    };
  },
};
