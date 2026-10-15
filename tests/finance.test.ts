import { describe, expect, it } from 'vitest';
import { FINANCE, TIME } from '../src/data';
import { PLAYER, account, liquidationPrice } from '../src/sim/chairman';
import { Company } from '../src/sim/company';
import { defaultTrackOptions } from '../src/sim/construction';
import { applyImpact, creditRating, fairValue, stockDaily } from '../src/sim/finance';
import { Game } from '../src/sim/game';
import { defaultMapParams } from '../src/sim/mapgen';
import { Rng } from '../src/sim/rng';
import { addTown, flatWorld } from './helpers';

const DAY = TIME.ticksPerDay;
const S = FINANCE.shares;

function run(g: Game, days: number): void {
  for (let i = 0; i < days * DAY; i++) g.step();
}

function game(): Game {
  const w = flatWorld(48);
  addTown(w, 'Westford', 4, 16, 6000);
  addTown(w, 'Eastburg', 40, 16, 6000);
  return new Game({ ...defaultMapParams(1), size: w.width }, w, { wrecks: false });
}

const normal = { state: 'normal', confidence: 55 };

describe('founding', () => {
  it('raises the starting capital from a share issue with the chairman holding a stake', () => {
    const g = game();
    const c = g.company;
    expect(c.shares).toBe(S.initial);
    expect(c.cash).toBe(S.initial * S.ipoPrice);
    expect(c.holding(PLAYER)).toBe(S.initial * S.chairmanFraction);
    expect(c.holding('public') + c.holding(PLAYER)).toBe(c.shares);
    expect(g.chairman.cash).toBe(S.chairmanFortune - S.initial * S.chairmanFraction * S.ipoPrice);
    expect(g.netWorth()).toBeCloseTo(S.chairmanFortune, 6);
    expect(c.ticker.length).toBeGreaterThanOrEqual(2);
  });
});

describe('stock valuation', () => {
  const c = () => new Company(1, 'Test Rail', 'TR', 1_000_000, 100_000, 10);

  it('rises with profits, book value and dividends', () => {
    const a = c();
    const base = fairValue(a, 1_000_000, normal).perShare;
    expect(base).toBeCloseTo(10, 6);
    a.profitTrend = 200_000;
    const profitable = fairValue(a, 1_000_000, normal).perShare;
    expect(profitable).toBeGreaterThan(base);
    expect(fairValue(a, 1_500_000, normal).perShare).toBeGreaterThan(profitable);
    a.dividendsPaid.push(0.25, 0.25, 0.25, 0.25);
    expect(fairValue(a, 1_000_000, normal).perShare).toBeGreaterThan(profitable);
  });

  it('falls with losses and in a bad economy; confidence leads', () => {
    const a = c();
    a.profitTrend = 100_000;
    const ok = fairValue(a, 1_000_000, normal).perShare;
    expect(fairValue(a, 1_000_000, { state: 'recession', confidence: 35 }).perShare).toBeLessThan(ok);
    expect(fairValue(a, 1_000_000, { state: 'panic', confidence: 15 }).perShare).toBeLessThan(fairValue(a, 1_000_000, { state: 'recession', confidence: 35 }).perShare);
    // Same state, falling confidence → lower price before the economy turns.
    expect(fairValue(a, 1_000_000, { state: 'normal', confidence: 40 }).perShare).toBeLessThan(ok);
    a.profitTrend = -100_000;
    expect(fairValue(a, 1_000_000, normal).perShare).toBeLessThan(10);
  });

  it('converges towards fair value and trading moves the price', () => {
    const a = c();
    const rng = new Rng(3);
    for (let d = 0; d < 200; d++) stockDaily(a, 20, { ...normal, day: d, year: 1850 }, rng);
    expect(a.stock.price).toBeGreaterThan(16);
    expect(a.stock.price).toBeLessThan(24);
    expect(a.stock.daily.length).toBe(FINANCE.stock.dailyHistory);
    expect(a.stock.weekly.length).toBeGreaterThan(25);
    const p = a.stock.price;
    expect(applyImpact(a, 10_000)).toBeGreaterThan(0);
    expect(a.stock.price).toBeGreaterThan(p);
    expect(applyImpact(a, -20_000)).toBeLessThan(0);
  });

  it('is deterministic', () => {
    const series = () => {
      const g = game();
      run(g, 120);
      return g.company.stock.daily.map((p) => p.price.toFixed(6)).join(',');
    };
    expect(series()).toBe(series());
  });
});

describe('share capital', () => {
  it('issuing shares raises cash, dilutes and lowers the price; not again for months', () => {
    const g = game();
    const c = g.company;
    const price = c.stock.price;
    const cash = c.cash;
    const r = g.issueShares();
    expect(r.ok).toBe(true);
    expect(r.effect).toBeLessThan(0);
    expect(c.stock.price).toBeLessThan(price);
    expect(c.shares).toBe(S.initial + r.shares);
    expect(c.cash).toBeCloseTo(cash + r.cash, 6);
    expect(r.cash).toBeLessThan(r.shares * price);
    expect(g.issueShares().ok).toBe(false);
    run(g, 200);
    expect(g.issueShares().ok).toBe(true);
  });

  it('buybacks retire shares and lift the price', () => {
    const g = game();
    const c = g.company;
    const price = c.stock.price;
    const r = g.buybackShares();
    expect(r.ok).toBe(true);
    expect(c.shares).toBe(S.initial - r.shares);
    expect(c.stock.price).toBeGreaterThan(price);
    expect(c.holding('public') + c.holding(PLAYER)).toBe(c.shares);
  });

  it('splits 2-for-1 only at high prices', () => {
    const g = game();
    const c = g.company;
    expect(g.splitStock().ok).toBe(false);
    c.stock.price = 80;
    const mine = c.holding(PLAYER);
    expect(g.splitStock().ok).toBe(true);
    expect(c.stock.price).toBe(40);
    expect(c.shares).toBe(S.initial * 2);
    expect(c.holding(PLAYER)).toBe(mine * 2);
  });

  it('pays dividends quarterly to shareholders, skipping them when broke', () => {
    const g = game();
    const c = g.company;
    g.setDividend(0.4);
    expect(c.dividendPerShare).toBeCloseTo(0.4, 9);
    const personal = g.chairman.cash;
    run(g, 92); // through Apr 1
    const paid = -c.financingIn(1850, 'dividends');
    expect(paid).toBeCloseTo(0.1 * c.shares, 6);
    const salary = (FINANCE.accounting.chairmanSalaryPerYear / 12) * 3;
    expect(g.chairman.cash).toBeCloseTo(personal + 0.1 * c.holding(PLAYER) + salary, 6);
    run(g, 88); // just before Jul 1
    c.cash = 1000;
    run(g, 3);
    expect(c.stock.notes.some((n) => /passed/.test(n.text))).toBe(true);
  });
});

describe('bonds & credit', () => {
  it('rates by leverage and interest coverage', () => {
    expect(creditRating(0, 1e6, 0, 0).def.id).toBe('AAA');
    expect(creditRating(250_000, 1e6, 0, 0).def.id).toBe('A');
    expect(creditRating(900_000, 1e6, 0, 0).def.id).toBe('D');
    // Same leverage, weak coverage → lower rating.
    const strong = creditRating(150_000, 1e6, 100_000, 7_500);
    const weak = creditRating(150_000, 1e6, 0, 7_500);
    expect(weak.index).toBeGreaterThan(strong.index);
  });

  it('charges monthly interest, costs more as debt grows, and refuses junk', () => {
    const g = game();
    const c = g.company;
    const first = g.issueBond();
    expect(first.ok).toBe(true);
    expect(c.debt).toBe(FINANCE.bonds.block);
    let last = first.rate!;
    let ok = true;
    for (let i = 0; i < 30 && ok; i++) {
      const r = g.issueBond();
      ok = r.ok;
      if (ok) {
        expect(r.rate!).toBeGreaterThanOrEqual(last);
        last = r.rate!;
      }
    }
    expect(ok).toBe(false); // eventually refused
    expect(last).toBeGreaterThan(first.rate!);
    const annual = c.annualInterest;
    run(g, 32); // one month close (Feb 1)
    expect(c.spentIn(1850, 'interest')).toBeCloseTo(annual / 12, 6);
    const id = c.bonds[0].id;
    const debt = c.debt;
    expect(g.repayBond(id).ok).toBe(true);
    expect(c.debt).toBe(debt - FINANCE.bonds.block);
  });

  it('forces emergency bonds when cash runs out', () => {
    const g = game();
    g.company.infrastructure = 600_000; // assets to borrow against
    g.company.cash = -150_000;
    run(g, 32);
    expect(g.company.bonds.length).toBe(2);
    expect(g.company.bonds.every((b) => b.emergency)).toBe(true);
    expect(g.company.cash).toBeGreaterThan(0);
  });
});

describe('books', () => {
  it('keeps book value = assets − liabilities; construction moves cash into infrastructure', () => {
    const g = game();
    const c = g.company;
    const before = g.balance().bookValue;
    const a = g.buildStation(6, 20, 'station', 'x');
    const b = g.buildStation(42, 20, 'station', 'x');
    const t = g.buildTrack(g.world.tileIndex(7, 20), g.world.tileIndex(42, 20), { ...defaultTrackOptions(1850), tunnels: false });
    expect(a.ok && b.ok && t.ok).toBe(true);
    const bs = g.balance();
    expect(bs.bookValue).toBeCloseTo(before, 0);
    expect(bs.infrastructure).toBeGreaterThan(0);
    expect(bs.bookValue).toBeCloseTo(bs.totalAssets - bs.debt, 6);
    // Bulldozing writes track off; undo writes it back.
    const infra = c.infrastructure;
    expect(g.bulldoze([g.world.tileIndex(20, 20)]).ok).toBe(true);
    expect(c.infrastructure).toBeLessThan(infra);
    expect(c.spentIn(1850, 'writeOffs')).toBeGreaterThan(0);
    expect(g.undo().ok).toBe(true);
    expect(c.infrastructure).toBeCloseTo(infra, 6);
  });

  it('depreciates infrastructure monthly and reports a year-end statement', () => {
    const g = game();
    g.company.infrastructure = 600_000;
    let report: unknown = null;
    g.on((e) => {
      if (e.type === 'yearEnd') report = e.report;
    });
    run(g, 366);
    expect(g.company.spentIn(1850, 'depreciation')).toBeGreaterThan(600_000 * FINANCE.accounting.infrastructureDepreciation * 0.85);
    expect(report).not.toBeNull();
    expect(g.company.history[0].year).toBe(1850);
    expect(g.company.history[0].netProfit).toBeCloseTo(g.company.netProfitIn(1850), 6);
  });
});

describe('personal account', () => {
  it('buys on margin up to the limit and pays interest on the loan', () => {
    const g = game();
    const ch = g.chairman;
    const max = g.maxBuyShares(0);
    expect(max).toBeGreaterThan(0);
    expect(g.buyStock(0, max + 20_000).ok).toBe(false);
    const r = g.buyStock(0, max);
    expect(r.ok).toBe(true);
    expect(ch.cash).toBeLessThan(0); // borrowed
    const acc = account(ch, g.companies);
    expect(acc.equity).toBeGreaterThanOrEqual(FINANCE.margin.initial * acc.gross * 0.98);
    const cash = ch.cash;
    run(g, 32);
    expect(ch.cash).toBeLessThan(cash + FINANCE.accounting.chairmanSalaryPerYear / 12);
  });

  it('margin call liquidates when the price falls below the liquidation price', () => {
    const g = game();
    const ch = g.chairman;
    g.buyStock(0, g.maxBuyShares(0));
    const c = g.company;
    const liq = liquidationPrice(ch, g.companies, c)!;
    expect(liq).toBeGreaterThan(0);
    expect(liq).toBeLessThan(c.stock.price);
    // At the liquidation price equity is exactly maintenance × gross.
    const saved = c.stock.price;
    c.stock.price = liq;
    const acc = account(ch, g.companies);
    expect(acc.equity).toBeCloseTo(FINANCE.margin.maintenance * acc.gross, 3);
    c.stock.price = saved;
    let called = false;
    g.on((e) => {
      if (e.type === 'marginCall') called = true;
    });
    const mine = c.holding(PLAYER);
    c.stock.price = liq * 0.8;
    run(g, 1);
    expect(called).toBe(true);
    expect(c.holding(PLAYER)).toBeLessThan(mine);
  });

  it('short selling profits when the price falls and loses when it rises', () => {
    const g = game();
    const ch = g.chairman;
    const c = g.company;
    const worth = g.netWorth();
    expect(g.shortStock(0, 5000).ok).toBe(true);
    expect(ch.short(0)).toBe(5000);
    c.stock.price *= 0.7;
    const down = g.netWorth();
    expect(down).toBeGreaterThan(worth - 20_000 * c.stock.price); // longs lose, short gains
    expect(g.coverStock(0, 5000).ok).toBe(true);
    expect(ch.short(0)).toBe(0);
    // Selling what you own works; selling more doesn't.
    expect(g.sellStock(0, 1000).ok).toBe(true);
    expect(g.sellStock(0, 1_000_000).ok).toBe(false);
  });
});
