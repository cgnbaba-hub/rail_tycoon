/**
 * Dev helper: signalling/performance stress test — 12 terminals on a double-track chain,
 * 120 trains, one simulated year.  npx vite-node scripts/stress.ts
 */
import { defaultTrackOptions } from '../src/sim/construction';
import { Game } from '../src/sim/game';
import { defaultMapParams } from '../src/sim/mapgen';
const g = new Game({ ...defaultMapParams(5), size: 256 }, undefined, { wrecks: false, charters: false });
g.company.cash = 1e10;
const towns = [...g.world.cities].sort((a, b) => b.population - a.population).slice(0, 12);
const st = [];
for (const town of towns) for (const [dx, dy] of [[0, 3], [0, -3], [3, 0], [-3, 0], [0, 5], [5, 0]]) { const r = g.buildStation(town.x + dx, town.y + dy, 'terminal', 'x'); if (r.ok) { st.push(r.station!); break; } }
let links = 0;
for (let i = 0; i + 1 < st.length; i++) { const r = g.buildTrack(st[i].tiles[2], st[i + 1].tiles[0], { ...defaultTrackOptions(1850), double: true }); if (r.ok) links++; }
console.log('stations', st.length, 'links', links, 'track tiles', g.world.track.size);
let bought = 0;
for (let k = 0; k < 120; k++) { const i = k % (st.length - 1); const r = g.buyTrain('columbia', ['passengers', 'mail', 'passengers'], [{ station: st[i].id, load: 'auto', waitFull: false }, { station: st[i + 1].id, load: 'auto', waitFull: false }]); if (r.ok) bought++; }
console.log('trains', bought);
const t0 = performance.now();
const ticks = 24 * 60;
for (let i = 0; i < ticks; i++) g.step();
const ms = (performance.now() - t0) / ticks;
console.log(`sim: ${ms.toFixed(3)} ms per tick → 8x speed needs ${(ms * 427).toFixed(0)} ms per real second`);
const states: Record<string, number> = {};
for (const t of g.trains.trains) states[t.state] = (states[t.state] ?? 0) + 1;
console.log(states, 'revenue', Math.round(g.company.revenueIn(1850)));
let maxWait = 0;
for (let i = 0; i < 24 * 300; i++) {
  g.step();
  for (const t of g.trains.trains) if (t.state === 'signal') maxWait = Math.max(maxWait, g.tick - t.waitSince);
}
const st2: Record<string, number> = {};
for (const t of g.trains.trains) st2[t.state] = (st2[t.state] ?? 0) + 1;
console.log('after a year:', st2, 'revenue', Math.round(g.company.revenueIn(1850)), 'longest signal wait (days)', (maxWait / 24).toFixed(1));
console.log('deliveries per train min/max', Math.min(...g.trains.trains.map((t) => t.stats.deliveries)), Math.max(...g.trains.trains.map((t) => t.stats.deliveries)));
