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
// All rates verified from the providers' public pricing pages on 2026-05-21.
// PRs welcome to bump these — include the source URL and a fresh `as_of`.
const ASOF = '2026-05-21';

const PRICING: Record<string, ModelPricing> = {
  // Anthropic — https://platform.claude.com/docs/en/about-claude/models/overview
  'anthropic/claude-opus-4-7': {
    input_per_mtok: 5,
    output_per_mtok: 25,
    as_of: ASOF,
    source: 'platform.claude.com/docs/en/about-claude/models/overview',
  },
  'anthropic/claude-sonnet-4-6': {
    input_per_mtok: 3,
    output_per_mtok: 15,
    as_of: ASOF,
    source: 'platform.claude.com/docs/en/about-claude/models/overview',
  },
  'anthropic/claude-haiku-4-5': {
    input_per_mtok: 1,
    output_per_mtok: 5,
    as_of: ASOF,
    source: 'platform.claude.com/docs/en/about-claude/models/overview',
  },
  // Legacy Anthropic models (still available, often pinned in older benchmarks).
  'anthropic/claude-opus-4-6': {
    input_per_mtok: 5,
    output_per_mtok: 25,
    as_of: ASOF,
    source: 'platform.claude.com/docs/en/about-claude/models/overview',
  },
  'anthropic/claude-sonnet-4-5': {
    input_per_mtok: 3,
    output_per_mtok: 15,
    as_of: ASOF,
    source: 'platform.claude.com/docs/en/about-claude/models/overview',
  },

  // Google Gemini — https://ai.google.dev/pricing
  'google/gemini-3.5-flash': {
    input_per_mtok: 1.5,
    output_per_mtok: 9,
    as_of: ASOF,
    source: 'ai.google.dev/pricing',
  },
  'google/gemini-3.1-pro-preview': {
    // Standard tier, prompts ≤200k tokens. Above 200k: $4 / $18.
    input_per_mtok: 2,
    output_per_mtok: 12,
    as_of: ASOF,
    source: 'ai.google.dev/pricing (≤200k context tier)',
  },
  'google/gemini-2.5-flash': {
    input_per_mtok: 0.3,
    output_per_mtok: 2.5,
    as_of: ASOF,
    source: 'ai.google.dev/pricing',
  },

  // OpenAI — https://developers.openai.com/api/docs/pricing
  // The gpt-4o / o1 lineup is no longer current as of 2026; the gpt-5.x
  // family replaces it. Add older entries here if benchmarking legacy runs.
  'openai/gpt-5.5': {
    input_per_mtok: 5,
    output_per_mtok: 30,
    as_of: ASOF,
    source: 'developers.openai.com/api/docs/pricing',
  },
  'openai/gpt-5.5-pro': {
    input_per_mtok: 30,
    output_per_mtok: 180,
    as_of: ASOF,
    source: 'developers.openai.com/api/docs/pricing',
  },
  'openai/gpt-5.4': {
    input_per_mtok: 2.5,
    output_per_mtok: 15,
    as_of: ASOF,
    source: 'developers.openai.com/api/docs/pricing',
  },
  'openai/gpt-5.4-mini': {
    input_per_mtok: 0.75,
    output_per_mtok: 4.5,
    as_of: ASOF,
    source: 'developers.openai.com/api/docs/pricing',
  },
  'openai/gpt-5.4-nano': {
    input_per_mtok: 0.2,
    output_per_mtok: 1.25,
    as_of: ASOF,
    source: 'developers.openai.com/api/docs/pricing',
  },
  'openai/gpt-5.4-pro': {
    input_per_mtok: 30,
    output_per_mtok: 180,
    as_of: ASOF,
    source: 'developers.openai.com/api/docs/pricing',
  },
  'openai/gpt-5.3-codex': {
    input_per_mtok: 1.75,
    output_per_mtok: 14,
    as_of: ASOF,
    source: 'developers.openai.com/api/docs/pricing',
  },

  // Mock — always free.
  'mock/mock-model': {
    input_per_mtok: 0,
    output_per_mtok: 0,
    as_of: ASOF,
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
