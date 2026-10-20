import { describe, expect, it } from 'vitest';
import { CONSTRUCTION, ECONOMY, TIME } from '../src/data';
import { defaultTrackOptions } from '../src/sim/construction';
import type { RevenueQuote } from '../src/sim/economy';
import { Game, type GameSettings } from '../src/sim/game';
import { defaultMapParams } from '../src/sim/mapgen';
import { loadGame, saveGame } from '../src/sim/save';
import type { Station } from '../src/sim/station';
import { stopTile, type RouteStop } from '../src/sim/train';
import { tileDistance } from '../src/sim/routing';
import { addIndustry, addTown, flatWorld } from './helpers';

const DAY = TIME.ticksPerDay;

/**
 * Three towns in a row — West, Hub, East, 20 tiles apart — with a station each and track
 * through all three. A coal mine by West, a steel mill by East.
 */
function corridor(settings: Partial<GameSettings> = {}) {
  const w = flatWorld(64);
  addTown(w, 'West', 4, 15, 5000);
  addTown(w, 'Hub', 24, 15, 5000);
  addTown(w, 'East', 44, 15, 5000);
  addIndustry(w, 'coal_mine', 3, 22);
  addIndustry(w, 'steel_mill', 45, 22);
  const g = new Game({ ...defaultMapParams(1), size: w.width }, w, { wrecks: false, model: 'advanced', ...settings });
  g.company.cash = 10_000_000;
  const st = [6, 26, 46].map((x) => {
    const r = g.buildStation(x, 20, 'station', 'x');
    expect(r.ok, r.error).toBe(true);
    return r.station!;
  });
  const opts = { ...defaultTrackOptions(1850), tunnels: false };
  for (let i = 0; i < 2; i++) expect(g.buildTrack(st[i].tiles[st[i].tiles.length - 1], st[i + 1].tiles[0], opts).ok).toBe(true);
  return { g, w, west: st[0], hub: st[1], east: st[2] };
}

function stops(...list: Array<[Station, Partial<RouteStop>?]>): RouteStop[] {
  return list.map(([s, o]) => ({ station: s.id, load: 'auto', waitFull: false, ...o }));
}

function run(g: Game, days: number): void {
  for (let i = 0; i < days * DAY; i++) g.step();
}

function deliveries(g: Game): Array<{ train: number; station: number; quotes: RevenueQuote[] }> {
  const out: Array<{ train: number; station: number; quotes: RevenueQuote[] }> = [];
  g.on((e) => e.type === 'delivery' && out.push(e));
  return out;
}

describe('transfers', () => {
  it('set cargo down at a transfer stop for another train, paid from the first station on delivery', () => {
    const { g, west, hub, east } = corridor();
    const log = deliveries(g);
    const feeder = g.buyTrain('columbia', ['coal', 'coal', 'coal'], stops([west, { load: 'keep' }], [hub, { load: 'keep', transfer: true }]));
    const trunk = g.buyTrain('columbia', ['coal', 'coal', 'coal'], stops([hub, { load: 'keep' }], [east, { load: 'keep' }]));
    expect(feeder.ok && trunk.ok).toBe(true);
    run(g, 200);
    // The feeder never delivers coal itself; the trunk does, at East.
    const coal = log.filter((d) => d.quotes.some((q) => q.cargo === 'coal'));
    expect(coal.length).toBeGreaterThan(0);
    expect(coal.every((d) => d.train === trunk.train!.id && d.station === east.id)).toBe(true);
    const q = coal[0].quotes.find((x) => x.cargo === 'coal')!;
    expect(q.transferred).toBe(q.loads);
    const whole = g.trains.trains;
    const f = whole.find((t) => t.id === feeder.train!.id)!;
    const t = whole.find((x) => x.id === trunk.train!.id)!;
    // Both trains earned a share by the distance they carried it.
    expect(f.stats.revenue).toBeGreaterThan(0);
    expect(t.stats.revenue).toBeGreaterThan(0);
    expect(f.stats.revenue + t.stats.revenue).toBe(g.company.revenueIn(g.year));
  });

  it('pay a transferred load over the full distance and time', () => {
    const { g, west, hub, east } = corridor();
    const log = deliveries(g);
    g.buyTrain('columbia', ['coal', 'coal'], stops([west, { load: 'keep' }], [hub, { load: 'keep', transfer: true }]));
    g.buyTrain('columbia', ['coal', 'coal'], stops([hub, { load: 'keep' }], [east, { load: 'keep' }]));
    run(g, 200);
    const q = log.flatMap((d) => d.quotes).find((x) => x.cargo === 'coal' && x.transferred)!;
    const miles = (tiles: number) => (tiles * CONSTRUCTION.feetPerTile) / 5280;
    const whole = tileDistance(g.world, stopTile(west), stopTile(east));
    expect(q.miles).toBeCloseTo(miles(whole));
    expect(whole).toBeGreaterThan(1.8 * tileDistance(g.world, stopTile(hub), stopTile(east)));
    // Counted from loading at West, waiting at the hub included.
    expect(q.transitDays).toBeGreaterThan(q.idealDays);
  });

  it('do not hand a load straight back to the train that set it down', () => {
    const { g, west, hub } = corridor();
    // A single train that transfers at Hub and could carry coal back to West: it must not.
    const r = g.buyTrain('columbia', ['coal', 'coal'], stops([west, { load: 'keep' }], [hub, { load: 'keep', transfer: true }]));
    run(g, 120);
    const lots = g.economy.cargoAt(hub.id).transfer ?? [];
    expect(lots.length).toBeGreaterThan(0);
    expect(lots.every((l) => l.legs[l.legs.length - 1][0] === r.train!.id && l.origin === west.id)).toBe(true);
    expect(g.trains.trains[0].stats.revenue).toBe(0);
  });

  it('let old lots spoil and survive a save', () => {
    const { g, west, hub } = corridor();
    g.buyTrain('columbia', ['coal', 'coal'], stops([west, { load: 'keep' }], [hub, { load: 'keep', transfer: true }]));
    run(g, 60);
    const b = loadGame(JSON.parse(JSON.stringify(saveGame(g))));
    expect(b.economy.cargoAt(hub.id).transfer).toEqual(g.economy.cargoAt(hub.id).transfer);
    expect(b.trains.trains[0].route[1].transfer).toBe(true);
    g.trains.trains.length = 0;
    const lots = g.economy.cargoAt(hub.id).transfer!;
    const oldest = lots[0].since;
    run(g, ECONOMY.transfers.maxDays + 5);
    expect(g.economy.cargoAt(hub.id).transfer!.every((l) => l.since > oldest)).toBe(true);
    expect(g.economy.cargoAt(hub.id).transfer!.length).toBe(0);
  });
});

describe('passenger destinations', () => {
  it('are off by default: no destination buckets', () => {
    const { g, west, hub } = corridor();
    g.buyTrain('columbia', ['passengers', 'passengers'], stops([west], [hub]));
    run(g, 30);
    expect(g.economy.cargoAt(west.id).dest).toBeUndefined();
  });

  it('split new travellers over the stations reachable with one change, nearer and bigger first', () => {
    const { g, west, hub, east } = corridor({ destinations: true });
    g.buyTrain('columbia', ['passengers', 'passengers'], stops([west], [hub]));
    g.buyTrain('columbia', ['passengers', 'passengers'], stops([hub], [east]));
    const net = g.trains.network();
    expect([...net.reach(west.id)].sort()).toEqual([hub.id, east.id].sort());
    const shares = new Map(net.shares(g.world, g.economy, west.id, 'passengers'));
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(shares.get(hub.id)!).toBeGreaterThan(shares.get(east.id)!);
    run(g, 10);
    const buckets = g.economy.cargoAt(west.id).dest!.passengers;
    const sum = Object.values(buckets).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(g.economy.cargoAt(west.id).waiting.passengers, 6);
  });

  it('carry travellers to their own station, changing trains at the hub', () => {
    const { g, west, hub, east } = corridor({ destinations: true });
    const log = deliveries(g);
    const a = g.buyTrain('columbia', ['passengers', 'passengers', 'passengers'], stops([west], [hub]));
    const b = g.buyTrain('columbia', ['passengers', 'passengers', 'passengers'], stops([hub], [east]));
    run(g, 240);
    const pax = log.filter((d) => d.quotes.some((q) => q.cargo === 'passengers'));
    // West → East travellers arrive at East on the second train, via the hub.
    const through = pax.filter((d) => d.station === east.id && d.quotes.some((q) => q.transferred));
    expect(through.length).toBeGreaterThan(0);
    expect(through.every((d) => d.train === b.train!.id)).toBe(true);
    // The first train never takes anyone beyond the hub.
    expect(pax.filter((d) => d.train === a.train!.id).every((d) => d.station === west.id || d.station === hub.id)).toBe(true);
    // Nobody rides without a destination.
    for (const t of g.trains.trains) for (const c of t.cars) if (c.loads > 0) expect(c.dest).toBeGreaterThanOrEqual(0);
  });

  it('leave travellers waiting while no train goes their way', () => {
    const { g, west, hub, east } = corridor({ destinations: true });
    g.buyTrain('columbia', ['passengers', 'passengers'], stops([west], [hub]));
    run(g, 20);
    expect(Object.keys(g.economy.cargoAt(west.id).dest!.passengers).map(Number)).toEqual([hub.id]);
    // East has no train: nobody starts a journey there.
    expect(g.economy.cargoAt(east.id).waiting.passengers ?? 0).toBe(0);
  });
});
