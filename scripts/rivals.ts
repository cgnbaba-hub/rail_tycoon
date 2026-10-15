/**
 * Dev helper: watch AI rivals for a few years.
 *   npx vite-node scripts/rivals.ts -- <seed> <years> <level> [friendly]
 * The player builds one line between the two biggest towns and otherwise waits; prints each
 * company's state every year and all rival news.
 */
import { TIME, type AiLevel } from '../src/data';
import { defaultTrackOptions } from '../src/sim/construction';
import { Game } from '../src/sim/game';
import { defaultMapParams } from '../src/sim/mapgen';

const args = process.argv.slice(2).filter((a) => a !== '--');
const seed = Number(args[0] ?? 42);
const years = Number(args[1] ?? 5);
const level = (args[2] ?? 'normal') as AiLevel;
const g = new Game({ ...defaultMapParams(seed), size: Number(process.env.SIZE ?? 128) }, undefined, { rivals: 3, aiLevel: level, friendlyAi: args[3] === 'friendly' });
const towns = [...g.world.cities].sort((a, b) => b.population - a.population);
const st = [];
for (const town of towns.slice(0, 2)) {
  for (const [dx, dy] of [[0, 3], [0, -3], [3, 0], [-3, 0], [0, 4], [4, 0]]) {
    const r = g.buildStation(town.x + dx, town.y + dy, 'station', 'x');
    if (r.ok) {
      st.push(r.station!);
      break;
    }
  }
}
if (st.length === 2) {
  g.buildTrack(st[0].tiles[1], st[1].tiles[0], defaultTrackOptions(1850));
  for (const [a, b] of [[0, 1], [1, 0]]) g.buyTrain('columbia', ['passengers', 'passengers', 'mail', 'passengers'], [{ station: st[a].id, load: 'auto', waitFull: false }, { station: st[b].id, load: 'auto', waitFull: false }]);
}
g.on((e) => {
  if (e.type === 'rival' || e.type === 'gameOver') console.log(`  [${g.date.year}-${g.date.month + 1}] ${e.type === 'rival' ? e.text : 'GAME OVER: ' + e.over.text}`);
});
const t0 = performance.now();
for (let y = 0; y < years; y++) {
  for (let i = 0; i < 365 * TIME.ticksPerDay; i++) g.step();
  console.log(`== ${g.date.year} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  for (const c of g.companies) {
    const stations = g.world.liveStations().filter((s) => s.owner === c.id).length;
    const trains = g.trains.trains.filter((t) => t.owner === c.id).length;
    const holders = [...c.holders].filter(([, n]) => n > 0).map(([k, n]) => `${k} ${((n / c.shares) * 100).toFixed(0)}%`).join(', ');
    console.log(`${c.ticker.padEnd(4)} ${c.defunct || 'active'} cash ${Math.round(c.cash)} debt ${c.debt} price ${c.stock.price.toFixed(2)} profit ${Math.round(c.netProfitIn(g.year - 1))} stations ${stations} trains ${trains} | ${holders}`);
  }
  for (const inv of g.investors) console.log(`   ${inv.name}: worth ${Math.round(g.netWorth(inv))} cash ${Math.round(inv.cash)} shorts ${[...inv.shorts].map(([k, v]) => `${k}:${v}`).join(',')}`);
}
