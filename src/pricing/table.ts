import type { TokenUsage } from '../adapters/types.js';

export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  input_per_mtok: number;
  /** USD per 1,000,000 output tokens. */
  output_per_mtok: number;
  /** Optional: USD per 1M cached/read tokens, if the provider supports prompt caching. */
  cached_input_per_mtok?: number;
  /** ISO date the rate was recorded — for staleness checks. */
  as_of: string;
  /** Where the rate came from (URL or "official-docs"). */
  source: string;
}

/**
 * Central pricing table. Keyed by `${provider}/${model}`.
 *
 * IMPORTANT: rates here are best-effort and *will* drift. Verify against
 * the provider's pricing page before relying on a number for billing. PRs
 * welcome to update — include an `as_of` date so reviewers can sanity-check.
 *
 * Rationale for living in the OSS repo (vs. fetching at runtime): cost
 * estimates need to be deterministic across runs of the same benchmark,
 * otherwise `afb compare` results aren't reproducible. Bumping the table
 * in git makes pricing changes part of the audit trail.
 */
const PRICING: Record<string, ModelPricing> = {
  // Anthropic — https://www.anthropic.com/pricing
  'anthropic/claude-opus-4-7': {
    input_per_mtok: 15,
    output_per_mtok: 75,
    cached_input_per_mtok: 1.5,
    as_of: '2026-01-01',
    source: 'anthropic.com/pricing',
  },
  'anthropic/claude-sonnet-4-6': {
    input_per_mtok: 3,
    output_per_mtok: 15,
    cached_input_per_mtok: 0.3,
    as_of: '2026-01-01',
    source: 'anthropic.com/pricing',
  },
  'anthropic/claude-haiku-4-5': {
    input_per_mtok: 1,
    output_per_mtok: 5,
    as_of: '2026-01-01',
    source: 'anthropic.com/pricing',
  },

  // Google Gemini — https://ai.google.dev/pricing
  // ⚠️ Rates below are placeholders pending verification against the
  // current Google pricing page. PRs welcome with updated as_of dates.
  'google/gemini-3.5-flash': {
    input_per_mtok: 0.15,
    output_per_mtok: 0.6,
    as_of: '2026-01-01',
    source: 'ai.google.dev/pricing (placeholder, verify before billing)',
  },
  'google/gemini-3.5-pro': {
    input_per_mtok: 1.25,
    output_per_mtok: 10,
    as_of: '2026-01-01',
    source: 'ai.google.dev/pricing (placeholder, verify before billing)',
  },
  'google/gemini-2.5-flash': {
    input_per_mtok: 0.075,
    output_per_mtok: 0.3,
    as_of: '2026-01-01',
    source: 'ai.google.dev/pricing (placeholder, verify before billing)',
  },

  // OpenAI — https://openai.com/api/pricing
  'openai/gpt-4o': {
    input_per_mtok: 2.5,
    output_per_mtok: 10,
    as_of: '2026-01-01',
    source: 'openai.com/pricing',
  },
  'openai/gpt-4o-mini': {
    input_per_mtok: 0.15,
    output_per_mtok: 0.6,
    as_of: '2026-01-01',
    source: 'openai.com/pricing',
  },
  'openai/o1': {
    input_per_mtok: 15,
    output_per_mtok: 60,
    as_of: '2026-01-01',
    source: 'openai.com/pricing',
  },

  // Mock — always free.
  'mock/mock-model': {
    input_per_mtok: 0,
    output_per_mtok: 0,
    as_of: '2026-01-01',
    source: 'built-in',
  },
};

export function lookupPricing(provider: string, model: string): ModelPricing | undefined {
  return PRICING[`${provider}/${model}`];
}

export function estimateUsd(pricing: ModelPricing, usage: TokenUsage): number {
  return (
    (usage.input_tokens * pricing.input_per_mtok +
      usage.output_tokens * pricing.output_per_mtok) /
    1_000_000
  );
}

export function listKnownModels(): string[] {
  return Object.keys(PRICING).sort();
}
