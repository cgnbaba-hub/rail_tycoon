import { describe, expect, it } from 'vitest';
import { ADVISOR, TIME } from '../src/data';
import { advise } from '../src/sim/advisor';
import { defaultTrackOptions } from '../src/sim/construction';
import { selectTrains, sellTrains, upgradeEngines } from '../src/sim/fleet';
import { Game } from '../src/sim/game';
import { defaultMapParams } from '../src/sim/mapgen';
import { computeOverlay, windowSum } from '../src/sim/overlays';
import { annualProfit, type RouteStop } from '../src/sim/train';
import { addHill, addIndustry, addTown, flatWorld } from './helpers';

const DAY = TIME.ticksPerDay;
const opts = defaultTrackOptions(1850);

function run(g: Game, days: number): void {
  for (let i = 0; i < days * DAY; i++) g.step();
}

function route(a: number, b: number): RouteStop[] {
  return [
    { station: a, load: 'auto', waitFull: false },
    { station: b, load: 'auto', waitFull: false },
  ];
}

/** Two towns joined by single track, with one train each way. */
function line(trains = 2) {
  const w = flatWorld(48);
  addTown(w, 'Westford', 4, 16, 6000);
  addTown(w, 'Eastburg', 40, 16, 6000);
  const g = new Game({ ...defaultMapParams(1), size: w.width }, w, { wrecks: false });
  g.company.cash = 5_000_000;
  const a = g.buildStation(6, 20, 'station', 'x').station!;
  const b = g.buildStation(42, 20, 'station', 'x').station!;
  expect(g.buildTrack(w.tileIndex(7, 20), w.tileIndex(42, 20), { ...opts, tunnels: false }).ok).toBe(true);
  const ids: number[] = [];
  for (let k = 0; k < trains; k++) ids.push(g.buyTrain('columbia', ['passengers', 'passengers', 'mail'], k % 2 ? route(b.id, a.id) : route(a.id, b.id)).train!.id);
  return { w, g, a, b, ids };
}

describe('statistics', () => {
  it('samples every month and adds up to the yearly books', () => {
    const { g, a } = line();
    run(g, 200);
    const s = g.stats.samples;
    expect(s.length).toBe(6);
    expect(s.map((x) => x.month)).toEqual([0, 1, 2, 3, 4, 5]);
    const rev = s.reduce((sum, x) => sum + Object.values(x.companies[0].revenue).reduce((p, q) => p + q, 0), 0);
    const since = [...g.company.sampleRevenue.values()].reduce((p, q) => p + q, 0);
    expect(rev + since).toBeCloseTo(g.company.revenueIn(1850), -1);
    const st = s.reduce((sum, x) => sum + (x.stations[a.id] ?? 0), 0) + g.economy.cargoAt(a.id).revenueSample;
    expect(st).toBeCloseTo(g.economy.cargoAt(a.id).revenue, -1);
    expect(s[5].worth.player).toBeGreaterThan(0);
    expect(s[5].companies[0].marketCap).toBeGreaterThan(0);
  });

  it('tracks each train\'s monthly profit and load factor', () => {
    const { g, ids } = line();
    run(g, 200);
    for (const id of ids) {
      const t = g.trains.byId(id)!;
      expect(t.stats.months.length).toBe(6);
      const months = t.stats.months.reduce((p, q) => p + q, 0) + t.stats.monthNet;
      expect(months).toBeCloseTo(t.stats.revenue - t.stats.costs, 0);
      expect(annualProfit(t)).toBeCloseTo((t.stats.months.reduce((p, q) => p + q, 0) * 12) / 6, 6);
      expect(t.stats.departures).toBeGreaterThan(2);
      expect(t.stats.loadFactor).toBeGreaterThan(0);
      expect(t.stats.loadFactor).toBeLessThanOrEqual(1);
    }
  });
});

describe('overlays', () => {
  it('window sums match a brute-force count', () => {
    const src = new Float32Array(25);
    src[0] = 1;
    src[12] = 2;
    src[24] = 4;
    const s = windowSum(src, 5, 5, 1);
    expect(s[0]).toBe(1);
    expect(s[6]).toBe(3);
    expect(s[12]).toBe(2);
    expect(s[18]).toBe(6);
    expect(s[2]).toBe(0);
  });

  it('show supply near producers and demand near consumers', () => {
    const w = flatWorld(48);
    addTown(w, 'Westford', 4, 16, 6000);
    addIndustry(w, 'coal_mine', 30, 30);
    addIndustry(w, 'steel_mill', 30, 4);
    const g = new Game({ ...defaultMapParams(1), size: w.width }, w);
    const pax = computeOverlay(g, 'supply', 'passengers');
    expect(pax.values[w.tileIndex(5, 17)]).toBeGreaterThan(0);
    expect(Number.isNaN(pax.values[w.tileIndex(40, 40)])).toBe(true);
    const coal = computeOverlay(g, 'supply', 'coal');
    expect(coal.values[w.tileIndex(31, 31)]).toBeGreaterThan(0);
    expect(Number.isNaN(coal.values[w.tileIndex(5, 17)])).toBe(true);
    const wants = computeOverlay(g, 'demand', 'coal');
    expect(wants.values[w.tileIndex(31, 5)]).toBeGreaterThan(0);
    expect(Number.isNaN(wants.values[w.tileIndex(31, 31)])).toBe(true);
    expect(coal.max).toBeGreaterThan(0);
  });

  it('show traffic, route profit and congestion on track and grades on hills', () => {
    const { g, w } = line(4);
    run(g, 120);
    const traffic = computeOverlay(g, 'traffic');
    expect(traffic.values[w.tileIndex(24, 20)]).toBeGreaterThan(0);
    expect(Number.isNaN(traffic.values[w.tileIndex(24, 30)])).toBe(true);
    const profit = computeOverlay(g, 'profit');
    expect(Number.isFinite(profit.values[w.tileIndex(24, 20)])).toBe(true);
    expect(profit.diverging).toBe(true);
    // Four trains on one single-track line have to wait for each other.
    const cong = computeOverlay(g, 'congestion');
    expect(cong.max).toBeGreaterThan(0);
    const flat = computeOverlay(g, 'gradient');
    expect(flat.values[w.tileIndex(24, 20)]).toBe(0);
    const hilly = flatWorld(32);
    addHill(hilly, 16, 16, 4);
    const h = new Game({ ...defaultMapParams(1), size: 32 }, hilly);
    expect(computeOverlay(h, 'gradient').values[hilly.tileIndex(14, 16)]).toBeGreaterThan(0);
  });

  it('count stations covering each tile', () => {
    const { g, w } = line(0);
    const c = computeOverlay(g, 'catchment');
    expect(c.values[w.tileIndex(6, 20)]).toBe(1);
    expect(Number.isNaN(c.values[w.tileIndex(24, 40)])).toBe(true);
  });
});

describe('advisor', () => {
  it('points out idle stations and waiting cargo', () => {
    const { g, a } = line(0);
    run(g, 120);
    const keys = advise(g).map((x) => x.key);
    expect(keys).toContain(`idle:${a.id}`);
    expect(g.economy.cargoAt(a.id).waiting.passengers).toBeGreaterThanOrEqual(ADVISOR.waitingLoads);
    expect(keys).toContain(`wait:${a.id}:passengers`);
  });

  it('warns about money, rival stakes and broken routes, most urgent first', () => {
    const { g, w, ids } = line(1);
    expect(g.bulldoze([w.tileIndex(24, 20)]).ok).toBe(true);
    run(g, 3);
    g.company.cash = -10;
    g.company.transferShares('public', 'ai:9', Math.round(g.company.shares * 0.35));
    const advice = advise(g);
    const keys = advice.map((x) => x.key);
    expect(keys).toContain('cash:neg');
    expect(keys).toContain('stake:ai:9');
    expect(keys).toContain(`noroute:${ids[0]}`);
    expect(advice[0].severity).toBe(2);
    for (let i = 1; i < advice.length; i++) expect(advice[i - 1].severity).toBeGreaterThanOrEqual(advice[i].severity);
  });

  it('flags trains that lose money', () => {
    const { g, ids } = line(1);
    const t = g.trains.byId(ids[0])!;
    t.stats.months.push(-5000, -5000, -5000, -5000, -5000, -5000);
    expect(advise(g).map((x) => x.key)).toContain(`loss:${t.id}`);
  });
});

describe('route templates', () => {
  it('copy a train\'s engine, cars and route, optionally reversed', () => {
    const { g, a, b, ids } = line(1);
    const tpl = g.saveTemplate(ids[0])!;
    expect(tpl.name).toContain('Westford');
    const r = g.buyFromTemplate(tpl.id);
    expect(r.ok).toBe(true);
    expect(r.train!.cars.map((c) => c.cargo)).toEqual(['passengers', 'passengers', 'mail']);
    expect(r.train!.route.map((x) => x.station)).toEqual([a.id, b.id]);
    const rev = g.buyFromTemplate(tpl.id, true);
    expect(rev.train!.route.map((x) => x.station)).toEqual([b.id, a.id]);
    // The template is a copy: editing the train doesn't change it.
    g.setRoute(ids[0], route(b.id, a.id));
    expect(tpl.route[0].station).toBe(a.id);
    expect(g.deleteTemplate(tpl.id)).toBe(true);
    expect(g.buyFromTemplate(tpl.id).ok).toBe(false);
  });
});

describe('fleet', () => {
  it('selects old trains and upgrades or sells them in bulk', () => {
    const { g, ids } = line(3);
    const t = g.trains.byId(ids[0])!;
    t.engineBuiltTick -= 30 * 365 * DAY;
    expect(selectTrains(g, { olderThan: 25 }).map((x) => x.id)).toEqual([t.id]);
    expect(selectTrains(g, { pastLifespan: true }).map((x) => x.id)).toEqual([t.id]);
    const cash = g.company.cash;
    const up = upgradeEngines(g, [t.id]);
    expect(up.done).toBe(1);
    expect(g.company.cash).toBeCloseTo(cash - up.cost, 6);
    expect(selectTrains(g, { olderThan: 25 })).toHaveLength(0);
    const sold = sellTrains(g, [ids[1], ids[2], 999]);
    expect(sold.done).toBe(2);
    expect(sold.failed).toBe(1);
    expect(g.trains.trains).toHaveLength(1);
  });
});
