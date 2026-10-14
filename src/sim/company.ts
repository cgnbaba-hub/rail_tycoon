import { COMPANY } from '../data';

export type ExpenseCategory =
  | 'track'
  | 'stations'
  | 'bridges'
  | 'tunnels'
  | 'demolition'
  | 'trains'
  | 'fuel'
  | 'maintenance'
  | 'repairs'
  | 'trackMaintenance'
  | 'improvementUpkeep'
  | 'improvements'
  | 'industries'
  | 'refunds';

export const EXPENSE_LABELS: Record<ExpenseCategory, string> = {
  track: 'Track construction',
  stations: 'Stations',
  bridges: 'Bridges',
  tunnels: 'Tunnels',
  demolition: 'Demolition',
  trains: 'Rolling stock',
  fuel: 'Fuel',
  maintenance: 'Engine maintenance',
  repairs: 'Breakdown repairs',
  trackMaintenance: 'Track & station upkeep',
  improvementUpkeep: 'Improvement upkeep',
  improvements: 'Station improvements',
  industries: 'Industry purchases',
  refunds: 'Undo refunds',
};

/** Capital spending (not part of operating profit). */
export const CAPITAL_CATEGORIES: ReadonlySet<ExpenseCategory> = new Set(['track', 'stations', 'bridges', 'tunnels', 'demolition', 'trains', 'improvements', 'industries', 'refunds']);

/**
 * The player's railroad company. Until M5 adds shares and bonds this tracks cash, a ledger
 * of spending by category and revenue by cargo, per year.
 */
export class Company {
  name: string;
  cash: number;
  /** year → category → amount spent (refunds are negative). */
  readonly ledger = new Map<number, Map<ExpenseCategory, number>>();
  /** year → cargo id → revenue. */
  readonly revenue = new Map<number, Map<string, number>>();
  /** year → other income (e.g. 'industries') → amount. */
  readonly income = new Map<number, Map<string, number>>();

  constructor(name: string, cash = COMPANY.startingCash) {
    this.name = name;
    this.cash = cash;
  }

  canAfford(amount: number): boolean {
    return amount <= this.cash;
  }

  /** Record spending. Negative amounts are refunds. */
  spend(year: number, category: ExpenseCategory, amount: number): void {
    this.cash -= amount;
    let y = this.ledger.get(year);
    if (!y) {
      y = new Map();
      this.ledger.set(year, y);
    }
    y.set(category, (y.get(category) ?? 0) + amount);
  }

  earn(year: number, cargo: string, amount: number): void {
    this.cash += amount;
    let y = this.revenue.get(year);
    if (!y) {
      y = new Map();
      this.revenue.set(year, y);
    }
    y.set(cargo, (y.get(cargo) ?? 0) + amount);
  }

  /** Non-freight income such as profits from owned industries. */
  earnOther(year: number, category: string, amount: number): void {
    this.cash += amount;
    let y = this.income.get(year);
    if (!y) {
      y = new Map();
      this.income.set(year, y);
    }
    y.set(category, (y.get(category) ?? 0) + amount);
  }

  otherIncomeIn(year: number): number {
    let s = 0;
    for (const v of this.income.get(year)?.values() ?? []) s += v;
    return s;
  }

  spentIn(year: number, category: ExpenseCategory): number {
    return this.ledger.get(year)?.get(category) ?? 0;
  }

  revenueIn(year: number): number {
    let s = 0;
    for (const v of this.revenue.get(year)?.values() ?? []) s += v;
    return s;
  }

  operatingCostsIn(year: number): number {
    let s = 0;
    for (const [cat, v] of this.ledger.get(year) ?? []) if (!CAPITAL_CATEGORIES.has(cat)) s += v;
    return s;
  }
}
