import type { Evaluator } from './types.js';
import { successEvaluator } from './success.js';
import { exactMatchEvaluator } from './exact-match.js';
import { containsEvaluator } from './contains.js';
import { jsonSchemaEvaluator } from './json-schema.js';

const evaluators = new Map<string, Evaluator>();

export function registerEvaluator(ev: Evaluator): void {
  evaluators.set(ev.name, ev);
}

export function getEvaluator(name: string): Evaluator | undefined {
  return evaluators.get(name);
}

export function listEvaluators(): string[] {
  return [...evaluators.keys()];
}

// Built-in evaluators.
registerEvaluator(successEvaluator);
registerEvaluator(exactMatchEvaluator);
registerEvaluator(containsEvaluator);
registerEvaluator(jsonSchemaEvaluator);
