import { describe, expect, it } from 'vitest';
import { TERRITORIES, TIME } from '../src/data';
import { defaultTrackOptions } from '../src/sim/construction';
import { Game } from '../src/sim/game';
import { defaultMapParams } from '../src/sim/mapgen';
import type { Region } from '../src/sim/territories';

const DAY = TIME.ticksPerDay;

function run(g: Game, days: number): void {
  for (let i = 0; i < days * DAY; i++) g.step();
}

function generated(rivals = 0): Game {
  return new Game({ ...defaultMapParams(42), size: 128 }, undefined, { rivals, wrecks: false });
}

/** A buildable spot (station) inside region r, or null. */
function spotIn(g: Game, r: Region): [number, number] | null {
  const W = g.world.width;
  for (let i = 0; i < g.territories.map.length; i++) {
    if (g.territories.map[i] !== r.id) continue;
    const x = i % W;
    const y = Math.floor(i / W);
    if (x < 4 || y < 4 || x > W - 6 || y > W - 6) continue;
    const p = planOk(g, x, y);
    if (p) return [x, y];
  }
  return null;
}

function planOk(g: Game, x: number, y: number): boolean {
  const saved = g.territories.regions.map((r) => r.chartered);
  for (const r of g.territories.regions) r.chartered = true;
  const ok = g.planStation(x, y, 'depot', 'x').ok;
  g.territories.regions.forEach((r, k) => (r.chartered = saved[k]));
  return ok;
}

describe('territories', () => {
  it('divide the map into named regions, the biggest town in an open one', () => {
    const g = generated();
    const T = g.territories;
    expect(T.regions.length).toBeGreaterThanOrEqual(TERRITORIES.minRegions);
    expect(T.regions.length).toBeLessThanOrEqual(TERRITORIES.maxRegions);
    expect(new Set(T.map).size).toBe(T.regions.length);
    const big = [...g.world.cities].sort((a, b) => b.population - a.population)[0];
    expect(T.regionAt(g.world.tileIndex(big.x, big.y)).restricted).toBe(false);
    expect(T.regions.some((r) => r.restricted)).toBe(true);
    expect(new Set(T.regions.map((r) => r.name)).size).toBe(T.regions.length);
    for (const r of T.regions) expect(r.goodwill).toBe(TERRITORIES.start);
  });

  it('need a charter before you can build in a restricted region', () => {
    const g = generated();
    g.company.cash = 5_000_000;
    const r = g.territories.regions.find((x) => x.restricted)!;
    const [x, y] = spotIn(g, r)!;
    const refused = g.buildStation(x, y, 'depot', 'x');
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/charter/);
    const cash = g.company.cash;
    expect(g.buyCharter(r.id).ok).toBe(true);
    expect(g.company.cash).toBe(cash - g.territories.charterFee(g.year));
    expect(g.buildStation(x, y, 'depot', 'x').ok).toBe(true);
    expect(g.buyCharter(r.id).ok).toBe(false);
  });

  it('keep rival railroads out of restricted regions', () => {
    const g = generated(2);
    run(g, 730);
    const nodes = [...g.world.track.nodes].filter(([, n]) => n.owner !== 0);
    expect(nodes.length).toBeGreaterThan(0);
    for (const [i] of nodes) expect(g.territories.regionAt(i).restricted).toBe(false);
  });

  it('grow goodwill with good service, grant a charter and make building cheaper', () => {
    const g = generated();
    g.company.cash = 5_000_000;
    const r = g.territories.regions.find((x) => x.restricted)!;
    // Pretend the region already likes you a lot.
    r.goodwill = TERRITORIES.charterGoodwill - 0.1;
    const open = g.territories.regions.find((x) => !x.restricted)!;
    const [x, y] = spotIn(g, open)!;
    const before = g.planStation(x, y, 'station', 'x').cost;
    open.goodwill = 100;
    expect(g.planStation(x, y, 'station', 'x').cost).toBeLessThan(before);
    open.goodwill = 0;
    expect(g.planStation(x, y, 'station', 'x').cost).toBeGreaterThan(before);
    open.goodwill = 50;
    // Stations in a region with trains calling raise goodwill there.
    const a = g.buildStation(x, y, 'station', 'x').station!;
    const [x2, y2] = spotIn(g, open)!;
    const b = g.buildStation(x2 + 0, y2 + 0, 'station', 'x').station;
    if (b) {
      g.buildTrack(a.tiles[a.tiles.length - 1], b.tiles[0], defaultTrackOptions(1850));
      g.buyTrain('columbia', ['passengers'], [
        { station: a.id, load: 'auto', waitFull: false },
        { station: b.id, load: 'auto', waitFull: false },
      ]);
    }
    r.goodwill = TERRITORIES.charterGoodwill + 5;
    run(g, 32);
    expect(r.chartered).toBe(true);
    if (b) expect(open.goodwill).toBeGreaterThan(50);
  });
});
