import { CONSTRUCTION, ECONOMY, ENGINE_BY_ID, TIME } from '../data';
import { gradePercent } from './construction';
import { quoteRevenue, DAYS_PER_MONTH } from './economy';
import { findTrainPath, tileDistance } from './routing';
import { NODE_BRIDGE, stepLength } from './track';
import { balanceSpeed, carForCargo, enginesAvailable, stopTile, trainTons, type RouteStop } from './train';
import { consistPrice, type Game } from './game';

export interface LegEstimate {
  from: number;
  to: number;
  /** Track length in tiles, or -1 when the stations aren't connected. */
  tiles: number;
  days: number;
  maxGrade: number;
  /** Slowest steady speed on the leg with a full train (mph). */
  crawl: number;
  revenue: number;
}

export interface TrainEstimate {
  ok: boolean;
  error?: string;
  legs: LegEstimate[];
  roundTripDays: number;
  tripsPerYear: number;
  revenuePerYear: number;
  costsPerYear: number;
  profitPerYear: number;
  price: number;
  paybackYears: number;
}

const tilesPerDay = (mph: number) => mph * ECONOMY.physics.tilesPerTickPerMph * TIME.ticksPerDay;

/**
 * Expected yearly figures for a train on a route, from current station supply and demand,
 * the track between stops (length, grades, bridge limits) and the engine's pulling power.
 * Uses the same revenue formula as actual deliveries.
 */
export function estimateTrain(game: Game, engineId: string, cargos: string[], route: RouteStop[], price = 0): TrainEstimate {
  const e = ENGINE_BY_ID.get(engineId);
  const empty: TrainEstimate = { ok: false, legs: [], roundTripDays: 0, tripsPerYear: 0, revenuePerYear: 0, costsPerYear: 0, profitPerYear: 0, price, paybackYears: Infinity };
  if (!e) return { ...empty, error: 'Pick an engine.' };
  if (route.length < 2) return { ...empty, error: 'Add at least two stops.' };
  const world = game.world;
  const cars = cargos.map((c) => ({ type: carForCargo(c), cargo: c, loads: 1 }));
  const fullTons = trainTons(e, cars);
  const L = ECONOMY.loading;
  const legs: LegEstimate[] = [];
  for (let i = 0; i < route.length; i++) {
    const a = world.stations[route[i].station];
    const b = world.stations[route[(i + 1) % route.length].station];
    if (!a || !b) return { ...empty, error: 'A stop no longer exists.' };
    // Trains may reverse in stations, so each leg starts with a free heading.
    const path = findTrainPath(world, stopTile(a), -1, new Set([stopTile(b)]));
    if (!path) return { ...empty, legs, error: `${a.name} and ${b.name} are not connected by track.` };
    let days = (L.minDwellHours + L.hoursPerLoad * cars.length * 2) / TIME.ticksPerDay;
    let maxGrade = 0;
    let crawl = e.topSpeed;
    for (let k = 0; k + 1 < path.nodes.length; k++) {
      const na = world.track.getIdx(path.nodes[k])!;
      const nb = world.track.getIdx(path.nodes[k + 1])!;
      const d = world.track.dirBetween(path.nodes[k], path.nodes[k + 1]);
      const len = stepLength(d);
      const g = gradePercent(nb.z - na.z, len);
      maxGrade = Math.max(maxGrade, g);
      let v = Math.max(3, balanceSpeed(e, fullTons, g));
      const span = na.kind === NODE_BRIDGE ? na.span : nb.kind === NODE_BRIDGE ? nb.span : -1;
      if (span >= 0) {
        const br = CONSTRUCTION.bridges[span];
        v = Math.min(v, fullTons > br.weightLimit ? ECONOMY.physics.overweightBridgeMph : br.speedLimit);
      }
      crawl = Math.min(crawl, v);
      days += len / tilesPerDay(v);
    }
    legs.push({ from: a.id, to: b.id, tiles: path.length, days, maxGrade, crawl, revenue: 0 });
  }
  return finishEstimate(game, engineId, cargos, legs, price);
}

/** Revenue, costs and payback for given legs (shared by train and track estimates). */
function finishEstimate(game: Game, engineId: string, cargos: string[], legs: LegEstimate[], price: number): TrainEstimate {
  const e = ENGINE_BY_ID.get(engineId)!;
  const world = game.world;
  const cars = cargos.map((c) => ({ type: carForCargo(c), cargo: c, loads: 1 }));
  const fullTons = trainTons(e, cars);
  const roundTripDays = legs.reduce((s, l) => s + l.days, 0);
  const tripsPerYear = 365 / Math.max(0.5, roundTripDays);
  // Revenue: each car fills at the origin if supply allows, paid at the next stop.
  const econ = game.economy;
  let revenuePerYear = 0;
  legs.forEach((leg) => {
    const supply = econ.station(leg.from)?.supply ?? {};
    const dist = tileDistance(world, stopTile(world.stations[leg.from]!), stopTile(world.stations[leg.to]!));
    const counts = new Map<string, number>();
    for (const c of cargos) counts.set(c, (counts.get(c) ?? 0) + 1);
    let perTrip = 0;
    for (const [cargo, n] of counts) {
      const available = ((supply[cargo] ?? 0) * roundTripDays) / DAYS_PER_MONTH;
      const loads = Math.min(n, available);
      if (loads <= 0) continue;
      perTrip += quoteRevenue(cargo, loads, dist, leg.days, econ.accepts(leg.to, cargo), econ.model).total;
    }
    leg.revenue = perTrip * tripsPerYear;
    revenuePerYear += leg.revenue;
  });
  const tilesPerYear = legs.reduce((s, l) => s + l.tiles, 0) * tripsPerYear;
  const avgTons = (fullTons + trainTons(e, cars.map((c) => ({ ...c, loads: 0 })))) / 2;
  const fuel = tilesPerYear * 0.25 * (ECONOMY.fuelPrice[e.fuel] ?? 1) * (e.fuelBase + e.fuelPerTon * avgTons);
  const costsPerYear = fuel + e.maintenance;
  const profitPerYear = revenuePerYear - costsPerYear;
  return {
    ok: true,
    legs,
    roundTripDays,
    tripsPerYear,
    revenuePerYear: Math.round(revenuePerYear),
    costsPerYear: Math.round(costsPerYear),
    profitPerYear: Math.round(profitPerYear),
    price,
    paybackYears: profitPerYear > 0 ? price / profitPerYear : Infinity,
  };
}

/** A sensible default consist for a route: what the first stop supplies and the next one wants. */
export function suggestConsist(game: Game, engineId: string, route: RouteStop[]): string[] {
  const e = ENGINE_BY_ID.get(engineId);
  const n = Math.min(e?.maxCars ?? 4, 4);
  if (route.length < 2) return Array.from({ length: n }, () => 'passengers');
  const supplyA = game.economy.station(route[0].station)?.supply ?? {};
  const scored = Object.entries(supplyA)
    .map(([cargo, rate]) => ({ cargo, score: rate * (game.economy.accepts(route[1].station, cargo) ? 1 : 0.3) }))
    .filter((s) => s.score > 0.2)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return Array.from({ length: n }, () => 'passengers');
  const total = scored.reduce((s, x) => s + x.score, 0);
  const out: string[] = [];
  for (const s of scored) {
    const k = Math.max(1, Math.round((s.score / total) * n));
    for (let i = 0; i < k && out.length < n; i++) out.push(s.cargo);
  }
  while (out.length < n) out.push(scored[0].cargo);
  return out;
}

/**
 * What a typical train would earn running between two stations over `tiles` of track whose
 * steepest grade is `maxGrade` — used by the track preview before anything is built.
 */
export function estimateConnection(game: Game, stationA: number, stationB: number, tiles: number, maxGrade: number): TrainEstimate | null {
  const engine = enginesAvailable(game.year).sort((a, b) => b.power * b.topSpeed - a.power * a.topSpeed)[0];
  if (!engine || stationA === stationB) return null;
  const route: RouteStop[] = [
    { station: stationA, load: 'auto', waitFull: false },
    { station: stationB, load: 'auto', waitFull: false },
  ];
  const cargos = suggestConsist(game, engine.id, route);
  const cars = cargos.map((c) => ({ type: carForCargo(c), cargo: c, loads: 1 }));
  const tons = trainTons(engine, cars);
  const v = (engine.topSpeed + Math.max(3, balanceSpeed(engine, tons, maxGrade))) / 2;
  const dwell = (ECONOMY.loading.minDwellHours + ECONOMY.loading.hoursPerLoad * cars.length * 2) / TIME.ticksPerDay;
  const days = tiles / tilesPerDay(v) + dwell;
  const legs: LegEstimate[] = [
    { from: stationA, to: stationB, tiles, days, maxGrade, crawl: v, revenue: 0 },
    { from: stationB, to: stationA, tiles, days, maxGrade, crawl: v, revenue: 0 },
  ];
  return finishEstimate(game, engine.id, cargos, legs, consistPrice(engine.id, cargos));
}
