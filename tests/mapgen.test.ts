import { describe, expect, it } from 'vitest';
import { INDUSTRY_BY_ID, MAPGEN } from '../src/data';
import { defaultMapParams, generateWorld } from '../src/sim/mapgen';
import { F, OCC_BUILDING, OCC_INDUSTRY, T, World, occupantIndex, occupantKind, terrainIdFromName } from '../src/sim/world';

function fingerprint(w: World): string {
  let h = 2166136261;
  const mix = (v: number) => {
    h ^= v;
    h = Math.imul(h, 16777619) >>> 0;
  };
  w.heights.forEach(mix);
  w.terrain.forEach(mix);
  w.flags.forEach(mix);
  w.occupant.forEach(mix);
  return `${h}:${w.cities.map((c) => c.name).join('|')}:${w.industries.length}`;
}

const worlds = [1, 7, 42, 2024].map((seed) => generateWorld({ ...defaultMapParams(seed), size: 96 }));

describe('map generation', () => {
  it('is deterministic for identical parameters', () => {
    const a = generateWorld({ ...defaultMapParams(77), size: 64 });
    const b = generateWorld({ ...defaultMapParams(77), size: 64 });
    expect(fingerprint(a)).toBe(fingerprint(b));
    const c = generateWorld({ ...defaultMapParams(78), size: 64 });
    expect(fingerprint(c)).not.toBe(fingerprint(a));
  });

  it('keeps neighbouring vertices within one height level', () => {
    for (const w of worlds) {
      for (let y = 0; y <= w.height; y++) {
        for (let x = 0; x <= w.width; x++) {
          if (x < w.width) expect(Math.abs(w.vh(x, y) - w.vh(x + 1, y))).toBeLessThanOrEqual(1);
          if (y < w.height) expect(Math.abs(w.vh(x, y) - w.vh(x, y + 1))).toBeLessThanOrEqual(1);
          expect(w.vh(x, y)).toBeLessThanOrEqual(w.maxHeight);
        }
      }
    }
  });

  it('marks exactly the sea-level tiles as water and roughly hits the water setting', () => {
    for (const w of worlds) {
      let water = 0;
      for (let y = 0; y < w.height; y++) {
        for (let x = 0; x < w.width; x++) {
          expect(w.isWater(x, y)).toBe(w.tileMaxH(x, y) === 0);
          if (w.isWater(x, y)) water++;
        }
      }
      const frac = water / (w.width * w.height);
      expect(frac).toBeGreaterThan(0.05);
      expect(frac).toBeLessThan(0.6);
    }
  });

  it('places named cities on land with buildings on flat, dry pads', () => {
    for (const w of worlds) {
      expect(w.cities.length).toBeGreaterThanOrEqual(2);
      expect(new Set(w.cities.map((c) => c.name)).size).toBe(w.cities.length);
      for (const c of w.cities) {
        expect(w.isWater(c.x, c.y)).toBe(false);
        const cls = MAPGEN.cities.classes[c.classIndex];
        expect(c.population).toBeGreaterThanOrEqual(cls.popMin);
        expect(c.population).toBeLessThanOrEqual(cls.popMax);
        expect(c.buildingIds.length).toBeGreaterThan(0);
      }
      for (const b of w.buildings) {
        expect(w.isWater(b.x, b.y)).toBe(false);
        expect(w.hasFlag(b.x, b.y, F.River)).toBe(false);
        expect(w.tileSlope(b.x, b.y)).toBe(0);
        const occ = w.occupantAt(b.x, b.y);
        expect(occupantKind(occ)).toBe(OCC_BUILDING);
        expect(occupantIndex(occ)).toBe(b.id);
      }
    }
  });

  it('respects city spacing', () => {
    for (const w of worlds) {
      for (let i = 0; i < w.cities.length; i++) {
        for (let j = i + 1; j < w.cities.length; j++) {
          const a = w.cities[i];
          const b = w.cities[j];
          expect(World.dist(a.x, a.y, b.x, b.y)).toBeGreaterThanOrEqual(MAPGEN.cities.minSpacing);
        }
      }
    }
  });

  it('places industries on allowed terrain, flat pads and without overlap', () => {
    for (const w of worlds) {
      expect(w.industries.length).toBeGreaterThan(5);
      for (const ind of w.industries) {
        const def = INDUSTRY_BY_ID.get(ind.defId)!;
        const allowed = def.placement.terrain.map(terrainIdFromName) as number[];
        const pad = w.vh(ind.x, ind.y);
        for (let dy = 0; dy < ind.h; dy++) {
          for (let dx = 0; dx < ind.w; dx++) {
            const x = ind.x + dx;
            const y = ind.y + dy;
            expect(allowed).toContain(w.terrainAt(x, y));
            expect(w.tileMaxH(x, y)).toBe(pad);
            expect(w.tileMinH(x, y)).toBe(pad);
            const occ = w.occupantAt(x, y);
            expect(occupantKind(occ)).toBe(OCC_INDUSTRY);
            expect(occupantIndex(occ)).toBe(ind.id);
          }
        }
      }
    }
  });

  it('only generates industries that exist in the start year', () => {
    const early = generateWorld({ ...defaultMapParams(5), size: 128, startYear: 1830 });
    expect(early.industries.some((i) => i.defId === 'oil_well' || i.defId === 'auto_plant')).toBe(false);
    const late = generateWorld({ ...defaultMapParams(5), size: 128, startYear: 1940 });
    expect(late.industries.some((i) => i.defId === 'oil_well')).toBe(true);
  });

  it('draws rivers that are not on sea tiles', () => {
    let rivers = 0;
    for (const w of worlds) {
      for (let i = 0; i < w.flags.length; i++) {
        if (w.flags[i] & F.River) {
          rivers++;
          expect(w.terrain[i]).not.toBe(T.Water);
        }
      }
    }
    expect(rivers).toBeGreaterThan(0);
  });

  it('honours the water setting monotonically', () => {
    const count = (water: 'low' | 'high') => {
      const w = generateWorld({ ...defaultMapParams(3), size: 64, water });
      return w.terrain.filter((t) => t === T.Water).length;
    };
    expect(count('high')).toBeGreaterThan(count('low'));
  });

  it('generates a 256x256 map in reasonable time', () => {
    const t0 = performance.now();
    const w = generateWorld({ ...defaultMapParams(11), size: 256 });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(w.width).toBe(256);
    expect(w.cities.length).toBeGreaterThan(10);
  });
});

describe('World.surfaceHeight', () => {
  it('matches corner heights and stays within the tile range', () => {
    const w = worlds[1];
    for (let y = 0; y < w.height; y += 5) {
      for (let x = 0; x < w.width; x += 5) {
        const [a, b, c, d] = w.corners(x, y);
        expect(w.surfaceHeight(x, y)).toBeCloseTo(a);
        expect(w.surfaceHeight(x + 0.999999, y)).toBeCloseTo(b, 4);
        expect(w.surfaceHeight(x + 0.999999, y + 0.999999)).toBeCloseTo(c, 4);
        expect(w.surfaceHeight(x, y + 0.999999)).toBeCloseTo(d, 4);
        const mid = w.surfaceHeight(x + 0.5, y + 0.5);
        expect(mid).toBeGreaterThanOrEqual(w.tileMinH(x, y));
        expect(mid).toBeLessThanOrEqual(w.tileMaxH(x, y));
      }
    }
  });
});
