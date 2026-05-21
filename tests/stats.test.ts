import { describe, it, expect } from 'vitest';
import { percentile, mean } from '../src/utils/stats.js';

describe('percentile (nearest-rank)', () => {
  it('returns 0 for an empty array', () => {
    expect(percentile([], 50)).toBe(0);
  });

  it('p50 of [10, 20] is the lower value (nearest-rank convention)', () => {
    expect(percentile([10, 20], 50)).toBe(10);
  });

  it('p95 of 1..100 is the 95th value', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
  });

  it('p99 of 1..100 is the 99th value', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 99)).toBe(99);
  });

  it('p100 returns the max', () => {
    expect(percentile([3, 1, 4, 1, 5, 9, 2, 6], 100)).toBe(9);
  });

  it('p0 returns the min', () => {
    expect(percentile([3, 1, 4, 1, 5, 9, 2, 6], 0)).toBe(1);
  });

  it('is stable regardless of input order', () => {
    const a = percentile([10, 20, 30, 40, 50], 75);
    const b = percentile([40, 10, 50, 30, 20], 75);
    expect(a).toBe(b);
  });

  it('handles a single-element array', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });
});

describe('mean', () => {
  it('returns 0 for an empty array', () => {
    expect(mean([])).toBe(0);
  });
  it('computes the average', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });
});
