import type { Evaluator } from './types.js';

/**
 * Pass iff the model's output:
 *   1. Parses as JSON, AND
 *   2. Contains every key in `task.expect.schema.required`, AND
 *   3. Each value matches the type in `task.expect.schema.properties[k].type`, AND
 *   4. If `task.expect.values` is supplied, those values match exactly.
 *
 * Deliberately a tiny subset of JSON Schema — full AJV would pull a
 * dependency. Covers the 80% case for "extract structured data" tasks.
 * Users who need full JSON Schema can write a richer evaluator and
 * register it.
 *
 * Also tolerates models wrapping JSON in markdown code fences.
 */
export const jsonSchemaEvaluator: Evaluator = {
  name: 'json_schema',
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
      schema?: {
        required?: string[];
        properties?: Record<string, { type: string }>;
      };
      values?: Record<string, unknown>;
    };
    if (!expect.schema) {
      return {
        taskId: task.id,
        score: 0,
        passed: false,
        detail: 'task.expect.schema is required for json_schema evaluator',
      };
    }

    const stripped = stripCodeFence(result.output);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch (err) {
      return {
        taskId: task.id,
        score: 0,
        passed: false,
        detail: `output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        taskId: task.id,
        score: 0,
        passed: false,
        detail: 'output is not a JSON object',
      };
    }
    const obj = parsed as Record<string, unknown>;

    const required = expect.schema.required ?? [];
    const missingKeys = required.filter((k) => !(k in obj));
    if (missingKeys.length > 0) {
      return {
        taskId: task.id,
        score: 0,
        passed: false,
        detail: `missing required keys: ${missingKeys.join(', ')}`,
      };
    }

    const props = expect.schema.properties ?? {};
    const typeMismatches: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      const spec = props[k];
      if (!spec) continue;
      if (!matchesType(v, spec.type)) {
        typeMismatches.push(`${k}: expected ${spec.type}, got ${typeOf(v)}`);
      }
    }
    if (typeMismatches.length > 0) {
      return {
        taskId: task.id,
        score: 0,
        passed: false,
        detail: `type mismatches: ${typeMismatches.slice(0, 3).join('; ')}`,
      };
    }

    if (expect.values) {
      const valueMismatches: string[] = [];
      for (const [k, expected] of Object.entries(expect.values)) {
        if (!deepEqual(obj[k], expected)) {
          valueMismatches.push(`${k}: got ${JSON.stringify(obj[k])}, expected ${JSON.stringify(expected)}`);
        }
      }
      if (valueMismatches.length > 0) {
        return {
          taskId: task.id,
          score: 0,
          passed: false,
          detail: valueMismatches.slice(0, 3).join('; '),
        };
      }
    }

    return { taskId: task.id, score: 1, passed: true };
  },
};

function stripCodeFence(s: string): string {
  // Match ```json ... ``` or ``` ... ```
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return m ? m[1] : s.trim();
}

function matchesType(v: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number';
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'null': return v === null;
    default: return true; // unknown type → don't fail on type
  }
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
