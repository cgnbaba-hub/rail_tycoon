import { describe, expect, it } from 'vitest';
import { Rng, hash2, hashFloat, seedFromString } from '../src/sim/rng';
import { fbm, valueNoise } from '../src/sim/noise';

describe('Rng', () => {
  it('is deterministic for a seed and resumable from its state', () => {
    const a = new Rng(1234);
    const seq = Array.from({ length: 10 }, () => a.next());
    const b = new Rng(1234);
    expect(Array.from({ length: 10 }, () => b.next())).toEqual(seq);
    const c = new Rng(1234);
    for (let i = 0; i < 5; i++) c.next();
    const resumed = new Rng(0);
    resumed.state = c.state;
    expect(resumed.next()).toBe(seq[5]);
  });

  it('produces roughly uniform values in [0,1)', () => {
    const r = new Rng(99);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 20000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]++;
    }
    for (const b of buckets) expect(b).toBeGreaterThan(1700);
  });

  it('int() stays within inclusive bounds and hits both ends', () => {
    const r = new Rng(5);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = r.int(3, 6);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it('weighted() respects weights and ignores zero weights', () => {
    const r = new Rng(7);
    const counts = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 6000; i++) counts[r.weighted(['a', 'b', 'c'] as const, (k) => (k === 'a' ? 1 : k === 'b' ? 3 : 0))]++;
    expect(counts.c).toBe(0);
    expect(counts.b / counts.a).toBeGreaterThan(2.5);
    expect(counts.b / counts.a).toBeLessThan(3.5);
  });

  it('fork() gives independent but reproducible streams', () => {
    const a = new Rng(1).fork(1).next();
    const b = new Rng(1).fork(2).next();
    expect(a).not.toBe(b);
    expect(new Rng(1).fork(1).next()).toBe(a);
  });
});

describe('hashing & seeds', () => {
  it('hash2 is stable and spreads neighbouring inputs', () => {
    expect(hash2(1, 2, 3)).toBe(hash2(1, 2, 3));
    expect(hash2(1, 2, 3)).not.toBe(hash2(2, 1, 3));
    const f = hashFloat(10, 20, 30);
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(1);
  });

  it('seedFromString keeps numeric seeds and hashes text', () => {
    expect(seedFromString('42')).toBe(42);
    expect(seedFromString('  42 ')).toBe(42);
    expect(seedFromString('iron')).toBe(seedFromString('iron'));
    expect(seedFromString('iron')).not.toBe(seedFromString('baron'));
  });
});

describe('noise', () => {
  it('value noise is continuous and within [0,1]', () => {
    for (let i = 0; i < 200; i++) {
      const x = i * 0.137;
      const v = valueNoise(x, 3.3, 11);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(Math.abs(valueNoise(x + 0.001, 3.3, 11) - v)).toBeLessThan(0.01);
    }
  });

  it('fbm is normalised and seed-dependent', () => {
    const o = { octaves: 5, lacunarity: 2, gain: 0.5 };
    let differs = false;
    for (let i = 0; i < 50; i++) {
      const v = fbm(i * 0.31, i * 0.17, 1, o);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (v !== fbm(i * 0.31, i * 0.17, 2, o)) differs = true;
    }
    expect(differs).toBe(true);
  });
});
