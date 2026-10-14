import { FINANCE } from '../data';
import type { Company } from './company';
import { applyImpact, executionPrice } from './finance';

const M = FINANCE.margin;
/** Share-register key of the human chairman. */
export const PLAYER = 'player';

/**
 * The chairman's personal account, separate from the company: cash (negative = margin
 * loan), long holdings (read from each company's share register) and short positions.
 */
export class Chairman {
  name: string;
  cash: number;
  /** companyId → shares sold short. */
  readonly shorts = new Map<number, number>();
  /** Year-start net worth, for the year-end report. */
  yearStartWorth = 0;
  /** Monthly net-worth history (newest last). */
  readonly worthHistory: number[] = [];

  constructor(name: string, cash: number) {
    this.name = name;
    this.cash = cash;
  }

  short(companyId: number): number {
    return this.shorts.get(companyId) ?? 0;
  }
}

export interface Position {
  company: Company;
  long: number;
  short: number;
}

export interface AccountSummary {
  cash: number;
  longValue: number;
  shortValue: number;
  /** Net worth = cash + longs − shorts. */
  equity: number;
  /** Gross exposure = longs + shorts. */
  gross: number;
  /** equity / gross (Infinity without positions). */
  ratio: number;
  marginLoan: number;
  positions: Position[];
}

export function positions(ch: Chairman, companies: readonly Company[]): Position[] {
  return companies.map((company) => ({ company, long: company.holding(PLAYER), short: ch.short(company.id) })).filter((p) => p.long > 0 || p.short > 0);
}

export function account(ch: Chairman, companies: readonly Company[]): AccountSummary {
  const pos = positions(ch, companies);
  const longValue = pos.reduce((a, p) => a + p.long * p.company.stock.price, 0);
  const shortValue = pos.reduce((a, p) => a + p.short * p.company.stock.price, 0);
  const equity = ch.cash + longValue - shortValue;
  const gross = longValue + shortValue;
  return { cash: ch.cash, longValue, shortValue, equity, gross, ratio: gross > 0 ? equity / gross : Infinity, marginLoan: Math.max(0, -ch.cash), positions: pos };
}

/**
 * Price of `company` at which a margin call would hit, other prices unchanged
 * (null when no price can trigger one).
 */
export function liquidationPrice(ch: Chairman, companies: readonly Company[], company: Company): number | null {
  const acc = account(ch, companies);
  const L = company.holding(PLAYER);
  const S = ch.short(company.id);
  if (L === 0 && S === 0) return null;
  const p0 = company.stock.price;
  const otherNet = acc.longValue - acc.shortValue - (L - S) * p0;
  const otherGross = acc.gross - (L + S) * p0;
  // cash + otherNet + (L − S)p = m (otherGross + (L + S)p)
  const denom = L - S - M.maintenance * (L + S);
  if (Math.abs(denom) < 1e-9) return null;
  const p = (M.maintenance * otherGross - ch.cash - otherNet) / denom;
  if (!(p > 0)) return null;
  // Longs are hurt by falling prices, shorts by rising ones: only report the side that matters.
  if (denom > 0 && p >= p0) return null;
  if (denom < 0 && p <= p0) return null;
  return p;
}

export interface TradeResult {
  ok: boolean;
  error?: string;
  shares: number;
  price: number;
  /** Cash change of the chairman (− paid, + received). */
  cash: number;
}

const no = (error: string): TradeResult => ({ ok: false, error, shares: 0, price: 0, cash: 0 });

/** Would the account still meet initial margin after a cash change and exposure change? */
function meetsInitialMargin(ch: Chairman, companies: readonly Company[], cashDelta: number, grossDelta: number, equityDelta: number): boolean {
  const acc = account(ch, companies);
  const equity = acc.equity + cashDelta + equityDelta;
  const gross = acc.gross + grossDelta;
  return gross <= 0 || equity >= M.initial * gross;
}

function buyCost(c: Company, n: number): number {
  return n * executionPrice(c, n) * (1 + M.commission);
}

function canBuy(ch: Chairman, companies: readonly Company[], c: Company, n: number): boolean {
  return c.holding('public') >= n && meetsInitialMargin(ch, companies, -buyCost(c, n), n * c.stock.price, n * c.stock.price);
}

/** Most shares the chairman can buy now (cash + margin), limited by the public float. */
export function maxBuy(ch: Chairman, companies: readonly Company[], c: Company): number {
  let lo = 0;
  let hi = c.holding('public');
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (canBuy(ch, companies, c, mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function buyShares(ch: Chairman, companies: readonly Company[], c: Company, n: number): TradeResult {
  n = Math.floor(n);
  if (n <= 0) return no('Choose how many shares.');
  if (c.holding('public') < n) return no(`Only ${c.holding('public').toLocaleString('en-US')} shares are on the market.`);
  const price = executionPrice(c, n);
  const cost = buyCost(c, n);
  // After buying, the position is worth n × market price; equity changes by n·p − cost.
  if (!canBuy(ch, companies, c, n)) return no('Not enough cash or margin for that many shares.');
  ch.cash -= cost;
  c.transferShares('public', PLAYER, n);
  applyImpact(c, n);
  return { ok: true, shares: n, price, cash: -cost };
}

export function sellShares(ch: Chairman, c: Company, n: number): TradeResult {
  n = Math.floor(n);
  if (n <= 0) return no('Choose how many shares.');
  if (c.holding(PLAYER) < n) return no('You do not own that many shares.');
  const price = executionPrice(c, -n);
  const proceeds = n * price * (1 - M.commission);
  ch.cash += proceeds;
  c.transferShares(PLAYER, 'public', n);
  applyImpact(c, -n);
  return { ok: true, shares: n, price, cash: proceeds };
}

/** Borrow shares and sell them; profit if the price falls. */
export function shortShares(ch: Chairman, companies: readonly Company[], c: Company, n: number): TradeResult {
  n = Math.floor(n);
  if (n <= 0) return no('Choose how many shares.');
  if (c.holding('public') < n + ch.short(c.id)) return no('Not enough shares available to borrow.');
  const price = executionPrice(c, -n);
  const proceeds = n * price * (1 - M.commission);
  if (!meetsInitialMargin(ch, companies, proceeds, n * c.stock.price, -n * c.stock.price)) return no('Not enough equity to cover the margin on that short.');
  ch.cash += proceeds;
  ch.shorts.set(c.id, ch.short(c.id) + n);
  applyImpact(c, -n);
  return { ok: true, shares: n, price, cash: proceeds };
}

/** Buy back shorted shares. */
export function coverShort(ch: Chairman, c: Company, n: number): TradeResult {
  n = Math.floor(Math.min(n, ch.short(c.id)));
  if (n <= 0) return no('No short position to cover.');
  const price = executionPrice(c, n);
  const cost = n * price * (1 + M.commission);
  ch.cash -= cost;
  ch.shorts.set(c.id, ch.short(c.id) - n);
  if (ch.short(c.id) === 0) ch.shorts.delete(c.id);
  applyImpact(c, n);
  return { ok: true, shares: n, price, cash: -cost };
}

export interface MarginCall {
  sold: Array<{ company: Company; shares: number; side: 'long' | 'short' }>;
  equity: number;
}

/**
 * Margin call: below maintenance margin, positions are closed (biggest first) until the
 * account meets initial margin again or nothing is left.
 */
export function enforceMargin(ch: Chairman, companies: readonly Company[]): MarginCall | null {
  let acc = account(ch, companies);
  if (acc.gross <= 0 || acc.equity >= M.maintenance * acc.gross) return null;
  const sold: MarginCall['sold'] = [];
  for (let guard = 0; guard < 50 && acc.gross > 0 && acc.equity < M.initial * acc.gross; guard++) {
    const biggest = [...acc.positions].sort((a, b) => (b.long + b.short) * b.company.stock.price - (a.long + a.short) * a.company.stock.price)[0];
    if (!biggest) break;
    const c = biggest.company;
    // Close a quarter of the position (at least one lot) per round.
    if (biggest.short > 0) {
      const n = Math.max(Math.min(biggest.short, 1000), Math.ceil(biggest.short / 4));
      coverShort(ch, c, n);
      sold.push({ company: c, shares: n, side: 'short' });
    } else {
      const n = Math.max(Math.min(biggest.long, 1000), Math.ceil(biggest.long / 4));
      sellShares(ch, c, n);
      sold.push({ company: c, shares: n, side: 'long' });
    }
    acc = account(ch, companies);
  }
  return { sold, equity: acc.equity };
}

/** Monthly interest on a margin loan. Returns the interest charged. */
export function chargeMarginInterest(ch: Chairman, baseRate: number): number {
  if (ch.cash >= 0) return 0;
  const interest = (-ch.cash * (baseRate + M.interestSpread)) / 12;
  ch.cash -= interest;
  return interest;
}
