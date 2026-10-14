import { describe, expect, it } from 'vitest';
import { ECONOMY, ENGINE_BY_ID, TIME } from '../src/data';
import { defaultTrackOptions } from '../src/sim/construction';
import { quoteRevenue, timeFactor } from '../src/sim/economy';
import { Game } from '../src/sim/game';
import { defaultMapParams } from '../src/sim/mapgen';
import { findTrainPath } from '../src/sim/routing';
import {
  accelerationPerTick,
  balanceSpeed,
  breakdownChance,
  stoppingDistance,
  tractiveEffort,
  trainTons,
  type RouteStop,
} from '../src/sim/train';
import { CARGO_BY_ID } from '../src/data';
import { World } from '../src/sim/world';
import { addHill, addTown, flatWorld } from './helpers';

const DAY = TIME.ticksPerDay;
const opts = defaultTrackOptions(1850);

/** Two towns 30 tiles apart, each with a station, joined by track. */
function line(options: { double?: boolean; hill?: boolean; size?: number } = {}) {
  const w = flatWorld(options.size ?? 48);
  if (options.hill) addHill(w, 24, 21, 6);
  addTown(w, 'Westford', 4, 16, 6000);
  addTown(w, 'Eastburg', 40, 16, 6000);
  const g = new Game({ ...defaultMapParams(1), size: w.width }, w, { wrecks: false });
  g.company.cash = 5_000_000;
  const a = g.buildStation(6, 20, 'station', 'x');
  const b = g.buildStation(42, 20, 'station', 'x');
  expect(a.ok && b.ok).toBe(true);
  const t = g.buildTrack(w.tileIndex(7, 20), w.tileIndex(42, 20), { ...opts, double: !!options.double, tunnels: false });
  expect(t.ok).toBe(true);
  return { w, g, a: a.station!, b: b.station! };
}

function route(a: number, b: number): RouteStop[] {
  return [
    { station: a, load: 'auto', waitFull: false },
    { station: b, load: 'auto', waitFull: false },
  ];
}

function run(g: Game, days: number, each?: () => void): void {
  for (let i = 0; i < days * DAY; i++) {
    g.step();
    each?.();
  }
}

describe('train physics', () => {
  const columbia = ENGINE_BY_ID.get('columbia')!;
  const cars = Array.from({ length: 5 }, () => ({ type: 'hopper', cargo: 'coal', loads: 1 }));

  it('weighs engine, tare and cargo', () => {
    expect(trainTons(columbia, cars)).toBe(columbia.weight + 5 * (13 + 40));
    expect(trainTons(columbia, [])).toBe(columbia.weight);
  });

  it('limits tractive effort by adhesion at low speed and by power at high speed', () => {
    expect(tractiveEffort(columbia, 1)).toBeCloseTo(columbia.adhesion * 2000 * ECONOMY.physics.adhesionCoefficient);
    expect(tractiveEffort(columbia, 40)).toBeCloseTo((columbia.power * 375) / 40);
  });

  it('grades and heavy loads cut the sustainable speed', () => {
    const light = trainTons(columbia, cars.map((c) => ({ ...c, loads: 0 })));
    const heavy = trainTons(columbia, cars);
    expect(balanceSpeed(columbia, light, 0)).toBe(columbia.topSpeed);
    expect(balanceSpeed(columbia, heavy, 2)).toBeLessThan(balanceSpeed(columbia, heavy, 0));
    expect(balanceSpeed(columbia, heavy, 2)).toBeLessThan(balanceSpeed(columbia, light, 2));
    expect(accelerationPerTick(columbia, heavy, 10, 0)).toBeGreaterThan(0);
    expect(accelerationPerTick(columbia, heavy, 10, 4.5)).toBeLessThan(0);
  });

  it('needs longer to stop when faster', () => {
    expect(stoppingDistance(0)).toBe(0);
    expect(stoppingDistance(60)).toBeGreaterThan(stoppingDistance(30));
  });
});

describe('revenue formula', () => {
  it('pays more for longer hauls', () => {
    const near = quoteRevenue('coal', 1, 10, 1, true, 'basic');
    const far = quoteRevenue('coal', 1, 60, 1, true, 'basic');
    expect(far.total).toBeGreaterThan(near.total);
    expect(near.distancePay).toBeCloseTo(CARGO_BY_ID.get('coal')!.base + CARGO_BY_ID.get('coal')!.perMile * 2.5);
  });

  it('perishable cargo loses value when late, bulk does not', () => {
    const pax = CARGO_BY_ID.get('passengers')!;
    const coal = CARGO_BY_ID.get('coal')!;
    expect(timeFactor(pax, 1, 20)).toBe(1);
    expect(timeFactor(pax, 40, 20)).toBeLessThan(0.5);
    expect(timeFactor(pax, 400, 20)).toBe(ECONOMY.timeValue.minFactor);
    expect(timeFactor(coal, 400, 20)).toBe(1);
  });

  it('pays less for undemanded cargo, depending on the economic model', () => {
    const yes = quoteRevenue('goods', 1, 40, 2, true, 'advanced').total;
    expect(quoteRevenue('goods', 1, 40, 2, false, 'basic').total).toBeCloseTo(yes * 0.75, -1);
    expect(quoteRevenue('goods', 1, 40, 2, false, 'advanced').total).toBeCloseTo(yes * 0.5, -1);
    expect(quoteRevenue('goods', 1, 40, 2, false, 'expert').total).toBeLessThan(yes * 0.2);
  });
});

describe('breakdowns', () => {
  it('get likelier with age and less reliable engines', () => {
    const good = ENGINE_BY_ID.get('tenwheeler')!;
    const bad = ENGINE_BY_ID.get('cricket')!;
    expect(breakdownChance(good, 20)).toBeGreaterThan(breakdownChance(good, 0));
    expect(breakdownChance(bad, 0)).toBeGreaterThan(breakdownChance(good, 0));
  });
});

describe('train routing', () => {
  it('finds paths along track and never turns sharper than 45°', () => {
    const w = flatWorld(30);
    const g = new Game({ ...defaultMapParams(1), size: 30 }, w);
    g.company.cash = 1e7;
    g.buildTrack(w.tileIndex(2, 10), w.tileIndex(20, 10), opts);
    // A spur leaving at a right angle can't be reached from the main line without a turn.
    g.buildTrack(w.tileIndex(10, 11), w.tileIndex(10, 20), opts);
    const p = findTrainPath(w, w.tileIndex(2, 10), 0, new Set([w.tileIndex(20, 10)]));
    expect(p).not.toBeNull();
    expect(p!.nodes.length).toBe(19);
    expect(findTrainPath(w, w.tileIndex(2, 10), 0, new Set([w.tileIndex(10, 20)]))).toBeNull();
  });
});

describe('running trains', () => {
  it('carries passengers between towns, earns revenue and pays running costs', () => {
    const { g, a, b } = line();
    const r = g.buyTrain('columbia', ['passengers', 'passengers', 'mail'], route(a.id, b.id));
    expect(r.ok).toBe(true);
    run(g, 120);
    const t = g.trains.byId(r.train!.id)!;
    expect(t.stats.deliveries).toBeGreaterThan(6);
    expect(t.stats.revenue).toBeGreaterThan(0);
    expect(g.company.spentIn(1850, 'fuel')).toBeGreaterThan(0);
    expect(g.company.spentIn(1850, 'maintenance')).toBeGreaterThan(0);
    expect(g.company.spentIn(1850, 'trackMaintenance')).toBeGreaterThan(0);
    expect(g.company.revenueIn(1850)).toBe(t.stats.revenue);
  });

  it('keeps opposing trains apart on single track without deadlocking', () => {
    const { g, w, a, b } = line();
    const t1 = g.buyTrain('columbia', ['passengers', 'passengers'], route(a.id, b.id)).train!;
    const t2 = g.buyTrain('columbia', ['passengers', 'passengers'], route(b.id, a.id)).train!;
    let maxHolders = 0;
    run(g, 150, () => {
      for (const [node, holders] of g.trains.signals.nodes) {
        if (w.track.getIdx(node)?.station !== -1) continue;
        maxHolders = Math.max(maxHolders, holders.size);
      }
      // Never two trains on the single track between the stations at once.
      const onLine = [t1, t2].filter((t) => {
        const [x, y] = g.trains.headPosition(t);
        return (w.track.get(Math.floor(x), Math.floor(y))?.station ?? -1) < 0;
      });
      expect(onLine.length).toBeLessThan(2);
    });
    expect(maxHolders).toBeLessThanOrEqual(1);
    expect(t1.stats.deliveries).toBeGreaterThan(3);
    expect(t2.stats.deliveries).toBeGreaterThan(3);
  });

  it('lets trains pass each other on double track', () => {
    const { g, a, b } = line({ double: true });
    const t1 = g.buyTrain('columbia', ['passengers'], route(a.id, b.id)).train!;
    const t2 = g.buyTrain('columbia', ['passengers'], route(b.id, a.id)).train!;
    let bothMoving = false;
    run(g, 40, () => {
      if (t1.state === 'running' && t2.state === 'running') bothMoving = true;
    });
    expect(bothMoving).toBe(true);
  });

  it('is slower over hills than on the flat', () => {
    const tripDays = (hill: boolean) => {
      const { g, a, b } = line({ hill });
      const t = g.buyTrain('cricket', ['coal', 'coal', 'coal'], [
        { station: a.id, load: 'keep', waitFull: false },
        { station: b.id, load: 'keep', waitFull: false },
      ]).train!;
      // Load the cars artificially so the train is heavy.
      t.cars.forEach((c) => (c.loads = 1));
      let arrived = -1;
      for (let i = 0; i < 200 * DAY && arrived < 0; i++) {
        g.step();
        if (t.state === 'loading' && t.stop === 1 && i > DAY) arrived = i;
      }
      return arrived;
    };
    const flat = tripDays(false);
    const hilly = tripDays(true);
    expect(flat).toBeGreaterThan(0);
    expect(hilly).toBeGreaterThan(flat);
  });

  it('protects track in use from bulldozing and undo', () => {
    const { g, w, a, b } = line();
    g.buyTrain('columbia', ['passengers'], route(a.id, b.id));
    run(g, 3);
    const r = g.bulldoze([...w.track.nodes.keys()]);
    expect(r.ok).toBe(false);
  });

  it('sells, upgrades, duplicates and re-routes trains', () => {
    const { g, a, b } = line();
    const t = g.buyTrain('cricket', ['passengers'], route(a.id, b.id)).train!;
    const cash = g.company.cash;
    run(g, 5);
    expect(g.upgradeEngine(t.id).ok).toBe(true);
    expect(t.engine).not.toBe('cricket');
    const dup = g.duplicateTrain(t.id);
    expect(dup.ok).toBe(true);
    expect(g.trains.trains.length).toBe(2);
    expect(g.setRoute(t.id, route(b.id, a.id)).ok).toBe(true);
    expect(g.setConsist(t.id, ['passengers', 'mail']).ok).toBe(true);
    expect(t.cars.length).toBe(2);
    const before = g.company.cash;
    expect(g.sellTrain(t.id).ok).toBe(true);
    expect(g.company.cash).toBeGreaterThan(before);
    expect(g.trains.trains.length).toBe(1);
    expect(cash).toBeGreaterThan(0);
  });

  it('rejects invalid purchases', () => {
    const { g, a, b } = line();
    expect(g.buyTrain('pacific', ['coal'], route(a.id, b.id)).ok).toBe(false); // not invented yet
    expect(g.buyTrain('cricket', ['coal', 'coal', 'coal', 'coal', 'coal'], route(a.id, b.id)).ok).toBe(false);
    expect(g.buyTrain('cricket', ['coal'], route(a.id, a.id).slice(0, 1)).ok).toBe(false);
  });

  it('is deterministic', () => {
    const runOnce = () => {
      const { g, a, b } = line();
      g.settings.wrecks = true;
      g.buyTrain('columbia', ['passengers', 'mail'], route(a.id, b.id));
      g.buyTrain('patriot', ['passengers'], route(b.id, a.id));
      run(g, 200);
      return [Math.round(g.company.cash), ...g.trains.trains.map((t) => t.odometer.toFixed(3))].join('|');
    };
    expect(runOnce()).toBe(runOnce());
  });

  it('feeds processing industries which then ship their output', () => {
    const w = flatWorld(48);
    addTown(w, 'Millton', 40, 12, 3000);
    w.industries.push({ id: 0, defId: 'coal_mine', name: 'Pit', x: 4, y: 16, w: 2, h: 2, cityId: 0 });
    w.industries.push({ id: 1, defId: 'steel_mill', name: 'Works', x: 40, y: 22, w: 2, h: 2, cityId: 0 });
    void World;
    const g = new Game({ ...defaultMapParams(1), size: 48 }, w, { wrecks: false, model: 'advanced' });
    g.company.cash = 5e6;
    const a = g.buildStation(6, 20, 'station', 'x').station!;
    const b = g.buildStation(42, 20, 'station', 'x').station!;
    g.buildTrack(w.tileIndex(7, 20), w.tileIndex(42, 20), opts);
    expect(g.economy.station(a.id)!.supply.coal).toBeGreaterThan(0);
    expect(g.economy.accepts(b.id, 'coal')).toBe(true);
    g.buyTrain('columbia', ['coal', 'coal', 'coal'], [
      { station: a.id, load: 'keep', waitFull: true },
      { station: b.id, load: 'keep', waitFull: false },
    ]);
    run(g, 150);
    expect(g.economy.cargoAt(b.id).delivered.coal).toBeGreaterThan(0);
    expect(g.economy.cargoAt(b.id).waiting.steel ?? 0).toBeGreaterThan(0);
  });
});

describe('estimates', () => {
  it('estimates a connected route close to what a train actually earns', async () => {
    const { estimateTrain } = await import('../src/sim/estimate');
    const { g, a, b } = line();
    const r = route(a.id, b.id);
    const cargos = ['passengers', 'passengers', 'mail'];
    // Let supply build up a little first, as in a real game.
    run(g, 30);
    const est = estimateTrain(g, 'columbia', cargos, r, 30000);
    expect(est.ok).toBe(true);
    expect(est.legs.length).toBe(2);
    expect(est.roundTripDays).toBeGreaterThan(5);
    expect(est.revenuePerYear).toBeGreaterThan(0);
    const t = g.buyTrain('columbia', cargos, r).train!;
    run(g, 365);
    const actual = t.stats.revenue + t.stats.lastRevenue;
    expect(actual).toBeGreaterThan(est.revenuePerYear * 0.4);
    expect(actual).toBeLessThan(est.revenuePerYear * 2.5);
  });

  it('reports unconnected stations and previews new connections', async () => {
    const { estimateTrain, estimateConnection } = await import('../src/sim/estimate');
    const w = flatWorld(48);
    addTown(w, 'A', 4, 16, 6000);
    addTown(w, 'B', 40, 16, 6000);
    const g = new Game({ ...defaultMapParams(1), size: 48 }, w);
    g.company.cash = 1e7;
    const a = g.buildStation(6, 20, 'station', 'x').station!;
    const b = g.buildStation(42, 20, 'station', 'x').station!;
    const est = estimateTrain(g, 'columbia', ['passengers'], route(a.id, b.id));
    expect(est.ok).toBe(false);
    expect(est.error).toMatch(/not connected/);
    const preview = estimateConnection(g, a.id, b.id, 36, 0);
    expect(preview?.ok).toBe(true);
    expect(preview!.profitPerYear).toBeGreaterThan(0);
  });
});

describe('signalling under load', () => {
  function longestWait(g: Game, days: number): number {
    let worst = 0;
    run(g, days, () => {
      for (const t of g.trains.trains) if (t.state === 'signal') worst = Math.max(worst, g.tick - t.waitSince);
    });
    return worst / DAY;
  }

  it('keeps a busy single-track line moving in both directions', () => {
    const { g, a, b } = line();
    const trains = [0, 1, 2, 3, 4, 5].map((i) => g.buyTrain('columbia', ['passengers'], i % 2 ? route(b.id, a.id) : route(a.id, b.id)).train!);
    const worst = longestWait(g, 200);
    expect(worst).toBeLessThan(40);
    for (const t of trains) expect(t.odometer).toBeGreaterThan(150);
  });

  it('never gridlocks a dense double-track network with junctions', () => {
    const g = new Game({ ...defaultMapParams(5), size: 128 }, undefined, { wrecks: false });
    g.company.cash = 1e10;
    const towns = [...g.world.cities].sort((p, q) => q.population - p.population).slice(0, 6);
    const st = [];
    for (const town of towns) {
      for (const [dx, dy] of [[0, 3], [0, -3], [3, 0], [-3, 0], [0, 5], [5, 0]]) {
        const r = g.buildStation(town.x + dx, town.y + dy, 'terminal', 'x');
        if (r.ok) {
          st.push(r.station!);
          break;
        }
      }
    }
    expect(st.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i + 1 < st.length; i++) g.buildTrack(st[i].tiles[2], st[i + 1].tiles[0], { ...opts, double: true });
    // A cross link creates extra junctions.
    g.buildTrack(st[0].tiles[0], st[st.length - 1].tiles[2], { ...opts, double: true });
    for (let k = 0; k < 36; k++) {
      const i = k % (st.length - 1);
      const r = k % 2 ? route(st[i + 1].id, st[i].id) : route(st[i].id, st[i + 1].id);
      g.buyTrain('columbia', ['passengers', 'mail'], r);
    }
    const before = g.trains.trains.map((t) => t.odometer);
    const worst = longestWait(g, 240);
    expect(worst).toBeLessThan(60);
    // Everybody kept moving.
    g.trains.trains.forEach((t, i) => expect(t.odometer).toBeGreaterThan(before[i] + 30));
  });
});
