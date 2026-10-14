import { describe, expect, it } from 'vitest';
import { CARGO, ECONOMY, MAPGEN, TIME } from '../src/data';
import { defaultTrackOptions } from '../src/sim/construction';
import { EconomicCycle } from '../src/sim/cycle';
import { Economy, daysToRecover, quoteRevenue, recover, saturate, steadyDemand } from '../src/sim/economy';
import { Game } from '../src/sim/game';
import { addBuilding, monthlyCityGrowth } from '../src/sim/growth';
import { defaultMapParams } from '../src/sim/mapgen';
import { Rng } from '../src/sim/rng';
import { F, OCC_BUILDING, occupantKind } from '../src/sim/world';
import { cargoBonus, consistBonus, type RouteStop } from '../src/sim/train';
import { addIndustry, addTown, flatWorld } from './helpers';

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

/** Two towns 30 tiles apart, each with a station, joined by track. */
function line(model: 'basic' | 'advanced' | 'expert' = 'advanced') {
  const w = flatWorld(48);
  addTown(w, 'Westford', 4, 16, 6000);
  addTown(w, 'Eastburg', 40, 16, 6000);
  const g = new Game({ ...defaultMapParams(1), size: w.width }, w, { wrecks: false, model });
  g.company.cash = 5_000_000;
  const a = g.buildStation(6, 20, 'station', 'x');
  const b = g.buildStation(42, 20, 'station', 'x');
  expect(a.ok && b.ok).toBe(true);
  expect(g.buildTrack(w.tileIndex(7, 20), w.tileIndex(42, 20), { ...opts, tunnels: false }).ok).toBe(true);
  return { w, g, a: a.station!, b: b.station! };
}

describe('demand saturation', () => {
  it('drops with deliveries, more so in harsher models, and recovers over time', () => {
    const basic = saturate(1, 10, 10, 'basic');
    const expert = saturate(1, 10, 10, 'expert');
    expect(basic).toBeLessThan(1);
    expect(expert).toBeLessThan(basic);
    expect(saturate(1, 1000, 1, 'expert')).toBe(ECONOMY.saturation.floor);
    const half = ECONOMY.saturation.recoveryHalfLifeDays;
    expect(recover(0.5, half)).toBeCloseTo(0.75, 6);
    expect(recover(0.5, 1000)).toBeGreaterThan(0.999);
    expect(recover(0.4, daysToRecover(0.4))).toBeCloseTo(0.9, 6);
    expect(daysToRecover(0.95)).toBe(0);
  });

  it('settles at a steady level that falls with the delivery rate', () => {
    expect(steadyDemand(0, 10, 'advanced')).toBe(1);
    const light = steadyDemand(3, 10, 'advanced');
    const heavy = steadyDemand(12, 10, 'advanced');
    expect(light).toBeGreaterThan(heavy);
    expect(heavy).toBeGreaterThanOrEqual(ECONOMY.saturation.floor);
  });

  it('feeds the demand level into the revenue formula', () => {
    const full = quoteRevenue('coal', 1, 40, 2, true, 'advanced');
    const sat = quoteRevenue('coal', 1, 40, 2, true, 'advanced', { demandLevel: 0.5, economy: 1.15, bonus: 1.1 });
    expect(sat.demandFactor).toBe(0.5);
    expect(sat.total).toBeCloseTo(full.total * 0.5 * 1.15 * 1.1, -1);
  });

  it('flooding one station with passengers lowers its price, which then recovers', () => {
    const { g, a, b } = line();
    const before = g.economy.quote(b.id, 'passengers', 1, 36, 1).total;
    g.economy.deliver(b.id, 'passengers', 150, 0);
    const level = g.economy.demandLevel(b.id, 'passengers');
    expect(level).toBeLessThan(0.7);
    expect(g.economy.quote(b.id, 'passengers', 1, 36, 1).total).toBeLessThan(before * 0.75);
    // The other station is untouched.
    expect(g.economy.demandLevel(a.id, 'passengers')).toBe(1);
    const days = daysToRecover(level);
    run(g, Math.ceil(days) + 2);
    expect(g.economy.demandLevel(b.id, 'passengers')).toBeGreaterThan(0.9);
    expect(g.economy.cargoAt(b.id).history.passengers?.length).toBeGreaterThan(0);
  });
});

describe('economic cycle', () => {
  it('is deterministic for a seed', () => {
    const a = new EconomicCycle(new Rng(5));
    const b = new EconomicCycle(new Rng(5));
    for (let m = 0; m < 240; m++) {
      a.monthly(m * 30);
      b.monthly(m * 30);
    }
    expect(a.history).toEqual(b.history);
    expect(a.state).toBe(b.state);
    expect(a.news).toEqual(b.news);
  });

  it('visits several states and always warns before a change', () => {
    const c = new EconomicCycle(new Rng(9));
    const seen = new Set<string>([c.state]);
    let changes = 0;
    let warnedMonths = 0;
    for (let m = 0; m < 600; m++) {
      const wasWarning = c.warningActive;
      const nextBefore = c.next;
      warnedMonths = wasWarning ? warnedMonths + 1 : 0;
      if (c.monthly(m * 30)) {
        changes++;
        // The state that arrived is the one announced, after at least `warningMonths[0]` months of signs.
        expect(c.state).toBe(nextBefore);
        expect(warnedMonths).toBeGreaterThanOrEqual(ECONOMY.cycle.warningMonths[0] - 1);
        warnedMonths = 0;
      }
      seen.add(c.state);
    }
    expect(changes).toBeGreaterThan(10);
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('moves business confidence towards the coming state (leading indicator)', () => {
    const c = new EconomicCycle(new Rng(3));
    let checked = 0;
    for (let m = 0; m < 600 && checked < 8; m++) {
      if (c.monthsLeft === 1 && c.next !== c.state) {
        const cur = c.current.confidence;
        const nxt = c.upcoming.confidence;
        c.monthly(m * 30);
        // On the month of the change it sits at the new state's level (± noise).
        expect(Math.abs(c.confidence - nxt)).toBeLessThanOrEqual(ECONOMY.cycle.confidenceNoise + 1e-9);
        expect(Math.abs(nxt - cur)).toBeGreaterThan(0);
        checked++;
      } else if (c.warningActive && c.monthsLeft === 2) {
        const cur = c.current.confidence;
        const nxt = c.upcoming.confidence;
        c.monthly(m * 30);
        // One month before the change confidence is clearly on its way to the new level.
        expect(Math.sign(c.confidence - cur)).toBe(Math.sign(nxt - cur) || Math.sign(c.confidence - cur));
        if (Math.abs(nxt - cur) > 2 * ECONOMY.cycle.confidenceNoise) expect(Math.abs(c.confidence - nxt)).toBeLessThan(Math.abs(cur - nxt));
      } else c.monthly(m * 30);
    }
    expect(checked).toBe(8);
  });

  it('scales revenue with the state', () => {
    const { g, b } = line();
    const base = g.economy.quote(b.id, 'coal', 1, 36, 1).total;
    g.economy.cycle.state = 'boom';
    expect(g.economy.quote(b.id, 'coal', 1, 36, 1).total).toBeCloseTo(base * 1.15, -1);
    g.economy.cycle.state = 'panic';
    expect(g.economy.quote(b.id, 'coal', 1, 36, 1).total).toBeCloseTo(base * 0.75, -1);
  });
});

describe('economic models', () => {
  it('only moves cargo prices in Expert, and keeps them within bounds', () => {
    for (const model of ['advanced', 'expert'] as const) {
      const w = flatWorld(16);
      const e = new Economy(w, model, new Rng(4));
      for (let m = 0; m < 600; m++) e.monthly(m * 30);
      const levels = CARGO.map((c) => e.priceLevel[c.id]);
      if (model === 'advanced') expect(levels.every((p) => p === 1)).toBe(true);
      else {
        expect(levels.some((p) => p !== 1)).toBe(true);
        for (const p of levels) {
          expect(p).toBeGreaterThanOrEqual(ECONOMY.priceLevels.min);
          expect(p).toBeLessThanOrEqual(ECONOMY.priceLevels.max);
        }
      }
    }
  });

  it('lets processors run without inputs only in Basic', () => {
    for (const model of ['basic', 'advanced'] as const) {
      const w = flatWorld(16);
      const id = addIndustry(w, 'steel_mill', 4, 4, [3, 2]);
      const e = new Economy(w, model, new Rng(1));
      e.monthly(0);
      const out = e.industryOutputPerMonth(w.industries[id]);
      if (model === 'basic') expect(out).toBeGreaterThan(0);
      else expect(out).toBe(0);
    }
  });

  it('sells industries only in Expert and pays monthly profits to the owner', () => {
    const adv = line('advanced');
    const w0 = adv.w;
    const mine0 = addIndustry(w0, 'coal_mine', 10, 10);
    expect(adv.g.buyIndustry(mine0).ok).toBe(false);

    const { g, w } = line('expert');
    const mine = addIndustry(w, 'coal_mine', 10, 10);
    const price = g.economy.industryPrice(w.industries[mine]);
    expect(price).toBeGreaterThanOrEqual(ECONOMY.ownership.minPrice);
    const cash = g.company.cash;
    const r = g.buyIndustry(mine);
    expect(r.ok).toBe(true);
    expect(g.company.cash).toBe(cash - price);
    expect(g.buyIndustry(mine).ok).toBe(false);
    run(g, 62);
    expect(g.company.otherIncomeIn(g.year)).not.toBe(0);
    const sold = g.sellIndustry(mine);
    expect(sold.ok).toBe(true);
    expect(g.economy.owned.has(mine)).toBe(false);
  });
});

describe('city growth', () => {
  it('grows served towns faster than unserved ones', () => {
    const { w, g, a, b } = line();
    // An unserved control town of the same size, far from the line.
    const control = addTown(w, 'Lonely', 20, 36, 6000);
    g.economy.invalidate();
    for (let i = 0; i < 3; i++) g.buyTrain('columbia', ['passengers', 'passengers', 'mail'], route(a.id, b.id));
    const pop0 = w.cities.map((c) => c.population);
    run(g, 365);
    const served = w.cities[0].population / pop0[0];
    const lonely = w.cities[control].population / pop0[control];
    expect(served).toBeGreaterThan(lonely);
    expect(lonely).toBeGreaterThan(1);
    expect(w.cities[0].service ?? 0).toBeGreaterThan(0);
    expect(w.cities[control].service ?? 0).toBe(0);
  });

  it('adds buildings on free flat lots, never on track, roads or rivers', () => {
    const w = flatWorld(32);
    const city = addTown(w, 'Growtown', 14, 14, 2000);
    for (let x = 0; x < 32; x++) w.flags[w.tileIndex(x, 18)] |= F.Road;
    w.track.nodes.set(w.tileIndex(16, 12), { z: 2, conn: 0, double: 0, kind: 0, span: -1, station: -1, owner: 0 });
    const rng = new Rng(1);
    let added = 0;
    for (let i = 0; i < 30; i++) if (addBuilding(w, w.cities[city], rng)) added++;
    expect(added).toBeGreaterThan(10);
    for (const id of w.cities[city].buildingIds) {
      const bld = w.buildings[id];
      const ti = w.tileIndex(bld.x, bld.y);
      expect(occupantKind(w.occupant[ti])).toBe(OCC_BUILDING);
      expect(w.flags[ti] & (F.Road | F.River)).toBe(0);
      expect(w.track.getIdx(ti)).toBeUndefined();
    }
  });

  it('moves towns up a size class as they grow', () => {
    const w = flatWorld(40);
    const classes = MAPGEN.cities.classes;
    const city = w.cities[addTown(w, 'Boomtown', 18, 18, classes[2].popMin - 1, 1)];
    const e = new Economy(w, 'advanced', new Rng(2));
    const reports = monthlyCityGrowth(w, e, new Rng(3), 1850);
    expect(city.classIndex).toBe(2);
    expect(reports.find((r) => r.cityId === city.id)?.classUp).toBe(true);
    expect(city.buildingIds.length).toBeGreaterThan(9);
  });

  it('keeps later growth when a demolition is undone', () => {
    const { w, g } = line();
    const town = w.cities[0];
    const pop0 = town.population;
    // A depot on top of the town demolishes houses.
    const r = g.buildStation(5, 17, 'depot', 'x');
    expect(r.ok).toBe(true);
    const afterDemolish = town.population;
    expect(afterDemolish).toBeLessThan(pop0);
    town.population += 100; // growth in the meantime
    expect(g.undo().ok).toBe(true);
    expect(town.population).toBeCloseTo(pop0 + 100, 6);
  });
});

describe('station improvements', () => {
  it('cost money, need prerequisites and cannot be built twice', () => {
    const { g, b } = line();
    const cash = g.company.cash;
    expect(g.buildImprovement(b.id, 'roundhouse').ok).toBe(false);
    expect(g.buildImprovement(b.id, 'maintenance_shop').ok).toBe(true);
    expect(g.buildImprovement(b.id, 'maintenance_shop').ok).toBe(false);
    expect(g.buildImprovement(b.id, 'roundhouse').ok).toBe(true);
    expect(g.company.cash).toBe(cash - 40000 - 60000);
    expect(b.improvements).toEqual(['maintenance_shop', 'roundhouse']);
  });

  it('a hotel raises passenger fares and supply; a post office raises mail', () => {
    const { g, b } = line();
    const fare = g.economy.quote(b.id, 'passengers', 1, 36, 1).total;
    const supply = g.economy.station(b.id)!.supply.passengers;
    expect(g.buildImprovement(b.id, 'hotel').ok).toBe(true);
    expect(g.economy.quote(b.id, 'passengers', 1, 36, 1).total).toBeCloseTo(fare * 1.2, -1);
    expect(g.economy.station(b.id)!.supply.passengers).toBeCloseTo(supply * 1.15, 6);
    expect(g.economy.quote(b.id, 'coal', 1, 36, 1).bonusFactor).toBe(1);
  });

  it('a water tower shortens stops and a maintenance shop services trains', () => {
    const plain = line();
    const fast = line();
    expect(fast.g.buildImprovement(fast.a.id, 'water_tower').ok).toBe(true);
    expect(fast.g.buildImprovement(fast.b.id, 'water_tower').ok).toBe(true);
    expect(fast.g.buildImprovement(fast.b.id, 'maintenance_shop').ok).toBe(true);
    const t1 = plain.g.buyTrain('columbia', ['passengers', 'passengers'], route(plain.a.id, plain.b.id)).train!;
    const t2 = fast.g.buyTrain('columbia', ['passengers', 'passengers'], route(fast.a.id, fast.b.id)).train!;
    run(plain.g, 120);
    run(fast.g, 120);
    expect(t2.odometer).toBeGreaterThan(t1.odometer);
    expect(t2.service).toBeDefined();
    expect(fast.g.trains.serviceFx(t2).breakdown).toBeLessThan(1);
    expect(plain.g.trains.serviceFx(t1).breakdown).toBe(1);
  });

  it('charges upkeep monthly', () => {
    const { g, b } = line();
    g.buildImprovement(b.id, 'hotel');
    run(g, 40);
    expect(g.company.spentIn(g.year, 'improvementUpkeep')).toBeGreaterThan(0);
  });
});

describe('consist extras', () => {
  it('caboose pays a freight bonus and cuts breakdowns; dining car pays passengers', () => {
    const cab = consistBonus([{ type: 'hopper' }, { type: 'caboose' }, { type: 'caboose' }]);
    expect(cab.freight).toBeCloseTo(1.08, 6);
    expect(cab.breakdown).toBeCloseTo(0.85, 6);
    expect(cargoBonus(cab, 'coal')).toBeCloseTo(1.08, 6);
    expect(cargoBonus(cab, 'passengers')).toBe(1);
    const din = consistBonus([{ type: 'coach' }, { type: 'dining' }]);
    expect(cargoBonus(din, 'passengers')).toBeCloseTo(1.15, 6);
    expect(cargoBonus(din, 'mail')).toBe(1);
  });

  it('a dining car never loads but raises passenger revenue', () => {
    const plain = line();
    const dine = line();
    const keep = (a: number, b: number): RouteStop[] => route(a, b).map((r) => ({ ...r, load: 'keep' }));
    const t1 = plain.g.buyTrain('columbia', ['passengers', 'passengers'], keep(plain.a.id, plain.b.id)).train!;
    const t2 = dine.g.buyTrain('columbia', ['passengers', 'passengers', '@dining'], keep(dine.a.id, dine.b.id)).train!;
    expect(t2.cars[2].type).toBe('dining');
    let maxDiningLoad = 0;
    for (let i = 0; i < 90 * DAY; i++) {
      plain.g.step();
      dine.g.step();
      maxDiningLoad = Math.max(maxDiningLoad, t2.cars[2].loads);
    }
    expect(maxDiningLoad).toBe(0);
    expect(t2.lastDelivery?.quotes.find((q) => q.cargo === 'passengers')?.bonusFactor).toBeCloseTo(1.15, 6);
    expect(t1.lastDelivery?.quotes.find((q) => q.cargo === 'passengers')?.bonusFactor).toBe(1);
  });
});
