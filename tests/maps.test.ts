import { describe, expect, it } from 'vitest';
import { INDUSTRY_BY_ID, MAPGEN, MAPS, SCENARIOS } from '../src/data';
import { defaultTrackOptions } from '../src/sim/construction';
import type { Game } from '../src/sim/game';
import { distToPath } from '../src/sim/layout';
import { defaultMapParams, generateWorld } from '../src/sim/mapgen';
import { scenarioMapParams, startScenario, townsConnected } from '../src/sim/scenario';
import { T, type World } from '../src/sim/world';

const worlds = new Map<string, World>();
function world(id: string, startYear = 1880): World {
  const key = `${id}:${startYear}`;
  if (!worlds.has(key)) {
    const layout = MAPS.find((m) => m.id === id)!;
    worlds.set(key, generateWorld({ ...defaultMapParams(5), size: layout.size, startYear, layout: id }));
  }
  return worlds.get(key)!;
}

/** A station in each town (searching outwards for a free spot), joined by track in order. */
function connect(g: Game, ids: number[]): boolean {
  for (const r of g.territories.regions) if (!g.canBuildIn(r)) g.buyCharter(r.id);
  const made = [];
  for (const id of ids) {
    const town = g.world.cities[id];
    let done = false;
    for (let r = 2; r <= 10 && !done; r++) {
      for (const [dx, dy] of [[0, r], [0, -r], [r, 0], [-r, 0], [r, r], [-r, -r], [r, -r], [-r, r]]) {
        for (const axis of ['x', 'y'] as const) {
          const res = g.buildStation(town.x + dx, town.y + dy, 'station', axis);
          if (res.ok) {
            made.push(res.station!);
            done = true;
            break;
          }
        }
        if (done) break;
      }
    }
    if (!done) return false;
  }
  for (let i = 0; i + 1 < made.length; i++) {
    if (!g.buildTrack(made[i].tiles[made[i].tiles.length - 1], made[i + 1].tiles[0], { ...defaultTrackOptions(g.year), tunnels: true }).ok) return false;
  }
  return true;
}

/** Towns a line between far-apart requirement towns runs through (one drag would be too long). */
const VIA: Record<string, string[]> = { coast_to_coast: ['Summit', 'Prairie Junction'] };

describe('hand-made maps', () => {
  it('reference known industries, sizes and town sizes', () => {
    for (const m of MAPS) {
      expect(MAPGEN.sizes).toContain(m.size);
      for (const ind of m.industries ?? []) expect(INDUSTRY_BY_ID.has(ind.type), `${m.id}: ${ind.type}`).toBe(true);
      expect(new Set(m.towns.map((t) => t.name)).size).toBe(m.towns.length);
    }
  });

  it('are deterministic', () => {
    const a = generateWorld({ ...defaultMapParams(9), size: 128, layout: 'high_pass' });
    const b = generateWorld({ ...defaultMapParams(9), size: 128, layout: 'high_pass' });
    expect(a.heights).toEqual(b.heights);
    expect(a.occupant).toEqual(b.occupant);
    expect(a.cities.map((c) => c.name)).toEqual(b.cities.map((c) => c.name));
  });

  it('place every named town first, with its name, size and population', () => {
    for (const m of MAPS) {
      const w = world(m.id);
      m.towns.forEach((t, i) => {
        const c = w.cities[i];
        expect(c.name, m.id).toBe(t.name);
        if (t.pop) expect(c.population).toBe(t.pop);
        expect(MAPGEN.cities.classes[c.classIndex].id).toBe(t.size);
        expect(c.buildingIds.length).toBeGreaterThan(0);
        // Near where the author put it.
        expect(Math.hypot(c.x - t.x * w.width, c.y - t.y * w.height)).toBeLessThanOrEqual(12);
      });
      const extras = w.cities.slice(m.towns.length);
      expect(extras.length).toBeLessThanOrEqual(m.extraTowns ?? 0);
      for (const c of extras) expect(c.classIndex).toBeLessThanOrEqual(1);
    }
  });

  it('place the fixed industries that exist in the start year', () => {
    for (const m of MAPS) {
      for (const year of [1860, 1920]) {
        const w = world(m.id, year);
        const want = new Map<string, number>();
        for (const ind of m.industries ?? []) {
          const def = INDUSTRY_BY_ID.get(ind.type)!;
          if (year >= def.era[0] && year <= def.era[1]) want.set(ind.type, (want.get(ind.type) ?? 0) + 1);
        }
        for (const [type, n] of want) expect(w.industries.filter((i) => i.defId === type).length, `${m.id} ${year} ${type}`).toBeGreaterThanOrEqual(n);
        if (year < 1860) expect(w.industries.some((i) => i.defId === 'oil_well')).toBe(false);
      }
    }
  });

  it('shape the land as described: seas, lakes, ridges, rivers and deserts', () => {
    for (const m of MAPS) {
      const w = world(m.id);
      const S = w.width;
      for (const f of m.features) {
        if (f.type === 'sea') {
          // A strip along that edge is water.
          const k = Math.floor(f.at * S * 0.4);
          const [x, y] = f.edge === 'west' ? [k, S >> 1] : f.edge === 'east' ? [S - 1 - k, S >> 1] : f.edge === 'north' ? [S >> 1, k] : [S >> 1, S - 1 - k];
          expect(w.isWater(x, y), `${m.id} ${f.edge}`).toBe(true);
        } else if (f.type === 'lake') {
          expect(w.isWater(Math.min(S - 1, Math.round(f.x * S)), Math.min(S - 1, Math.round(f.y * S))), `${m.id} lake`).toBe(true);
        } else if (f.type === 'ridge') {
          let top = 0;
          for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (distToPath(x / S, y / S, f.path) < f.width * 0.3) top = Math.max(top, w.tileAvgH(x, y));
          expect(top / w.maxHeight, `${m.id} ridge`).toBeGreaterThan(0.45);
        } else if (f.type === 'desert') {
          let sand = 0;
          let all = 0;
          for (let y = 0; y < S; y++) {
            for (let x = 0; x < S; x++) {
              if (Math.hypot(x / S - f.x, y / S - f.y) < f.r * 0.7) {
                all++;
                if (w.terrain[w.tileIndex(x, y)] === T.Sand) sand++;
              }
            }
          }
          expect(sand / all, `${m.id} desert`).toBeGreaterThan(0.5);
        }
      }
      for (let y = 0; y <= w.height; y++) {
        for (let x = 0; x < w.width; x++) expect(Math.abs(w.vh(x, y) - w.vh(x + 1, y))).toBeLessThanOrEqual(1);
      }
    }
  });

  it('work at other map sizes too', () => {
    const w = generateWorld({ ...defaultMapParams(3), size: 192, layout: 'twin_rivers' });
    expect(w.width).toBe(192);
    expect(w.cities.slice(0, 6).map((c) => c.name)).toEqual(MAPS.find((m) => m.id === 'twin_rivers')!.towns.map((t) => t.name));
  });

  it('let every scenario on them reach its required towns by rail', () => {
    for (const def of SCENARIOS.filter((s) => s.map.layout)) {
      const g = startScenario(def);
      expect(g.world.width).toBe(scenarioMapParams(def).size);
      for (let k = 0; k < def.requires.length; k++) {
        const r = def.requires[k];
        const [a, b] = [g.scenario!.towns[2 * k], g.scenario!.towns[2 * k + 1]];
        expect(g.world.cities[a].name, def.id).toBe(r.a);
        expect(g.world.cities[b].name, def.id).toBe(r.b);
        g.company.cash = 50_000_000;
        const via = (VIA[def.id] ?? []).map((n) => g.world.cities.findIndex((c) => c.name === n));
        expect(connect(g, [a, ...via, b]), `${def.id}: ${r.a} – ${r.b}`).toBe(true);
        expect(townsConnected(g, a, b)).toBe(true);
      }
    }
  });
});
