import type { Game } from './game';

/**
 * Monthly statistics for the graphs: revenue by cargo and profit per company, share prices,
 * market and book values, everyone's net worth, and the month's profit of every train and
 * revenue of every station. One sample per month, kept for 20 years.
 */

export interface CompanySample {
  id: number;
  /** Revenue by cargo this month. */
  revenue: Record<string, number>;
  /** Net profit this month. */
  net: number;
  price: number;
  marketCap: number;
  bookValue: number;
}

export interface MonthSample {
  /** Game day of the sample (the first of the following month). */
  day: number;
  /** Year and month (0–11) the sample covers. */
  year: number;
  month: number;
  companies: CompanySample[];
  /** Investor key → net worth. */
  worth: Record<string, number>;
  /** Train id → net profit this month. */
  trains: Record<number, number>;
  /** Station id → revenue this month. */
  stations: Record<number, number>;
}

export const MAX_SAMPLES = 240;

export class Statistics {
  readonly samples: MonthSample[] = [];

  /** Record the month that just ended (call once per month, after the month's bookkeeping). */
  sample(game: Game): void {
    const ended = game.day - 1;
    const date = game.dateOf(ended);
    const companies: CompanySample[] = [];
    for (const c of game.activeCompanies) {
      const revenue: Record<string, number> = {};
      for (const [cargo, v] of c.sampleRevenue) revenue[cargo] = Math.round(v);
      c.sampleRevenue.clear();
      companies.push({
        id: c.id,
        revenue,
        net: Math.round(c.monthlyNet[c.monthlyNet.length - 1] ?? 0),
        price: Math.round(c.stock.price * 100) / 100,
        marketCap: Math.round(c.stock.price * c.shares),
        bookValue: Math.round(game.balance(c).bookValue),
      });
    }
    const worth: Record<string, number> = {};
    for (const inv of game.investors) worth[inv.key] = Math.round(game.netWorth(inv));
    const trains: Record<number, number> = {};
    for (const t of game.trains.trains) trains[t.id] = Math.round(t.stats.months[t.stats.months.length - 1] ?? 0);
    const stations: Record<number, number> = {};
    for (const st of game.world.liveStations()) {
      const sc = game.economy.cargoAt(st.id);
      stations[st.id] = Math.round(sc.revenueSample);
      sc.revenueSample = 0;
    }
    this.samples.push({ day: game.day, year: date.year, month: date.month, companies, worth, trains, stations });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** One value per sample (missing → null), e.g. a company's price or a train's profit. */
  series(pick: (s: MonthSample) => number | undefined): Array<number | null> {
    return this.samples.map((s) => {
      const v = pick(s);
      return v === undefined ? null : v;
    });
  }
}
