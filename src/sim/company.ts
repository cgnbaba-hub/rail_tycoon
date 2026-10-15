import { FINANCE } from '../data';

export type ExpenseCategory =
  | 'track'
  | 'stations'
  | 'bridges'
  | 'tunnels'
  | 'demolition'
  | 'bulldozing'
  | 'trains'
  | 'fuel'
  | 'maintenance'
  | 'repairs'
  | 'trackMaintenance'
  | 'improvementUpkeep'
  | 'salary'
  | 'charters'
  | 'improvements'
  | 'industries'
  | 'refunds'
  | 'interest'
  | 'depreciation'
  | 'writeOffs';

export const EXPENSE_LABELS: Record<ExpenseCategory, string> = {
  track: 'Track construction',
  stations: 'Stations',
  bridges: 'Bridges',
  tunnels: 'Tunnels',
  demolition: 'Demolition',
  bulldozing: 'Bulldozing',
  trains: 'Rolling stock',
  fuel: 'Fuel',
  maintenance: 'Engine maintenance',
  repairs: 'Breakdown repairs',
  trackMaintenance: 'Track & station upkeep',
  improvementUpkeep: 'Improvement upkeep',
  salary: 'Salaries (chairman & manager)',
  charters: 'Charters',
  improvements: 'Station improvements',
  industries: 'Industry purchases',
  refunds: 'Undo refunds',
  interest: 'Bond interest',
  depreciation: 'Depreciation',
  writeOffs: 'Write-offs (bulldozed)',
};

/** Capital spending (not part of operating profit). */
export const CAPITAL_CATEGORIES: ReadonlySet<ExpenseCategory> = new Set(['track', 'stations', 'bridges', 'tunnels', 'demolition', 'trains', 'improvements', 'industries', 'refunds']);
/** Capital spending carried as infrastructure on the balance sheet. */
export const INFRASTRUCTURE_CATEGORIES: ReadonlySet<ExpenseCategory> = new Set(['track', 'stations', 'bridges', 'tunnels', 'demolition', 'improvements']);
/** Charges below the operating line. */
export const NON_OPERATING: ReadonlySet<ExpenseCategory> = new Set(['interest', 'depreciation', 'writeOffs']);
/** Non-cash charges (book only). */
const NON_CASH: ReadonlySet<ExpenseCategory> = new Set(['depreciation', 'writeOffs']);

export type FinancingCategory = 'sharesIssued' | 'buybacks' | 'bondsIssued' | 'bondsRepaid' | 'dividends';

export const FINANCING_LABELS: Record<FinancingCategory, string> = {
  sharesIssued: 'Shares issued',
  buybacks: 'Share buybacks',
  bondsIssued: 'Bonds issued',
  bondsRepaid: 'Bonds repaid',
  dividends: 'Dividends paid',
};

export interface Bond {
  id: number;
  principal: number;
  /** Annual interest rate (fixed at issue). */
  rate: number;
  issuedDay: number;
  maturityYear: number;
  emergency?: boolean;
}

export interface PricePoint {
  day: number;
  price: number;
  volume: number;
}

/** A dated note on something that moved the share price (shown under the chart). */
export interface StockNote {
  day: number;
  text: string;
  /** Relative price effect when known (e.g. -0.06), else 0. */
  effect: number;
}

export interface StockState {
  price: number;
  /** Price at the start of the current day / month / year. */
  open: number;
  monthOpen: number;
  yearOpen: number;
  /** Shares traded today. */
  volume: number;
  daily: PricePoint[];
  weekly: PricePoint[];
  notes: StockNote[];
}

/** Year-end snapshot for reports and graphs. */
export interface YearRecord {
  year: number;
  revenue: number;
  operatingCosts: number;
  netProfit: number;
  bookValue: number;
  price: number;
  shares: number;
  debt: number;
  dividendsPerShare: number;
}

/**
 * A railroad company: cash and books, share register, bonds and its stock. The ledger keeps
 * spending by category, revenue by cargo and financing flows per year.
 */
export class Company {
  readonly id: number;
  name: string;
  ticker: string;
  cash: number;
  /** Hired manager (id from managers.json) or null. */
  manager: string | null = null;
  /** Holder key of the chairman (the baron who runs it). */
  chairman: string;
  /** Company colour (palette name) for the map and charts. */
  color: string;
  /** Set when the company has been merged away or went bankrupt. */
  defunct: false | 'merged' | 'bankrupt' = false;
  /** Consecutive month-ends with negative cash and debts above assets. */
  insolventMonths = 0;
  /** Lost board votes in a row. */
  boardStrikes = 0;
  /** Acquirer company id → day before which it may not call another merger vote. */
  readonly mergerCooldown = new Map<number, number>();
  /** year → category → amount spent (refunds are negative). */
  readonly ledger = new Map<number, Map<ExpenseCategory, number>>();
  /** year → cargo id → revenue. */
  readonly revenue = new Map<number, Map<string, number>>();
  /** year → other income (e.g. 'industries') → amount. */
  readonly income = new Map<number, Map<string, number>>();
  /** year → financing flow → cash in (+) / out (−). */
  readonly financing = new Map<number, Map<FinancingCategory, number>>();

  /** Infrastructure at book value (cost less depreciation and write-offs). */
  infrastructure = 0;
  /** Purchase cost of industries owned. */
  industryCost = new Map<number, number>();

  /** Share register: holder ('player', 'public', later rivals) → shares. */
  readonly holders = new Map<string, number>();
  shares: number;
  /** Annual dividend per share declared by the board. */
  dividendPerShare = 0;
  /** Dividends per share actually paid in the last four quarters (newest last). */
  readonly dividendsPaid: number[] = [];
  lastIssueDay = -Infinity;

  readonly bonds: Bond[] = [];
  private nextBondId = 1;

  /** Net profit this month (accumulates, reset monthly). */
  monthNet = 0;
  /** Exponentially smoothed annualised net profit (what investors price in). */
  profitTrend = 0;
  /** Net profit per month, newest last (up to 24). */
  readonly monthlyNet: number[] = [];
  /** Loads delivered per cargo since founding. */
  readonly delivered = new Map<string, number>();
  /** Revenue by cargo since the statistics last sampled it (see stats.ts). */
  readonly sampleRevenue = new Map<string, number>();

  readonly stock: StockState;
  readonly history: YearRecord[] = [];

  constructor(id: number, name: string, ticker: string, cash: number, shares: number, price: number, chairman = 'player', color = 'gold') {
    this.id = id;
    this.name = name;
    this.ticker = ticker;
    this.cash = cash;
    this.chairman = chairman;
    this.color = color;
    this.shares = shares;
    this.holders.set('public', shares);
    this.stock = { price, open: price, monthOpen: price, yearOpen: price, volume: 0, daily: [], weekly: [], notes: [] };
  }

  /** Founding: sell `initial` shares at the IPO price; a stake of them goes to the chairman. */
  static found(id: number, name: string, chairman = 'player', color = 'gold', ticker = tickerFor(name)): Company {
    const S = FINANCE.shares;
    const c = new Company(id, name, ticker, S.initial * S.ipoPrice, S.initial, S.ipoPrice, chairman, color);
    c.transferShares('public', chairman, Math.round(S.initial * S.chairmanFraction));
    return c;
  }

  holding(holder: string): number {
    return this.holders.get(holder) ?? 0;
  }

  transferShares(from: string, to: string, n: number): void {
    if (n <= 0) return;
    if (this.holding(from) < n) throw new Error(`${from} holds only ${this.holding(from)} shares`);
    this.holders.set(from, this.holding(from) - n);
    this.holders.set(to, this.holding(to) + n);
  }

  canAfford(amount: number): boolean {
    return amount <= this.cash;
  }

  private bucket<K>(m: Map<number, Map<K, number>>, year: number): Map<K, number> {
    let y = m.get(year);
    if (!y) {
      y = new Map();
      m.set(year, y);
    }
    return y;
  }

  /** Record spending. Negative amounts are refunds. */
  spend(year: number, category: ExpenseCategory, amount: number): void {
    if (!NON_CASH.has(category)) this.cash -= amount;
    const y = this.bucket(this.ledger, year);
    y.set(category, (y.get(category) ?? 0) + amount);
    if (INFRASTRUCTURE_CATEGORIES.has(category)) this.infrastructure = Math.max(0, this.infrastructure + amount);
    // One-off write-offs are reported but not extrapolated by investors.
    if (!CAPITAL_CATEGORIES.has(category) && category !== 'writeOffs') this.monthNet -= amount;
  }

  earn(year: number, cargo: string, amount: number): void {
    this.cash += amount;
    const y = this.bucket(this.revenue, year);
    y.set(cargo, (y.get(cargo) ?? 0) + amount);
    this.monthNet += amount;
    this.sampleRevenue.set(cargo, (this.sampleRevenue.get(cargo) ?? 0) + amount);
  }

  /** Non-freight income such as profits from owned industries. */
  earnOther(year: number, category: string, amount: number): void {
    this.cash += amount;
    const y = this.bucket(this.income, year);
    y.set(category, (y.get(category) ?? 0) + amount);
    this.monthNet += amount;
  }

  /** Financing cash flow (+ in, − out). Not part of profit. */
  finance(year: number, category: FinancingCategory, amount: number): void {
    this.cash += amount;
    const y = this.bucket(this.financing, year);
    y.set(category, (y.get(category) ?? 0) + amount);
  }

  /** Non-cash book charges: depreciation, write-offs (negative = write back on undo). */
  writeDown(year: number, category: 'depreciation' | 'writeOffs', amount: number): void {
    const a = Math.min(amount, this.infrastructure);
    this.infrastructure -= a;
    this.spend(year, category, a);
  }

  otherIncomeIn(year: number): number {
    let s = 0;
    for (const v of this.income.get(year)?.values() ?? []) s += v;
    return s;
  }

  spentIn(year: number, category: ExpenseCategory): number {
    return this.ledger.get(year)?.get(category) ?? 0;
  }

  financingIn(year: number, category: FinancingCategory): number {
    return this.financing.get(year)?.get(category) ?? 0;
  }

  revenueIn(year: number): number {
    let s = 0;
    for (const v of this.revenue.get(year)?.values() ?? []) s += v;
    return s;
  }

  /** Cash operating costs (excludes capital, interest and book charges). */
  operatingCostsIn(year: number): number {
    let s = 0;
    for (const [cat, v] of this.ledger.get(year) ?? []) if (!CAPITAL_CATEGORIES.has(cat) && !NON_OPERATING.has(cat)) s += v;
    return s;
  }

  operatingProfitIn(year: number): number {
    return this.revenueIn(year) + this.otherIncomeIn(year) - this.operatingCostsIn(year);
  }

  netProfitIn(year: number): number {
    let below = 0;
    for (const cat of NON_OPERATING) below += this.spentIn(year, cat);
    return this.operatingProfitIn(year) - below;
  }

  // -- bonds --------------------------------------------------------------------------------

  get debt(): number {
    return this.bonds.reduce((a, b) => a + b.principal, 0);
  }

  /** Annual interest on all bonds. */
  get annualInterest(): number {
    return this.bonds.reduce((a, b) => a + b.principal * b.rate, 0);
  }

  addBond(year: number, day: number, principal: number, rate: number, emergency = false): Bond {
    const bond: Bond = { id: this.nextBondId++, principal, rate, issuedDay: day, maturityYear: year + FINANCE.bonds.termYears, emergency };
    this.bonds.push(bond);
    this.finance(year, 'bondsIssued', principal);
    return bond;
  }

  removeBond(year: number, id: number): Bond | undefined {
    const i = this.bonds.findIndex((b) => b.id === id);
    if (i < 0) return undefined;
    const [bond] = this.bonds.splice(i, 1);
    this.finance(year, 'bondsRepaid', -bond.principal);
    return bond;
  }

  // -- stock ---------------------------------------------------------------------------------

  note(day: number, text: string, effect = 0): void {
    this.stock.notes.push({ day, text, effect });
    if (this.stock.notes.length > 30) this.stock.notes.shift();
  }

  /** Annual dividends per share paid over the last four quarters. */
  get trailingDividend(): number {
    return this.dividendsPaid.reduce((a, b) => a + b, 0);
  }
}

/** Three-letter ticker from the company name's initials. */
export function tickerFor(name: string): string {
  const words = name
    .replace(/[^A-Za-z ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 || /^[A-Z]/.test(w))
    .filter((w) => !['and', 'the', 'of', 'Co'].includes(w));
  const t = words.map((w) => w[0].toUpperCase()).join('');
  return (t.length >= 2 ? t : name.replace(/[^A-Za-z]/g, '').toUpperCase()).slice(0, 4);
}
