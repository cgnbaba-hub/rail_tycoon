import { COMPANY } from '../data';

export type ExpenseCategory = 'track' | 'stations' | 'bridges' | 'tunnels' | 'demolition' | 'refunds';

export const EXPENSE_LABELS: Record<ExpenseCategory, string> = {
  track: 'Track construction',
  stations: 'Stations',
  bridges: 'Bridges',
  tunnels: 'Tunnels',
  demolition: 'Demolition',
  refunds: 'Undo refunds',
};

/**
 * The player's railroad company. M2 only tracks cash and a construction ledger; the full
 * books (revenue, shares, bonds) arrive in M5.
 */
export class Company {
  name: string;
  cash: number;
  /** year → category → amount spent (refunds are negative). */
  readonly ledger = new Map<number, Map<ExpenseCategory, number>>();

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

  spentIn(year: number, category: ExpenseCategory): number {
    return this.ledger.get(year)?.get(category) ?? 0;
  }
}
