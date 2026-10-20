/**
 * Dev helper for medal tiers: plays a scenario with a scripted plan — the lines a sensible
 * player would build first — then adds trains where cargo piles up, and prints the goal
 * metric every year.
 *   npx vite-node scripts/scenario-bot.ts -- <scenario id> [seed offset]
 * The bot plays plainly (no stock tricks, no clever routing): silver should be within its
 * reach, gold should need a better player.
 */
import { FINANCE, SCENARIOS, TIME } from '../src/data';
import { defaultTrackOptions } from '../src/sim/construction';
import { suggestConsist } from '../src/sim/estimate';
import type { Game, LineEnd } from '../src/sim/game';
import { scenarioProgress, startScenario, townsConnected } from '../src/sim/scenario';
import type { Station } from '../src/sim/station';
import { enginesAvailable, stopTile, type RouteStop } from '../src/sim/train';
import type { City, Industry } from '../src/sim/world';

/** A line end: a town by name, an industry type (`ind:type`, near a town with `@Town`), or a spot `x,y` in map fractions. */
type Target = string;

const PLANS: Record<string, Array<[Target, Target]>> = {
  tutorial: [['$0', '$1']],
  iron_horse: [['#0', '#1'], ['#0', '#2'], ['#1', '#3']],
  river_towns: [['Rivermouth', 'Forkton'], ['Forkton', 'Upper Weld'], ['Forkton', 'Elmford'], ['Rivermouth', 'Baywater'], ['ind:logging_camp', 'ind:lumber_mill']],
  coal_steel: [['ind:coal_mine', 'ind:steel_mill'], ['ind:iron_mine', 'ind:steel_mill'], ['ind:steel_mill', 'ind:factory'], ['#0', '#1']],
  over_the_pass: [['Wheatfield', 'Port Ashby'], ['Port Ashby', 'Fairhaven'], ['ind:coal_mine', 'ind:steel_mill'], ['ind:grain_farm@Wheatfield', 'ind:food_plant'], ['Wheatfield', 'Cedar Bend']],
  black_gold: [['0.38,0.42', 'ind:refinery@Mesa City'], ['0.55,0.5', 'ind:refinery@Gulfport'], ['0.47,0.6', 'ind:refinery@Mesa City'], ['Petrolia', 'Mesa City'], ['ind:refinery@Mesa City', 'Bayshore']],
  divide: [['$0', '$1'], ['#0', '#2'], ['#1', '#3']],
  lake_shore: [['Northshore', 'Southport'], ['Northshore', 'Easton'], ['Southport', 'Westlake'], ['ind:logging_camp@Northshore', 'ind:paper_mill'], ['ind:coal_mine@Coalridge', 'ind:steel_mill']],
  streamliner: [['#0', '#1'], ['#0', '#2'], ['#1', '#3'], ['#2', '#4']],
  commuter_rush: [['Capitol City', 'Oakdale'], ['Capitol City', 'Riverside'], ['Capitol City', 'Hillcrest'], ['Capitol City', 'Northfield'], ['Capitol City', 'Lakeview'], ['Capitol City', 'Westbrook'], ['Capitol City', 'Eastgate']],
  barons: [['#0', '#1'], ['#0', '#2'], ['#1', '#3'], ['#2', '#4']],
  coast_to_coast: [['Eastport', 'Great Falls'], ['Bayview', 'Redwood'], ['Eastport', 'Prairie Junction'], ['Prairie Junction', 'Summit'], ['Summit', 'Bayview'], ['Eastport', 'Southfork']],
};

const args = process.argv.slice(2).filter((a) => a !== '--');
const def = SCENARIOS.find((s) => s.id === args[0]);
if (!def) throw new Error(`Unknown scenario ${args[0]}; one of ${SCENARIOS.map((s) => s.id).join(', ')}`);
const g = startScenario({ ...def, map: { ...def.map, seed: def.map.seed + Number(args[1] ?? 0) } });
g.scenario!.deadlineYear = 99999; // play to the end to see the headroom
g.settings.boardVotes = false; // measure the metric, not the bot's standing with the board
const c = g.company;
const W = g.world.width;
const byPop = [...g.world.cities].sort((a, b) => b.population - a.population);

/** `#k` = k-th largest town, `$k` = the scenario's k-th requirement town, else a name. */
function town(t: string): City | undefined {
  if (t.startsWith('#')) return byPop[Number(t.slice(1))];
  if (t.startsWith('$')) return g.world.cities[g.scenario!.towns[Number(t.slice(1))]];
  return g.world.cities.find((x) => x.name === t);
}

/** Buy the charter of the region around (x, y) if it needs one. */
function charter(x: number, y: number): void {
  const r = g.territories.regionAt(g.world.tileIndex(Math.max(0, Math.min(W - 1, x)), Math.max(0, Math.min(W - 1, y))));
  if (!g.canBuildIn(r, c)) g.buyCharter(r.id, c);
}

/** The best station spot near a target: most people / wanted industries covered for the money. */
function placeEnd(t: Target, towards: [number, number]): { end: LineEnd; at: [number, number] } | null {
  let cx: number;
  let cy: number;
  let wantInd: ((i: Industry) => boolean) | null = null;
  if (t.startsWith('ind:')) {
    const [type, near] = t.slice(4).split('@');
    const ref = near ? town(near) : null;
    const list = g.world.industries.filter((i) => i.defId === type);
    const pick = list.sort((a, b) => (ref ? Math.hypot(a.x - ref.x, a.y - ref.y) - Math.hypot(b.x - ref.x, b.y - ref.y) : 0))[0];
    if (!pick) return null;
    [cx, cy] = [pick.x + 1, pick.y + 1];
    wantInd = (i) => i.defId === type;
  } else if (/^[\d.]+,[\d.]+$/.test(t)) {
    const [fx, fy] = t.split(',').map(Number);
    [cx, cy] = [Math.round(fx * W), Math.round(fy * W)];
    wantInd = () => true;
  } else {
    const city = town(t);
    if (!city) return null;
    [cx, cy] = [city.x, city.y];
  }
  charter(cx, cy);
  const axis0: 'x' | 'y' = Math.abs(towards[0] - cx) >= Math.abs(towards[1] - cy) ? 'x' : 'y';
  let best: { end: LineEnd; at: [number, number]; score: number } | null = null;
  for (let r = 1; r <= 10; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        for (const axis of [axis0, axis0 === 'x' ? 'y' : 'x'] as const) {
          for (const kind of ['station', 'terminal'] as const) {
            const plan = g.planStation(cx + dx, cy + dy, kind, axis);
            if (!plan.ok) continue;
            const people = plan.coverage.cities.reduce((a, x) => a + x.population, 0);
            const inds = wantInd ? plan.coverage.industries.filter(wantInd).length : 0;
            if (wantInd && inds === 0) continue;
            const score = people * 40 + inds * 400000 - plan.cost - (axis === axis0 ? 0 : 15000);
            if (!best || score > best.score) best = { end: { x: cx + dx, y: cy + dy, axis, kind }, at: [cx + dx, cy + dy], score };
          }
        }
      }
    }
  }
  return best;
}

function bestEngine(maxPrice: number) {
  return enginesAvailable(g.year)
    .filter((e) => e.price < maxPrice)
    .sort((a, b) => b.power * b.topSpeed - a.power * a.topSpeed)[0];
}

function buyTrain(stops: [number, number]): boolean {
  const engine = bestEngine(c.cash - 20000);
  if (!engine) return false;
  const route: RouteStop[] = stops.map((station) => ({ station, load: 'auto', waitFull: false }));
  const cargos = suggestConsist(g, engine.id, route).slice(0, Math.min(engine.maxCars, 5));
  return g.buyTrain(engine.id, cargos, route, c).ok;
}

/** At most two bonds, and only for building. */
function borrow(): boolean {
  if (c.bonds.length >= 2 || g.rating(c, FINANCE.bonds.block).index > 3) return false;
  return g.issueBond(c).ok;
}

const todo = [...(PLANS[def.id] ?? [['#0', '#1']])];
const lines: Array<[Station, Station]> = [];
const stationAt = new Map<Target, Station>();

function tryBuild(): void {
  while (todo.length) {
    const [a, b] = todo[0];
    const sa = stationAt.get(a);
    const sb = stationAt.get(b);
    const pa = sa ? null : placeEnd(a, [W / 2, W / 2]);
    const atA: [number, number] | null = sa ? [stopTile(sa) % W, Math.floor(stopTile(sa) / W)] : (pa?.at ?? null);
    const pb = sb || !atA ? null : placeEnd(b, atA);
    if ((!sa && !pa) || (!sb && !pb)) {
      console.log(`  skip ${a} → ${b}: no station spot`);
      todo.shift();
      continue;
    }
    const endA: LineEnd = sa ? { station: sa.id } : pa!.end;
    const endB: LineEnd = sb ? { station: sb.id } : pb!.end;
    // Charters for the regions along the way.
    const atB: [number, number] = sb ? [stopTile(sb) % W, Math.floor(stopTile(sb) / W)] : pb!.at;
    for (let k = 0; k <= 20; k++) charter(Math.round(atA![0] + ((atB[0] - atA![0]) * k) / 20), Math.round(atA![1] + ((atB[1] - atA![1]) * k) / 20));
    const r = g.buildLine(c, endA, endB, defaultTrackOptions(g.year, c.id), c.cash - 60000);
    if (!r.ok || !r.stations) {
      if (/cash|afford|budget|cost|expensive/i.test(r.error ?? '') && r.cost < 1_500_000) {
        if (borrow()) continue;
        return; // wait for money
      }
      console.log(`  skip ${a} → ${b}: ${r.error}`);
      todo.shift();
      continue;
    }
    todo.shift();
    stationAt.set(a, r.stations[0]);
    stationAt.set(b, r.stations[1]);
    lines.push(r.stations);
    console.log(`  ${g.date.year}: built ${r.stations[0].name} → ${r.stations[1].name} for $${Math.round(r.cost / 1000)}k`);
    buyTrain([r.stations[0].id, r.stations[1].id]);
  }
}

function waiting(id: number): number {
  return Object.values(g.economy.cargoAt(id).waiting).reduce((x, y) => x + y, 0);
}

function addTrains(): void {
  for (const [a, b] of lines) {
    const n = g.trains.trains.filter((t) => t.owner === c.id && t.route.some((s) => s.station === a.id) && t.route.some((s) => s.station === b.id)).length;
    if (n >= 2) continue; // single track: stations are the only passing points
    if (waiting(a.id) + waiting(b.id) > 6 && c.cash > 150000) buyTrain(n % 2 ? [b.id, a.id] : [a.id, b.id]);
  }
}

const t0 = performance.now();
const end = def.map.startYear + def.years;
const fmt = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : v.toFixed(0));
tryBuild();
let month = g.date.month;
let year = g.year;
while (g.year < end && !g.over) {
  for (let i = 0; i < TIME.ticksPerDay; i++) g.step();
  if (g.date.month !== month) {
    month = g.date.month;
    tryBuild();
    if (month % 3 === 0) addTrains();
  }
  if (g.year !== year) {
    year = g.year;
    const p = scenarioProgress(g)!;
    const st = g.scenario!;
    const req = st.towns.length ? ` connected:${townsConnected(g, st.towns[0], st.towns[1])}` : '';
    const mine = g.trains.trains.filter((t) => t.owner === c.id).length;
    console.log(
      `${year}  ${def.goal.metric}=${fmt(p.metric)} tier=${p.tier}${req}  cash=${fmt(c.cash)} trains=${mine} nw=${fmt(g.netWorth())} rivals=${g.companies
        .filter((x) => x !== c)
        .map((x) => `${x.ticker}:${x.defunct ? 'x' : fmt(g.balance(x).bookValue)}`)
        .join(',')}`,
    );
  }
}
console.log(`${def.id}: ${def.goal.tiers.join(' / ')}  ${((performance.now() - t0) / 1000).toFixed(0)} s${g.over ? `  over: ${g.over.reason}` : ''}`);
