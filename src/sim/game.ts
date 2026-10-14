import { CAR_BY_ID, COMPANY, CONSTRUCTION, ECONOMY, ENGINE_BY_ID, FINANCE, IMPROVEMENT_BY_ID, STATION_BY_ID, TIME, type EconomicModel } from '../data';
import { Chairman, PLAYER, account, buyShares, chargeMarginInterest, coverShort, enforceMargin, maxBuy, sellShares, shortShares, type MarginCall, type TradeResult } from './chairman';
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
  | TrainEvent;

export interface YearEndReport {
  year: number;
  company: YearRecord;
  previous?: YearRecord;
  priceStart: number;
  worthStart: number;
  worthEnd: number;
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
  /** All railroad companies; index 0 is the player's. */
  readonly companies: Company[];
  readonly chairman: Chairman;
  readonly economy: Economy;
  readonly trains: TrainSystem;
  readonly settings: GameSettings;
  /** Ticks since Jan 1 of the start year. */
  tick = 0;
  readonly undoStack: UndoEntry[] = [];
  private readonly growthRng: Rng;
  private readonly marketRng: Rng;
  private listeners: Array<(e: GameEvent) => void> = [];

  constructor(params: MapParams, world?: World, settings?: Partial<GameSettings>) {
    this.params = params;
    this.world = world ?? generateWorld(params);
    this.rng = new Rng((params.seed ^ 0xa5a5a5a5) >>> 0);
    this.companies = [Company.found(0, this.rng.pick(COMPANY.names))];
    const S = FINANCE.shares;
    this.chairman = new Chairman('You', S.chairmanFortune - S.initial * S.chairmanFraction * S.ipoPrice);
    this.settings = { wrecks: ECONOMY.wrecks.enabledByDefault, model: ECONOMY.model, ...settings };
    this.economy = new Economy(this.world, this.settings.model, this.rng.fork(11));
    this.growthRng = this.rng.fork(12);
    this.marketRng = this.rng.fork(13);
    this.chairman.yearStartWorth = this.netWorth();
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

  /** The player's company. */
  get company(): Company {
    return this.companies[0];
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
      this.marketDaily();
      this.emit({ type: 'day', date });
      if (date.day === 1) {
        this.financeMonthly(date);
        this.monthly(date);
        this.trains.monthly();
        this.chargeTrackMaintenance();
        this.emit({ type: 'month', date });
        if (date.month === 0) {
          this.financeYearly();
          this.trains.yearly();
          this.economy.yearly();
          this.emit({ type: 'year', date });
        }
      }
    }
  }

  /** Monthly economy: industries, cycle, owned-industry profits, then town growth. */
  private monthly(date: GameDate): void {
    const newsBefore = this.economy.cycle.news.length;
    const stateBefore = this.economy.cycle.state;
    const income = this.economy.monthly(this.day);
    const total = income.reduce((a, i) => a + i.amount, 0);
    if (income.length) {
      this.company.earnOther(this.year, 'industries', total);
      this.emit({ type: 'industryIncome', amount: total });
    }
    const blocked = new Set(this.undoStack.flatMap((e) => e.tx.touchedTiles));
    const reports = monthlyCityGrowth(this.world, this.economy, this.growthRng, this.year, blocked);
    this.economy.resetMonth();
    if (reports.length) {
      this.economy.invalidate();
      this.emit({ type: 'growth', reports });
    }
    const cycle = this.economy.cycle;
    if (cycle.state !== stateBefore) this.emit({ type: 'cycle', state: cycle.state, date });
    // news is capped (shifted), so compare against the newest entries
    const fresh = cycle.news.length > newsBefore ? cycle.news.slice(newsBefore) : cycle.news.slice(-1).filter((h) => h.day === this.day);
    for (const headline of fresh) this.emit({ type: 'news', headline });
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
    let upkeep = 0;
    for (const st of this.world.liveStations()) {
      total += (tm.stationPerYear[st.kind] ?? 0) / 12;
      for (const id of st.improvements ?? []) upkeep += (IMPROVEMENT_BY_ID.get(id)?.upkeep ?? 0) / 12;
    }
    if (total > 0) this.company.spend(this.year, 'trackMaintenance', total);
    if (upkeep > 0) this.company.spend(this.year, 'improvementUpkeep', upkeep);
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
    const value = this.replacementValue(plan.tiles, plan.stations);
    const tx = new Transaction(this.world);
    applyBulldoze(this.world, plan, tx);
    const what = plan.stations.length ? `${plan.stations.length} station${plan.stations.length > 1 ? 's' : ''}` : `${plan.tiles.length} track tile${plan.tiles.length > 1 ? 's' : ''}`;
    const before = this.company.infrastructure;
    this.company.writeDown(this.year, 'writeOffs', value);
    this.commit(`Bulldoze ${what}`, tx, [['bulldozing', plan.cost]]);
    this.undoStack[this.undoStack.length - 1].writeOff = before - this.company.infrastructure;
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
    if (c.id !== 0) return 0;
    return this.trains.trains.reduce((a, t) => a + resaleValue(t, this.tick), 0);
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
    return bondRate(this.rating(c, FINANCE.bonds.block), this.economy.cycle.state);
  }

  /** The chairman's net worth (cash + shares − shorts). */
  netWorth(): number {
    return account(this.chairman, this.companies).equity;
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
    for (const c of this.companies) stockDaily(c, this.fair(c).perShare, ctx, this.marketRng);
    const call = enforceMargin(this.chairman, this.companies);
    if (call && call.sold.length) this.emit({ type: 'marginCall', call });
  }

  private financeEvent(c: Company, text: string, tone: number): void {
    this.emit({ type: 'finance', company: c.id, text, tone });
  }

  /** Month end: depreciation, interest, emergency bonds, salary, dividends, margin interest. */
  private financeMonthly(date: GameDate): void {
    const closing = dayToDate(this.day - 1, this.params.startYear).year;
    const A = FINANCE.accounting;
    for (const c of this.companies) {
      c.writeDown(closing, 'depreciation', (c.infrastructure * A.infrastructureDepreciation) / 12);
      closeMonth(c, closing);
      // Dividends come out of the company's own cash, before any emergency borrowing.
      if (FINANCE.dividends.months.includes(date.month)) {
        const r = payDividend(c, this.year, (holder, amount) => {
          if (holder === PLAYER) this.chairman.cash += amount;
        });
        if (r.perShare > 0) this.chairman.cash -= r.perShare * this.chairman.short(c.id);
        if (r.skipped) {
          c.note(this.day, 'Dividend passed (not enough cash)');
          this.financeEvent(c, `${c.name} could not afford its dividend.`, -1);
        }
      }
      if (c.cash < 0) {
        const blocks = Math.ceil(-c.cash / FINANCE.bonds.block);
        const rate = bondRate(this.rating(c, blocks * FINANCE.bonds.block), this.economy.cycle.state) + FINANCE.bonds.emergencyPenalty;
        for (let i = 0; i < blocks; i++) c.addBond(this.year, this.day, FINANCE.bonds.block, rate, true);
        c.note(this.day, `Emergency bonds: ${fmt(blocks * FINANCE.bonds.block)} at ${(rate * 100).toFixed(1)}%`);
        this.financeEvent(c, `${c.name} ran out of cash: the bank forced ${blocks} emergency bond${blocks > 1 ? 's' : ''} at ${(rate * 100).toFixed(1)}%.`, -1);
      }
      c.stock.monthOpen = c.stock.price;
    }
    const salary = A.chairmanSalaryPerYear / 12;
    this.company.spend(this.year, 'salary', salary);
    this.chairman.cash += salary;
    chargeMarginInterest(this.chairman, baseRate(this.economy.cycle.state));
    this.chairman.worthHistory.push(Math.round(this.netWorth()));
    if (this.chairman.worthHistory.length > 240) this.chairman.worthHistory.shift();
  }

  /** Year end: bond maturities, year record, year-end report. */
  private financeYearly(): void {
    const closing = this.year - 1;
    for (const c of this.companies) {
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
      if (c.id === 0) {
        const worth = this.netWorth();
        this.emit({ type: 'yearEnd', report: { year: closing, company: record, previous: prev, priceStart: c.stock.yearOpen, worthStart: this.chairman.yearStartWorth, worthEnd: worth } });
        this.chairman.yearStartWorth = worth;
      }
      c.stock.yearOpen = c.stock.price;
    }
  }

  issueBond(c: Company = this.company): CommandResult & { rate?: number } {
    const block = FINANCE.bonds.block;
    const after = this.rating(c, block);
    if (after.def.id === 'D') return { ok: false, error: 'No lender will buy more bonds at this level of debt.', cost: 0 };
    const rate = bondRate(after, this.economy.cycle.state);
    c.addBond(this.year, this.day, block, rate);
    c.note(this.day, `Issued a ${fmt(block)} bond at ${(rate * 100).toFixed(1)}%`);
    return { ok: true, cost: -block, rate };
  }

  repayBond(id: number, c: Company = this.company): CommandResult {
    const bond = c.bonds.find((b) => b.id === id);
    if (!bond) return { ok: false, error: 'No such bond.', cost: 0 };
    if (!c.canAfford(bond.principal)) return { ok: false, error: 'Not enough cash.', cost: bond.principal };
    c.removeBond(this.year, id);
    c.note(this.day, `Repaid a ${fmt(bond.principal)} bond`);
    return { ok: true, cost: bond.principal };
  }

  issueShares(c: Company = this.company): ShareAction {
    return issueShares(c, this.marketContext());
  }

  buybackShares(c: Company = this.company): ShareAction {
    return buybackShares(c, this.marketContext());
  }

  splitStock(c: Company = this.company): ShareAction {
    const r = splitStock(c, this.marketContext());
    if (r.ok) {
      const s = this.chairman.short(c.id);
      if (s) this.chairman.shorts.set(c.id, s * 2);
    }
    return r;
  }

  /** Set the annual dividend per share (rounded to the step). */
  setDividend(perShare: number, c: Company = this.company): CommandResult {
    const step = FINANCE.dividends.step;
    const v = Math.max(0, Math.round(perShare / step) * step);
    if (Math.abs(v - c.dividendPerShare) < 1e-9) return { ok: true, cost: 0 };
    const up = v > c.dividendPerShare;
    c.dividendPerShare = Math.round(v * 100) / 100;
    c.note(this.day, v === 0 ? 'Dividend suspended' : `Dividend ${up ? 'raised' : 'cut'} to $${v.toFixed(2)} a year`);
    return { ok: true, cost: 0 };
  }

  private companyById(id: number): Company | undefined {
    return this.companies.find((c) => c.id === id);
  }

  private trade(id: number, fn: (c: Company) => TradeResult): TradeResult {
    const c = this.companyById(id);
    if (!c) return { ok: false, error: 'No such company.', shares: 0, price: 0, cash: 0 };
    return fn(c);
  }

  buyStock(companyId: number, n: number): TradeResult {
    return this.trade(companyId, (c) => buyShares(this.chairman, this.companies, c, n));
  }

  sellStock(companyId: number, n: number): TradeResult {
    return this.trade(companyId, (c) => sellShares(this.chairman, c, n));
  }

  shortStock(companyId: number, n: number): TradeResult {
    return this.trade(companyId, (c) => shortShares(this.chairman, this.companies, c, n));
  }

  coverStock(companyId: number, n: number): TradeResult {
    return this.trade(companyId, (c) => coverShort(this.chairman, c, n));
  }

  maxBuyShares(companyId: number): number {
    const c = this.companyById(companyId);
    return c ? maxBuy(this.chairman, this.companies, c) : 0;
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
    if (!ind || !this.economy.owned.has(industryId)) return { ok: false, error: 'You don\'t own that industry.', cost: 0 };
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
