import { describe, expect, it } from 'vitest';
import { CARGO, INDUSTRIES, MAPGEN, TIME, validateData } from '../src/data';

describe('data files', () => {
  it('validate cross references', () => {
    expect(() => validateData()).not.toThrow();
  });

  it('define 25–35 cargo types with unique ids', () => {
    expect(CARGO.length).toBeGreaterThanOrEqual(25);
    expect(CARGO.length).toBeLessThanOrEqual(35);
    expect(new Set(CARGO.map((c) => c.id)).size).toBe(CARGO.length);
  });

  it('form production chains: every processed input is produced somewhere', () => {
    const produced = new Set(INDUSTRIES.flatMap((i) => i.produces));
    for (const ind of INDUSTRIES.filter((i) => i.kind === 'processor')) {
      for (const c of ind.consumes) expect(produced.has(c)).toBe(true);
    }
  });

  it('have sane clock and mapgen settings', () => {
    expect(TIME.speeds).toEqual([1, 2, 4, 8]);
    expect(MAPGEN.sizes).toContain(256);
    expect(MAPGEN.maxHeight).toBeLessThan(64);
  });
});
