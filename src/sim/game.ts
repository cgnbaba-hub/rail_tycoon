import { COMPANY, CONSTRUCTION, TIME } from '../data';
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
import { generateWorld } from './mapgen';
import { Rng } from './rng';
import type { Station } from './station';
import { dayToDate, type GameDate } from './time';
import type { MapParams, World } from './world';

export type GameEvent =
  | { type: 'day'; date: GameDate }
  | { type: 'month'; date: GameDate }
  | { type: 'year'; date: GameDate }
  | { type: 'built'; label: string; cost: number }
  | { type: 'undone'; label: string; refund: number };

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
  /** Ticks since Jan 1 of the start year. */
  tick = 0;
  readonly undoStack: UndoEntry[] = [];
  private listeners: Array<(e: GameEvent) => void> = [];

  constructor(params: MapParams, world?: World) {
    this.params = params;
    this.world = world ?? generateWorld(params);
    this.rng = new Rng((params.seed ^ 0xa5a5a5a5) >>> 0);
    this.company = new Company(this.rng.pick(COMPANY.names));
  }

  get day(): number {
    return Math.floor(this.tick / TIME.ticksPerDay);
  }

  get date(): GameDate {
    return dayToDate(this.day, this.params.startYear);
  }

  get year(): number {
    return this.date.year;
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
    if (this.tick % TIME.ticksPerDay === 0) {
      const date = this.date;
      this.pruneUndo();
      this.emit({ type: 'day', date });
      if (date.day === 1) {
        this.emit({ type: 'month', date });
        if (date.month === 0) this.emit({ type: 'year', date });
      }
    }
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
   * passed since each was made (building while paused can always be undone).
   */
  undo(): CommandResult {
    const e = this.undoStack.pop();
    if (!e) return { ok: false, error: 'Nothing to undo.', cost: 0 };
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
}
