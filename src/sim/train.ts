import { CARGO_BY_ID, CAR_BY_ID, CONSTRUCTION, ECONOMY, ENGINE_BY_ID, ENGINES, TIME, type EngineDef } from '../data';
import type { Company } from './company';
import { gradePercent } from './construction';
import type { Economy, RevenueQuote } from './economy';
import type { Rng } from './rng';
import { findTrainPath, tileDistance } from './routing';
import { stationEffects, type Station } from './station';
import { NODE_BRIDGE, NODE_GROUND, NODE_TUNNEL, bitCount, canTurn, stepLength } from './track';
import type { World } from './world';

const PH = ECONOMY.physics;
const DXS = [1, 1, 0, -1, -1, -1, 0, 1];
const DYS = [0, 1, 1, 1, 0, -1, -1, -1];
const TICKS_PER_YEAR = TIME.ticksPerDay * 365;

// ---------------------------------------------------------------------------------------
// Data model (plain objects → easy to save later)
// ---------------------------------------------------------------------------------------

export interface Car {
  /** Car type id (cars.json). */
  type: string;
  /** Cargo this car carries / is assigned to. */
  cargo: string;
  /** 0 = empty, 1 = one full load. */
  loads: number;
  /** Station the load came from, and when it was loaded (tick). */
  origin: number;
  loadedTick: number;
}

export interface RouteStop {
  station: number;
  /** 'auto' re-assigns empty cars to the best-paying cargo waiting here; 'keep' keeps the consist. */
  load: 'auto' | 'keep';
  /** Wait until every car is loaded (up to economy.loading.maxWaitDays). */
  waitFull: boolean;
}

export type TrainState = 'running' | 'signal' | 'loading' | 'broken' | 'noroute';

export interface TrainStats {
  revenue: number;
  costs: number;
  lastRevenue: number;
  lastCosts: number;
  lifetimeProfit: number;
  deliveries: number;
  breakdowns: number;
  lastBreakdownTick: number;
}

/** A reservation: a node with a lane ('S' exclusive or 'D<dir>'), or a station platform (node = -1). */
export interface Hold {
  node: number;
  lane: string;
  station: number;
  releaseAt: number;
}

export interface VehiclePosition {
  x: number;
  y: number;
  z: number;
  /** Unit direction the vehicle faces (towards the front of the train). */
  dx: number;
  dy: number;
  tunnel: boolean;
  kind: 'engine' | 'tender' | 'car';
  /** Index into train.cars for kind 'car', else -1. */
  car: number;
}

export interface TrailPoint {
  x: number;
  y: number;
  z: number;
  odo: number;
}

export interface Train {
  id: number;
  name: string;
  /** Owning company id (0 = the player). */
  owner: number;
  engine: string;
  cars: Car[];
  route: RouteStop[];
  /** Index of the route stop the train is heading to (or loading at). */
  stop: number;
  builtTick: number;
  engineBuiltTick: number;
  state: TrainState;
  /** Planned path (tile indices); the head sits between path[seg] and path[seg+1]. */
  path: number[];
  seg: number;
  offset: number;
  /** Highest path index already reserved. */
  auth: number;
  /** Current direction of travel (0–7), -1 = free (e.g. standing in a station). */
  heading: number;
  speed: number;
  odometer: number;
  holds: Hold[];
  trail: TrailPoint[];
  dwellUntil: number;
  loadingSince: number;
  brokenUntil: number;
  waitSince: number;
  /** True while a grade holds the train below 5 mph. */
  struggling: boolean;
  stats: TrainStats;
  /** Serviced at a maintenance shop / roundhouse: buffs last until `until` (tick). */
  service?: { until: number; breakdown: number; maintenance: number };
  /** Sand taken on at a sand house: adhesion multiplier for the current leg. */
  sand?: number;
  /** Most recent delivery, for the train panel's revenue breakdown. */
  lastDelivery?: { station: number; tick: number; quotes: RevenueQuote[] };
}

/** Pseudo-cargo ids for cars that carry nothing but give a bonus. */
export const SPECIAL_CARS: Record<string, string> = { '@caboose': 'caboose', '@dining': 'dining' };

export function isSpecialCar(cargo: string): boolean {
  return cargo in SPECIAL_CARS;
}

export interface ConsistBonus {
  /** Revenue multiplier for freight (all but people). */
  freight: number;
  /** Revenue multiplier for passengers & troops. */
  passengers: number;
  breakdown: number;
}

/** Bonuses from caboose / dining car (each counts once per train). */
export function consistBonus(cars: ReadonlyArray<Pick<Car, 'type'>>): ConsistBonus {
  const out: ConsistBonus = { freight: 1, passengers: 1, breakdown: 1 };
  for (const type of new Set(cars.map((c) => c.type))) {
    const b = CAR_BY_ID.get(type)?.bonus;
    if (!b) continue;
    out.freight *= b.freight ?? 1;
    out.passengers *= b.passengers ?? 1;
    out.breakdown *= b.breakdown ?? 1;
  }
  return out;
}

/** The consist revenue multiplier that applies to one cargo. */
export function cargoBonus(bonus: ConsistBonus, cargo: string): number {
  const def = CARGO_BY_ID.get(cargo);
  if (!def) return 1;
  if (def.group !== 'people') return bonus.freight;
  return cargo === 'mail' ? 1 : bonus.passengers;
}

export function newStats(): TrainStats {
  return { revenue: 0, costs: 0, lastRevenue: 0, lastCosts: 0, lifetimeProfit: 0, deliveries: 0, breakdowns: 0, lastBreakdownTick: -1 };
}

export function engineDef(t: Train): EngineDef {
  const e = ENGINE_BY_ID.get(t.engine);
  if (!e) throw new Error(`Unknown engine ${t.engine}`);
  return e;
}

export function carForCargo(cargo: string): string {
  return SPECIAL_CARS[cargo] ?? CARGO_BY_ID.get(cargo)?.car ?? 'box';
}

// ---------------------------------------------------------------------------------------
// Physics (pure)
// ---------------------------------------------------------------------------------------

export function trainTons(engine: EngineDef, cars: ReadonlyArray<Pick<Car, 'type' | 'cargo' | 'loads'>>): number {
  let t = engine.weight;
  for (const c of cars) t += (CAR_BY_ID.get(c.type)?.tare ?? 15) + c.loads * (CARGO_BY_ID.get(c.cargo)?.tons ?? 20);
  return t;
}

/** Steam engines run with a tender; diesels don't. */
export function hasTender(engineId: string): boolean {
  return !ENGINE_BY_ID.get(engineId)?.look.diesel;
}

/**
 * Length the signalling works with (engine + cars). A steam engine's tender is drawn behind
 * the engine on top of this and fits inside the 0.5-tile margin every block keeps.
 */
export function trainLength(t: Pick<Train, 'cars' | 'engine'>): number {
  return PH.engineLength + t.cars.length * PH.carLength;
}

/** Length as drawn, including the tender. */
export function visualLength(t: Pick<Train, 'cars' | 'engine'>): number {
  return trainLength(t) + (hasTender(t.engine) ? PH.tenderLength : 0);
}

/** Tractive effort (lbf): power-limited, capped by adhesion (× `sand`, see sand house). */
export function tractiveEffort(engine: EngineDef, mph: number, sand = 1): number {
  const powerLimited = (engine.power * 375) / Math.max(mph, 3);
  const adhesion = engine.adhesion * 2000 * PH.adhesionCoefficient * sand;
  return Math.min(powerLimited, adhesion);
}

/** Rolling + grade resistance (lbf). Grade in percent, positive uphill. */
export function resistance(tons: number, mph: number, gradePct: number): number {
  const [a, b, c] = PH.rollingLbfPerTon;
  return tons * (a + b * mph + c * mph * mph) + tons * PH.gradeLbfPerTonPercent * gradePct;
}

/** Speed change over one tick (mph), before speed limits. */
export function accelerationPerTick(engine: EngineDef, tons: number, mph: number, gradePct: number, sand = 1): number {
  const net = tractiveEffort(engine, mph, sand) - resistance(tons, mph, gradePct);
  const mphPerSecond = (net * 0.010968) / tons;
  return mphPerSecond * PH.physicsSecondsPerTick;
}

/** Highest steady speed (mph) on a grade, capped at the engine's top speed. */
export function balanceSpeed(engine: EngineDef, tons: number, gradePct: number, sand = 1): number {
  for (let v = engine.topSpeed; v >= 1; v -= 0.5) {
    if (tractiveEffort(engine, v, sand) >= resistance(tons, v, gradePct)) return v;
  }
  return 0;
}

/** Distance (tiles) needed to stop from `mph` with constant braking. */
export function stoppingDistance(mph: number): number {
  const k = PH.tilesPerTickPerMph;
  return (k * mph * mph) / (2 * PH.brakeMphPerTick) + k * mph;
}

/** Tiles travelled per tick at `mph`. */
export function tilesPerTick(mph: number): number {
  return mph * PH.tilesPerTickPerMph;
}

// ---------------------------------------------------------------------------------------
// Signalling: node holders + station platforms
// ---------------------------------------------------------------------------------------

/**
 * Lanes: 'S' = exclusive (single track), 'D<in>><out>' = passing a double-track node via
 * the edge towards neighbour <in> and leaving towards neighbour <out> (directions seen from
 * the node, 8 = path ends here). Two trains may share a node only if they use the same pair
 * of edges in opposite senses — i.e. they are on the two tracks of the same double line,
 * which also holds through curves.
 */
function lanesConflict(a: string, b: string): boolean {
  if (a === 'S' || b === 'S') return true;
  const [ai, ao] = a.slice(1).split('>');
  const [bi, bo] = b.slice(1).split('>');
  return !(ai === bo && ao === bi && ai !== '8' && ao !== '8');
}

export function doubleLane(track: { dirBetween(a: number, b: number): number }, prev: number, node: number, next: number | undefined): string {
  const inSide = track.dirBetween(node, prev);
  const outSide = next === undefined ? 8 : track.dirBetween(node, next);
  return `D${inSide}>${outSide}`;
}

export class Signals {
  /** node → (train id → lane) */
  readonly nodes = new Map<number, Map<number, string>>();
  /** station id → train ids holding a platform */
  readonly platforms = new Map<number, Set<number>>();

  canHold(node: number, train: number, lane: string): boolean {
    const h = this.nodes.get(node);
    if (!h) return true;
    for (const [tid, l] of h) if (tid !== train && lanesConflict(l, lane)) return false;
    return true;
  }

  hold(node: number, train: number, lane: string): void {
    let h = this.nodes.get(node);
    if (!h) {
      h = new Map();
      this.nodes.set(node, h);
    }
    h.set(train, lane);
  }

  release(node: number, train: number): void {
    const h = this.nodes.get(node);
    if (!h) return;
    h.delete(train);
    if (h.size === 0) this.nodes.delete(node);
  }

  platformCount(station: number): number {
    return this.platforms.get(station)?.size ?? 0;
  }

  hasPlatform(station: number, train: number): boolean {
    return this.platforms.get(station)?.has(train) ?? false;
  }

  takePlatform(station: number, train: number): void {
    let s = this.platforms.get(station);
    if (!s) {
      s = new Set();
      this.platforms.set(station, s);
    }
    s.add(train);
  }

  releasePlatform(station: number, train: number): void {
    this.platforms.get(station)?.delete(train);
  }

  /** Is any train holding (or standing on) this tile? */
  occupied(node: number): boolean {
    return (this.nodes.get(node)?.size ?? 0) > 0;
  }
}

// ---------------------------------------------------------------------------------------
// Train system
// ---------------------------------------------------------------------------------------

export interface TrainHost {
  world: World;
  economy: Economy;
  /** Company by id (trains bill their owner). */
  companyOf(id: number): Company;
  rng: Rng;
  tick: number;
  year: number;
  settings: { wrecks: boolean };
  emit(e: TrainEvent): void;
}

export type TrainEvent =
  | { type: 'delivery'; train: number; station: number; revenue: number; quotes: RevenueQuote[] }
  | { type: 'breakdown'; train: number; days: number; cost: number }
  | { type: 'wreck'; train: number; name: string; x: number; y: number }
  | { type: 'noroute'; train: number };

export function stationPlatforms(st: Station): number {
  return ECONOMY.platforms[st.kind] ?? 2;
}

export function stopTile(st: Station): number {
  return st.tiles[Math.floor(st.tiles.length / 2)];
}

export function engineAgeYears(t: Train, tick: number): number {
  return (tick - t.engineBuiltTick) / TICKS_PER_YEAR;
}

export function resaleValue(t: Train, tick: number): number {
  const e = engineDef(t);
  const r = ECONOMY.resale;
  const age = engineAgeYears(t, tick);
  const engineValue = e.price * Math.max(r.floor, r.newFraction - r.perYear * age);
  const carValue = t.cars.reduce((a, c) => a + (CAR_BY_ID.get(c.type)?.price ?? 2000) * 0.5, 0);
  return Math.round(engineValue + carValue);
}

/** What the engine alone fetches when traded in. */
export function engineTradeIn(t: Train, tick: number): number {
  const r = ECONOMY.resale;
  return Math.round(engineDef(t).price * Math.max(r.floor, r.newFraction - r.perYear * engineAgeYears(t, tick)));
}

/** Daily breakdown probability for an engine of this reliability and age. */
export function breakdownChance(engine: EngineDef, ageYears: number): number {
  const b = ECONOMY.breakdowns;
  const relFactor = (1 - engine.reliability) / (1 - b.referenceReliability);
  return b.perDayAtReference * relFactor * (1 + Math.pow(ageYears / engine.lifespan, b.ageExponent));
}

/** Engines on sale in a given year, newest first. */
export function enginesAvailable(year: number): EngineDef[] {
  return ENGINES.filter((e) => year >= e.era[0] && year <= e.era[1]).sort((a, b) => b.era[0] - a.era[0]);
}

export class TrainSystem {
  readonly trains: Train[] = [];
  readonly signals = new Signals();
  nextId = 1;

  constructor(private readonly host: TrainHost) {}

  get world(): World {
    return this.host.world;
  }

  byId(id: number): Train | undefined {
    return this.trains.find((t) => t.id === id);
  }

  // -- geometry -----------------------------------------------------------------------------

  private center(i: number): [number, number] {
    const W = this.world.width;
    return [(i % W) + 0.5, Math.floor(i / W) + 0.5];
  }

  private segLength(t: Train, k: number): number {
    const a = t.path[k];
    const b = t.path[k + 1];
    if (b === undefined) return 0;
    const d = this.world.track.dirBetween(a, b);
    return d < 0 ? 1 : stepLength(d);
  }

  private nodeZ(i: number): number {
    return this.world.track.getIdx(i)?.z ?? 0;
  }

  /** Distance from the head to the centre of path[k] (k > seg). */
  private distToNode(t: Train, k: number): number {
    let d = this.segLength(t, t.seg) - t.offset;
    for (let j = t.seg + 1; j < k; j++) d += this.segLength(t, j);
    return d;
  }

  /** World position (x, y, z) of the head. */
  headPosition(t: Train): [number, number, number] {
    const a = t.path[t.seg];
    const b = t.path[t.seg + 1];
    const [ax, ay] = this.center(a);
    if (b === undefined) return [ax, ay, this.surfaceZ(a, ax, ay)];
    const [bx, by] = this.center(b);
    const f = t.offset / (this.segLength(t, t.seg) || 1);
    const x = ax + (bx - ax) * f;
    const y = ay + (by - ay) * f;
    return [x, y, this.edgeZ(a, b, f, x, y)];
  }

  private surfaceZ(i: number, x: number, y: number): number {
    const n = this.world.track.getIdx(i);
    if (n && n.kind !== NODE_GROUND) return n.z;
    return this.world.surfaceHeight(x, y);
  }

  /** Track height along edge a→b at fraction f (ground track follows the terrain like the rails do). */
  edgeZ(a: number, b: number, f: number, x: number, y: number): number {
    const na = this.world.track.getIdx(a);
    const nb = this.world.track.getIdx(b);
    if (na && nb && (na.kind !== NODE_GROUND || nb.kind !== NODE_GROUND)) return na.z + (nb.z - na.z) * f;
    return this.world.surfaceHeight(x, y);
  }

  private segGrade(t: Train): number {
    const a = t.path[t.seg];
    const b = t.path[t.seg + 1];
    if (b === undefined) return 0;
    return gradePercent(this.nodeZ(b) - this.nodeZ(a), this.segLength(t, t.seg));
  }

  /** Bridge speed/weight limit for the current segment. */
  private segBridge(t: Train): (typeof CONSTRUCTION.bridges)[number] | null {
    const a = this.world.track.getIdx(t.path[t.seg]);
    const b = this.world.track.getIdx(t.path[t.seg + 1] ?? -1);
    const span = a?.kind === NODE_BRIDGE ? a.span : b?.kind === NODE_BRIDGE ? b.span : -1;
    return span >= 0 ? CONSTRUCTION.bridges[span] : null;
  }

  // -- reservations ---------------------------------------------------------------------------

  private stationAt(i: number): Station | null {
    const n = this.world.track.getIdx(i);
    if (!n || n.station < 0) return null;
    return this.world.stations[n.station] ?? null;
  }

  /**
   * Stations are passing points with room for every train that arrives: a hard platform
   * limit can gridlock two busy stations whose trains want to swap. Platform counts are
   * still tracked (for display and to protect occupied stations from bulldozing).
   */
  private platformFree(_st: Station, _t: Train): boolean {
    return true;
  }

  private takePlatform(st: Station, t: Train): void {
    if (this.signals.hasPlatform(st.id, t.id)) return;
    this.signals.takePlatform(st.id, t.id);
    t.holds.push({ node: -1, lane: 'P', station: st.id, releaseAt: Infinity });
  }

  private holdNode(t: Train, node: number, lane: string): void {
    this.signals.hold(node, t.id, lane);
    t.holds.push({ node, lane, station: -1, releaseAt: Infinity });
  }

  /**
   * A node where a waiting train can never block anyone coming the other way: a station
   * (unlimited room) or a plain double-track node (exactly two connections, both double).
   */
  private isSafe(n: number): boolean {
    if (this.stationAt(n)) return true;
    const node = this.world.track.getIdx(n);
    return !!node && bitCount(node.conn) === 2 && node.double === node.conn;
  }

  /**
   * Reserve the block starting at path[k] atomically (all or nothing): every node up to a
   * station, or up to a stretch of plain double track long enough to hold the whole train.
   * Single-track nodes are held exclusively, double-track nodes per lane. A train can then
   * only ever stand where neither its head nor its tail blocks opposing traffic, which rules
   * out the circular waits that node-by-node reservation allows at junctions, on single
   * track and around small loops. Returns the new authority index or -1.
   */
  private tryReserve(t: Train, k: number): number {
    const track = this.world.track;
    const nodes: Array<{ node: number; lane: string }> = [];
    const need = trainLength(t) + 0.5;
    let station: Station | null = null;
    let safeRun = 0;
    let j = k;
    for (; j < t.path.length; j++) {
      const n = t.path[j];
      const st = this.stationAt(n);
      if (st) {
        station = st;
        break;
      }
      const prev = t.path[j - 1];
      const lane = track.isDouble(prev, n) ? doubleLane(track, prev, n, t.path[j + 1]) : 'S';
      if (!this.signals.canHold(n, t.id, lane)) return -1;
      nodes.push({ node: n, lane });
      if (this.isSafe(n) && this.isSafe(prev)) safeRun += stepLength(track.dirBetween(prev, n));
      else safeRun = 0;
      if (this.isSafe(n) && safeRun >= need) break;
    }
    if (j >= t.path.length) j = t.path.length - 1;
    for (const { node, lane } of nodes) {
      if (!t.holds.some((h) => h.node === node && h.releaseAt === Infinity)) this.holdNode(t, node, lane);
    }
    if (station && this.platformFree(station, t)) this.takePlatform(station, t);
    return j;
  }

  private releaseDue(t: Train): void {
    if (!t.holds.some((h) => h.releaseAt <= t.odometer)) return;
    t.holds = t.holds.filter((h) => {
      if (h.releaseAt > t.odometer) return true;
      if (h.node >= 0) this.signals.release(h.node, t.id);
      else this.signals.releasePlatform(h.station, t.id);
      return false;
    });
  }

  /** Drop every reservation except where the train physically is. */
  private releaseAhead(t: Train): void {
    const keepNode = t.path[t.seg];
    const keepStation = this.stationAt(keepNode)?.id ?? -2;
    t.holds = t.holds.filter((h) => {
      if (h.releaseAt !== Infinity) return true;
      if (h.node === keepNode || h.station === keepStation) return true;
      if (h.node >= 0) this.signals.release(h.node, t.id);
      else this.signals.releasePlatform(h.station, t.id);
      return false;
    });
  }

  releaseAll(t: Train): void {
    for (const h of t.holds) {
      if (h.node >= 0) this.signals.release(h.node, t.id);
      else this.signals.releasePlatform(h.station, t.id);
    }
    t.holds = [];
  }

  /** Tiles trains stand on or have reserved (construction must not remove them). */
  occupiedTiles(): Set<number> {
    const s = new Set<number>(this.signals.nodes.keys());
    for (const t of this.trains) {
      s.add(t.path[t.seg]);
      for (const h of t.holds) if (h.station >= 0) for (const tile of this.world.stations[h.station]?.tiles ?? []) s.add(tile);
    }
    return s;
  }

  // -- lifecycle ------------------------------------------------------------------------------

  /** Place a new train standing in the first stop's station. */
  private readonly numbers = new Map<number, number>();

  /** Train numbers count per company (No. 1, No. 2, … for each railroad). */
  private nextNumber(owner: number): number {
    const n = (this.numbers.get(owner) ?? 0) + 1;
    this.numbers.set(owner, n);
    return n;
  }

  spawn(engine: string, cargos: string[], route: RouteStop[], name?: string, owner = 0): Train {
    const st = this.world.stations[route[0].station];
    if (!st) throw new Error('First stop is not a station');
    const node = stopTile(st);
    const id = this.nextId++;
    const t: Train = {
      id,
      name: name ?? `No. ${this.nextNumber(owner)}`,
      owner,
      engine,
      cars: cargos.map((c) => ({ type: carForCargo(c), cargo: c, loads: 0, origin: -1, loadedTick: 0 })),
      route: route.map((r) => ({ ...r })),
      stop: 0,
      builtTick: this.host.tick,
      engineBuiltTick: this.host.tick,
      state: 'loading',
      path: [node],
      seg: 0,
      offset: 0,
      auth: 0,
      heading: -1,
      speed: 0,
      odometer: 0,
      holds: [],
      trail: [],
      dwellUntil: this.host.tick,
      loadingSince: this.host.tick,
      brokenUntil: 0,
      waitSince: 0,
      struggling: false,
      stats: newStats(),
    };
    this.signals.takePlatform(st.id, t.id);
    t.holds.push({ node: -1, lane: 'Pin', station: st.id, releaseAt: Infinity });
    this.resetTrail(t, st.axis === 'x' ? 0 : 2);
    this.trains.push(t);
    this.arrive(t, true);
    return t;
  }

  remove(t: Train): void {
    this.releaseAll(t);
    const i = this.trains.indexOf(t);
    if (i >= 0) this.trains.splice(i, 1);
  }

  /**
   * Trail behind the head, opposite to direction `dir` (used after spawning/reversing). It
   * follows the track back from the head's node where there is track, then runs straight.
   */
  private resetTrail(t: Train, dir: number, placing = false): void {
    const track = this.world.track;
    const [x, y, z] = this.headPosition(t);
    const back = visualLength(t) + 1;
    const start = t.path[t.seg];
    let node = start;
    const behind = (d: number) => [d, (d + 1) % 8, (d + 7) % 8].find((c) => track.connected(node, track.neighbor(node, c)));
    // Walk the track from the head's node in direction d; returns the points visited.
    const walk = (d0: number) => {
      node = start;
      let d = d0;
      const out: Array<{ x: number; y: number; z: number }> = [{ x, y, z }];
      let run = 0;
      for (let guard = 0; guard < 64 && run < back; guard++) {
        const c = behind(d);
        if (c === undefined) break;
        const next = track.neighbor(node, c);
        const nx = (next % this.world.width) + 0.5;
        const ny = Math.floor(next / this.world.width) + 0.5;
        const last = out[out.length - 1];
        run += Math.hypot(nx - last.x, ny - last.y);
        out.push({ x: nx, y: ny, z: this.surfaceZ(next, nx, ny) });
        node = next;
        d = c;
      }
      return { pts: out, run, d };
    };
    // Trail behind the train; a train placed at the end of a line lies along the line.
    let best = walk((dir + 4) % 8);
    if (placing && best.run < back) {
      const other = walk(dir);
      if (other.run > best.run) best = other;
    }
    const pts = best.pts;
    const run = best.run;
    const d = best.d;
    if (run < back) {
      const last = pts[pts.length - 1];
      const prev = pts.length > 1 ? pts[pts.length - 2] : { x: x + DXS[(d + 4) % 8], y: y + DYS[(d + 4) % 8] };
      const l = Math.hypot(last.x - prev.x, last.y - prev.y) || 1;
      const rest = back - run;
      pts.push({ x: last.x + ((last.x - prev.x) / l) * rest, y: last.y + ((last.y - prev.y) / l) * rest, z: last.z });
    }
    // Oldest point first, odometer decreasing backwards.
    let odo = t.odometer;
    const trail: TrailPoint[] = [{ ...pts[0], odo }];
    for (let k = 1; k < pts.length; k++) {
      odo -= Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);
      trail.push({ ...pts[k], odo });
    }
    t.trail = trail.reverse();
  }


  // -- tick -----------------------------------------------------------------------------------

  step(): void {
    for (const t of [...this.trains]) {
      switch (t.state) {
        case 'broken':
          if (this.host.tick >= t.brokenUntil) t.state = 'running';
          break;
        case 'loading':
          this.loadingTick(t);
          break;
        case 'noroute':
          if (this.host.tick % TIME.ticksPerDay === 0) this.depart(t);
          break;
        default:
          this.move(t);
      }
    }
  }

  /** Daily random events (breakdowns). */
  daily(): void {
    for (const t of this.trains) {
      if (t.state !== 'running' && t.state !== 'signal') continue;
      const e = engineDef(t);
      const factor = consistBonus(t.cars).breakdown * this.serviceFx(t).breakdown;
      if (this.host.rng.next() >= breakdownChance(e, engineAgeYears(t, this.host.tick)) * factor) continue;
      const b = ECONOMY.breakdowns;
      const days = this.host.rng.int(b.repairDays[0], b.repairDays[1]);
      const cost = Math.round(e.price * b.repairCostFraction);
      t.state = 'broken';
      t.speed = 0;
      t.brokenUntil = this.host.tick + days * TIME.ticksPerDay;
      t.stats.breakdowns++;
      t.stats.lastBreakdownTick = this.host.tick;
      this.charge(t, 'repairs', cost);
      this.host.emit({ type: 'breakdown', train: t.id, days, cost });
    }
  }

  /** Monthly running costs: engine maintenance (rises with age). */
  monthly(): void {
    for (const t of this.trains) {
      const e = engineDef(t);
      const age = engineAgeYears(t, this.host.tick);
      const base = (e.maintenance / 12) * (1 + ECONOMY.engineWear.maintenancePerYearOfAge * age);
      this.charge(t, 'maintenance', base * this.serviceFx(t).maintenance);
    }
  }

  /** Active maintenance-shop buffs (1 = none). */
  serviceFx(t: Train): { breakdown: number; maintenance: number } {
    return t.service && t.service.until > this.host.tick ? t.service : { breakdown: 1, maintenance: 1 };
  }

  yearly(): void {
    for (const t of this.trains) {
      t.stats.lifetimeProfit += t.stats.revenue - t.stats.costs;
      t.stats.lastRevenue = t.stats.revenue;
      t.stats.lastCosts = t.stats.costs;
      t.stats.revenue = 0;
      t.stats.costs = 0;
    }
  }

  private charge(t: Train, cat: 'fuel' | 'maintenance' | 'repairs', amount: number): void {
    t.stats.costs += amount;
    this.host.companyOf(t.owner).spend(this.host.year, cat, amount);
  }

  private move(t: Train): void {
    const e = engineDef(t);
    if (t.seg >= t.path.length - 1) {
      this.arrive(t, false);
      return;
    }
    const tons = trainTons(e, t.cars);
    // Extend authority ahead of the head.
    const look = stoppingDistance(t.speed) + tilesPerTick(e.topSpeed) + 1;
    let k = t.auth + 1;
    while (k < t.path.length && this.distToNode(t, k) - 0.5 <= look) {
      const got = this.tryReserve(t, k);
      if (got < 0) break;
      t.auth = got;
      k = t.auth + 1;
    }
    const blocked = k < t.path.length;
    // Without authority for the next tile the head must stay inside its current tile.
    const limit = Math.max(0, blocked ? this.distToNode(t, k) - 0.52 : this.distToNode(t, t.path.length - 1));

    // Physics.
    const grade = this.segGrade(t);
    let vmax = e.topSpeed;
    const bridge = this.segBridge(t);
    if (bridge) vmax = Math.min(vmax, tons > bridge.weightLimit ? PH.overweightBridgeMph : bridge.speedLimit);
    let v = t.speed + accelerationPerTick(e, tons, t.speed, grade, t.sand ?? 1);
    t.struggling = v < 5 && grade > 0;
    // Trains never stall completely on a grade; they crawl.
    v = Math.max(v, Math.min(3, vmax));
    v = Math.min(v, vmax);
    // Brake so we can stop at the limit point.
    const k2 = PH.tilesPerTickPerMph;
    const vStop = Math.sqrt((2 * PH.brakeMphPerTick * Math.max(0, limit - k2 * t.speed)) / k2);
    v = Math.min(v, Math.max(vStop, limit > 0.02 ? 2 : 0));
    let travel = Math.min(tilesPerTick(v), limit);
    // Close enough to the stop point: snap onto it instead of creeping forever.
    if (limit < 0.02) {
      travel = blocked ? 0 : limit;
      v = 0;
    }
    t.speed = v;
    if (travel <= 0) {
      if (blocked && t.state !== 'signal') {
        t.state = 'signal';
        t.waitSince = this.host.tick;
      }
      return;
    }
    t.state = 'running';
    this.advance(t, travel, e, tons, bridge !== null && tons > bridge.weightLimit);
  }

  private advance(t: Train, d: number, e: EngineDef, tons: number, overweight: boolean): void {
    // Fuel and wreck risk scale with distance.
    const fuel = d * 0.25 * (ECONOMY.fuelPrice[e.fuel] ?? 1) * (e.fuelBase + e.fuelPerTon * tons);
    this.charge(t, 'fuel', fuel);
    if (this.host.settings.wrecks) {
      const w = ECONOMY.wrecks;
      const age = engineAgeYears(t, this.host.tick);
      const p = d * w.perTileAtLifespan * Math.pow(age / e.lifespan, w.ageExponent) * (overweight ? w.overweightBridgeFactor : 1);
      if (p > 0 && this.host.rng.next() < p) {
        this.wreck(t);
        return;
      }
    }
    while (d > 1e-9) {
      const len = this.segLength(t, t.seg);
      const rem = len - t.offset;
      if (d < rem) {
        t.offset += d;
        t.odometer += d;
        d = 0;
      } else {
        t.odometer += rem;
        d -= rem;
        t.offset = 0;
        t.seg++;
        this.enterNode(t);
        if (t.seg >= t.path.length - 1) {
          d = 0;
          t.speed = 0;
          this.arrive(t, false);
          return;
        }
      }
    }
    this.releaseDue(t);
  }

  private enterNode(t: Train): void {
    const node = t.path[t.seg];
    const prev = t.path[t.seg - 1];
    t.heading = this.world.track.dirBetween(prev, node);
    const [x, y] = this.center(node);
    t.trail.push({ x, y, z: this.surfaceZ(node, x, y), odo: t.odometer });
    // Keep only what the cars need.
    const need = visualLength(t) + 2;
    while (t.trail.length > 2 && t.odometer - t.trail[1].odo > need) t.trail.shift();
    // The tail clears this node (and stations we have left) one train length later.
    const st = this.stationAt(node);
    for (const h of t.holds) {
      if (h.releaseAt !== Infinity) continue;
      if (h.node === prev) h.releaseAt = t.odometer + 0.5 + trainLength(t);
      if (h.station >= 0) {
        // 'P' = platform reserved ahead, 'Pin' = the train has been in that station.
        if (h.station === st?.id) h.lane = 'Pin';
        else if (h.lane === 'Pin') h.releaseAt = t.odometer + 0.5 + trainLength(t);
      }
    }
    this.releaseDue(t);
    // Track changed under us? Re-plan from here.
    const next = t.path[t.seg + 1];
    if (next !== undefined && !this.world.track.connected(node, next)) this.replan(t);
  }

  private replan(t: Train): void {
    const target = this.currentTarget(t);
    this.releaseAhead(t);
    const node = t.path[t.seg];
    const path = target ? findTrainPath(this.world, node, t.heading, new Set([stopTile(target)])) : null;
    if (!path) {
      t.path = [node];
      t.seg = 0;
      t.offset = 0;
      t.auth = 0;
      t.state = 'noroute';
      t.speed = 0;
      this.host.emit({ type: 'noroute', train: t.id });
      return;
    }
    t.path = path.nodes;
    t.seg = 0;
    t.offset = 0;
    t.auth = 0;
  }

  /** Station of the current route stop (skipping stops whose station was removed). */
  private currentTarget(t: Train): Station | null {
    for (let i = 0; i < t.route.length; i++) {
      const s = this.world.stations[t.route[t.stop].station];
      if (s) return s;
      t.stop = (t.stop + 1) % t.route.length;
    }
    return null;
  }

  // -- stations ---------------------------------------------------------------------------------

  /** Head reached the end of its path (or the train was just placed): unload & load. */
  private arrive(t: Train, spawned: boolean): void {
    t.speed = 0;
    t.state = 'loading';
    t.loadingSince = this.host.tick;
    const node = t.path[t.path.length - 1];
    t.path = [node];
    t.seg = 0;
    t.offset = 0;
    t.auth = 0;
    const st = this.stationAt(node);
    // A train standing at a platform fits the station: free the track behind it.
    for (const h of t.holds) {
      if (h.station >= 0 && h.station === st?.id) h.lane = 'Pin';
      else h.releaseAt = -Infinity;
    }
    this.releaseDue(t);
    const stop = t.route[t.stop];
    let handled = 0;
    t.sand = undefined;
    const fx = stationEffects(st);
    if (st && stop && st.id === stop.station) {
      if (!spawned) handled += this.unload(t, st);
      handled += this.load(t, st, stop);
      if (fx.breakdown < 1 || fx.maintenance < 1) {
        t.service = { until: this.host.tick + ECONOMY.serviceDays * TIME.ticksPerDay, breakdown: fx.breakdown, maintenance: fx.maintenance };
      }
      if (fx.adhesion > 1) t.sand = fx.adhesion;
    }
    const L = ECONOMY.loading;
    t.dwellUntil = this.host.tick + Math.round((L.minDwellHours + L.hoursPerLoad * handled) * fx.dwell);
  }

  private routeDemands(t: Train, cargo: string, except: number): boolean {
    return t.route.some((r) => r.station !== except && this.host.economy.accepts(r.station, cargo));
  }

  private unload(t: Train, st: Station): number {
    const econ = this.host.economy;
    const quotes = new Map<string, RevenueQuote>();
    const bonus = consistBonus(t.cars);
    let n = 0;
    let total = 0;
    for (const car of t.cars) {
      if (car.loads <= 0 || car.origin === st.id || isSpecialCar(car.cargo)) continue;
      const demanded = econ.accepts(st.id, car.cargo);
      if (!demanded && this.routeDemands(t, car.cargo, st.id)) continue;
      const origin = this.world.stations[car.origin];
      const dist = origin ? tileDistance(this.world, stopTile(origin), stopTile(st)) : 0;
      const days = (this.host.tick - car.loadedTick) / TIME.ticksPerDay;
      const q = econ.quote(st.id, car.cargo, car.loads, dist, days, { bonus: cargoBonus(bonus, car.cargo), graceBonus: stationEffects(origin).fresh });
      const prev = quotes.get(car.cargo);
      if (prev) {
        // average the factors over the cars of this cargo
        const w = prev.loads + q.loads;
        prev.timeFactor = (prev.timeFactor * prev.loads + q.timeFactor * q.loads) / w;
        prev.transitDays = (prev.transitDays * prev.loads + q.transitDays * q.loads) / w;
        prev.demandFactor = (prev.demandFactor * prev.loads + q.demandFactor * q.loads) / w;
        prev.loads = w;
        prev.total += q.total;
      } else quotes.set(car.cargo, q);
      total += q.total;
      econ.deliver(st.id, car.cargo, car.loads, q.total);
      this.host.companyOf(t.owner).earn(this.host.year, car.cargo, q.total);
      t.stats.revenue += q.total;
      t.stats.deliveries += car.loads;
      n += car.loads;
      car.loads = 0;
      car.origin = -1;
    }
    if (n > 0) {
      t.lastDelivery = { station: st.id, tick: this.host.tick, quotes: [...quotes.values()] };
      this.host.emit({ type: 'delivery', train: t.id, station: st.id, revenue: total, quotes: [...quotes.values()] });
    }
    return n;
  }

  /** Best-paying cargo waiting here for an empty car, judged by the next stop that wants it. */
  private bestCargo(t: Train, st: Station, taken: Map<string, number>): string | null {
    const econ = this.host.economy;
    const waiting = econ.cargoAt(st.id).waiting;
    let best: string | null = null;
    let bestValue = 0;
    for (const [cargo, amount] of Object.entries(waiting)) {
      if (Math.floor(amount + 1e-9) - (taken.get(cargo) ?? 0) < 1) continue;
      const def = CARGO_BY_ID.get(cargo);
      if (!def) continue;
      // Value at the first later stop that demands it (else the next stop at a discount).
      let value = 0;
      for (let k = 1; k <= t.route.length; k++) {
        const r = t.route[(t.stop + k) % t.route.length];
        const other = this.world.stations[r.station];
        if (!other || other.id === st.id) continue;
        const dist = tileDistance(this.world, stopTile(st), stopTile(other));
        const demanded = econ.accepts(other.id, cargo);
        const q = econ.quote(other.id, cargo, 1, dist, 0);
        if (demanded) {
          value = q.total;
          break;
        }
        value = Math.max(value, q.total * 0.5);
      }
      if (value > bestValue) {
        bestValue = value;
        best = cargo;
      }
    }
    return best;
  }

  private load(t: Train, st: Station, stop: RouteStop): number {
    const econ = this.host.economy;
    let n = 0;
    const taken = new Map<string, number>();
    for (const car of t.cars) {
      if (car.loads > 0 || isSpecialCar(car.cargo)) continue;
      if (stop.load === 'auto') {
        const best = this.bestCargo(t, st, taken);
        if (best) {
          car.cargo = best;
          car.type = carForCargo(best);
        }
      }
      if (econ.take(st.id, car.cargo, 1) === 1) {
        car.loads = 1;
        car.origin = st.id;
        car.loadedTick = this.host.tick;
        taken.set(car.cargo, (taken.get(car.cargo) ?? 0) + 1);
        n++;
      }
    }
    return n;
  }

  private loadingTick(t: Train): void {
    if (this.host.tick < t.dwellUntil) return;
    const stop = t.route[t.stop];
    const st = this.stationAt(t.path[0]);
    if (stop?.waitFull && st && st.id === stop.station && t.cars.some((c) => c.loads === 0 && !isSpecialCar(c.cargo))) {
      const waited = (this.host.tick - t.loadingSince) / TIME.ticksPerDay;
      if (waited < ECONOMY.loading.maxWaitDays) {
        // Check for new cargo a few times a day.
        if (this.host.tick % 6 === 0) {
          const got = this.load(t, st, stop);
          if (got) t.dwellUntil = this.host.tick + ECONOMY.loading.hoursPerLoad * got;
        }
        return;
      }
    }
    t.stop = (t.stop + 1) % t.route.length;
    this.depart(t);
  }

  /** Leave for the current target stop; trains may reverse while standing in a station. */
  private depart(t: Train): void {
    const target = this.currentTarget(t);
    const node = t.path[t.seg];
    const inStation = this.stationAt(node) !== null;
    const path = target ? findTrainPath(this.world, node, inStation ? -1 : t.heading, new Set([stopTile(target)])) : null;
    if (!path || path.nodes.length < 2) {
      if (target && path && path.nodes.length === 1) {
        // Already there (single-station route).
        this.arrive(t, false);
        return;
      }
      if (t.state !== 'noroute') this.host.emit({ type: 'noroute', train: t.id });
      t.state = 'noroute';
      return;
    }
    this.releaseAhead(t);
    t.path = path.nodes;
    t.seg = 0;
    t.offset = 0;
    t.auth = 0;
    t.state = 'running';
    const first = this.world.track.dirBetween(path.nodes[0], path.nodes[1]);
    if (t.heading < 0 || !canTurn(t.heading, first)) this.resetTrail(t, first);
    t.heading = first;
  }

  private wreck(t: Train): void {
    const [x, y] = this.headPosition(t);
    this.remove(t);
    this.host.emit({ type: 'wreck', train: t.id, name: t.name, x, y });
  }

  // -- queries ----------------------------------------------------------------------------------

  /** Positions of engine + cars for drawing: [x, y, z, dirX, dirY] per vehicle, head first. */
  vehiclePositions(t: Train): VehiclePosition[] {
    const [hx, hy, hz] = this.headPosition(t);
    const pts: TrailPoint[] = [...t.trail, { x: hx, y: hy, z: hz, odo: t.odometer }];
    const at = (back: number) => {
      // Walk back along the polyline from the head.
      let remaining = back;
      for (let i = pts.length - 1; i > 0; i--) {
        const a = pts[i - 1];
        const b = pts[i];
        const seg = Math.hypot(b.x - a.x, b.y - a.y);
        if (remaining <= seg || i === 1) {
          const f = seg > 0 ? Math.max(0, 1 - remaining / seg) : 1;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          return { x: a.x + dx * f, y: a.y + dy * f, z: a.z + (b.z - a.z) * f, dx: dx / len, dy: dy / len };
        }
        remaining -= seg;
      }
      return { x: hx, y: hy, z: hz, dx: 1, dy: 0 };
    };
    const tunnelAt = (x: number, y: number) => this.world.track.get(Math.floor(x), Math.floor(y))?.kind === NODE_TUNNEL;
    const out: VehiclePosition[] = [];
    let back = 0;
    // Each vehicle sits on the chord between its front and rear points, so it turns smoothly.
    const place = (len: number, kind: VehiclePosition['kind'], car: number) => {
      const f = at(back + len * 0.1);
      const r = at(back + len * 0.9);
      let dx = f.x - r.x;
      let dy = f.y - r.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) {
        dx /= d;
        dy /= d;
      } else {
        dx = f.dx;
        dy = f.dy;
      }
      const x = (f.x + r.x) / 2;
      const y = (f.y + r.y) / 2;
      out.push({ x, y, z: (f.z + r.z) / 2, dx, dy, tunnel: tunnelAt(x, y), kind, car });
      back += len;
    };
    place(PH.engineLength, 'engine', -1);
    if (hasTender(t.engine)) place(PH.tenderLength, 'tender', -1);
    for (let i = 0; i < t.cars.length; i++) place(PH.carLength, 'car', i);
    return out;
  }

}
