import { describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../src/data';
import {
  defaultTrackOptions,
  gradePercent,
  planBulldoze,
  planStation,
  planTrack,
  sumBreakdown,
  tilesToMiles,
} from '../src/sim/construction';
import { Game } from '../src/sim/game';
import { defaultMapParams } from '../src/sim/mapgen';
import { coverage, catchmentRect } from '../src/sim/station';
import { NODE_BRIDGE, NODE_TUNNEL, canTurn, opposite } from '../src/sim/track';
import { F, OCC_BUILDING, T, World, encodeOccupant } from '../src/sim/world';
import { addHill, addRiver, flatWorld } from './helpers';

const opts = defaultTrackOptions(1850);

function gameOn(world: World): Game {
  return new Game({ ...defaultMapParams(1), size: world.width }, world);
}

function snapshot(w: World): string {
  const nodes = [...w.track.nodes.entries()].sort((a, b) => a[0] - b[0]);
  return JSON.stringify([Array.from(w.terrain), Array.from(w.flags), Array.from(w.occupant), nodes, w.stations, w.buildings.map((b) => b.demolished), w.cities.map((c) => c.population)]);
}

describe('track geometry', () => {
  it('limits turns to 45 degrees', () => {
    expect(canTurn(0, 0)).toBe(true);
    expect(canTurn(0, 1)).toBe(true);
    expect(canTurn(0, 7)).toBe(true);
    expect(canTurn(0, 2)).toBe(false);
    expect(canTurn(0, 4)).toBe(false);
    expect(opposite(1)).toBe(5);
  });

  it('computes grades from levels and tile lengths', () => {
    const oneLevelPerTile = (CONSTRUCTION.feetPerLevel / CONSTRUCTION.feetPerTile) * 100;
    expect(gradePercent(1, 1)).toBeCloseTo(oneLevelPerTile);
    expect(gradePercent(-1, 2)).toBeCloseTo(-oneLevelPerTile / 2);
    expect(tilesToMiles(4)).toBeCloseTo((4 * CONSTRUCTION.feetPerTile) / 5280);
  });
});

describe('track planning', () => {
  it('lays a straight line on flat land at the base price', () => {
    const w = flatWorld();
    const plan = planTrack(w, w.tileIndex(2, 5), w.tileIndex(12, 5), opts);
    expect(plan.ok).toBe(true);
    expect(plan.steps.length).toBe(10);
    expect(plan.lengthTiles).toBeCloseTo(10);
    expect(plan.maxGrade).toBe(0);
    expect(plan.cost).toBe(10 * CONSTRUCTION.track.single);
    expect(plan.cost).toBe(sumBreakdown(plan.breakdown));
  });

  it('never turns more than 45 degrees per tile', () => {
    const w = flatWorld();
    const plan = planTrack(w, w.tileIndex(3, 3), w.tileIndex(20, 25), opts);
    expect(plan.ok).toBe(true);
    for (let i = 1; i < plan.steps.length; i++) expect(canTurn(plan.steps[i - 1].dir, plan.steps[i].dir)).toBe(true);
    // Octile distance: 17 diagonal-ish + 5 straight.
    expect(plan.lengthTiles).toBeLessThan(17 * Math.SQRT2 + 6);
  });

  it('bridges a river and charges for it', () => {
    const w = flatWorld();
    addRiver(w, 10);
    const plan = planTrack(w, w.tileIndex(5, 8), w.tileIndex(15, 8), opts);
    expect(plan.ok).toBe(true);
    expect(plan.bridges).toBe(1);
    expect(plan.breakdown.bridges).toBeGreaterThan(0);
    const noBridge = planTrack(w, w.tileIndex(5, 8), w.tileIndex(15, 8), { ...opts, bridge: 'steel' });
    expect(noBridge.ok).toBe(false); // steel not available in 1850
  });

  it('refuses to cross open sea wider than any bridge', () => {
    const w = flatWorld();
    for (let y = 0; y < 32; y++) for (let x = 10; x < 25; x++) w.terrain[w.tileIndex(x, y)] = T.Water;
    const plan = planTrack(w, w.tileIndex(5, 8), w.tileIndex(28, 8), opts);
    expect(plan.ok).toBe(false);
    expect(plan.error).toBeTruthy();
  });

  it('prefers going around a hill to steep grades, or tunnels through when allowed', () => {
    const w = flatWorld(40);
    addHill(w, 20, 20, 8);
    const around = planTrack(w, w.tileIndex(4, 20), w.tileIndex(36, 20), { ...opts, tunnels: false });
    expect(around.ok).toBe(true);
    expect(around.maxGrade).toBeLessThan(gradePercent(1, 1) + 0.01);
    const through = planTrack(w, w.tileIndex(4, 20), w.tileIndex(36, 20), { ...opts, tunnels: true });
    expect(through.ok).toBe(true);
    expect(through.lengthTiles).toBeLessThanOrEqual(around.lengthTiles + 1e-9);
  });

  it('avoids industries and needs permission to demolish buildings', () => {
    const w = flatWorld();
    for (let y = 0; y < 32; y++) {
      w.buildings.push({ id: y, cityId: 0, x: 10, y, defId: 'house', wall: 'cream', roof: 'tile', h: 9, pair: false });
      w.occupant[w.tileIndex(10, y)] = encodeOccupant(OCC_BUILDING, y);
    }
    w.cities.push({ id: 0, name: 'Testville', x: 10, y: 16, population: 3200, classIndex: 1, radius: 16, buildingIds: w.buildings.map((b) => b.id) });
    const blocked = planTrack(w, w.tileIndex(5, 8), w.tileIndex(15, 8), { ...opts, demolish: false });
    expect(blocked.ok).toBe(false);
    const through = planTrack(w, w.tileIndex(5, 8), w.tileIndex(15, 8), opts);
    expect(through.ok).toBe(true);
    expect(through.demolished.length).toBe(1);
    expect(through.breakdown.demolition).toBe(CONSTRUCTION.track.demolish.house);
  });

  it('reuses existing track cheaply and charges for double-track upgrades', () => {
    const w = flatWorld();
    const g = gameOn(w);
    expect(g.buildTrack(w.tileIndex(2, 5), w.tileIndex(20, 5), opts).ok).toBe(true);
    const again = planTrack(w, w.tileIndex(2, 5), w.tileIndex(20, 5), opts);
    expect(again.cost).toBe(0);
    const dbl = planTrack(w, w.tileIndex(2, 5), w.tileIndex(20, 5), { ...opts, double: true });
    expect(dbl.breakdown.doubling).toBe(18 * CONSTRUCTION.track.doubleExtra);
    expect(dbl.newTiles).toBe(0);
  });

  it('only joins existing track without hairpins', () => {
    const w = flatWorld();
    const g = gameOn(w);
    g.buildTrack(w.tileIndex(5, 10), w.tileIndex(15, 10), opts);
    const branch = planTrack(w, w.tileIndex(15, 10), w.tileIndex(25, 20), opts);
    expect(branch.ok).toBe(true);
    // First move leaving the east end must keep heading roughly east.
    expect([7, 0, 1]).toContain(branch.steps[0].dir);
  });
});

describe('construction commands', () => {
  it('builds bridges with interior nodes and deducts cash', () => {
    const w = flatWorld();
    addRiver(w, 10);
    const g = gameOn(w);
    const cash = g.company.cash;
    const r = g.buildTrack(w.tileIndex(5, 8), w.tileIndex(15, 8), opts);
    expect(r.ok).toBe(true);
    expect(g.company.cash).toBe(cash - r.cost);
    expect(w.track.get(10, 8)!.kind).toBe(NODE_BRIDGE);
    expect(g.company.spentIn(1850, 'bridges')).toBeGreaterThan(0);
  });

  it('builds tunnels (when worth it) whose interior nodes keep the terrain', () => {
    const w = flatWorld(40);
    addHill(w, 20, 20, 8);
    const terrainBefore = Array.from(w.heights);
    const g = gameOn(w);
    const saved = CONSTRUCTION.tunnel.perTile;
    CONSTRUCTION.tunnel.perTile = 1000; // make boring cheap so the planner prefers it
    try {
      const r = g.buildTrack(w.tileIndex(4, 20), w.tileIndex(36, 20), { ...opts, tunnels: true });
      expect(r.ok).toBe(true);
      expect(r.plan.tunnels).toBeGreaterThan(0);
      expect(g.company.spentIn(1850, 'tunnels')).toBeGreaterThan(0);
      const interior = [...w.track.nodes.values()].filter((n) => n.kind === NODE_TUNNEL);
      expect(interior.length).toBeGreaterThan(0);
      for (const n of interior) expect(n.conn).toBeGreaterThan(0);
      expect(Array.from(w.heights)).toEqual(terrainBefore);
      // Tunnels keep grades gentle compared with climbing over the top.
      expect(r.plan.maxGrade).toBeLessThan(gradePercent(1, 1));
    } finally {
      CONSTRUCTION.tunnel.perTile = saved;
    }
  });

  it('refuses work it cannot afford', () => {
    const w = flatWorld();
    const g = gameOn(w);
    g.company.cash = 1000;
    const r = g.buildTrack(w.tileIndex(2, 5), w.tileIndex(20, 5), opts);
    expect(r.ok).toBe(false);
    expect(w.track.size).toBe(0);
    expect(g.company.cash).toBe(1000);
  });

  it('undo restores the world and refunds in full', () => {
    const w = flatWorld();
    w.terrain[w.tileIndex(8, 5)] = T.Forest;
    w.flags[w.tileIndex(9, 5)] |= F.Tree;
    addRiver(w, 12);
    const g = gameOn(w);
    const before = snapshot(w);
    const cash = g.company.cash;
    g.buildTrack(w.tileIndex(2, 5), w.tileIndex(20, 5), opts);
    g.buildStation(4, 5, 'station', 'x');
    expect(snapshot(w)).not.toBe(before);
    expect(g.undo().ok).toBe(true);
    expect(g.undo().ok).toBe(true);
    expect(snapshot(w)).toBe(before);
    expect(g.company.cash).toBe(cash);
    expect(g.undo().ok).toBe(false);
  });

  it('expires undo after the configured number of days', () => {
    const w = flatWorld();
    const g = gameOn(w);
    g.buildTrack(w.tileIndex(2, 5), w.tileIndex(6, 5), opts);
    expect(g.undoable).toBeDefined();
    for (let i = 0; i < (CONSTRUCTION.undo.windowDays + 2) * 24; i++) g.step();
    expect(g.undoable).toBeUndefined();
  });

  it('bulldozes track, whole spans, and stations separately', () => {
    const w = flatWorld();
    addRiver(w, 10);
    const g = gameOn(w);
    g.buildTrack(w.tileIndex(5, 8), w.tileIndex(15, 8), opts);
    const plan = planBulldoze(w, [w.tileIndex(11, 8)]);
    expect(plan.tiles).toContain(w.tileIndex(10, 8)); // touches the bridge → whole span
    expect(g.bulldoze([w.tileIndex(11, 8)]).ok).toBe(true);
    expect(w.track.get(10, 8)).toBeUndefined();
    expect(w.track.get(9, 8)!.conn & (1 << 0)).toBe(0);

    g.buildStation(6, 8, 'depot', 'x');
    expect(w.liveStations().length).toBe(1);
    g.bulldoze([w.tileIndex(6, 8)]);
    expect(w.liveStations().length).toBe(0);
    expect(w.track.get(6, 8)).toBeDefined(); // track stays
  });
});

describe('stations', () => {
  it('plans footprints along the axis with catchment by size', () => {
    const w = flatWorld();
    const p = planStation(w, 10, 10, 'terminal', 'y');
    expect(p.ok).toBe(true);
    expect(p.tiles).toEqual([w.tileIndex(10, 9), w.tileIndex(10, 10), w.tileIndex(10, 11)]);
    expect(p.rect).toEqual([6, 5, 14, 15]);
    expect(p.cost).toBe(120000 + 3 * CONSTRUCTION.track.single);
  });

  it('rejects water and crooked track, and prices demolition of buildings', () => {
    const w = flatWorld();
    w.terrain[w.tileIndex(3, 3)] = T.Water;
    expect(planStation(w, 3, 3, 'depot', 'x').ok).toBe(false);
    w.buildings.push({ id: 0, cityId: 0, x: 20, y: 20, defId: 'shop', wall: 'brick', roof: 'slate', h: 12, pair: false });
    w.occupant[w.tileIndex(20, 20)] = encodeOccupant(OCC_BUILDING, 0);
    w.cities.push({ id: 0, name: 'Shopton', x: 20, y: 20, population: 500, classIndex: 0, radius: 2, buildingIds: [0] });
    const inTown = planStation(w, 20, 20, 'depot', 'x');
    expect(inTown.ok).toBe(true);
    expect(inTown.breakdown.demolition).toBe(CONSTRUCTION.track.demolish.shop);
    const g = gameOn(w);
    g.buildTrack(w.tileIndex(10, 2), w.tileIndex(10, 20), opts);
    expect(planStation(w, 10, 10, 'station', 'x').ok).toBe(false);
    expect(planStation(w, 10, 10, 'station', 'y').ok).toBe(true);
  });

  it('builds on existing track, names after the nearest town and reports coverage', () => {
    const w = flatWorld();
    w.buildings.push({ id: 0, cityId: 0, x: 12, y: 10, defId: 'house', wall: 'cream', roof: 'tile', h: 9, pair: false });
    w.buildings.push({ id: 1, cityId: 0, x: 25, y: 25, defId: 'house', wall: 'cream', roof: 'tile', h: 9, pair: false });
    w.occupant[w.tileIndex(12, 10)] = encodeOccupant(OCC_BUILDING, 0);
    w.occupant[w.tileIndex(25, 25)] = encodeOccupant(OCC_BUILDING, 1);
    w.cities.push({ id: 0, name: 'Testville', x: 12, y: 10, population: 1000, classIndex: 0, radius: 15, buildingIds: [0, 1] });
    w.industries.push({ id: 0, defId: 'coal_mine', name: 'Testville Coal Mine', x: 8, y: 12, w: 2, h: 2, cityId: 0 });
    const g = gameOn(w);
    const r = g.buildStation(10, 10, 'station', 'x');
    expect(r.ok).toBe(true);
    expect(r.station!.name).toBe('Testville');
    const cov = coverage(w, catchmentRect(w, r.station!.tiles, 3));
    expect(cov.cities[0].covered).toBe(1);
    expect(cov.cities[0].population).toBe(500);
    expect(cov.industries.map((i) => i.id)).toEqual([0]);
    const second = g.buildStation(20, 20, 'depot', 'x');
    expect(second.station!.name).toBe('Testville Junction');
  });
});
