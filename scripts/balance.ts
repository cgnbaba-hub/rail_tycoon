/**
 * Dev helper: one-year balance check on a generated map.
 *   npx vite-node scripts/balance.ts -- <seed> <engine> <cars>
 * Connects the two largest towns, runs a passenger train for a year, prints the books.
 */
import { CONSTRUCTION, TIME } from '../src/data';
import { defaultTrackOptions } from '../src/sim/construction';
import { Game } from '../src/sim/game';
import { defaultMapParams } from '../src/sim/mapgen';
import { tileDistance } from '../src/sim/routing';
import { stopTile } from '../src/sim/train';

const args = process.argv.slice(2).filter((a) => a !== '--');
const seed = Number(args[0] ?? 7);
const engine = args[1] ?? 'columbia';
const nCars = Number(args[2] ?? 4);
const g = new Game({ ...defaultMapParams(seed), size: 128 });
g.company.cash = 1e8;
const towns = [...g.world.cities].sort((a, b) => b.population - a.population);
const stations = [];
for (const town of towns) {
  if (stations.length === 2) break;
  for (const [dx, dy] of [[0, 3], [0, -3], [3, 0], [-3, 0], [0, 5], [5, 0], [2, 2], [-2, -2]]) {
    const r = g.buildStation(town.x + dx, town.y + dy, 'station', 'x');
    if (r.ok) {
      stations.push(r.station!);
      break;
    }
  }
}
const [a, b] = stations;
const track = g.buildTrack(a.tiles[a.tiles.length - 1], b.tiles[0], defaultTrackOptions(1850));
const dist = tileDistance(g.world, stopTile(a), stopTile(b));
console.log(`${a.name} -> ${b.name}: straight ${dist.toFixed(0)} tiles (${((dist * CONSTRUCTION.feetPerTile) / 5280).toFixed(1)} mi), track ${track.plan.lengthTiles.toFixed(0)} tiles, cost $${track.cost} ok=${track.ok} ${track.error ?? ''}`);
const cargos = Array.from({ length: nCars }, (_, i) => (i === nCars - 1 ? 'mail' : 'passengers'));
const buy = g.buyTrain(engine, cargos, [
  { station: a.id, load: 'auto', waitFull: false },
  { station: b.id, load: 'auto', waitFull: false },
]);
console.log('train', buy.ok, buy.error ?? '', 'price', buy.cost);
const sup = g.economy.station(a.id)!.supply;
console.log('supply/month at A', Object.entries(sup).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', '));
for (let i = 0; i < 365 * TIME.ticksPerDay; i++) g.step();
const t = g.trains.trains[0];
console.log(`year: revenue $${Math.round(t.stats.lastRevenue)}, train costs $${Math.round(t.stats.lastCosts)}, deliveries ${t.stats.deliveries}, breakdowns ${t.stats.breakdowns}`);
const y = g.params.startYear;
for (const [k, v] of g.company.ledger.get(y) ?? []) console.log(`  ${k}: $${Math.round(v)}`);
const opProfit = g.company.revenueIn(y) - g.company.operatingCostsIn(y);
console.log(`operating profit $${Math.round(opProfit)}; payback on track+train ≈ ${((track.cost + buy.cost) / opProfit).toFixed(1)} years`);
console.log(`train ${t.name}: state ${t.state}, odometer ${t.odometer.toFixed(0)} tiles`);
for (const s of [a, b]) console.log(`${s.name} demand`, JSON.stringify(Object.fromEntries(Object.entries(g.economy.cargoAt(s.id).demand).map(([k, v]) => [k, +v.toFixed(2)]))), "cycle", g.economy.cycle.state);
console.log("towns", g.world.cities.slice(0, 6).map((c) => `${c.name} ${Math.round(c.population)} g=${((c.growth ?? 0) * 100).toFixed(1)}%`).join(", "));
