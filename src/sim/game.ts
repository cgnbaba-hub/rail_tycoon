import { AI, MANAGERS, MANAGER_BY_ID, TERRITORIES, type EventDef, CAR_BY_ID, COMPANY, CONSTRUCTION, ECONOMY, ENGINE_BY_ID, FINANCE, IMPROVEMENT_BY_ID, STATION_BY_ID, TIME, type AiLevel, type EconomicModel } from '../data';
import { AIBaron } from './ai';
import { Statistics } from './stats';
import { EventSystem } from './events';
import { Territories, type Region } from './territories';
import { checkScenario, type Medal, type ScenarioState } from './scenario';
import { cargoFactor, combineMods, type Modifiers } from './modifiers';
import { boardVote, checkSolvency, type BoardVote } from './rivals';
import { Chairman, account, buyShares, chargeMarginInterest, coverShort, enforceMargin, maxBuy, sellShares, shortShares, type MarginCall, type TradeResult } from './chairman';
import { Company, type ExpenseCategory, type YearRecord } from './company';
import {
  balanceSheet,
  baseRate,
  bondRate,
  buybackShares,
  closeMonth,
  creditRating,
  fairValue,
  issueShares,
  payDividend,
  splitStock,
  stockDaily,
  type BalanceSheet,
  type CreditRating,
  type FairValue,
  type MarketContext,
  type ShareAction,
} from './finance';
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
import type { Headline } from './cycle';
import { monthlyCityGrowth, type GrowthReport } from './growth';
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
  type TrainHost,
} from './train';
import type { MapParams, World } from './world';

export type GameEvent =
  | { type: 'day'; date: GameDate }
  | { type: 'month'; date: GameDate }
  | { type: 'year'; date: GameDate }
  | { type: 'built'; label: string; cost: number }
  | { type: 'undone'; label: string; refund: number }
  | { type: 'cycle'; state: string; date: GameDate }
  | { type: 'news'; headline: Headline }
  | { type: 'growth'; reports: GrowthReport[] }
  | { type: 'industryIncome'; amount: number }
  | { type: 'finance'; company: number; text: string; tone: number }
  | { type: 'marginCall'; call: MarginCall }
  | { type: 'yearEnd'; report: YearEndReport }
  | { type: 'rival'; company: number; text: string; tone: number }
  | { type: 'gameOver'; over: GameOver }
  | { type: 'event'; def: EventDef; started: boolean }
  | { type: 'scenarioEnd'; medal: Medal }
  | TrainEvent;

export interface GameOver {
  reason: 'takeover' | 'bankrupt' | 'board';
  text: string;
  day: number;
}

export interface YearEndReport {
  year: number;
  company: YearRecord;
  previous?: YearRecord;
  priceStart: number;
  worthStart: number;
  worthEnd: number;
  /** The shareholders' vote on the chairman, when one was held. */
  board?: BoardVote;
}

/** A train recipe: engine, cars and route, to create more trains like it. */
export interface RouteTemplate {
  id: number;
  name: string;
  engine: string;
  cargos: string[];
  route: RouteStop[];
}

export interface UndoEntry {
  label: string;
  day: number;
  /** Amount spent per ledger category (refunded on undo). */
  spent: Array<[ExpenseCategory, number]>;
  tx: Transaction;
  /** Infrastructure written off (bulldozing), written back on undo. */
  writeOff?: number;
}

/** One end of a line: an existing station, or where to put a new one. */
export type LineEnd = { station: number } | { x: number; y: number; axis: 'x' | 'y'; kind: Station['kind'] };

export interface CommandResult {
  ok: boolean;
  error?: string;
  cost: number;
}

export interface GameSettings {
  wrecks: boolean;
  model: EconomicModel;
  /** Number of AI rivals (0–3). */
  rivals: number;
  aiLevel: AiLevel;
  /** Friendly rivals never short, raid or vote against you. */
  friendlyAi: boolean;
  /** Some territories need a charter (default on for generated maps, off for hand-made worlds). */
  charters: boolean;
  /** The shareholders vote on the chairman each January (two failed votes end the game). Off in the easy scenarios. */
  boardVotes: boolean;
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

/** A plan with its cost (and breakdown) scaled, e.g. by a manager or an event. */
function scaleCost<T extends { cost: number; breakdown: CostBreakdown }>(plan: T, f: number): T {
  if (f === 1) return plan;
  const breakdown = { ...plan.breakdown };
  for (const k of Object.keys(breakdown) as Array<keyof CostBreakdown>) breakdown[k] = Math.round(breakdown[k] * f);
  return { ...plan, cost: Math.round(plan.cost * f), breakdown };
}

function fmt(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
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
  /** All railroad companies ever founded; index 0 is the player's (some may be defunct). */
  readonly companies: Company[];
  /** Everyone with a personal account: index 0 is you, then the rival barons. */
  readonly investors: Chairman[];
  readonly ai: AIBaron[] = [];
  /** Set when you have lost your railroad. */
  over: GameOver | null = null;
  readonly economy: Economy;
  readonly trains: TrainSystem;
  readonly settings: GameSettings;
  /** Ticks since Jan 1 of the start year. */
  tick = 0;
  readonly undoStack: UndoEntry[] = [];
  /** Monthly history for the statistics screen. */
  readonly stats = new Statistics();
  /** Running scenario (null in sandbox games). */
  scenario: ScenarioState | null = null;
  /** Regions with goodwill and charters. */
  readonly territories: Territories;
  /** Historical events in effect. */
  readonly events: EventSystem;
  /** Managers you can hire right now (ids; refreshed every January). */
  managerOffers: string[] = [];
  private readonly managerRng: Rng;
  /** Saved routes + consists for new trains ("route templates"). */
  readonly templates: RouteTemplate[] = [];
  private nextTemplateId = 1;
  private readonly growthRng: Rng;
  private readonly marketRng: Rng;
  private listeners: Array<(e: GameEvent) => void> = [];

  constructor(params: MapParams, world?: World, settings?: Partial<GameSettings>) {
    this.params = params;
    this.world = world ?? generateWorld(params);
    this.rng = new Rng((params.seed ^ 0xa5a5a5a5) >>> 0);
    this.companies = [Company.found(0, this.rng.pick(COMPANY.names))];
    const S = FINANCE.shares;
    const fortune = S.chairmanFortune - S.initial * S.chairmanFraction * S.ipoPrice;
    this.investors = [new Chairman('You', fortune)];
    this.settings = { wrecks: ECONOMY.wrecks.enabledByDefault, model: ECONOMY.model, rivals: 0, aiLevel: 'normal', friendlyAi: false, charters: !world, boardVotes: true, ...settings };
    const rivals = Math.max(0, Math.min(AI.barons.length, this.settings.rivals));
    for (let k = 0; k < rivals; k++) {
      const b = AI.barons[k];
      const key = `ai:${k + 1}`;
      const c = Company.found(k + 1, b.company, key, b.color, b.ticker);
      this.companies.push(c);
      const baron = new Chairman(b.name, fortune, key);
      this.investors.push(baron);
      this.ai.push(new AIBaron(baron, c.id, b.personality, this.rng.fork(20 + k), k));
    }
    this.economy = new Economy(this.world, this.settings.model, this.rng.fork(11));
    this.growthRng = this.rng.fork(12);
    this.marketRng = this.rng.fork(13);
    this.events = new EventSystem(this.rng.fork(14));
    this.territories = new Territories(this.world, this.rng.fork(16));
    if (!this.settings.charters) for (const r of this.territories.regions) r.restricted = false;
    this.managerRng = this.rng.fork(15);
    this.refreshManagerOffers();
    for (const inv of this.investors) inv.yearStartWorth = this.netWorth(inv);
    this.trains = new TrainSystem(this.trainHost());
  }

  /** The train system's view of the game (rebuilt after loading a save). */
  trainHost(): TrainHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const game = this;
    return {
      world: this.world,
      economy: this.economy,
      companyOf: (id: number) => this.companyById(id) ?? this.company,
      rng: this.rng,
      settings: this.settings,
      get tick() {
        return game.tick;
      },
      get year() {
        return game.year;
      },
      emit: (e) => {
        if (e.type === 'wreck' && this.trains.byId(e.train)?.owner === 0) this.goodwillHit(this.world.tileIndex(Math.floor(e.x), Math.floor(e.y)), -TERRITORIES.wreck);
        this.emit(e);
      },
      mods: (owner: number) => {
        const c = this.companyById(owner);
        return c ? this.modsFor(c) : this.events.mods;
      },
      managerBonus: (owner: number, cargo: string) => {
        const id = this.companyById(owner)?.manager;
        const m = id ? MANAGER_BY_ID.get(id) : undefined;
        return m?.effects.revenue ? cargoFactor(m.effects.revenue, cargo) : 1;
      },
    };
  }

  /** Re-link a game rebuilt from a save (see save.ts). */
  restored(): void {
    this.listeners = [];
    this.trains.attach(this.trainHost());
    // Undo entries hold live world transactions; they are not saved.
    (this as { undoStack: UndoEntry[] }).undoStack = [];
  }

  /** The player's company. */
  get company(): Company {
    return this.companies[0];
  }

  /** The player's personal account. */
  get chairman(): Chairman {
    return this.investors[0];
  }

  /** Companies still in business. */
  get activeCompanies(): Company[] {
    return this.companies.filter((c) => !c.defunct);
  }

  investorByKey(key: string): Chairman | undefined {
    return this.investors.find((i) => i.key === key);
  }

  /** End the game for the player (you keep watching as an investor). */
  endGame(reason: GameOver['reason'], text: string): void {
    if (this.over) return;
    this.over = { reason, text, day: this.day };
    this.undoStack.length = 0;
    this.emit({ type: 'gameOver', over: this.over });
  }

  get day(): number {
    return Math.floor(this.tick / TIME.ticksPerDay);
  }

  get date(): GameDate {
    return dayToDate(this.day, this.params.startYear);
  }

  dateOf(day: number): GameDate {
    return dayToDate(day, this.params.startYear);
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

  emit(e: GameEvent): void {
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
      this.marketDaily();
      this.emit({ type: 'day', date });
      if (date.day === 1) {
        this.financeMonthly(date);
        this.monthly(date);
        this.trains.monthly();
        this.chargeTrackMaintenance();
        for (const ai of this.ai) ai.monthly(this);
        this.stats.sample(this);
        this.goodwillMonthly();
        const sc = checkScenario(this);
        if (sc) this.emit({ type: 'scenarioEnd', medal: sc.medal });
        this.emit({ type: 'month', date });
        if (date.month === 0) {
          this.financeYearly();
          this.refreshManagerOffers();
          this.trains.yearly();
          this.economy.yearly();
          this.emit({ type: 'year', date });
        }
      }
    }
  }

  /** Monthly economy: events, industries, cycle, owned-industry profits, then town growth. */
  private monthly(date: GameDate): void {
    const ev = this.events.monthly(this.day, this.year);
    this.economy.mods = this.events.mods;
    for (const def of ev.started) {
      if (def.effects.confidence) this.economy.cycle.confidence = Math.max(0, Math.min(100, this.economy.cycle.confidence + def.effects.confidence));
      this.emit({ type: 'event', def, started: true });
    }
    for (const def of ev.ended) this.emit({ type: 'event', def, started: false });
    const newsBefore = this.economy.cycle.news.length;
    const stateBefore = this.economy.cycle.state;
    const income = this.economy.monthly(this.day);
    let mine = 0;
    for (const inc of income) {
      const owner = this.activeCompanies.find((c) => c.industryCost.has(inc.industry)) ?? this.company;
      owner.earnOther(this.year, 'industries', inc.amount);
      if (owner === this.company) mine += inc.amount;
    }
    if (mine !== 0 && !this.company.defunct) this.emit({ type: 'industryIncome', amount: mine });
    const blocked = new Set(this.undoStack.flatMap((e) => e.tx.touchedTiles));
    const reports = monthlyCityGrowth(this.world, this.economy, this.growthRng, this.year, blocked);
    this.economy.resetMonth();
    // Populations change a little every month: recompute station supply from them.
    this.economy.invalidate();
    if (reports.length) this.emit({ type: 'growth', reports });
    const cycle = this.economy.cycle;
    if (cycle.state !== stateBefore) this.emit({ type: 'cycle', state: cycle.state, date });
    // news is capped (shifted), so compare against the newest entries
    const fresh = cycle.news.length > newsBefore ? cycle.news.slice(newsBefore) : cycle.news.slice(-1).filter((h) => h.day === this.day);
    for (const headline of fresh) this.emit({ type: 'news', headline });
  }

  /** Monthly upkeep of every track tile and station. */
  private chargeTrackMaintenance(): void {
    const tm = ECONOMY.trackMaintenance;
    const total = new Map<number, number>();
    const upkeep = new Map<number, number>();
    const add = (m: Map<number, number>, k: number, v: number) => m.set(k, (m.get(k) ?? 0) + v);
    for (const n of this.world.track.nodes.values()) {
      let f = 1;
      if (n.double) f *= tm.doubleFactor;
      if (n.kind === NODE_BRIDGE) f *= tm.bridgeFactor;
      if (n.kind === NODE_TUNNEL) f *= tm.tunnelFactor;
      add(total, n.owner, (tm.perTileYear * f) / 12);
    }
    for (const st of this.world.liveStations()) {
      add(total, st.owner, (tm.stationPerYear[st.kind] ?? 0) / 12);
      for (const id of st.improvements ?? []) add(upkeep, st.owner, (IMPROVEMENT_BY_ID.get(id)?.upkeep ?? 0) / 12);
    }
    for (const [owner, v] of total) {
      const c = this.companyById(owner);
      if (c && v > 0) c.spend(this.year, 'trackMaintenance', v * this.modsFor(c).maintenance);
    }
    for (const [owner, v] of upkeep) if (v > 0) this.companyById(owner)?.spend(this.year, 'improvementUpkeep', v);
  }

  // -------------------------------------------------------------------------------------
  // Construction commands
  // -------------------------------------------------------------------------------------

  planTrack(from: number, to: number, opts: TrackOptions, c: Company = this.company): TrackPlan {
    const forbidden = this.territories.forbiddenFor(c.id);
    const plan = planTrack(this.world, from, to, { ...opts, owner: c.id, forbidden });
    if (!plan.ok) {
      const closed = [from, to].map((t) => this.territories.regionAt(t)).find((r) => !this.canBuildIn(r, c));
      if (closed) return { ...plan, error: this.charterError(closed, c) };
      return plan;
    }
    const tiles = plan.steps.map((st) => st.to);
    const goodwill = c.id === 0 && tiles.length ? tiles.reduce((a, t) => a + this.territories.costFactor(this.territories.regionAt(t)), 0) / tiles.length : 1;
    return scaleCost(plan, this.modsFor(c).construction * goodwill);
  }

  /** May company c build in region r? (Rivals stay out of restricted regions.) */
  canBuildIn(r: Region, c: Company = this.company): boolean {
    return !r.restricted || (c.id === 0 && r.chartered);
  }

  private charterError(r: Region, c: Company): string {
    if (c.id !== 0) return `${r.name} is closed to ${c.name}.`;
    return `Building in ${r.name} needs a charter: goodwill ${TERRITORIES.charterGoodwill} (now ${Math.round(r.goodwill)}) or ${fmt(this.territories.charterFee(this.year))} — inspect a tile there to buy one.`;
  }

  /** Buy the charter for a restricted region. */
  buyCharter(regionId: number, c: Company = this.company): CommandResult {
    const no = this.refuse(c);
    if (no) return { ok: false, error: no, cost: 0 };
    const r = this.territories.regions[regionId];
    if (!r || !r.restricted) return { ok: false, error: 'No charter needed there.', cost: 0 };
    if (r.chartered) return { ok: false, error: 'You already hold that charter.', cost: 0 };
    const fee = this.territories.charterFee(this.year);
    if (!c.canAfford(fee)) return { ok: false, error: 'Not enough cash.', cost: fee };
    c.spend(this.year, 'charters', fee);
    r.chartered = true;
    c.note(this.day, `Bought the charter for ${r.name}`);
    return { ok: true, cost: fee };
  }

  /** Goodwill bookkeeping at month end (player only). */
  private goodwillMonthly(): void {
    const T = TERRITORIES;
    const me = this.company;
    if (me.defunct) return;
    const sample = this.stats.samples[this.stats.samples.length - 1];
    const served = new Set(this.trains.trains.filter((t) => t.owner === me.id).flatMap((t) => t.route.map((r) => r.station)));
    const gain = new Map<number, number>();
    const revenue = new Map<number, number>();
    for (const st of this.world.liveStations()) {
      if (st.owner !== me.id) continue;
      const r = this.territories.regionAt(st.tiles[0]).id;
      gain.set(r, (gain.get(r) ?? 0) + (served.has(st.id) ? T.perServedStation : -T.idleStation));
      revenue.set(r, (revenue.get(r) ?? 0) + (sample?.stations[st.id] ?? 0));
    }
    const mult = this.modsFor(me).goodwill;
    for (const r of this.territories.regions) {
      const g = (gain.get(r.id) ?? 0) + Math.min(T.revenueCap, (revenue.get(r.id) ?? 0) / T.perRevenue);
      this.territories.change(r, g > 0 ? g * mult : g);
      this.territories.change(r, (T.start - r.goodwill) * T.drift);
      if (r.restricted && !r.chartered && r.goodwill >= T.charterGoodwill) {
        r.chartered = true;
        this.emit({ type: 'finance', company: me.id, text: `${r.name} grants ${me.name} a charter: its people like your railroad.`, tone: 1 });
      }
    }
  }

  /** One-off goodwill change in the region of a tile. */
  private goodwillHit(tile: number, delta: number): void {
    if (tile < 0) return;
    this.territories.change(this.territories.regionAt(tile), delta);
  }

  planStation(x: number, y: number, kind: Station['kind'], axis: 'x' | 'y', c: Company = this.company): StationPlan {
    const plan = planStation(this.world, x, y, kind, axis, c.id);
    const closed = plan.tiles.map((t) => this.territories.regionAt(t)).find((r) => !this.canBuildIn(r, c));
    if (closed && plan.ok) return { ...plan, ok: false, error: this.charterError(closed, c) };
    const goodwill = c.id === 0 && plan.tiles.length ? this.territories.costFactor(this.territories.regionAt(plan.tiles[0])) : 1;
    return scaleCost(plan, this.modsFor(c).construction * goodwill);
  }

  /** Why company c can't act right now (game over for the player, or a defunct company). */
  refuse(c: Company): string | null {
    if (c.defunct) return `${c.name} no longer exists.`;
    if (c.id === 0 && this.over) return 'You no longer run a railroad.';
    return null;
  }

  private commit(label: string, tx: Transaction, split: Array<[ExpenseCategory, number]>, c: Company = this.company): void {
    const year = this.year;
    for (const [cat, amount] of split) c.spend(year, cat, amount);
    if (c.id === 0) {
      this.undoStack.push({ label, day: this.day, spent: split, tx });
      while (this.undoStack.length > CONSTRUCTION.undo.maxActions) this.undoStack.shift();
      this.emit({ type: 'built', label, cost: split.reduce((a, [, v]) => a + v, 0) });
    } else {
      // A rival built on tiles a pending undo would restore: those undos are no longer safe.
      const touched = new Set(tx.touchedTiles);
      if (this.undoStack.some((e) => e.tx.touchedTiles.some((t) => touched.has(t)))) this.undoStack.length = 0;
    }
  }

  /**
   * Build track between two tiles. A plan computed earlier (e.g. the UI preview) is reused
   * when the world hasn't changed since; otherwise the route is planned again.
   */
  buildTrack(from: number, to: number, opts: TrackOptions, prePlanned?: TrackPlan, c: Company = this.company): CommandResult & { plan: TrackPlan } {
    const o = { ...opts, owner: c.id };
    const fresh = prePlanned && prePlanned.ok && prePlanned.from === from && prePlanned.to === to && prePlanned.version === this.world.editVersion;
    const plan = fresh ? prePlanned : this.planTrack(from, to, o, c);
    const no = this.refuse(c);
    if (no) return { ok: false, error: no, cost: 0, plan };
    if (!plan.ok) return { ok: false, error: plan.error, cost: 0, plan };
    if (plan.newTiles === 0 && plan.cost === 0) return { ok: false, error: 'That track already exists.', cost: 0, plan };
    if (!c.canAfford(plan.cost)) return { ok: false, error: 'Not enough cash.', cost: plan.cost, plan };
    const tx = new Transaction(this.world);
    applyTrackPlan(this.world, plan, o, tx);
    if (c.id === 0) for (const t of plan.demolished) this.goodwillHit(t, -TERRITORIES.perDemolished);
    const tiles = Math.round(plan.lengthTiles);
    this.commit(`Track (${tiles} tile${tiles === 1 ? '' : 's'})`, tx, ledgerSplit(plan.breakdown), c);
    return { ok: true, cost: plan.cost, plan };
  }

  buildStation(x: number, y: number, kind: Station['kind'], axis: 'x' | 'y', c: Company = this.company): CommandResult & { plan: StationPlan; station?: Station } {
    const plan = this.planStation(x, y, kind, axis, c);
    const no = this.refuse(c);
    if (no) return { ok: false, error: no, cost: 0, plan };
    if (!plan.ok) return { ok: false, error: plan.error, cost: 0, plan };
    if (!c.canAfford(plan.cost)) return { ok: false, error: 'Not enough cash.', cost: plan.cost, plan };
    const tx = new Transaction(this.world);
    const station = applyStationPlan(this.world, plan, this.day, tx, c.id);
    this.commit(`${plan.name} ${kind}`, tx, ledgerSplit(plan.breakdown), c);
    return { ok: true, cost: plan.cost, plan, station };
  }

  bulldoze(tiles: number[], c: Company = this.company): CommandResult {
    const no = this.refuse(c);
    if (no) return { ok: false, error: no, cost: 0 };
    const plan = planBulldoze(this.world, tiles, c.id);
    if (plan.tiles.length === 0 && plan.stations.length === 0) {
      const other = tiles.map((t) => this.world.track.getIdx(t)).find((n) => n && n.owner !== c.id);
      return { ok: false, error: other ? `That belongs to ${this.companyById(other.owner)?.name ?? 'another railroad'}.` : 'Nothing to remove here.', cost: 0 };
    }
    const busy = this.trains.occupiedTiles();
    const stationTiles = plan.stations.flatMap((id) => this.world.stations[id]?.tiles ?? []);
    if ([...plan.tiles, ...stationTiles].some((t) => busy.has(t))) return { ok: false, error: 'A train is using that track.', cost: 0 };
    if (!c.canAfford(plan.cost)) return { ok: false, error: 'Not enough cash.', cost: plan.cost };
    const value = this.replacementValue(plan.tiles, plan.stations);
    const tx = new Transaction(this.world);
    if (c.id === 0) for (const id of plan.stations) this.goodwillHit(this.world.stations[id]?.tiles[0] ?? -1, -TERRITORIES.bulldozedStation);
    applyBulldoze(this.world, plan, tx);
    const what = plan.stations.length ? `${plan.stations.length} station${plan.stations.length > 1 ? 's' : ''}` : `${plan.tiles.length} track tile${plan.tiles.length > 1 ? 's' : ''}`;
    const before = c.infrastructure;
    c.writeDown(this.year, 'writeOffs', value);
    this.commit(`Bulldoze ${what}`, tx, [['bulldozing', plan.cost]], c);
    if (c.id === 0) this.undoStack[this.undoStack.length - 1].writeOff = before - c.infrastructure;
    return { ok: true, cost: plan.cost };
  }

  /**
   * Build a whole line for company c in one go: new stations where needed and track
   * between the facing ends, all or nothing (rolled back if a step fails or the total
   * exceeds `maxCost`). Used by the AI; not undoable.
   */
  buildLine(c: Company, a: LineEnd, b: LineEnd, opts: TrackOptions, maxCost: number): CommandResult & { stations?: [Station, Station] } {
    const no = this.refuse(c);
    if (no) return { ok: false, error: no, cost: 0 };
    const o = { ...opts, owner: c.id };
    const tx = new Transaction(this.world);
    const split = new Map<ExpenseCategory, number>();
    const addSplit = (bd: CostBreakdown) => {
      for (const [cat, v] of ledgerSplit(bd)) split.set(cat, (split.get(cat) ?? 0) + v);
    };
    const fail = (error: string, cost = 0) => {
      tx.revert();
      return { ok: false, error, cost };
    };
    const ends: Station[] = [];
    for (const e of [a, b]) {
      if ('station' in e) {
        const st = this.world.stations[e.station];
        if (!st || st.owner !== c.id) return fail('Station is gone.');
        ends.push(st);
        continue;
      }
      const plan = this.planStation(e.x, e.y, e.kind, e.axis, c);
      if (!plan.ok) return fail(plan.error ?? 'Cannot place station.');
      addSplit(plan.breakdown);
      ends.push(applyStationPlan(this.world, plan, this.day, tx, c.id));
    }
    const [sa, sb] = ends;
    const nearest = (st: Station, other: Station) => {
      const W = this.world.width;
      const ot = other.tiles[Math.floor(other.tiles.length / 2)];
      const d = (t: number) => Math.hypot((t % W) - (ot % W), Math.floor(t / W) - Math.floor(ot / W));
      return [st.tiles[0], st.tiles[st.tiles.length - 1]].sort((p, q) => d(p) - d(q))[0];
    };
    const from = nearest(sa, sb);
    const to = nearest(sb, sa);
    const plan = this.planTrack(from, to, o, c);
    if (!plan.ok) return fail(plan.error ?? 'No route.');
    const W = this.world.width;
    const straight = Math.hypot((from % W) - (to % W), Math.floor(from / W) - Math.floor(to / W));
    if (plan.lengthTiles > straight * 1.8 + 4) return fail('Too roundabout.');
    addSplit(plan.breakdown);
    const total = [...split.values()].reduce((x, y) => x + y, 0);
    if (total > maxCost || !c.canAfford(total)) return fail('Too expensive.', total);
    applyTrackPlan(this.world, plan, o, tx);
    this.commit(`Line ${sa.name}–${sb.name}`, tx, [...split.entries()], c);
    return { ok: true, cost: total, stations: [sa, sb] };
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
    if (e.writeOff) this.company.writeDown(year, 'writeOffs', -e.writeOff);
    this.emit({ type: 'undone', label: e.label, refund });
    return { ok: true, cost: -refund };
  }

  private pruneUndo(): void {
    const limit = this.day - CONSTRUCTION.undo.windowDays;
    while (this.undoStack.length && this.undoStack[0].day < limit) this.undoStack.shift();
  }

  // -------------------------------------------------------------------------------------
  // Finance
  // -------------------------------------------------------------------------------------

  marketContext(): MarketContext {
    const c = this.economy.cycle;
    return { day: this.day, year: this.year, state: c.state, confidence: c.confidence };
  }

  /** Resale value of the company's trains. */
  rollingStockValue(c: Company = this.company): number {
    return this.trains.trains.reduce((a, t) => a + (t.owner === c.id ? resaleValue(t, this.tick) : 0), 0);
  }

  balance(c: Company = this.company): BalanceSheet {
    return balanceSheet(c, this.rollingStockValue(c));
  }

  fair(c: Company = this.company): FairValue {
    return fairValue(c, this.balance(c).bookValue, this.marketContext());
  }

  /** Credit rating, optionally as if `extraDebt` more bonds were issued. */
  rating(c: Company = this.company, extraDebt = 0): CreditRating {
    const b = this.balance(c);
    const rate = bondRate(creditRating(b.debt, b.totalAssets, c.profitTrend, c.annualInterest), this.economy.cycle.state);
    return creditRating(b.debt + extraDebt, b.totalAssets + extraDebt, c.profitTrend, c.annualInterest + extraDebt * rate);
  }

  /** Rate a new bond would carry now. */
  newBondRate(c: Company = this.company): number {
    return Math.max(0.005, bondRate(this.rating(c, FINANCE.bonds.block), this.economy.cycle.state) + this.modsFor(c).interest);
  }

  /** An investor's net worth (cash + shares − shorts); yours by default. */
  netWorth(inv: Chairman = this.chairman): number {
    return account(inv, this.activeCompanies).equity;
  }

  /** Replacement value of track tiles and stations (what bulldozing writes off). */
  replacementValue(tiles: number[], stations: number[]): number {
    const C = CONSTRUCTION;
    let v = 0;
    for (const t of tiles) {
      const n = this.world.track.getIdx(t);
      if (!n) continue;
      if (n.kind === NODE_BRIDGE) v += C.bridges[n.span]?.perTile ?? C.track.single;
      else if (n.kind === NODE_TUNNEL) v += C.tunnel.perTile;
      else v += C.track.single + (n.double ? C.track.doubleExtra : 0);
    }
    for (const id of stations) {
      const st = this.world.stations[id];
      if (!st) continue;
      v += STATION_BY_ID.get(st.kind)?.cost ?? 0;
      for (const imp of st.improvements ?? []) v += IMPROVEMENT_BY_ID.get(imp)?.cost ?? 0;
    }
    return v;
  }

  private marketDaily(): void {
    const ctx = this.marketContext();
    const active = this.activeCompanies;
    for (const c of active) stockDaily(c, this.fair(c).perShare, ctx, this.marketRng);
    for (const inv of this.investors) {
      const call = enforceMargin(inv, active);
      if (call && call.sold.length && inv === this.chairman) this.emit({ type: 'marginCall', call });
    }
  }

  private financeEvent(c: Company, text: string, tone: number): void {
    this.emit({ type: 'finance', company: c.id, text, tone });
  }

  /** Month end: depreciation, interest, emergency bonds, salary, dividends, margin interest. */
  private financeMonthly(date: GameDate): void {
    const closing = dayToDate(this.day - 1, this.params.startYear).year;
    const A = FINANCE.accounting;
    for (const c of this.activeCompanies) {
      // The chairman's salary is part of the month's costs.
      const salary = A.chairmanSalaryPerYear / 12;
      c.spend(closing, 'salary', salary);
      const mgr = c.manager ? MANAGER_BY_ID.get(c.manager) : undefined;
      if (mgr) c.spend(closing, 'salary', mgr.salary / 12);
      const boss = this.investorByKey(c.chairman);
      if (boss) boss.cash += salary;
      c.writeDown(closing, 'depreciation', (c.infrastructure * A.infrastructureDepreciation) / 12);
      closeMonth(c, closing);
      // Dividends come out of the company's own cash, before any emergency borrowing.
      if (FINANCE.dividends.months.includes(date.month)) {
        const r = payDividend(c, this.year, (holder, amount) => {
          const inv = this.investorByKey(holder);
          if (inv) inv.cash += amount;
        });
        if (r.perShare > 0) for (const inv of this.investors) inv.cash -= r.perShare * inv.short(c.id);
        if (r.skipped) {
          c.note(this.day, 'Dividend passed (not enough cash)');
          this.financeEvent(c, `${c.name} could not afford its dividend.`, -1);
        }
      }
      // Lenders won't help a company whose debts exceed its assets: that one heads for bankruptcy.
      if (c.cash < 0 && checkSolvency(this, c)) {
        const blocks = Math.ceil(-c.cash / FINANCE.bonds.block);
        const rate = Math.max(0.005, bondRate(this.rating(c, blocks * FINANCE.bonds.block), this.economy.cycle.state) + this.modsFor(c).interest) + FINANCE.bonds.emergencyPenalty;
        for (let i = 0; i < blocks; i++) c.addBond(this.year, this.day, FINANCE.bonds.block, rate, true);
        c.note(this.day, `Emergency bonds: ${fmt(blocks * FINANCE.bonds.block)} at ${(rate * 100).toFixed(1)}%`);
        this.financeEvent(c, `${c.name} ran out of cash: the bank forced ${blocks} emergency bond${blocks > 1 ? 's' : ''} at ${(rate * 100).toFixed(1)}%.`, -1);
      }
      c.stock.monthOpen = c.stock.price;
    }
    for (const inv of this.investors) {
      chargeMarginInterest(inv, baseRate(this.economy.cycle.state));
      inv.worthHistory.push(Math.round(this.netWorth(inv)));
      if (inv.worthHistory.length > 240) inv.worthHistory.shift();
    }
  }

  /** Year end: bond maturities, year record, year-end report. */
  private financeYearly(): void {
    const closing = this.year - 1;
    for (const c of this.activeCompanies) {
      for (const b of [...c.bonds]) {
        if (b.maturityYear <= this.year) {
          c.removeBond(this.year, b.id);
          this.financeEvent(c, `A ${fmt(b.principal)} bond of ${c.name} matured and was repaid.`, 0);
        }
      }
      const prev = c.history[c.history.length - 1];
      const record: YearRecord = {
        year: closing,
        revenue: c.revenueIn(closing) + c.otherIncomeIn(closing),
        operatingCosts: c.operatingCostsIn(closing),
        netProfit: c.netProfitIn(closing),
        bookValue: this.balance(c).bookValue,
        price: c.stock.price,
        shares: c.shares,
        debt: c.debt,
        dividendsPerShare: c.trailingDividend,
      };
      c.history.push(record);
      if (c.id === 0 && !this.over) {
        const worth = this.netWorth();
        const board = boardVote(this, c);
        if (board.held) {
          if (board.support < 0.5) c.boardStrikes++;
          else c.boardStrikes = 0;
          board.strikes = c.boardStrikes;
        }
        this.emit({ type: 'yearEnd', report: { year: closing, company: record, previous: prev, priceStart: c.stock.yearOpen, worthStart: this.chairman.yearStartWorth, worthEnd: worth, board } });
        this.chairman.yearStartWorth = worth;
        if (board.held && c.boardStrikes >= 2) {
          this.endGame('board', `The shareholders of ${c.name} voted you out: only ${Math.round(board.support * 100)}% stood by you, for the second year running.`);
        } else if (board.held && c.boardStrikes === 1) {
          this.emit({ type: 'rival', company: 0, text: `The shareholders voted no confidence in you (${Math.round(board.support * 100)}% support). Turn the company around this year or you will be removed.`, tone: -1 });
        }
      }
      c.stock.yearOpen = c.stock.price;
    }
    for (const inv of this.investors) if (inv !== this.chairman) inv.yearStartWorth = this.netWorth(inv);
  }

  issueBond(c: Company = this.company): CommandResult & { rate?: number } {
    const no = this.refuse(c);
    if (no) return { ok: false, error: no, cost: 0 };
    const block = FINANCE.bonds.block;
    const after = this.rating(c, block);
    if (after.def.id === 'D') return { ok: false, error: 'No lender will buy more bonds at this level of debt.', cost: 0 };
    const rate = Math.max(0.005, bondRate(after, this.economy.cycle.state) + this.modsFor(c).interest);
    c.addBond(this.year, this.day, block, rate);
    c.note(this.day, `Issued a ${fmt(block)} bond at ${(rate * 100).toFixed(1)}%`);
    return { ok: true, cost: -block, rate };
  }

  repayBond(id: number, c: Company = this.company): CommandResult {
    const no = this.refuse(c);
    if (no) return { ok: false, error: no, cost: 0 };
    const bond = c.bonds.find((b) => b.id === id);
    if (!bond) return { ok: false, error: 'No such bond.', cost: 0 };
    if (!c.canAfford(bond.principal)) return { ok: false, error: 'Not enough cash.', cost: bond.principal };
    c.removeBond(this.year, id);
    c.note(this.day, `Repaid a ${fmt(bond.principal)} bond`);
    return { ok: true, cost: bond.principal };
  }

  issueShares(c: Company = this.company): ShareAction {
    const no = this.refuse(c);
    if (no) return { ok: false, error: no, shares: 0, cash: 0, effect: 0 };
    return issueShares(c, this.marketContext());
  }

  buybackShares(c: Company = this.company): ShareAction {
    const no = this.refuse(c);
    if (no) return { ok: false, error: no, shares: 0, cash: 0, effect: 0 };
    return buybackShares(c, this.marketContext());
  }

  splitStock(c: Company = this.company): ShareAction {
    const no = this.refuse(c);
    if (no) return { ok: false, error: no, shares: 0, cash: 0, effect: 0 };
    const r = splitStock(c, this.marketContext());
    if (r.ok) {
      for (const inv of this.investors) {
        const s = inv.short(c.id);
        if (s) inv.shorts.set(c.id, s * 2);
      }
    }
    return r;
  }

  /** Set the annual dividend per share (rounded to the step). */
  setDividend(perShare: number, c: Company = this.company): CommandResult {
    const no = this.refuse(c);
    if (no) return { ok: false, error: no, cost: 0 };
    const step = FINANCE.dividends.step;
    const v = Math.max(0, Math.round(perShare / step) * step);
    if (Math.abs(v - c.dividendPerShare) < 1e-9) return { ok: true, cost: 0 };
    const up = v > c.dividendPerShare;
    c.dividendPerShare = Math.round(v * 100) / 100;
    c.note(this.day, v === 0 ? 'Dividend suspended' : `Dividend ${up ? 'raised' : 'cut'} to $${v.toFixed(2)} a year`);
    return { ok: true, cost: 0 };
  }

  companyById(id: number): Company | undefined {
    return this.companies.find((c) => c.id === id);
  }

  private trade(id: number, fn: (c: Company) => TradeResult): TradeResult {
    const c = this.companyById(id);
    if (!c || c.defunct) return { ok: false, error: 'No such company.', shares: 0, price: 0, cash: 0 };
    return fn(c);
  }

  buyStock(companyId: number, n: number, inv: Chairman = this.chairman): TradeResult {
    return this.trade(companyId, (c) => buyShares(inv, this.activeCompanies, c, n));
  }

  sellStock(companyId: number, n: number, inv: Chairman = this.chairman): TradeResult {
    return this.trade(companyId, (c) => sellShares(inv, c, n));
  }

  shortStock(companyId: number, n: number, inv: Chairman = this.chairman): TradeResult {
    return this.trade(companyId, (c) => shortShares(inv, this.activeCompanies, c, n));
  }

  coverStock(companyId: number, n: number, inv: Chairman = this.chairman): TradeResult {
    return this.trade(companyId, (c) => coverShort(inv, c, n));
  }

  maxBuyShares(companyId: number, inv: Chairman = this.chairman): number {
    const c = this.companyById(companyId);
    return c && !c.defunct ? maxBuy(inv, this.activeCompanies, c) : 0;
  }

  // -------------------------------------------------------------------------------------
  // Economy commands
  // -------------------------------------------------------------------------------------

  /** Why an improvement can't be built at a station right now (null = it can). */
  improvementBlocker(stationId: number, improvementId: string): string | null {
    const st = this.world.stations[stationId];
    const def = IMPROVEMENT_BY_ID.get(improvementId);
    if (!st) return 'No such station.';
    if (!def) return 'Unknown improvement.';
    if (st.owner !== this.company.id) return 'That is a rival\'s station.';
    if (this.over) return 'You no longer run a railroad.';
    const have = st.improvements ?? [];
    if (have.includes(def.id)) return `${def.name} already built.`;
    if (def.requires && !have.includes(def.requires)) return `Needs a ${IMPROVEMENT_BY_ID.get(def.requires)?.name.toLowerCase() ?? def.requires} first.`;
    if (!this.company.canAfford(def.cost)) return 'Not enough cash.';
    return null;
  }

  buildImprovement(stationId: number, improvementId: string): CommandResult {
    const err = this.improvementBlocker(stationId, improvementId);
    const def = IMPROVEMENT_BY_ID.get(improvementId);
    if (err || !def) return { ok: false, error: err ?? 'Unknown improvement.', cost: def?.cost ?? 0 };
    const st = this.world.stations[stationId]!;
    st.improvements = [...(st.improvements ?? []), def.id];
    this.company.spend(this.year, 'improvements', def.cost);
    // An undo that removed the station would silently lose the improvement.
    this.undoStack.length = 0;
    this.economy.invalidate();
    for (const t of st.tiles) this.world.markDirty(t);
    this.emit({ type: 'built', label: `${def.name} at ${st.name}`, cost: def.cost });
    return { ok: true, cost: def.cost };
  }

  canBuyIndustries(): boolean {
    return ECONOMY.models[this.economy.model].buyIndustries;
  }

  buyIndustry(industryId: number): CommandResult {
    const ind = this.world.industries[industryId];
    if (!ind) return { ok: false, error: 'No such industry.', cost: 0 };
    if (!this.canBuyIndustries()) return { ok: false, error: 'Industries can only be bought in the Expert economy.', cost: 0 };
    if (this.over) return { ok: false, error: 'You no longer run a railroad.', cost: 0 };
    if (this.economy.owned.has(industryId)) return { ok: false, error: 'You already own it.', cost: 0 };
    const price = this.economy.industryPrice(ind);
    if (!this.company.canAfford(price)) return { ok: false, error: 'Not enough cash.', cost: price };
    this.company.spend(this.year, 'industries', price);
    this.company.industryCost.set(industryId, price);
    this.economy.owned.add(industryId);
    this.emit({ type: 'built', label: `Bought ${ind.name}`, cost: price });
    return { ok: true, cost: price };
  }

  sellIndustry(industryId: number): CommandResult {
    const ind = this.world.industries[industryId];
    if (!ind || !this.economy.owned.has(industryId) || !this.company.industryCost.has(industryId)) return { ok: false, error: 'You don\'t own that industry.', cost: 0 };
    if (this.over) return { ok: false, error: 'You no longer run a railroad.', cost: 0 };
    const value = Math.round(this.economy.industryPrice(ind) * ECONOMY.ownership.sellFraction);
    this.economy.owned.delete(industryId);
    const cost = this.company.industryCost.get(industryId) ?? value;
    this.company.industryCost.delete(industryId);
    // Book the purchase cost out; any difference is a gain or loss.
    this.company.spend(this.year, 'industries', -cost);
    if (value !== cost) this.company.earnOther(this.year, 'industrySales', value - cost);
    return { ok: true, cost: -value };
  }

  // -------------------------------------------------------------------------------------
  // Train commands
  // -------------------------------------------------------------------------------------

  private validRoute(route: RouteStop[], owner: number): string | null {
    if (route.length < 2) return 'A route needs at least two stops.';
    for (const r of route) {
      const st = this.world.stations[r.station];
      if (!st) return 'A stop on this route no longer exists.';
      if (st.owner !== owner) return `${st.name} belongs to another railroad.`;
    }
    return null;
  }

  /** A train the company may give orders to. */
  private ownTrain(id: number, c: Company): Train | string {
    const t = this.trains.byId(id);
    if (!t) return 'No such train.';
    if (t.owner !== c.id) return 'That train belongs to another railroad.';
    return this.refuse(c) ?? t;
  }

  buyTrain(engineId: string, cargos: string[], route: RouteStop[], c: Company = this.company): CommandResult & { train?: Train } {
    const no = this.refuse(c);
    if (no) return { ok: false, error: no, cost: 0 };
    const e = ENGINE_BY_ID.get(engineId);
    if (!e) return { ok: false, error: 'Unknown engine.', cost: 0 };
    if (!enginesAvailable(this.year).includes(e)) return { ok: false, error: `${e.name} is not on sale in ${this.year}.`, cost: 0 };
    if (cargos.length < 1 || cargos.length > e.maxCars) return { ok: false, error: `${e.name} pulls 1–${e.maxCars} cars.`, cost: 0 };
    const bad = this.validRoute(route, c.id);
    if (bad) return { ok: false, error: bad, cost: 0 };
    const price = consistPrice(engineId, cargos);
    if (!c.canAfford(price)) return { ok: false, error: 'Not enough cash.', cost: price };
    c.spend(this.year, 'trains', price);
    const train = this.trains.spawn(engineId, cargos, route, undefined, c.id);
    return { ok: true, cost: price, train };
  }

  sellTrain(id: number, c: Company = this.company): CommandResult {
    const t = this.ownTrain(id, c);
    if (typeof t === 'string') return { ok: false, error: t, cost: 0 };
    const value = resaleValue(t, this.tick);
    this.trains.remove(t);
    c.spend(this.year, 'trains', -value);
    return { ok: true, cost: -value };
  }

  setRoute(id: number, route: RouteStop[], c: Company = this.company): CommandResult {
    const t = this.ownTrain(id, c);
    if (typeof t === 'string') return { ok: false, error: t, cost: 0 };
    const bad = this.validRoute(route, c.id);
    if (bad) return { ok: false, error: bad, cost: 0 };
    const current = t.route[t.stop]?.station;
    t.route = route.map((r) => ({ ...r }));
    const idx = t.route.findIndex((r) => r.station === current);
    t.stop = idx >= 0 ? idx : 0;
    return { ok: true, cost: 0 };
  }

  /** Change the consist: new cars are bought, removed cars sold at half price. */
  setConsist(id: number, cargos: string[], c: Company = this.company): CommandResult {
    const t = this.ownTrain(id, c);
    if (typeof t === 'string') return { ok: false, error: t, cost: 0 };
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
    if (cost > 0 && !c.canAfford(cost)) return { ok: false, error: 'Not enough cash.', cost };
    c.spend(this.year, 'trains', cost);
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
  upgradeEngine(id: number, c: Company = this.company): CommandResult {
    const t = this.ownTrain(id, c);
    if (typeof t === 'string') return { ok: false, error: t, cost: 0 };
    const best = this.bestEngineFor(t);
    if (!best) return { ok: false, error: 'No suitable engine on sale.', cost: 0 };
    if (best.id === t.engine && engineAgeYears(t, this.tick) < 1) return { ok: false, error: 'Already the best available engine.', cost: 0 };
    const cost = best.price - engineTradeIn(t, this.tick);
    if (!c.canAfford(cost)) return { ok: false, error: 'Not enough cash.', cost };
    c.spend(this.year, 'trains', cost);
    t.engine = best.id;
    t.engineBuiltTick = this.tick;
    return { ok: true, cost };
  }

  // -------------------------------------------------------------------------------------
  // Events & managers
  // -------------------------------------------------------------------------------------

  /** Everything that changes company c's numbers: current events plus its manager. */
  modsFor(c: Company): Modifiers {
    const mgr = c.manager ? MANAGER_BY_ID.get(c.manager) : undefined;
    return mgr ? combineMods(this.events.mods, mgr.effects) : this.events.mods;
  }

  /** Start an event now (scenarios, tests). */
  forceEvent(id: string, months?: number): void {
    const def = this.events.force(id, this.day, months);
    this.economy.mods = this.events.mods;
    if (def) this.emit({ type: 'event', def, started: true });
  }

  /** New candidates each January (never the one you employ). */
  refreshManagerOffers(): void {
    const pool = MANAGERS.managers.map((m) => m.id).filter((id) => id !== this.company.manager);
    const out: string[] = [];
    while (out.length < MANAGERS.offered && pool.length) out.push(pool.splice(this.managerRng.int(0, pool.length - 1), 1)[0]);
    this.managerOffers = out;
  }

  /** Signing fee for a manager. */
  managerFee(id: string): number {
    return Math.round((MANAGER_BY_ID.get(id)?.salary ?? 0) * MANAGERS.fee);
  }

  hireManager(id: string, c: Company = this.company): CommandResult {
    const no = this.refuse(c);
    if (no) return { ok: false, error: no, cost: 0 };
    const def = MANAGER_BY_ID.get(id);
    if (!def || !this.managerOffers.includes(id)) return { ok: false, error: 'That manager is not available.', cost: 0 };
    const fee = this.managerFee(id);
    if (!c.canAfford(fee)) return { ok: false, error: 'Not enough cash for the signing fee.', cost: fee };
    c.spend(this.year, 'salary', fee);
    const old = c.manager;
    c.manager = id;
    this.managerOffers = this.managerOffers.filter((x) => x !== id);
    if (old) this.managerOffers.push(old);
    c.note(this.day, `Hired ${def.name} (${def.title.toLowerCase()})`);
    return { ok: true, cost: fee };
  }

  fireManager(c: Company = this.company): CommandResult {
    const no = this.refuse(c);
    if (no) return { ok: false, error: no, cost: 0 };
    if (!c.manager) return { ok: false, error: 'You have no manager.', cost: 0 };
    this.managerOffers.push(c.manager);
    c.manager = null;
    return { ok: true, cost: 0 };
  }

  /** Save a train's engine, cars and route as a template. */
  saveTemplate(trainId: number, name?: string): RouteTemplate | null {
    const t = this.trains.byId(trainId);
    if (!t || t.owner !== this.company.id) return null;
    const stops = t.route.map((r) => this.world.stations[r.station]?.name ?? '?');
    const tpl: RouteTemplate = {
      id: this.nextTemplateId++,
      name: name?.trim() || stops.join(' – '),
      engine: t.engine,
      cargos: t.cars.map((c) => c.cargo),
      route: t.route.map((r) => ({ ...r })),
    };
    this.templates.push(tpl);
    return tpl;
  }

  deleteTemplate(id: number): boolean {
    const i = this.templates.findIndex((t) => t.id === id);
    if (i < 0) return false;
    this.templates.splice(i, 1);
    return true;
  }

  /** Buy a train from a template, with the best engine on sale if the saved one no longer is. */
  buyFromTemplate(id: number, reverse = false): CommandResult & { train?: Train } {
    const tpl = this.templates.find((t) => t.id === id);
    if (!tpl) return { ok: false, error: 'No such template.', cost: 0 };
    const sale = enginesAvailable(this.year);
    const engine = sale.some((e) => e.id === tpl.engine)
      ? tpl.engine
      : sale.filter((e) => e.maxCars >= tpl.cargos.length).sort((a, b) => b.power * b.topSpeed - a.power * a.topSpeed)[0]?.id;
    if (!engine) return { ok: false, error: 'No suitable engine on sale.', cost: 0 };
    const route = reverse ? [...tpl.route].reverse() : tpl.route;
    return this.buyTrain(engine, tpl.cargos, route.map((r) => ({ ...r })));
  }

  duplicateTrain(id: number, c: Company = this.company): CommandResult & { train?: Train } {
    const t = this.ownTrain(id, c);
    if (typeof t === 'string') return { ok: false, error: t, cost: 0 };
    const engine = enginesAvailable(this.year).some((e) => e.id === t.engine) ? t.engine : this.bestEngineFor(t)?.id;
    if (!engine) return { ok: false, error: 'No suitable engine on sale.', cost: 0 };
    return this.buyTrain(engine, t.cars.map((car) => car.cargo), t.route, c);
  }
}
