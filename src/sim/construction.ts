import { CONSTRUCTION, type BridgeDef } from '../data';
import { MinHeap } from './heap';
import { catchmentRect, coverage, stationDef, stationName, type Coverage, type Station, type TileRect } from './station';
import {
  NODE_BRIDGE,
  NODE_GROUND,
  NODE_TUNNEL,
  canTurn,
  cloneNode,
  isDiagonal,
  opposite,
  stepLength,
  type TrackNode,
} from './track';
import { F, OCC_BUILDING, OCC_INDUSTRY, T, World, occupantIndex, occupantKind, TERRAIN_NAMES } from './world';

const C = CONSTRUCTION;

// ---------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------

const groundCache = new WeakMap<World, { heights: Uint8Array; z: Float32Array }>();

/** Terrain height at a tile centre (levels). Cached per world (heights are fixed). */
export function groundZ(world: World, i: number): number {
  let c = groundCache.get(world);
  if (!c || c.heights !== world.heights) {
    const z = new Float32Array(world.width * world.height).fill(NaN);
    c = { heights: world.heights, z };
    groundCache.set(world, c);
  }
  let v = c.z[i];
  if (v !== v) {
    v = world.surfaceHeight((i % world.width) + 0.5, Math.floor(i / world.width) + 0.5);
    c.z[i] = v;
  }
  return v;
}

/** Track height at a tile: existing node's height, else the ground. */
export function trackZ(world: World, i: number): number {
  return world.track.getIdx(i)?.z ?? groundZ(world, i);
}

/** Signed grade in percent for a rise of dz levels over `len` tiles. */
export function gradePercent(dz: number, len: number): number {
  return ((dz * C.feetPerLevel) / (len * C.feetPerTile)) * 100;
}

export function tilesToMiles(tiles: number): number {
  return (tiles * C.feetPerTile) / 5280;
}

export function axisDirs(axis: 'x' | 'y'): [number, number] {
  return axis === 'x' ? [0, 4] : [2, 6];
}

export function bridgesAvailable(year: number): BridgeDef[] {
  return C.bridges.filter((b) => year >= b.era[0] && year <= b.era[1]);
}

// ---------------------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------------------

export interface CostBreakdown {
  track: number;
  earthworks: number;
  clearing: number;
  crossings: number;
  doubling: number;
  demolition: number;
  bridges: number;
  tunnels: number;
  stations: number;
}

export function emptyBreakdown(): CostBreakdown {
  return { track: 0, earthworks: 0, clearing: 0, crossings: 0, doubling: 0, demolition: 0, bridges: 0, tunnels: 0, stations: 0 };
}

export function sumBreakdown(b: CostBreakdown): number {
  return b.track + b.earthworks + b.clearing + b.crossings + b.doubling + b.demolition + b.bridges + b.tunnels + b.stations;
}

function terrainMult(world: World, i: number): number {
  return C.track.terrain[TERRAIN_NAMES[world.terrain[i]]] ?? 1;
}

/** Building on this tile (if any, and not demolished). */
function buildingAt(world: World, i: number) {
  const occ = world.occupant[i];
  if (occupantKind(occ) !== OCC_BUILDING) return null;
  return world.buildings[occupantIndex(occ)];
}

export interface TrackOptions {
  double: boolean;
  /** Preferred bridge type id or 'auto' (cheapest that spans the gap). */
  bridge: 'auto' | string;
  tunnels: boolean;
  demolish: boolean;
  year: number;
}

export function defaultTrackOptions(year: number): TrackOptions {
  return { double: false, bridge: 'auto', tunnels: true, demolish: true, year };
}

/**
 * Can a ground track node be created on (or reuse) tile i?
 * Returns the one-off cost of preparing the tile, or null if impossible.
 */
function groundNodeCost(world: World, i: number, opts: TrackOptions, into?: CostBreakdown): number | null {
  if (i < 0) return null;
  const node = world.track.getIdx(i);
  if (node) return node.kind === NODE_GROUND ? 0 : null;
  if (world.terrain[i] === T.Water) return null;
  if (world.flags[i] & F.River) return null;
  const occ = world.occupant[i];
  if (occupantKind(occ) === OCC_INDUSTRY) return null;
  let cost = 0;
  const b = buildingAt(world, i);
  if (b) {
    if (!opts.demolish) return null;
    const d = C.track.demolish[b.defId] ?? 20000;
    cost += d;
    if (into) into.demolition += d;
  }
  if (world.terrain[i] === T.Forest || world.flags[i] & F.Tree) {
    cost += C.track.clearForest;
    if (into) into.clearing += C.track.clearForest;
  }
  if (world.flags[i] & F.Road) {
    cost += C.track.levelCrossing;
    if (into) into.crossings += C.track.levelCrossing;
  }
  return cost;
}

/** Can tile i carry a ground track node (possibly after clearing/demolition)? */
export function canHostTrack(world: World, i: number, opts: TrackOptions): boolean {
  return groundNodeCost(world, i, opts) !== null;
}

function edgeCost(world: World, a: number, b: number, d: number, za: number, zb: number, opts: TrackOptions, into?: CostBreakdown): number {
  const len = stepLength(d);
  const base = C.track.single * len * Math.max(terrainMult(world, a), terrainMult(world, b));
  const earth = C.track.perLevelClimb * Math.abs(zb - za);
  const dbl = opts.double ? C.track.doubleExtra * len : 0;
  if (into) {
    into.track += base;
    into.earthworks += earth;
    into.doubling += dbl;
  }
  return base + earth + dbl;
}

// ---------------------------------------------------------------------------------------
// Track planning (A*)
// ---------------------------------------------------------------------------------------

export type StepKind = 'new' | 'reuse' | 'bridge' | 'tunnel';

export interface PlanStep {
  from: number;
  to: number;
  dir: number;
  kind: StepKind;
  /** Interior tiles of a bridge/tunnel span (or of an existing span being reused). */
  interior: number[];
  /** Bridge type index for bridges. */
  bridge: number;
  /** Tiles travelled. */
  length: number;
  z0: number;
  z1: number;
  /** Signed grade in percent. */
  grade: number;
  /** Reusing single track in double mode → upgrade. */
  upgrade: boolean;
}

export interface TrackPlan {
  ok: boolean;
  /** world.editVersion when planned; a plan is only applied to the same world state. */
  version: number;
  error?: string;
  from: number;
  to: number;
  steps: PlanStep[];
  breakdown: CostBreakdown;
  cost: number;
  lengthTiles: number;
  newTiles: number;
  maxGrade: number;
  bridges: number;
  tunnels: number;
  demolished: number[];
  treesCleared: number;
  /** Elevation profile: cumulative distance (tiles) and track height (levels). */
  profile: Array<{ dist: number; z: number }>;
}

function failedPlan(from: number, to: number, error: string): TrackPlan {
  return {
    ok: false,
    version: -1,
    error,
    from,
    to,
    steps: [],
    breakdown: emptyBreakdown(),
    cost: 0,
    lengthTiles: 0,
    newTiles: 0,
    maxGrade: 0,
    bridges: 0,
    tunnels: 0,
    demolished: [],
    treesCleared: 0,
    profile: [],
  };
}

/** Search buffers; one instance per concurrent planner (reused between plans). */
export class PlannerScratch {
  size = 0;
  gScore = new Float64Array(0);
  parent = new Int32Array(0);
  stepMeta = new Int32Array(0);
  closed = new Uint8Array(0);

  ensure(n: number): void {
    if (this.size === n) return;
    this.size = n;
    this.gScore = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.stepMeta = new Int32Array(n);
    this.closed = new Uint8Array(n);
  }
}

const sharedScratch = new PlannerScratch();

// stepMeta encoding: kind (2 bits) | spanLen << 2 | (bridgeIdx + 1) << 8
const META_NEW = 0;
const META_REUSE = 1;
const META_BRIDGE = 2;
const META_TUNNEL = 3;

interface SpanOption {
  landing: number;
  k: number;
  bridge: number;
  money: number;
  cat: 'bridges' | 'tunnels';
}

function chooseBridge(k: number, opts: TrackOptions): number {
  const avail = bridgesAvailable(opts.year);
  const fitting = avail.filter((b) => b.maxSpan >= k && (opts.bridge === 'auto' || b.id === opts.bridge));
  if (fitting.length === 0) return -1;
  fitting.sort((a, b) => a.perTile - b.perTile);
  return C.bridges.indexOf(fitting[0]);
}

const spanCache = new Map<string, number>();
function maxBridgeSpan(opts: TrackOptions): number {
  const key = `${opts.year}:${opts.bridge}`;
  let v = spanCache.get(key);
  if (v === undefined) {
    v = Math.max(0, ...bridgesAvailable(opts.year).filter((b) => opts.bridge === 'auto' || b.id === opts.bridge).map((b) => b.maxSpan));
    spanCache.set(key, v);
  }
  return v;
}

/** Bridge / tunnel spans that start at tile t heading in direction d. */
function spanOptions(world: World, t: number, d: number, zt: number, opts: TrackOptions): SpanOption[] {
  const out: SpanOption[] = [];
  const track = world.track;
  const n1 = track.neighbor(t, d);
  if (n1 < 0) return out;
  const z1 = groundZ(world, n1);
  const firstWet = world.terrain[n1] === T.Water || (world.flags[n1] & F.River) !== 0;
  const len = stepLength(d);

  // Bridges: over water/rivers, or over a dip.
  const maxBridge = maxBridgeSpan(opts);
  if (maxBridge > 0 && (firstWet || z1 < zt - 0.5)) {
    const interior: number[] = [];
    let cur = t;
    for (let k = 1; k <= maxBridge; k++) {
      cur = track.neighbor(cur, d);
      if (cur < 0 || track.getIdx(cur) || world.occupant[cur] !== 0) break;
      if (isDiagonal(d) && crossesSpan(world, cur, d)) break;
      interior.push(cur);
      const landing = track.neighbor(cur, d);
      if (landing < 0) break;
      if (!landingOk(world, landing, d, opts)) continue;
      const zl = trackZ(world, landing);
      // Deck clearance over every interior tile.
      let clear = true;
      let heightSum = 0;
      for (let j = 0; j < interior.length; j++) {
        const deck = zt + ((zl - zt) * (j + 1)) / (k + 1);
        const it = interior[j];
        const wet = world.terrain[it] === T.Water || (world.flags[it] & F.River) !== 0;
        const ground = wet ? 0 : world.tileMaxH(it % world.width, Math.floor(it / world.width));
        if (!wet && ground > deck - 0.5) {
          clear = false;
          break;
        }
        heightSum += Math.max(0, deck - (wet ? 0 : groundZ(world, it)));
      }
      if (!clear) continue;
      if (Math.abs(zl - zt) / (k + 1) > 1) continue;
      const bi = chooseBridge(k, opts);
      if (bi < 0) continue;
      const b = C.bridges[bi];
      const money = b.perTile * (k + 1) * len + b.perLevel * heightSum;
      out.push({ landing, k, bridge: bi, money, cat: 'bridges' });
    }
  }

  // Tunnels: through a hill that rises ahead.
  if (opts.tunnels && z1 > zt + 0.5) {
    let cur = t;
    const interior: number[] = [];
    for (let k = 1; k <= C.tunnel.maxLength; k++) {
      cur = track.neighbor(cur, d);
      if (cur < 0 || track.getIdx(cur)) break;
      if (world.terrain[cur] === T.Water || world.flags[cur] & F.River) break;
      interior.push(cur);
      if (k < 2) continue;
      const landing = track.neighbor(cur, d);
      if (landing < 0) break;
      if (!landingOk(world, landing, d, opts)) continue;
      const zl = trackZ(world, landing);
      if (Math.abs(zl - zt) / (k + 1) > C.tunnel.maxGradeLevelsPerTile) continue;
      let covered = true;
      for (let j = 0; j < interior.length; j++) {
        const line = zt + ((zl - zt) * (j + 1)) / (k + 1);
        const it = interior[j];
        if (groundZ(world, it) < line + C.tunnel.minCover) {
          covered = false;
          break;
        }
      }
      if (!covered) continue;
      out.push({ landing, k, bridge: -1, money: C.tunnel.perTile * (k + 1) * len, cat: 'tunnels' });
    }
  }
  return out;
}

function landingOk(world: World, landing: number, d: number, opts: TrackOptions): boolean {
  if (groundNodeCost(world, landing, opts) === null) return false;
  const ln = world.track.getIdx(landing);
  return !ln || ln.station < 0 || axisDirs(stationAxis(world, ln)).includes(d);
}

/** A new diagonal span step through tile `cur` would cross an existing diagonal edge. */
function crossesSpan(world: World, cur: number, d: number): boolean {
  const prev = world.track.neighbor(cur, opposite(d));
  return prev >= 0 && world.track.crossesDiagonal(prev, cur);
}

function stationAxis(world: World, n: TrackNode): 'x' | 'y' {
  return world.stations[n.station]?.axis ?? 'x';
}

const FORWARD: number[][] = Array.from({ length: 8 }, (_, d) => [(d + 7) & 7, d, (d + 1) & 7]);
const ALL_DIRS = [0, 1, 2, 3, 4, 5, 6, 7];

function allowedDirsAt(world: World, i: number, din: number): number[] {
  const node = world.track.getIdx(i);
  if (!node) return din < 8 ? FORWARD[din] : ALL_DIRS;
  let dirs: number[];
  if (din < 8) dirs = FORWARD[din];
  else if (node && node.conn) {
    dirs = [];
    for (let d = 0; d < 8; d++) {
      // Following existing track is always fine.
      if (node.conn & (1 << d)) {
        dirs.push(d);
        continue;
      }
      for (let c = 0; c < 8; c++) {
        if (node.conn & (1 << c) && canTurn(opposite(c), d)) {
          dirs.push(d);
          break;
        }
      }
    }
  } else dirs = ALL_DIRS;
  if (node.station >= 0) {
    const ax = axisDirs(stationAxis(world, node));
    dirs = dirs.filter((d) => ax.includes(d));
  }
  return dirs;
}

function goalAccepts(world: World, goal: number, din: number): boolean {
  const node = world.track.getIdx(goal);
  if (!node) return true;
  if (node.station >= 0 && !axisDirs(stationAxis(world, node)).includes(din)) return false;
  if (node.conn === 0) return true;
  // Arrived along existing track, or a train arriving can continue onto it (no hairpins).
  return (node.conn & (1 << opposite(din))) !== 0 || world.track.hasExitFor(goal, din);
}

/**
 * Plan the cheapest buildable route between two tiles. Costs are real money; the search
 * additionally penalises steep grades and turns so routes look like real railways.
 */
export function planTrack(world: World, from: number, to: number, opts: TrackOptions): TrackPlan {
  return new TrackPlanner(world, from, to, opts, sharedScratch).run(Infinity)!;
}

/**
 * Resumable A* search over (tile, heading) states, so the UI can spread long searches
 * over several frames. `run(budgetMs)` returns the plan when finished, else null.
 */
export class TrackPlanner {
  private readonly heap = new MinHeap();
  private readonly startState: number;
  private result: TrackPlan | null = null;
  private expansions = 0;
  private readonly tx: number;
  private readonly ty: number;
  private readonly hScale = C.track.single * C.planner.heuristicWeight;

  constructor(
    readonly world: World,
    readonly from: number,
    readonly to: number,
    readonly opts: TrackOptions,
    private readonly sc: PlannerScratch = new PlannerScratch(),
  ) {
    const W = world.width;
    this.tx = to % W;
    this.ty = Math.floor(to / W);
    this.startState = from * 9 + 8;
    if (from === to) {
      this.result = failedPlan(from, to, 'Drag to another tile to lay track.');
      return;
    }
    const startNode = world.track.getIdx(from);
    if (startNode && startNode.kind !== NODE_GROUND) {
      this.result = failedPlan(from, to, 'Cannot branch off a bridge or tunnel.');
      return;
    }
    if (groundNodeCost(world, from, opts) === null) {
      this.result = failedPlan(from, to, 'Cannot build track on the start tile.');
      return;
    }
    if (groundNodeCost(world, to, opts) === null) {
      this.result = failedPlan(from, to, 'Cannot build track on the destination tile.');
      return;
    }
    sc.ensure(W * world.height * 9);
    sc.gScore.fill(Infinity);
    sc.closed.fill(0);
    sc.gScore[this.startState] = 0;
    sc.parent[this.startState] = -1;
    this.heap.push(this.heur(from), this.startState);
  }

  get done(): boolean {
    return this.result !== null;
  }

  private heur(i: number): number {
    const W = this.world.width;
    const dx = Math.abs((i % W) - this.tx);
    const dy = Math.abs(Math.floor(i / W) - this.ty);
    return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * this.hScale;
  }

  private relax(state: number, ng: number, tile: number, from: number, meta: number): void {
    const sc = this.sc;
    if (sc.closed[state] || ng >= sc.gScore[state]) return;
    sc.gScore[state] = ng;
    sc.parent[state] = from;
    sc.stepMeta[state] = meta;
    this.heap.push(ng + this.heur(tile), state);
  }

  run(budgetMs: number): TrackPlan | null {
    if (this.result) return this.result;
    const { world, opts, sc, heap, to } = this;
    const P = C.planner;
    const t0 = performance.now();
    let found = -1;
    let iter = 0;
    while (heap.size > 0) {
      if ((++iter & 255) === 0 && performance.now() - t0 > budgetMs) return null;
      const s = heap.pop();
      if (sc.closed[s]) continue;
      sc.closed[s] = 1;
      const t = Math.floor(s / 9);
      const din = s % 9;
      if (t === to && din < 8 && goalAccepts(world, to, din)) {
        found = s;
        break;
      }
      if (++this.expansions > P.maxExpansions) break;
      const g = sc.gScore[s];
      const zt = trackZ(world, t);
      for (const d of allowedDirsAt(world, t, din)) {
        const n = world.track.neighbor(t, d);
        if (n < 0) continue;
        const len = stepLength(d);
        const turn = din < 8 && d !== din ? P.turnPenalty : 0;
        if (world.track.connected(t, n)) {
          // Follow existing track (through whole spans).
          let m = n;
          let steps = 1;
          while (world.track.getIdx(m)!.kind !== NODE_GROUND) {
            const nx = world.track.neighbor(m, d);
            if (nx < 0 || !world.track.connected(m, nx)) break;
            m = nx;
            steps++;
          }
          if (world.track.getIdx(m)!.kind !== NODE_GROUND) continue;
          let cost = P.reusePerTile * len * steps;
          if (opts.double && !world.track.isDouble(t, n)) cost += C.track.doubleExtra * len * steps;
          this.relax(m * 9 + d, g + cost + turn, m, s, META_REUSE | (steps << 2));
          continue;
        }
        // New ground edge.
        const prep = groundNodeCost(world, n, opts);
        if (prep !== null && !(isDiagonal(d) && world.track.crossesDiagonal(t, n))) {
          const nn = world.track.getIdx(n);
          const stationOk = !nn || nn.station < 0 || axisDirs(stationAxis(world, nn)).includes(d);
          if (stationOk) {
            const zn = trackZ(world, n);
            const money = edgeCost(world, t, n, d, zt, zn, opts) + prep;
            const gr = gradePercent(zn - zt, len);
            this.relax(n * 9 + d, g + money + P.gradeAvoidance * gr * gr * len + turn, n, s, META_NEW);
          }
        }
        // Bridges and tunnels.
        for (const sp of spanOptions(world, t, d, zt, opts)) {
          const prepL = groundNodeCost(world, sp.landing, opts) ?? 0;
          const zl = trackZ(world, sp.landing);
          const spanLen = (sp.k + 1) * len;
          const gr = gradePercent(zl - zt, spanLen);
          const kind = sp.cat === 'bridges' ? META_BRIDGE : META_TUNNEL;
          this.relax(
            sp.landing * 9 + d,
            g + sp.money + prepL + P.gradeAvoidance * gr * gr * spanLen + turn,
            sp.landing,
            s,
            kind | (sp.k << 2) | ((sp.bridge + 1) << 8),
          );
        }
      }
    }
    this.result = found < 0 ? failedPlan(this.from, to, 'No buildable route found. Try a shorter drag, or allow bridges/tunnels.') : this.reconstruct(found);
    return this.result;
  }

  private reconstruct(found: number): TrackPlan {
    const { world, opts, sc, from } = this;
    const states: number[] = [];
    for (let s = found; s !== this.startState; s = sc.parent[s]) states.push(s);
    states.reverse();
    const steps: PlanStep[] = [];
    let prev = from;
    for (const s of states) {
      const tile = Math.floor(s / 9);
      const d = s % 9;
      const meta = sc.stepMeta[s];
      const kindCode = meta & 3;
      const span = (meta >> 2) & 63;
      const bridge = (meta >> 8) - 1;
      const interior: number[] = [];
      if (kindCode !== META_NEW) {
        let cur = prev;
        const count = kindCode === META_REUSE ? span - 1 : span;
        for (let j = 0; j < count; j++) {
          cur = world.track.neighbor(cur, d);
          interior.push(cur);
        }
      }
      const kind: StepKind = kindCode === META_NEW ? 'new' : kindCode === META_REUSE ? 'reuse' : kindCode === META_BRIDGE ? 'bridge' : 'tunnel';
      const length = (interior.length + 1) * stepLength(d);
      const z0 = trackZ(world, prev);
      const z1 = trackZ(world, tile);
      steps.push({
        from: prev,
        to: tile,
        dir: d,
        kind,
        interior,
        bridge,
        length,
        z0,
        z1,
        grade: gradePercent(z1 - z0, length),
        upgrade: kind === 'reuse' && opts.double && !world.track.isDouble(prev, world.track.neighbor(prev, d)),
      });
      prev = tile;
    }
    return summarisePlan(world, from, this.to, steps, opts);
  }
}

/** Exact money cost and statistics of a plan (the A* penalties are not charged). */
function summarisePlan(world: World, from: number, to: number, steps: PlanStep[], opts: TrackOptions): TrackPlan {
  const bd = emptyBreakdown();
  const prepared = new Set<number>();
  const demolished: number[] = [];
  let trees = 0;
  const prep = (i: number) => {
    if (prepared.has(i) || world.track.getIdx(i)) return;
    prepared.add(i);
    const b = buildingAt(world, i);
    if (b) demolished.push(b.id);
    if (world.terrain[i] === T.Forest || world.flags[i] & F.Tree) trees++;
    groundNodeCost(world, i, opts, bd);
  };
  prep(from);
  let lengthTiles = 0;
  let newTiles = 0;
  let maxGrade = 0;
  let bridges = 0;
  let tunnels = 0;
  const profile = [{ dist: 0, z: trackZ(world, from) }];
  for (const st of steps) {
    lengthTiles += st.length;
    maxGrade = Math.max(maxGrade, Math.abs(st.grade));
    const len = stepLength(st.dir);
    if (st.kind === 'reuse') {
      if (st.upgrade) bd.doubling += C.track.doubleExtra * st.length;
    } else if (st.kind === 'new') {
      prep(st.to);
      edgeCost(world, st.from, st.to, st.dir, st.z0, st.z1, opts, bd);
      newTiles++;
    } else {
      prep(st.to);
      newTiles += st.interior.length + 1;
      if (st.kind === 'bridge') {
        bridges++;
        const b = C.bridges[st.bridge];
        let heightSum = 0;
        st.interior.forEach((it, j) => {
          const deck = st.z0 + ((st.z1 - st.z0) * (j + 1)) / (st.interior.length + 1);
          const wet = world.terrain[it] === T.Water || (world.flags[it] & F.River) !== 0;
          heightSum += Math.max(0, deck - (wet ? 0 : groundZ(world, it)));
        });
        bd.bridges += b.perTile * (st.interior.length + 1) * len + b.perLevel * heightSum;
      } else {
        tunnels++;
        bd.tunnels += C.tunnel.perTile * (st.interior.length + 1) * len;
      }
      if (opts.double) bd.doubling += C.track.doubleExtra * st.length;
    }
    const startDist = profile[profile.length - 1].dist;
    st.interior.forEach((_, j) => {
      const f = (j + 1) / (st.interior.length + 1);
      profile.push({ dist: startDist + st.length * f, z: st.z0 + (st.z1 - st.z0) * f });
    });
    profile.push({ dist: startDist + st.length, z: st.z1 });
  }
  for (const k of Object.keys(bd) as Array<keyof CostBreakdown>) bd[k] = Math.round(bd[k]);
  return {
    ok: true,
    version: world.editVersion,
    from,
    to,
    steps,
    breakdown: bd,
    cost: sumBreakdown(bd),
    lengthTiles,
    newTiles,
    maxGrade,
    bridges,
    tunnels,
    demolished,
    treesCleared: trees,
    profile,
  };
}

// ---------------------------------------------------------------------------------------
// Transactions (undo)
// ---------------------------------------------------------------------------------------

interface TileSnap {
  terrain: number;
  flags: number;
  occupant: number;
  node: TrackNode | undefined;
}

/** Records the prior state of everything a construction action touches, so it can be reverted exactly. */
export class Transaction {
  private tiles = new Map<number, TileSnap>();
  private buildings = new Map<number, boolean | undefined>();
  private cities = new Map<number, number>();
  private stations = new Map<number, Station | null>();
  private stationCount: number;

  constructor(private readonly world: World) {
    this.stationCount = world.stations.length;
  }

  touchTile(i: number): void {
    if (this.tiles.has(i)) return;
    const w = this.world;
    const n = w.track.getIdx(i);
    this.tiles.set(i, { terrain: w.terrain[i], flags: w.flags[i], occupant: w.occupant[i], node: n ? cloneNode(n) : undefined });
  }

  touchBuilding(id: number): void {
    if (!this.buildings.has(id)) this.buildings.set(id, this.world.buildings[id].demolished);
  }

  /** Record population removed from a town (given back on revert, as a delta so later growth is kept). */
  removePopulation(id: number, amount: number): void {
    this.cities.set(id, (this.cities.get(id) ?? 0) + amount);
  }

  touchStation(id: number): void {
    if (!this.stations.has(id) && id < this.stationCount) this.stations.set(id, this.world.stations[id]);
  }

  get touchedTiles(): number[] {
    return [...this.tiles.keys()];
  }

  revert(): void {
    const w = this.world;
    for (const [i, s] of this.tiles) {
      w.terrain[i] = s.terrain;
      w.flags[i] = s.flags;
      w.occupant[i] = s.occupant;
      if (s.node) w.track.nodes.set(i, cloneNode(s.node));
      else w.track.nodes.delete(i);
      w.markDirty(i);
    }
    for (const [id, dem] of this.buildings) w.buildings[id].demolished = dem;
    for (const [id, removed] of this.cities) w.cities[id].population += removed;
    for (const [id, st] of this.stations) w.stations[id] = st;
    w.stations.length = this.stationCount;
  }
}

/** Prepare a tile for a ground node (clear trees, demolish a building) and create the node. */
function ensureGroundNode(world: World, i: number, tx: Transaction): TrackNode {
  const existing = world.track.getIdx(i);
  if (existing) return existing;
  tx.touchTile(i);
  const b = buildingAt(world, i);
  if (b) {
    tx.touchBuilding(b.id);
    const city = world.cities[b.cityId];
    const live = city.buildingIds.filter((id) => !world.buildings[id].demolished).length;
    const removed = Math.min(city.population, Math.round(city.population / Math.max(1, live)));
    tx.removePopulation(b.cityId, removed);
    city.population -= removed;
    b.demolished = true;
    world.occupant[i] = 0;
  }
  if (world.terrain[i] === T.Forest) world.terrain[i] = T.Grass;
  world.flags[i] &= ~F.Tree;
  const node: TrackNode = { z: groundZ(world, i), conn: 0, double: 0, kind: NODE_GROUND, span: -1, station: -1 };
  world.track.nodes.set(i, node);
  world.markDirty(i);
  return node;
}

function connectTracked(world: World, a: number, b: number, double: boolean, tx: Transaction): void {
  tx.touchTile(a);
  tx.touchTile(b);
  world.track.connect(a, b, double);
  world.markDirty(a);
  world.markDirty(b);
}

/** Apply a successful plan to the world. Cash is handled by the caller. */
export function applyTrackPlan(world: World, plan: TrackPlan, opts: TrackOptions, tx: Transaction): void {
  if (!plan.ok) throw new Error('Cannot apply a failed plan');
  ensureGroundNode(world, plan.from, tx);
  for (const st of plan.steps) {
    if (st.kind === 'reuse') {
      if (st.upgrade) {
        let cur = st.from;
        for (const nxt of [...st.interior, st.to]) {
          connectTracked(world, cur, nxt, true, tx);
          cur = nxt;
        }
      }
      continue;
    }
    ensureGroundNode(world, st.to, tx);
    if (st.kind === 'new') {
      connectTracked(world, st.from, st.to, opts.double, tx);
      continue;
    }
    const kind = st.kind === 'bridge' ? NODE_BRIDGE : NODE_TUNNEL;
    let cur = st.from;
    st.interior.forEach((it, j) => {
      tx.touchTile(it);
      const z = st.z0 + ((st.z1 - st.z0) * (j + 1)) / (st.interior.length + 1);
      world.track.nodes.set(it, { z, conn: 0, double: 0, kind, span: st.kind === 'bridge' ? st.bridge : -1, station: -1 });
      if (kind === NODE_BRIDGE) world.flags[it] &= ~F.Tree;
      world.markDirty(it);
      connectTracked(world, cur, it, opts.double, tx);
      cur = it;
    });
    connectTracked(world, cur, st.to, opts.double, tx);
  }
}

// ---------------------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------------------

export interface StationPlan {
  ok: boolean;
  error?: string;
  kind: Station['kind'];
  axis: 'x' | 'y';
  side: 1 | -1;
  tiles: number[];
  /** Tiles that need new track. */
  newTiles: number[];
  breakdown: CostBreakdown;
  cost: number;
  rect: TileRect;
  coverage: Coverage;
  name: string;
  cityId: number;
}

/** Validate and price a station centred on (x, y). */
export function planStation(world: World, x: number, y: number, kind: Station['kind'], axis: 'x' | 'y'): StationPlan {
  const def = stationDef(kind);
  const tiles: number[] = [];
  const offset = Math.floor((def.length - 1) / 2);
  for (let k = 0; k < def.length; k++) {
    const tx = axis === 'x' ? x - offset + k : x;
    const ty = axis === 'y' ? y - offset + k : y;
    if (world.inBounds(tx, ty)) tiles.push(world.tileIndex(tx, ty));
  }
  const city = world.nearestCity(x, y);
  const bd = emptyBreakdown();
  bd.stations = def.cost;
  const base: StationPlan = {
    ok: false,
    kind,
    axis,
    side: 1,
    tiles,
    newTiles: [],
    breakdown: bd,
    cost: 0,
    rect: catchmentRect(world, tiles.length ? tiles : [world.tileIndex(Math.max(0, Math.min(world.width - 1, x)), Math.max(0, Math.min(world.height - 1, y)))], def.radius),
    coverage: { cities: [], industries: [] },
    name: stationName(world, city),
    cityId: city ? city.id : -1,
  };
  base.coverage = coverage(world, base.rect);
  const fail = (error: string): StationPlan => ({ ...base, cost: sumBreakdown(bd), error });
  if (tiles.length !== def.length) return fail('Too close to the map edge.');
  const axMask = axisDirs(axis).reduce((m, d) => m | (1 << d), 0);
  const opts = defaultTrackOptions(0);
  let prevZ: number | null = null;
  for (const t of tiles) {
    const n = world.track.getIdx(t);
    if (n) {
      if (n.kind !== NODE_GROUND) return fail('Stations cannot sit on bridges or tunnels.');
      if (n.station >= 0) return fail('There is already a station here.');
      if ((n.conn & ~axMask) !== 0) return fail(`Track here must run straight ${axis === 'x' ? 'east–west' : 'north–south'} (press R to rotate).`);
    } else {
      const prep = groundNodeCost(world, t, opts, bd);
      if (prep === null) {
        return fail(occupantKind(world.occupant[t]) === OCC_INDUSTRY ? 'An industry is in the way.' : 'Stations need dry land.');
      }
      if (world.tileSlope(t % world.width, Math.floor(t / world.width)) > 1) return fail('The ground is too steep for a platform.');
      base.newTiles.push(t);
      bd.track += Math.round(C.track.single * terrainMult(world, t));
    }
    const z = trackZ(world, t);
    if (prevZ !== null && Math.abs(z - prevZ) > 0.5) return fail('Platforms must be nearly level.');
    prevZ = z;
  }
  // Building side: prefer the side without track or water.
  const mid = tiles[Math.floor(tiles.length / 2)];
  const perp = axis === 'x' ? [2, 6] : [0, 4];
  const sideFree = (d: number) => {
    const n = world.track.neighbor(mid, d);
    return n >= 0 && !world.track.getIdx(n) && world.terrain[n] !== T.Water;
  };
  base.side = sideFree(perp[0]) || !sideFree(perp[1]) ? 1 : -1;
  for (const k of Object.keys(bd) as Array<keyof CostBreakdown>) bd[k] = Math.round(bd[k]);
  return { ...base, ok: true, cost: sumBreakdown(bd) };
}

export function applyStationPlan(world: World, plan: StationPlan, day: number, tx: Transaction): Station {
  if (!plan.ok) throw new Error('Cannot apply a failed station plan');
  const id = world.stations.length;
  for (const t of plan.tiles) ensureGroundNode(world, t, tx);
  for (let k = 1; k < plan.tiles.length; k++) {
    if (!world.track.connected(plan.tiles[k - 1], plan.tiles[k])) connectTracked(world, plan.tiles[k - 1], plan.tiles[k], false, tx);
  }
  for (const t of plan.tiles) {
    tx.touchTile(t);
    world.track.getIdx(t)!.station = id;
    world.markDirty(t);
  }
  const st: Station = {
    id,
    name: plan.name,
    kind: plan.kind,
    tiles: [...plan.tiles],
    axis: plan.axis,
    side: plan.side,
    cityId: plan.cityId,
    builtDay: day,
  };
  world.stations.push(st);
  return st;
}

// ---------------------------------------------------------------------------------------
// Bulldozing
// ---------------------------------------------------------------------------------------

export interface BulldozePlan {
  /** Station ids removed (their track stays). */
  stations: number[];
  /** Track tiles removed. */
  tiles: number[];
  cost: number;
}

/**
 * Clicking a station tile removes the station (track remains); clicking track removes the
 * track tile, and whole bridge/tunnel spans it belongs to or touches.
 */
export function planBulldoze(world: World, targets: number[]): BulldozePlan {
  const stations = new Set<number>();
  const tiles = new Set<number>();
  for (const t of targets) {
    const n = world.track.getIdx(t);
    if (!n) continue;
    if (n.station >= 0) {
      stations.add(n.station);
      continue;
    }
    if (n.kind !== NODE_GROUND) {
      for (const i of world.track.spanOf(t).interior) tiles.add(i);
      continue;
    }
    tiles.add(t);
    for (let d = 0; d < 8; d++) {
      if (!(n.conn & (1 << d))) continue;
      const nb = world.track.neighbor(t, d);
      const nn = world.track.getIdx(nb);
      if (nn && nn.kind !== NODE_GROUND) for (const i of world.track.spanOf(nb).interior) tiles.add(i);
    }
  }
  let removedStationTiles = 0;
  for (const id of stations) removedStationTiles += world.stations[id]?.tiles.length ?? 0;
  return {
    stations: [...stations],
    tiles: [...tiles],
    cost: (tiles.size + removedStationTiles) * C.track.bulldozePerTile,
  };
}

export function applyBulldoze(world: World, plan: BulldozePlan, tx: Transaction): void {
  for (const id of plan.stations) {
    const st = world.stations[id];
    if (!st) continue;
    tx.touchStation(id);
    for (const t of st.tiles) {
      tx.touchTile(t);
      const n = world.track.getIdx(t);
      if (n) n.station = -1;
      world.markDirty(t);
    }
    world.stations[id] = null;
  }
  const removed = new Set(plan.tiles);
  const orphans = new Set<number>();
  for (const t of plan.tiles) {
    const n = world.track.getIdx(t);
    if (!n) continue;
    tx.touchTile(t);
    for (let d = 0; d < 8; d++) {
      if (!(n.conn & (1 << d))) continue;
      const nb = world.track.neighbor(t, d);
      tx.touchTile(nb);
      world.track.disconnect(t, nb);
      world.markDirty(nb);
      if (!removed.has(nb)) orphans.add(nb);
    }
    world.track.nodes.delete(t);
    world.markDirty(t);
  }
  for (const o of orphans) {
    const n = world.track.getIdx(o);
    if (n && n.conn === 0 && n.station < 0) {
      tx.touchTile(o);
      world.track.nodes.delete(o);
      world.markDirty(o);
    }
  }
}

