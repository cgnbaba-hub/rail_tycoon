/**
 * Dev helper: four years of company finance on a generated map.
 *   npx vite-node scripts/finance.ts -- <seed>
 * Connects the three largest towns, issues a bond, sets a dividend, issues shares; prints
 * price vs. fair value, profit trend, book value, rating and the chairman's net worth.
 */
import { TIME } from '../src/data';
import { defaultTrackOptions } from '../src/sim/construction';
import { Game } from '../src/sim/game';
import { defaultMapParams } from '../src/sim/mapgen';
const seed = Number(process.argv[2] ?? 42);
const g = new Game({ ...defaultMapParams(seed), size: 128 });
const towns = [...g.world.cities].sort((a, b) => b.population - a.population).slice(0, 3);
const st: any[] = [];
for (const town of towns) for (const [dx, dy] of [[0, 3], [0, -3], [3, 0], [-3, 0], [0, 4], [4, 0]]) { const r = g.buildStation(town.x + dx, town.y + dy, 'station', 'x'); if (r.ok) { st.push(r.station); break; } }
const tr = g.buildTrack(st[0].tiles[1], st[1].tiles[0], defaultTrackOptions(1850));
console.log('track', tr.ok, tr.cost, 'cash', Math.round(g.company.cash));
const route = (a: any, b: any) => [{ station: a.id, load: 'auto' as const, waitFull: false }, { station: b.id, load: 'auto' as const, waitFull: false }];
g.buyTrain('columbia', ['passengers', 'passengers', 'mail', 'passengers'], route(st[0], st[1]));
g.buyTrain('columbia', ['passengers', 'passengers', 'mail', 'passengers'], route(st[1], st[0]));
g.on((e) => { if (e.type === 'finance' || e.type === 'marginCall') console.log('EVENT', JSON.stringify(e).slice(0, 200)); });
for (let m = 0; m < 48; m++) {
  for (let i = 0; i < 30 * TIME.ticksPerDay; i++) g.step();
  if (m === 6) console.log('bond', JSON.stringify(g.issueBond()));
  if (m === 12) console.log('div', JSON.stringify(g.setDividend(0.5)));
  if (m === 18) console.log('issue', JSON.stringify(g.issueShares()));
  const c = g.company; const b = g.balance(); const f = g.fair(); const r = g.rating();
  if (m % 3 === 2) console.log(`${g.date.year}-${g.date.month + 1} price ${c.stock.price.toFixed(2)} fair ${f.perShare.toFixed(2)} [book ${Math.round(f.book/1000)}k earn ${Math.round(f.earnings/1000)}k div ${Math.round(f.dividends/1000)}k mood ${f.mood.toFixed(2)} pe ${f.pe}] trend ${Math.round(c.profitTrend)} cash ${Math.round(c.cash)} infra ${Math.round(c.infrastructure)} rs ${Math.round(b.rollingStock)} debt ${b.debt} rating ${r.def.id} worth ${Math.round(g.netWorth())} pcash ${Math.round(g.chairman.cash)} ${g.economy.cycle.state}`);
}
for (const h of g.company.history) console.log(JSON.stringify(h));
