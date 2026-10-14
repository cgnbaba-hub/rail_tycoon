import { FINANCE, type RatingDef } from '../data';
import type { Company } from './company';
import type { Rng } from './rng';

const ST = FINANCE.stock;
const BD = FINANCE.bonds;
const SH = FINANCE.shares;

/** What the market knows each day. */
export interface MarketContext {
  day: number;
  year: number;
  /** Economic cycle state id. */
  state: string;
  /** Business confidence 0–100 (leading indicator). */
  confidence: number;
}

// ---------------------------------------------------------------------------------------
// Balance sheet & valuation
// ---------------------------------------------------------------------------------------

export interface BalanceSheet {
  cash: number;
  rollingStock: number;
  infrastructure: number;
  industries: number;
  totalAssets: number;
  debt: number;
  bookValue: number;
}

export function balanceSheet(c: Company, rollingStock: number): BalanceSheet {
  const industries = [...c.industryCost.values()].reduce((a, b) => a + b, 0);
  // An overdraft counts as a liability, not negative assets.
  const cash = Math.max(0, c.cash);
  const overdraft = Math.max(0, -c.cash);
  const totalAssets = cash + rollingStock + c.infrastructure + industries;
  const debt = c.debt + overdraft;
  return { cash: c.cash, rollingStock, infrastructure: c.infrastructure, industries, totalAssets, debt, bookValue: totalAssets - debt };
}

export interface FairValue {
  /** Components in dollars (whole company). */
  book: number;
  earnings: number;
  dividends: number;
  pe: number;
  mood: number;
  total: number;
  perShare: number;
}

/** Market mood from business confidence: the stock market looks ahead of the economy. */
export function marketMood(confidence: number): number {
  return 1 + (confidence - 55) * ST.moodPerConfidence;
}

/**
 * What investors think the company is worth:
 *   (bookWeight·book + P/E·profit (losses at lossWeight) + dividendMultiple·dividends) × mood
 */
export function fairValue(c: Company, bookValue: number, ctx: Pick<MarketContext, 'state' | 'confidence'>): FairValue {
  const pe = ST.peByState[ctx.state] ?? 10;
  const book = ST.bookWeight * bookValue;
  const earnings = c.profitTrend >= 0 ? pe * c.profitTrend : ST.lossWeight * pe * c.profitTrend;
  const dividends = ST.dividendMultiple * c.trailingDividend * c.shares;
  const mood = marketMood(ctx.confidence);
  const total = (book + earnings + dividends) * mood;
  return { book, earnings, dividends, pe, mood, total, perShare: Math.max(ST.minPrice, total / Math.max(1, c.shares)) };
}

/** Move the price by the market impact of trading `n` shares (+ buying, − selling). */
export function applyImpact(c: Company, n: number): number {
  const before = c.stock.price;
  c.stock.price = Math.max(ST.minPrice, before * (1 + (SH.impact * n) / Math.max(1, c.shares)));
  c.stock.volume += Math.abs(n);
  return c.stock.price / before - 1;
}

/** Average execution price for trading `n` shares now (half the impact). */
export function executionPrice(c: Company, n: number): number {
  return c.stock.price * (1 + (SH.impact * n) / (2 * Math.max(1, c.shares)));
}

/** Daily price step towards fair value with noise; records history. */
export function stockDaily(c: Company, fair: number, ctx: MarketContext, rng: Rng): void {
  const s = c.stock;
  const noise = gaussian(rng) * ST.volatility;
  const p = s.price + (fair - s.price) * ST.reversion + s.price * noise;
  s.price = Math.max(ST.minPrice, p);
  // Background trading volume: a fraction of a percent of the shares, more on big moves.
  const move = Math.abs(s.price / Math.max(ST.minPrice, s.open) - 1);
  s.volume += Math.round(c.shares * (0.002 + move * 0.2) * (0.5 + rng.next()));
  s.daily.push({ day: ctx.day, price: s.price, volume: s.volume });
  if (s.daily.length > ST.dailyHistory) s.daily.shift();
  if (ctx.day % 7 === 0) {
    const week = s.daily.slice(-7);
    s.weekly.push({ day: ctx.day, price: s.price, volume: week.reduce((a, b) => a + b.volume, 0) });
    if (s.weekly.length > ST.weeklyHistory) s.weekly.shift();
  }
  s.open = s.price;
  s.volume = 0;
}

function gaussian(rng: Rng): number {
  // Irwin–Hall approximation: deterministic and cheap.
  let s = 0;
  for (let i = 0; i < 4; i++) s += rng.next();
  return (s - 2) * Math.sqrt(3);
}

// ---------------------------------------------------------------------------------------
// Credit
// ---------------------------------------------------------------------------------------

export interface CreditRating {
  index: number;
  def: RatingDef;
  leverage: number;
  /** Profit before interest / interest (Infinity without debt). */
  coverage: number;
}

export function creditRating(debt: number, totalAssets: number, profitTrend: number, annualInterest: number): CreditRating {
  const leverage = debt / Math.max(1, totalAssets);
  let index = BD.ratings.findIndex((r) => leverage <= r.maxLeverage);
  if (index < 0) index = BD.ratings.length - 1;
  const coverage = annualInterest > 0 ? (profitTrend + annualInterest) / annualInterest : Infinity;
  if (annualInterest > 0) {
    for (const [below, notches] of BD.coverageNotches) {
      if (coverage < below) {
        index += notches;
        break;
      }
    }
  }
  index = Math.min(BD.ratings.length - 1, index);
  return { index, def: BD.ratings[index], leverage, coverage };
}

export function baseRate(state: string): number {
  return BD.baseRate[state] ?? 0.05;
}

export function bondRate(rating: CreditRating, state: string): number {
  return baseRate(state) + rating.def.spread;
}

// ---------------------------------------------------------------------------------------
// Monthly / quarterly / yearly
// ---------------------------------------------------------------------------------------

/** Close the month's books: smooth profit for investors, pay bond interest. Returns interest paid. */
export function closeMonth(c: Company, year: number): number {
  const interest = c.annualInterest / 12;
  if (interest > 0) c.spend(year, 'interest', interest);
  c.monthlyNet.push(c.monthNet);
  if (c.monthlyNet.length > 24) c.monthlyNet.shift();
  c.profitTrend += ST.profitSmoothing * (c.monthNet * 12 - c.profitTrend);
  c.monthNet = 0;
  return interest;
}

/** Shares per block for issues and buybacks. */
export function blockSize(c: Company): number {
  return Math.max(SH.roundLot, Math.round((c.shares * SH.blockFraction) / SH.roundLot) * SH.roundLot);
}

/** Pay the quarterly dividend. Returns the amount per share paid (0 if skipped). */
export function payDividend(c: Company, year: number, pay: (holder: string, amount: number) => void): { perShare: number; skipped: boolean } {
  const perShare = c.dividendPerShare / FINANCE.dividends.months.length;
  let paid = 0;
  let skipped = false;
  if (perShare > 0) {
    const total = perShare * c.shares;
    if (c.cash >= total) {
      c.finance(year, 'dividends', -total);
      for (const [holder, n] of c.holders) if (n > 0) pay(holder, n * perShare);
      paid = perShare;
    } else skipped = true;
  }
  c.dividendsPaid.push(paid);
  while (c.dividendsPaid.length > FINANCE.dividends.months.length) c.dividendsPaid.shift();
  return { perShare: paid, skipped };
}

// ---------------------------------------------------------------------------------------
// Share capital
// ---------------------------------------------------------------------------------------

export interface ShareAction {
  ok: boolean;
  error?: string;
  shares: number;
  /** Cash to (+) or from (−) the company. */
  cash: number;
  /** Relative price effect of the trade itself. */
  effect: number;
}

const fail = (error: string): ShareAction => ({ ok: false, error, shares: 0, cash: 0, effect: 0 });

export function issueBlocked(c: Company, day: number): string | null {
  const months = (day - c.lastIssueDay) / (365 / 12);
  if (months < SH.minMonthsBetweenIssues) return `Investors won't take new shares again so soon (wait ${Math.ceil(SH.minMonthsBetweenIssues - months)} months).`;
  return null;
}

/** Sell a block of new shares to the public at a discount. */
export function issueShares(c: Company, ctx: MarketContext): ShareAction {
  const blocked = issueBlocked(c, ctx.day);
  if (blocked) return fail(blocked);
  const n = blockSize(c);
  const proceeds = Math.round(n * c.stock.price * (1 - SH.issueDiscount));
  c.shares += n;
  c.holders.set('public', c.holding('public') + n);
  c.finance(ctx.year, 'sharesIssued', proceeds);
  c.lastIssueDay = ctx.day;
  const effect = applyImpact(c, -n);
  c.note(ctx.day, `Issued ${n.toLocaleString('en-US')} new shares`, effect);
  return { ok: true, shares: n, cash: proceeds, effect };
}

/** Buy back up to a block of shares from the public at a premium and retire them. */
export function buybackShares(c: Company, ctx: MarketContext): ShareAction {
  const n = Math.min(blockSize(c), Math.floor(c.holding('public') / SH.roundLot) * SH.roundLot);
  if (n <= 0) return fail('No shares left in public hands.');
  const cost = Math.round(n * c.stock.price * (1 + SH.buybackPremium));
  if (c.cash < cost) return fail('Not enough cash.');
  c.holders.set('public', c.holding('public') - n);
  c.shares -= n;
  c.finance(ctx.year, 'buybacks', -cost);
  const effect = applyImpact(c, n);
  c.note(ctx.day, `Bought back ${n.toLocaleString('en-US')} shares`, effect);
  return { ok: true, shares: n, cash: -cost, effect };
}

/** 2-for-1 split: twice the shares at half the price; history is adjusted. */
export function splitStock(c: Company, ctx: MarketContext): ShareAction {
  if (c.stock.price < SH.splitMinPrice) return fail(`Splits need a share price of at least $${SH.splitMinPrice}.`);
  c.shares *= 2;
  for (const [h, n] of c.holders) c.holders.set(h, n * 2);
  const s = c.stock;
  s.price /= 2;
  s.open /= 2;
  s.monthOpen /= 2;
  s.yearOpen /= 2;
  for (const p of [...s.daily, ...s.weekly]) p.price /= 2;
  c.dividendPerShare /= 2;
  for (let i = 0; i < c.dividendsPaid.length; i++) c.dividendsPaid[i] /= 2;
  c.note(ctx.day, '2-for-1 stock split (history adjusted)', 0);
  return { ok: true, shares: c.shares / 2, cash: 0, effect: 0 };
}
