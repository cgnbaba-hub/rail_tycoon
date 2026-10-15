import { describe, expect, it } from 'vitest';
import { ENGINES, EVENTS, MANAGERS, TIME } from '../src/data';
import { defaultTrackOptions } from '../src/sim/construction';
import { Game } from '../src/sim/game';
import { defaultMapParams } from '../src/sim/mapgen';
import { cargoFactor, describeMods } from '../src/sim/modifiers';
import { enginesAvailable } from '../src/sim/train';
import { addTown, flatWorld } from './helpers';

const DAY = TIME.ticksPerDay;

function run(g: Game, days: number): void {
  for (let i = 0; i < days * DAY; i++) g.step();
}

function game(): Game {
  const w = flatWorld(48);
  addTown(w, 'Westford', 4, 16, 6000);
  addTown(w, 'Eastburg', 40, 16, 6000);
  const g = new Game({ ...defaultMapParams(1), size: w.width }, w, { wrecks: false });
  g.company.cash = 5_000_000;
  return g;
}

describe('engine roster', () => {
  it('has engines on sale in every year from 1830 to 2000, steam giving way to diesel', () => {
    for (let y = 1830; y <= 2000; y++) expect(enginesAvailable(y).length, `year ${y}`).toBeGreaterThan(0);
    expect(enginesAvailable(1990).every((e) => e.fuel === 'diesel')).toBe(true);
    expect(ENGINES.length).toBeGreaterThanOrEqual(25);
    expect(new Set(ENGINES.map((e) => e.id)).size).toBe(ENGINES.length);
  });
});

describe('events', () => {
  it('change revenue and supply while they last and explain themselves', () => {
    const g = game();
    const before = g.economy.economyFactor('steel');
    g.forceEvent('war', 6);
    expect(g.economy.economyFactor('steel')).toBeCloseTo(before * 1.5, 6);
    expect(g.economy.economyFactor('passengers')).toBeCloseTo(before * 0.85, 6);
    expect(g.newBondRate()).toBeGreaterThan(0);
    const war = EVENTS.events.find((e) => e.id === 'war')!;
    expect(describeMods(war.effects).join(', ')).toMatch(/steel pays \+50%/);
    run(g, 6 * 30 + 35);
    expect(g.events.active.some((x) => x.id === 'war')).toBe(false);
    expect(g.events.mods.revenue.steel ?? 1).toBe(1);
    // ... and it can't break out again straight away.
    expect(g.events.cooldown.get('war')).toBeGreaterThan(g.day);
  });

  it('adopt technologies once and for good', () => {
    const g = game();
    g.forceEvent('air_brakes');
    g.forceEvent('air_brakes');
    expect(g.events.adopted).toEqual(['air_brakes']);
    expect(g.modsFor(g.company).breakdowns).toBeCloseTo(0.9, 6);
    run(g, 400);
    expect(g.modsFor(g.company).breakdowns).toBeLessThanOrEqual(0.9 + 1e-9);
  });

  it('happen at random but reproducibly', () => {
    const a = game();
    const b = game();
    const seen: string[] = [];
    a.on((e) => e.type === 'event' && e.started && seen.push(e.def.id));
    run(a, 365 * 6);
    run(b, 365 * 6);
    expect(seen.length).toBeGreaterThan(0);
    expect(b.events.active.map((x) => x.id)).toEqual(a.events.active.map((x) => x.id));
    expect(b.events.adopted).toEqual(a.events.adopted);
  });

  it('group factors combine with cargo factors', () => {
    expect(cargoFactor({ people: 1.1, passengers: 1.2 }, 'passengers')).toBeCloseTo(1.32, 6);
    expect(cargoFactor({ all: 1.03 }, 'coal')).toBeCloseTo(1.03, 6);
    expect(cargoFactor({}, 'coal')).toBe(1);
  });
});

describe('managers', () => {
  it('offer a few candidates, charge a signing fee and a salary', () => {
    const g = game();
    expect(g.managerOffers).toHaveLength(MANAGERS.offered);
    expect(new Set(g.managerOffers).size).toBe(MANAGERS.offered);
    const id = g.managerOffers[0];
    const cash = g.company.cash;
    const r = g.hireManager(id);
    expect(r.ok).toBe(true);
    expect(g.company.cash).toBeCloseTo(cash - g.managerFee(id), 6);
    expect(g.company.manager).toBe(id);
    expect(g.managerOffers).not.toContain(id);
    const salaryBefore = g.company.spentIn(g.year, 'salary');
    run(g, 31);
    expect(g.company.spentIn(g.year, 'salary') - salaryBefore).toBeGreaterThan(MANAGERS.managers.find((m) => m.id === id)!.salary / 12 - 1);
    expect(g.fireManager().ok).toBe(true);
    expect(g.company.manager).toBeNull();
    expect(g.managerOffers).toContain(id);
  });

  it('make construction cheaper and bonds cheaper when they are good at it', () => {
    const g = game();
    const opts = defaultTrackOptions(1850);
    const plain = g.planTrack(g.world.tileIndex(8, 20), g.world.tileIndex(38, 20), opts).cost;
    const plainRate = g.newBondRate();
    g.managerOffers = ['builder', 'banker'];
    expect(g.hireManager('builder').ok).toBe(true);
    expect(g.planTrack(g.world.tileIndex(8, 20), g.world.tileIndex(38, 20), opts).cost).toBeCloseTo(plain * 0.85, -2);
    expect(g.hireManager('banker').ok).toBe(true);
    expect(g.newBondRate()).toBeCloseTo(plainRate - 0.005, 6);
    // Only one manager at a time: the builder went back into the pool.
    expect(g.managerOffers).toContain('builder');
  });

  it('cut fuel bills', () => {
    const run2 = (hire: boolean) => {
      const g = game();
      const a = g.buildStation(6, 20, 'station', 'x').station!;
      const b = g.buildStation(42, 20, 'station', 'x').station!;
      g.buildTrack(g.world.tileIndex(7, 20), g.world.tileIndex(42, 20), { ...defaultTrackOptions(1850), tunnels: false });
      if (hire) {
        g.managerOffers = ['fuel'];
        g.hireManager('fuel');
      }
      g.buyTrain('columbia', ['passengers', 'passengers'], [
        { station: a.id, load: 'auto', waitFull: false },
        { station: b.id, load: 'auto', waitFull: false },
      ]);
      run(g, 60);
      return g.company.spentIn(1850, 'fuel');
    };
    expect(run2(true)).toBeCloseTo(run2(false) * 0.85, 0);
  });
});
