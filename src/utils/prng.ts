/**
 * mulberry32 — small, fast, decent-quality PRNG that's seedable and
 * deterministic across Node versions. Good enough for picking which tasks
 * get failure-injected; not suitable for crypto.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit non-deterministic seed for when the scenario didn't supply one. */
export function randomSeed(): number {
  return (Math.random() * 0x1_0000_0000) >>> 0;
}
