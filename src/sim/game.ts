import { CAR_BY_ID, COMPANY, CONSTRUCTION, ECONOMY, ENGINE_BY_ID, TIME, type EconomicModel } from '../data';
import { Company, type ExpenseCategory } from './company';
import {
  Transaction,
  applyBulldoze,
  applyStationPlan,
  applyTrackPlan,
  planBulldoze,
  planStation,
  planTrack,
  type CostBreakdown,
  type StationPlan,
  type TrackOptions,
  type TrackPlan,
} from './construction';
import { Economy } from './economy';
import { generateWorld } from './mapgen';
import { Rng } from './rng';
import type { Station } from './station';
import { dayToDate, type GameDate } from './time';
import { NODE_BRIDGE, NODE_TUNNEL } from './track';
import {
  TrainSystem,
  carForCargo,
  engineAgeYears,
  engineTradeIn,
  enginesAvailable,
  resaleValue,
  type RouteStop,
  type Train,
  type TrainEvent,
} from './train';
import type { MapParams, World } from './world';

export type GameEvent =
  | { type: 'day'; date: GameDate }
  | { type: 'month'; date: GameDate }
  | { type: 'year'; date: GameDate }
  | { type: 'built'; label: string; cost: number }
  | { type: 'undone'; label: string; refund: number }
  | TrainEvent;

export interface UndoEntry {
  label: string;
  day: number;
  /** Amount spent per ledger category (refunded on undo). */
  spent: Array<[ExpenseCategory, number]>;
  tx: Transaction;
}

export interface CommandResult {
  ok: boolean;
  error?: string;
  cost: number;
}

export interface GameSettings {
  wrecks: boolean;
  model: EconomicModel;
}

/** Map a cost breakdown onto ledger categories. */
function ledgerSplit(b: CostBreakdown): Array<[ExpenseCategory, number]> {
  const out: Array<[ExpenseCategory, number]> = [
    ['track', b.track + b.earthworks + b.clearing + b.crossings + b.doubling],
    ['demolition', b.demolition],
    ['bridges', b.bridges],
    ['tunnels', b.tunnels],
    ['stations', b.stations],
  ];
  return out.filter(([, v]) => v !== 0);
}

export function consistPrice(engineId: string, cargos: string[]): number {
  const e = ENGINE_BY_ID.get(engineId);
  if (!e) return Infinity;
  return e.price + cargos.reduce((a, c) => a + (CAR_BY_ID.get(carForCargo(c))?.price ?? 2000), 0);
}

/**
 * Root simulation object. Advances only through `step()` (one fixed tick = one in-game
 * hour), never reads the wall clock, and owns the single seeded RNG → fully deterministic.
 * All world changes go through command methods so they can be undone and (later) replayed.
 */
export class Game {
  readonly params: MapParams;
  readonly world: World;
  readonly rng: Rng;
  readonly company: Company;
  readonly economy: Economy;
  readonly trains: TrainSystem;
  readonly settings: GameSettings;
  /** Ticks since Jan 1 of the start year. */
  tick = 0;
  readonly undoStack: UndoEntry[] = [];
  private listeners: Array<(e: GameEvent) => void> = [];

  constructor(params: MapParams, world?: World, settings?: Partial<GameSettings>) {
    this.params = params;
    this.world = world ?? generateWorld(params);
    this.rng = new Rng((params.seed ^ 0xa5a5a5a5) >>> 0);
    this.company = new Company(this.rng.pick(COMPANY.names));
    this.settings = { wrecks: ECONOMY.wrecks.enabledByDefault, model: ECONOMY.model, ...settings };
    this.economy = new Economy(this.world, this.settings.model);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const game = this;
    this.trains = new TrainSystem({
      world: this.world,
      economy: this.economy,
      company: this.company,
      rng: this.rng,
      settings: this.settings,
      get tick() {
        return game.tick;
      },
      get year() {
        return game.year;
      },
      emit: (e) => this.emit(e),
    });
  }

  get day(): number {
    return Math.floor(this.tick / TIME.ticksPerDay);
  }

  get date(): GameDate {
    return dayToDate(this.day, this.params.startYear);
  }

  get year(): number {
    return this.params.startYear + Math.floor(this.day / 365);
  }

  on(fn: (e: GameEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(e: GameEvent): void {
    for (const l of this.listeners) l(e);
  }

  step(): void {
    this.tick++;
    this.trains.step();
    if (this.tick % TIME.ticksPerDay === 0) {
      const date = this.date;
      this.pruneUndo();
      this.economy.daily();
      this.trains.daily();
      this.emit({ type: 'day', date });
      if (date.day === 1) {
        this.economy.monthly();
        this.trains.monthly();
        this.chargeTrackMaintenance();
        this.emit({ type: 'month', date });
        if (date.month === 0) {
          this.trains.yearly();
          this.economy.yearly();
          this.emit({ type: 'year', date });
        }
      }
    }
  }

  /** Monthly upkeep of every track tile and station. */
  private chargeTrackMaintenance(): void {
    const tm = ECONOMY.trackMaintenance;
    let total = 0;
    for (const n of this.world.track.nodes.values()) {
      let f = 1;
      if (n.double) f *= tm.doubleFactor;
      if (n.kind === NODE_BRIDGE) f *= tm.bridgeFactor;
      if (n.kind === NODE_TUNNEL) f *= tm.tunnelFactor;
      total += (tm.perTileYear * f) / 12;
    }
    for (const st of this.world.liveStations()) total += (tm.stationPerYear[st.kind] ?? 0) / 12;
    if (total > 0) this.company.spend(this.year, 'trackMaintenance', total);
  }

  // -------------------------------------------------------------------------------------
  // Construction commands
  // -------------------------------------------------------------------------------------

  planTrack(from: number, to: number, opts: TrackOptions): TrackPlan {
    return planTrack(this.world, from, to, opts);
  }

  planStation(x: number, y: number, kind: Station['kind'], axis: 'x' | 'y'): StationPlan {
    return planStation(this.world, x, y, kind, axis);
  }

  private commit(label: string, tx: Transaction, split: Array<[ExpenseCategory, number]>): void {
    const year = this.year;
    for (const [cat, amount] of split) this.company.spend(year, cat, amount);
    this.undoStack.push({ label, day: this.day, spent: split, tx });
    while (this.undoStack.length > CONSTRUCTION.undo.maxActions) this.undoStack.shift();
    this.emit({ type: 'built', label, cost: split.reduce((a, [, v]) => a + v, 0) });
  }

  /**
   * Build track between two tiles. A plan computed earlier (e.g. the UI preview) is reused
   * when the world hasn't changed since; otherwise the route is planned again.
   */
  buildTrack(from: number, to: number, opts: TrackOptions, prePlanned?: TrackPlan): CommandResult & { plan: TrackPlan } {
    const fresh = prePlanned && prePlanned.ok && prePlanned.from === from && prePlanned.to === to && prePlanned.version === this.world.editVersion;
    const plan = fresh ? prePlanned : this.planTrack(from, to, opts);
    if (!plan.ok) return { ok: false, error: plan.error, cost: 0, plan };
    if (plan.newTiles === 0 && plan.cost === 0) return { ok: false, error: 'That track already exists.', cost: 0, plan };
    if (!this.company.canAfford(plan.cost)) return { ok: false, error: 'Not enough cash.', cost: plan.cost, plan };
    const tx = new Transaction(this.world);
    applyTrackPlan(this.world, plan, opts, tx);
    const tiles = Math.round(plan.lengthTiles);
    this.commit(`Track (${tiles} tile${tiles === 1 ? '' : 's'})`, tx, ledgerSplit(plan.breakdown));
    return { ok: true, cost: plan.cost, plan };
  }

  buildStation(x: number, y: number, kind: Station['kind'], axis: 'x' | 'y'): CommandResult & { plan: StationPlan; station?: Station } {
    const plan = this.planStation(x, y, kind, axis);
    if (!plan.ok) return { ok: false, error: plan.error, cost: 0, plan };
    if (!this.company.canAfford(plan.cost)) return { ok: false, error: 'Not enough cash.', cost: plan.cost, plan };
    const tx = new Transaction(this.world);
    const station = applyStationPlan(this.world, plan, this.day, tx);
    this.commit(`${plan.name} ${kind}`, tx, ledgerSplit(plan.breakdown));
    return { ok: true, cost: plan.cost, plan, station };
  }

  bulldoze(tiles: number[]): CommandResult {
    const plan = planBulldoze(this.world, tiles);
    if (plan.tiles.length === 0 && plan.stations.length === 0) return { ok: false, error: 'Nothing to remove here.', cost: 0 };
    const busy = this.trains.occupiedTiles();
    const stationTiles = plan.stations.flatMap((id) => this.world.stations[id]?.tiles ?? []);
    if ([...plan.tiles, ...stationTiles].some((t) => busy.has(t))) return { ok: false, error: 'A train is using that track.', cost: 0 };
    if (!this.company.canAfford(plan.cost)) return { ok: false, error: 'Not enough cash.', cost: plan.cost };
    const tx = new Transaction(this.world);
    applyBulldoze(this.world, plan, tx);
    const what = plan.stations.length ? `${plan.stations.length} station${plan.stations.length > 1 ? 's' : ''}` : `${plan.tiles.length} track tile${plan.tiles.length > 1 ? 's' : ''}`;
    this.commit(`Bulldoze ${what}`, tx, [['demolition', plan.cost]]);
    return { ok: true, cost: plan.cost };
  }

  /** The most recent action that can still be undone, if any. */
  get undoable(): UndoEntry | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  /**
   * Undo the last construction action with a full refund. Allowed for the last
   * `undo.maxActions` actions as long as fewer than `undo.windowDays` in-game days have
   * passed since each was made, and no train stands on or has reserved affected track.
   */
  undo(): CommandResult {
    const e = this.undoable;
    if (!e) return { ok: false, error: 'Nothing to undo.', cost: 0 };
    const busy = this.trains.occupiedTiles();
    if (e.tx.touchedTiles.some((t) => busy.has(t))) return { ok: false, error: 'A train is using that track.', cost: 0 };
    this.undoStack.pop();
    e.tx.revert();
    const year = this.year;
    let refund = 0;
    for (const [cat, amount] of e.spent) {
      this.company.spend(year, cat, -amount);
      refund += amount;
    }
    this.emit({ type: 'undone', label: e.label, refund });
    return { ok: true, cost: -refund };
  }

  private pruneUndo(): void {
    const limit = this.day - CONSTRUCTION.undo.windowDays;
    while (this.undoStack.length && this.undoStack[0].day < limit) this.undoStack.shift();
  }

  // -------------------------------------------------------------------------------------
  // Train commands
  // -------------------------------------------------------------------------------------

  private validRoute(route: RouteStop[]): string | null {
    if (route.length < 2) return 'A route needs at least two stops.';
    for (const r of route) if (!this.world.stations[r.station]) return 'A stop on this route no longer exists.';
    return null;
  }

  buyTrain(engineId: string, cargos: string[], route: RouteStop[]): CommandResult & { train?: Train } {
    const e = ENGINE_BY_ID.get(engineId);
    if (!e) return { ok: false, error: 'Unknown engine.', cost: 0 };
    if (!enginesAvailable(this.year).includes(e)) return { ok: false, error: `${e.name} is not on sale in ${this.year}.`, cost: 0 };
    if (cargos.length < 1 || cargos.length > e.maxCars) return { ok: false, error: `${e.name} pulls 1–${e.maxCars} cars.`, cost: 0 };
    const bad = this.validRoute(route);
    if (bad) return { ok: false, error: bad, cost: 0 };
    const price = consistPrice(engineId, cargos);
    if (!this.company.canAfford(price)) return { ok: false, error: 'Not enough cash.', cost: price };
    this.company.spend(this.year, 'trains', price);
    const train = this.trains.spawn(engineId, cargos, route);
    return { ok: true, cost: price, train };
  }

  sellTrain(id: number): CommandResult {
    const t = this.trains.byId(id);
    if (!t) return { ok: false, error: 'No such train.', cost: 0 };
    const value = resaleValue(t, this.tick);
    this.trains.remove(t);
    this.company.spend(this.year, 'trains', -value);
    return { ok: true, cost: -value };
  }

  setRoute(id: number, route: RouteStop[]): CommandResult {
    const t = this.trains.byId(id);
    if (!t) return { ok: false, error: 'No such train.', cost: 0 };
    const bad = this.validRoute(route);
    if (bad) return { ok: false, error: bad, cost: 0 };
    const current = t.route[t.stop]?.station;
    t.route = route.map((r) => ({ ...r }));
    const idx = t.route.findIndex((r) => r.station === current);
    t.stop = idx >= 0 ? idx : 0;
    return { ok: true, cost: 0 };
  }

  /** Change the consist: new cars are bought, removed cars sold at half price. */
  setConsist(id: number, cargos: string[]): CommandResult {
    const t = this.trains.byId(id);
    if (!t) return { ok: false, error: 'No such train.', cost: 0 };
    const e = ENGINE_BY_ID.get(t.engine)!;
    if (cargos.length < 1 || cargos.length > e.maxCars) return { ok: false, error: `${e.name} pulls 1–${e.maxCars} cars.`, cost: 0 };
    const oldTypes = t.cars.map((c) => c.type);
    const newCars = cargos.map((cargo, i) => {
      const old = t.cars[i];
      const type = carForCargo(cargo);
      if (old && old.type === type && old.cargo === cargo) return old;
      return { type, cargo, loads: 0, origin: -1, loadedTick: 0 };
    });
    const buy = newCars.filter((c, i) => c.type !== oldTypes[i]).reduce((a, c) => a + (CAR_BY_ID.get(c.type)?.price ?? 2000), 0);
    const sell = oldTypes.filter((type, i) => newCars[i]?.type !== type).reduce((a, type) => a + (CAR_BY_ID.get(type)?.price ?? 2000) * 0.5, 0);
    const cost = Math.round(buy - sell);
    if (cost > 0 && !this.company.canAfford(cost)) return { ok: false, error: 'Not enough cash.', cost };
    this.company.spend(this.year, 'trains', cost);
    t.cars = newCars;
    return { ok: true, cost };
  }

  /** Best engine on sale now that can pull the train's cars. */
  bestEngineFor(t: Train) {
    return enginesAvailable(this.year)
      .filter((e) => e.maxCars >= t.cars.length)
      .sort((a, b) => b.power * b.topSpeed - a.power * a.topSpeed)[0];
  }

  /** Swap in the best available engine; the old one is traded in. */
  upgradeEngine(id: number): CommandResult {
    const t = this.trains.byId(id);
    if (!t) return { ok: false, error: 'No such train.', cost: 0 };
    const best = this.bestEngineFor(t);
    if (!best) return { ok: false, error: 'No suitable engine on sale.', cost: 0 };
    if (best.id === t.engine && engineAgeYears(t, this.tick) < 1) return { ok: false, error: 'Already the best available engine.', cost: 0 };
    const cost = best.price - engineTradeIn(t, this.tick);
    if (!this.company.canAfford(cost)) return { ok: false, error: 'Not enough cash.', cost };
    this.company.spend(this.year, 'trains', cost);
    t.engine = best.id;
    t.engineBuiltTick = this.tick;
    return { ok: true, cost };
  }

  duplicateTrain(id: number): CommandResult & { train?: Train } {
    const t = this.trains.byId(id);
    if (!t) return { ok: false, error: 'No such train.', cost: 0 };
    const engine = enginesAvailable(this.year).some((e) => e.id === t.engine) ? t.engine : this.bestEngineFor(t)?.id;
    if (!engine) return { ok: false, error: 'No suitable engine on sale.', cost: 0 };
    return this.buyTrain(engine, t.cars.map((c) => c.cargo), t.route);
  }
}
