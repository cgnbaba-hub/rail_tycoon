import { CARGO_BY_ID, FINANCE } from '../data';
import { PLAYER, account, liquidationPrice } from '../sim/chairman';
import { CAPITAL_CATEGORIES, EXPENSE_LABELS, FINANCING_LABELS, NON_OPERATING, type Company, type ExpenseCategory, type FinancingCategory, type PricePoint } from '../sim/company';
import { blockSize, issueBlocked } from '../sim/finance';
import type { Game, YearEndReport } from '../sim/game';
import { dayToDate, formatDate } from '../sim/time';
import { PALETTE } from '../render/palette';
import { boardVote } from '../sim/rivals';
import { esc, fmtInt } from './dom';
import { holderColor, holderName } from './rivals';
import { fmtMoney } from './tools';
import { confirmModal, type TrainUiHost } from './trains';

export type FinanceTab = 'books' | 'bonds' | 'stock' | 'portfolio';

function row(label: string, value: string, cls = ''): string {
  return `<div class="kv ${cls}"><span>${esc(label)}</span><b>${value}</b></div>`;
}

function money(v: number, cls = true): string {
  const s = fmtMoney(Math.round(v));
  return cls && v < 0 ? `<span class="bad">${s}</span>` : s;
}

export function fmtPrice(p: number): string {
  return `$${p.toFixed(2)}`;
}

function pct(v: number, digits = 1): string {
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`;
}

function tone(v: number): string {
  return v > 0.0005 ? 'good' : v < -0.0005 ? 'bad' : '';
}

function dateOf(game: Game, day: number): string {
  return formatDate(dayToDate(day, game.params.startYear));
}

// ---------------------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------------------

/** Price change over roughly the last month. */
export function monthChange(c: Company): number {
  const d = c.stock.daily;
  const ref = d.length > 30 ? d[d.length - 31].price : d[0]?.price ?? c.stock.price;
  return c.stock.price / ref - 1;
}

export function stockChipHtml(game: Game): string {
  const c = game.company;
  const ch = monthChange(c);
  return `<span class="tick">${esc(c.ticker)}</span> ${fmtPrice(c.stock.price)} <i class="${tone(ch)}">${ch >= 0 ? '+' : '−'}${Math.abs(ch * 100).toFixed(1)}%</i>`;
}

/** Tooltip with the share-price formula (multi-line). */
export function stockTip(game: Game): string {
  const c = game.company;
  const f = game.fair();
  const m = (v: number) => fmtMoney(Math.round(v));
  return [
    `${c.ticker} ${fmtPrice(c.stock.price)} — click for the stock window`,
    `Fair value = (book ${m(f.book)} + profits ${m(f.earnings)} + dividends ${m(f.dividends)}) × mood ${f.mood.toFixed(2)}`,
    `= ${m(f.total)} ÷ ${fmtInt(c.shares)} shares = ${fmtPrice(f.perShare)}`,
    `The price moves 5% of the gap a day, plus noise.`,
  ].join('\n');
}

export function personalTip(game: Game): string {
  const acc = account(game.chairman, game.activeCompanies);
  const m = (v: number) => fmtMoney(Math.round(v));
  return [`Your net worth — click for your portfolio`, `= cash ${m(acc.cash)} + shares ${m(acc.longValue)}${acc.shortValue ? ` − shorts ${m(acc.shortValue)}` : ''} = ${m(acc.equity)}`].join('\n');
}

export function cashTip(game: Game): string {
  const c = game.company;
  const y = game.year;
  const m = (v: number) => fmtMoney(Math.round(v));
  const rev = c.revenueIn(y) + c.otherIncomeIn(y);
  return [`Company cash`, `${y} so far: revenue ${m(rev)} − operating costs ${m(c.operatingCostsIn(y))} = operating profit ${m(c.operatingProfitIn(y))}`, `Net profit after interest & depreciation: ${m(c.netProfitIn(y))}`].join('\n');
}

export function personalChipHtml(game: Game): string {
  return `<span class="label">You</span><span class="${game.netWorth() < 0 ? 'bad' : ''}">${fmtMoney(Math.round(game.netWorth()))}</span>`;
}

// ---------------------------------------------------------------------------------------
// Chart (pixel-crisp SVG)
// ---------------------------------------------------------------------------------------

export function priceChart(points: PricePoint[], w = 320, h = 120, label: (v: number) => string = fmtPrice): string {
  if (points.length < 2) return '<p class="hint">Not enough trading history yet.</p>';
  const ph = Math.round(h * 0.72);
  const vh = h - ph - 4;
  const prices = points.map((p) => p.price);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  if (hi - lo < hi * 0.05) {
    hi *= 1.03;
    lo *= 0.97;
  }
  const maxVol = Math.max(0, ...points.map((p) => p.volume));
  const x = (i: number) => Math.round((i / (points.length - 1)) * (w - 1));
  const y = (p: number) => Math.round(ph - 1 - ((p - lo) / (hi - lo)) * (ph - 2));
  const line = points.map((p, i) => `${x(i)},${y(p.price)}`).join(' ');
  const bw = Math.max(1, Math.floor(w / points.length) - 1);
  const bars = points
    .filter(() => maxVol > 0)
    .map((p, i) => {
      const bh = Math.max(1, Math.round((p.volume / maxVol) * vh));
      return `<rect x="${x(i)}" y="${h - bh}" width="${bw}" height="${bh}"/>`;
    })
    .join('');
  const grid = [0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${w}" y1="${Math.round(ph * f)}" y2="${Math.round(ph * f)}"/>`).join('');
  const plotH = maxVol > 0 ? h : ph;
  return `<div class="chart${maxVol > 0 ? '' : ' short'}"><svg viewBox="0 0 ${w} ${plotH}" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="Price chart">
      <g class="grid">${grid}</g>
      <g class="vol">${bars}</g>
      <polyline class="price" points="${line}" fill="none"/>
    </svg>
    <div class="chart-axis"><span>${label(hi)}</span><span>${label(lo)}</span></div></div>`;
}

/** Ownership pie as SVG arcs: you, the rival barons and the public. */
export function ownershipPie(c: Company, game?: Game): string {
  const keys = [...c.holders.keys()].filter((k) => c.holding(k) > 0);
  const order = (k: string) => (k === PLAYER ? 0 : k === 'public' ? 2 : 1);
  keys.sort((a, b) => order(a) - order(b) || c.holding(b) - c.holding(a));
  const slices = keys.map((k) => ({
    label: game ? holderName(game, k) : k === PLAYER ? 'You' : k === 'public' ? 'Public' : k,
    value: c.holding(k),
    color: game ? holderColor(game, k) : k === PLAYER ? PALETTE.gold : PALETTE.steel,
  }));
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  let a0 = -Math.PI / 2;
  const r = 30;
  const paths = slices
    .map((s) => {
      const frac = s.value / total;
      if (frac >= 0.9999) return `<circle fill="${s.color}" cx="32" cy="32" r="${r}"/>`;
      const a1 = a0 + frac * Math.PI * 2;
      const p = (a: number) => `${(32 + r * Math.cos(a)).toFixed(2)},${(32 + r * Math.sin(a)).toFixed(2)}`;
      const d = `M32,32 L${p(a0)} A${r},${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${p(a1)} Z`;
      a0 = a1;
      return `<path fill="${s.color}" d="${d}"/>`;
    })
    .join('');
  const legend = slices.map((s) => `<li><i class="sw" style="background:${s.color}"></i>${esc(s.label)} <b>${((s.value / total) * 100).toFixed(1)}%</b> <small>${fmtInt(s.value)}</small></li>`).join('');
  return `<div class="pie"><svg viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Ownership">${paths}</svg><ul>${legend}</ul></div>`;
}

// ---------------------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------------------

function booksHtml(game: Game): string {
  const c = game.company;
  const y = game.year;
  const years = [y, y - 1].filter((yr) => yr >= game.params.startYear);
  const col = (f: (yr: number) => number, cls = '') => years.map((yr) => `<td class="${cls}">${money(f(yr))}</td>`).join('');
  const lines: string[] = [];
  const cargoRows = new Set<string>();
  for (const yr of years) for (const k of c.revenue.get(yr)?.keys() ?? []) cargoRows.add(k);
  const revByGroup = (yr: number, people: boolean) => {
    let s = 0;
    for (const [k, v] of c.revenue.get(yr) ?? []) if ((CARGO_BY_ID.get(k)?.group === 'people') === people) s += v;
    return s;
  };
  lines.push(`<tr><td>Passengers & mail</td>${col((yr) => revByGroup(yr, true))}</tr>`);
  lines.push(`<tr><td>Freight</td>${col((yr) => revByGroup(yr, false))}</tr>`);
  lines.push(`<tr><td>Other income</td>${col((yr) => c.otherIncomeIn(yr))}</tr>`);
  lines.push(`<tr class="sum"><td>Revenue</td>${col((yr) => c.revenueIn(yr) + c.otherIncomeIn(yr))}</tr>`);
  const opCats = (Object.keys(EXPENSE_LABELS) as ExpenseCategory[]).filter((k) => !CAPITAL_CATEGORIES.has(k) && !NON_OPERATING.has(k));
  for (const k of opCats) {
    if (years.every((yr) => !c.spentIn(yr, k))) continue;
    lines.push(`<tr class="sub"><td>${esc(EXPENSE_LABELS[k])}</td>${col((yr) => -c.spentIn(yr, k))}</tr>`);
  }
  lines.push(`<tr class="sum"><td>Operating profit</td>${col((yr) => c.operatingProfitIn(yr))}</tr>`);
  for (const k of NON_OPERATING) {
    if (years.every((yr) => !c.spentIn(yr, k))) continue;
    lines.push(`<tr class="sub"><td>${esc(EXPENSE_LABELS[k])}</td>${col((yr) => -c.spentIn(yr, k))}</tr>`);
  }
  lines.push(`<tr class="sum total"><td>Net profit</td>${col((yr) => c.netProfitIn(yr))}</tr>`);
  const capital = (Object.keys(EXPENSE_LABELS) as ExpenseCategory[]).filter((k) => CAPITAL_CATEGORIES.has(k));
  const capRows = capital
    .filter((k) => years.some((yr) => c.spentIn(yr, k)))
    .map((k) => `<tr class="sub"><td>${esc(EXPENSE_LABELS[k])}</td>${col((yr) => -c.spentIn(yr, k))}</tr>`)
    .join('');
  const finRows = (Object.keys(FINANCING_LABELS) as FinancingCategory[])
    .filter((k) => years.some((yr) => c.financingIn(yr, k)))
    .map((k) => `<tr class="sub"><td>${esc(FINANCING_LABELS[k])}</td>${col((yr) => c.financingIn(yr, k))}</tr>`)
    .join('');
  const b = game.balance();
  const head = `<thead><tr><th></th>${years.map((yr) => `<th>${yr}${yr === y ? ' (so far)' : ''}</th>`).join('')}</tr></thead>`;
  return `<div class="fin-grid">
    <div>
      <div class="section">Income statement</div>
      <table class="table compact books">${head}<tbody>${lines.join('')}</tbody></table>
      ${capRows || finRows ? `<div class="section">Investment & financing</div><table class="table compact books">${head}<tbody>${capRows}${finRows}</tbody></table>` : ''}
    </div>
    <div>
      <div class="section">Balance sheet (today)</div>
      ${row('Cash', money(b.cash))}
      ${row('Rolling stock', money(b.rollingStock), 'sub')}
      ${row('Track, stations & buildings', money(b.infrastructure), 'sub')}
      ${b.industries ? row('Industries', money(b.industries), 'sub') : ''}
      ${row('Total assets', money(b.totalAssets))}
      ${row('Bonds' + (c.cash < 0 ? ' & overdraft' : ''), money(-b.debt))}
      ${row('Book value', money(b.bookValue), 'total')}
      ${row('Book value per share', fmtPrice(b.bookValue / c.shares))}
      <p class="hint">Infrastructure is carried at cost less ${(FINANCE.accounting.infrastructureDepreciation * 100).toFixed(0)}% depreciation a year; trains at resale value. Bulldozed track is written off.</p>
      ${historyTable(c)}
    </div>
  </div>`;
}

function historyTable(c: Company): string {
  if (!c.history.length) return '';
  const rows = [...c.history]
    .reverse()
    .slice(0, 8)
    .map((h) => `<tr><td>${h.year}</td><td>${money(h.revenue)}</td><td>${money(h.netProfit)}</td><td>${money(h.bookValue)}</td><td>${fmtPrice(h.price)}</td></tr>`)
    .join('');
  return `<div class="section">History</div><table class="table compact"><thead><tr><th>Year</th><th>Revenue</th><th>Net profit</th><th>Book value</th><th>Share</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function bondsHtml(game: Game): string {
  const c = game.company;
  const r = game.rating();
  const next = game.rating(c, FINANCE.bonds.block);
  const rate = game.newBondRate();
  const can = next.def.id !== 'D';
  const bonds = c.bonds
    .map(
      (b) => `<tr><td>#${b.id}${b.emergency ? ' <small class="bad">emergency</small>' : ''}</td><td>${money(b.principal)}</td><td>${(b.rate * 100).toFixed(2)}%</td><td>${money(b.principal * b.rate)}</td><td>${esc(dateOf(game, b.issuedDay))}</td><td>${b.maturityYear}</td>
        <td><button class="btn small" data-bond-repay="${b.id}" ${c.cash >= b.principal ? '' : 'disabled'}>Repay</button></td></tr>`,
    )
    .join('');
  const cov = Number.isFinite(r.coverage) ? `${r.coverage.toFixed(1)}×` : '—';
  return `<div class="fin-grid">
    <div>
      <div class="section">Credit rating</div>
      <div class="rating r${r.index}">${esc(r.def.id)}</div>
      ${row('Debt / assets', `${(r.leverage * 100).toFixed(0)}%`)}
      ${row('Interest cover', cov)}
      ${row('Base rate (economy)', `${(FINANCE.bonds.baseRate[game.economy.cycle.state] * 100).toFixed(1)}%`)}
      <p class="hint">The rating follows debt as a share of assets, lowered when profits barely cover interest. Lower ratings pay higher rates; the economy sets the base rate. If cash is negative at month end the bank forces emergency bonds at a penalty.</p>
    </div>
    <div>
      <div class="section">Issue a bond</div>
      ${row('Size', money(FINANCE.bonds.block))}
      ${row('Rate now', can ? `${(rate * 100).toFixed(2)}% (${esc(next.def.id)} after issuing)` : '<span class="bad">No lender</span>')}
      ${row('Interest / year', can ? money(FINANCE.bonds.block * rate) : '—')}
      ${row('Term', `${FINANCE.bonds.termYears} years, repay early any time`)}
      <div class="actions"><button class="btn primary" data-act="bond" ${can ? '' : 'disabled'}>Issue ${fmtMoney(FINANCE.bonds.block)} bond</button></div>
    </div>
  </div>
  <div class="section">Outstanding bonds · ${money(c.debt)} · ${money(c.annualInterest)}/yr interest</div>
  ${bonds ? `<table class="table compact"><thead><tr><th>Bond</th><th>Principal</th><th>Rate</th><th>Interest/yr</th><th>Issued</th><th>Matures</th><th></th></tr></thead><tbody>${bonds}</tbody></table>` : '<p class="hint">No bonds outstanding.</p>'}`;
}

function stockHtml(game: Game, range: 'daily' | 'weekly'): string {
  const c = game.company;
  const f = game.fair();
  const s = c.stock;
  const points = range === 'daily' ? s.daily : s.weekly;
  const yearCh = s.price / s.yearOpen - 1;
  const notes = [...s.notes]
    .reverse()
    .slice(0, 8)
    .map((n) => `<li><small>${esc(dateOf(game, n.day))}</small> ${esc(n.text)}${n.effect ? ` <span class="${tone(n.effect)}">${pct(n.effect)}</span>` : ''}</li>`)
    .join('');
  const trend = c.monthlyNet.length >= 2 ? c.monthlyNet[c.monthlyNet.length - 1] - c.monthlyNet[c.monthlyNet.length - 2] : 0;
  const why = [
    `Investors value the company at ${fmtMoney(Math.round(f.total))}: book value ${fmtMoney(Math.round(f.book))}, profits ${fmtMoney(Math.round(f.earnings))} (${f.pe}× expected profit of ${fmtMoney(Math.round(c.profitTrend))}/yr)${f.dividends ? `, dividends ${fmtMoney(Math.round(f.dividends))}` : ''}.`,
    `Market mood ×${f.mood.toFixed(2)} from business confidence ${Math.round(game.economy.cycle.confidence)} — the market moves before the economy does.`,
    `That is ${fmtPrice(f.perShare)} a share; the price drifts towards it (${s.price < f.perShare ? 'currently below — likely to rise' : 'currently above — likely to fall'}).`,
    trend ? `Last month's profit was ${trend > 0 ? 'up' : 'down'} on the month before.` : '',
  ]
    .filter(Boolean)
    .map((t) => `<li>${esc(t)}</li>`)
    .join('');
  const block = blockSize(c);
  const issueErr = issueBlocked(c, game.day);
  const yieldPct = c.dividendPerShare > 0 ? (c.dividendPerShare / s.price) * 100 : 0;
  return `<div class="fin-grid">
    <div>
      <div class="chart-head"><b>${esc(c.ticker)} ${fmtPrice(s.price)}</b> <span class="${tone(yearCh)}">${pct(yearCh)} this year</span>
        <span class="grow"></span>
        <span class="seg"><button class="btn small" data-range="daily" aria-pressed="${range === 'daily'}">120 days</button><button class="btn small" data-range="weekly" aria-pressed="${range === 'weekly'}">10 years</button></span></div>
      ${priceChart(points)}
      <div class="section">Why the price is where it is</div>
      <ul class="why">${why}</ul>
      ${notes ? `<div class="section">Recent events</div><ul class="why notes">${notes}</ul>` : ''}
    </div>
    <div>
      <div class="section">Ownership · ${fmtInt(c.shares)} shares</div>
      ${ownershipPie(c, game)}
      ${row('Market value', money(s.price * c.shares))}
      ${row('Fair value / share', fmtPrice(f.perShare))}
      ${boardRow(game, c)}
      <div class="section">Dividend</div>
      <div class="kv"><span>Per share / year</span><b><button class="btn small" data-div="-1" aria-label="Lower dividend">−</button> ${fmtPrice(c.dividendPerShare)} <button class="btn small" data-div="1" aria-label="Raise dividend">+</button></b></div>
      ${row('Yield · cost per year', `${yieldPct.toFixed(1)}% · ${money(c.dividendPerShare * c.shares)}`)}
      <div class="section">Share capital</div>
      <div class="actions wrap">
        <button class="btn small" data-act="issue" ${issueErr ? `disabled data-tip="${esc(issueErr)}"` : `data-tip="Sell ${fmtInt(block)} new shares at ~${fmtPrice(s.price * (1 - FINANCE.shares.issueDiscount))}"`}>Issue ${fmtInt(block)} shares</button>
        <button class="btn small" data-act="buyback" data-tip="Buy back up to ${fmtInt(block)} shares at ~${fmtPrice(s.price * (1 + FINANCE.shares.buybackPremium))}">Buy back</button>
        <button class="btn small" data-act="split" ${s.price >= FINANCE.shares.splitMinPrice ? '' : `disabled data-tip="Needs a share price of $${FINANCE.shares.splitMinPrice}"`}>Split 2:1</button>
      </div>
    </div>
  </div>`;
}

/** The company the portfolio tab trades. */
function tradeTarget(game: Game): Company {
  const t = game.companyById(state.target);
  if (t && !t.defunct) return t;
  return game.activeCompanies.find((x) => x.id === 0) ?? game.activeCompanies[0] ?? game.company;
}

function boardRow(game: Game, c: Company): string {
  if (c.id !== game.company.id || game.over) return '';
  const v = boardVote(game, c);
  return row('Board support today', `<span class="${v.support < 0.5 ? 'bad' : v.warn ? 'warn' : 'good'}">${Math.round(v.support * 100)}%</span>${v.strikes ? ' <small class="bad">1 strike</small>' : ''}`);
}

function portfolioHtml(game: Game, amount: number): string {
  const ch = game.chairman;
  const acc = account(ch, game.companies);
  const c = tradeTarget(game);
  const picker =
    game.activeCompanies.length > 1
      ? `<span class="seg">${game.activeCompanies.map((x) => `<button class="btn small" data-target="${x.id}" aria-pressed="${x.id === c.id}">${esc(x.ticker)}</button>`).join('')}</span>`
      : '';
  const liq = liquidationPrice(ch, game.companies, c);
  const M = FINANCE.margin;
  const ratio = Number.isFinite(acc.ratio) ? acc.ratio : 1;
  const bar = Math.max(0, Math.min(100, ratio * 100));
  const rows = game.activeCompanies
    .map((co) => {
      const long = co.holding(PLAYER);
      const short = ch.short(co.id);
      return `<tr><td><i class="sw" style="background:${holderColor(game, co.chairman)}"></i>${esc(co.ticker)}</td><td>${esc(co.name)}</td><td>${fmtPrice(co.stock.price)}</td><td>${fmtInt(long)}</td><td>${money(long * co.stock.price)}</td><td>${short ? fmtInt(short) : '—'}</td><td>${((long / co.shares) * 100).toFixed(1)}%</td></tr>`;
    })
    .join('');
  const max = game.maxBuyShares(c.id);
  return `<div class="fin-grid">
    <div>
      <div class="section">Your account</div>
      ${row('Cash', money(ch.cash))}
      ${acc.marginLoan ? row('Margin loan', `<span class="bad">${fmtMoney(Math.round(acc.marginLoan))}</span> at ${((FINANCE.bonds.baseRate[game.economy.cycle.state] + M.interestSpread) * 100).toFixed(1)}%`) : ''}
      ${row('Shares (long)', money(acc.longValue))}
      ${acc.shortValue ? row('Short positions', money(-acc.shortValue)) : ''}
      ${row('Net worth', money(acc.equity), 'total')}
      <div class="section">Margin</div>
      <div class="margin-bar" data-tip="Equity as a share of positions: below ${M.maintenance * 100}% triggers a margin call; new trades need ${M.initial * 100}%">
        <span class="bar"><i class="${ratio < M.maintenance * 1.2 ? 'low' : ratio < M.initial ? 'warn' : 'ok'}" style="width:${bar}%"></i><em style="left:${M.maintenance * 100}%"></em><em class="init" style="left:${M.initial * 100}%"></em></span>
        <b>${Number.isFinite(acc.ratio) ? `${Math.round(acc.ratio * 100)}%` : '—'}</b></div>
      ${row(`Margin call if ${c.ticker} falls to`, liq !== null ? `<span class="bad">${fmtPrice(liq)}</span>` : 'never')}
      <p class="hint">Your money is separate from the company's. You earn a ${fmtMoney(FINANCE.accounting.chairmanSalaryPerYear)} salary and dividends on your shares. Buying on margin borrows against your shares; a margin call sells them if equity drops below ${M.maintenance * 100}% of your positions.</p>
      <div class="section">Net worth</div>
      ${ch.worthHistory.length > 1 ? priceChart(ch.worthHistory.map((v, i) => ({ day: i, price: v, volume: 0 })), 320, 70, (v) => fmtMoney(Math.round(v))) : '<p class="hint">Monthly history appears here.</p>'}
    </div>
    <div>
      <div class="section">Trade ${esc(c.ticker)} at ${fmtPrice(c.stock.price)}</div>
      ${picker}
      <div class="trade">
        <input type="number" id="trade-n" min="0" step="${FINANCE.shares.roundLot}" value="${amount}" aria-label="Number of shares">
        <span class="seg"><button class="btn small" data-n="1000">1,000</button><button class="btn small" data-n="5000">5,000</button><button class="btn small" data-n="${max}">Max ${fmtInt(max)}</button></span>
      </div>
      ${row('Value', `<span id="trade-value">${money(amount * c.stock.price)}</span>`)}
      ${row('On the market', fmtInt(c.holding('public')))}
      <div class="actions wrap">
        <button class="btn small primary" data-trade="buy">Buy</button>
        <button class="btn small" data-trade="sell" ${c.holding(PLAYER) ? '' : 'disabled'}>Sell</button>
        <button class="btn small" data-trade="short">Sell short</button>
        <button class="btn small" data-trade="cover" ${ch.short(c.id) ? '' : 'disabled'}>Cover short</button>
      </div>
      <p class="hint">Each trade costs ${(M.commission * 100).toFixed(1)}% commission and moves the price: buying pushes it up, selling down.</p>
      <div class="section">Holdings</div>
      <table class="table compact"><thead><tr><th></th><th>Company</th><th>Price</th><th>Shares</th><th>Value</th><th>Short</th><th>Stake</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------------------

const TABS: Array<[FinanceTab, string]> = [
  ['books', 'Books'],
  ['bonds', 'Bonds'],
  ['stock', 'Stock'],
  ['portfolio', 'Your portfolio'],
];

interface FinanceState {
  tab: FinanceTab;
  range: 'daily' | 'weekly';
  amount: number;
  /** Company traded in the portfolio tab. */
  target: number;
}

const state: FinanceState = { tab: 'books', range: 'daily', amount: 1000, target: 0 };

export function openFinance(host: TrainUiHost, tab?: FinanceTab, target?: number): void {
  if (tab) state.tab = tab;
  if (target !== undefined) state.target = target;
  const game = host.game;
  const c = game.company;
  const body =
    state.tab === 'books' ? booksHtml(game) : state.tab === 'bonds' ? bondsHtml(game) : state.tab === 'stock' ? stockHtml(game, state.range) : portfolioHtml(game, state.amount);
  const m = host.openModal(
    `<div class="fin-head"><h2>${esc(c.name)} <small>${esc(c.ticker)}</small></h2>
      <div class="tabs" role="tablist">${TABS.map(([id, label]) => `<button class="btn small" role="tab" data-tab="${id}" aria-selected="${state.tab === id}">${esc(label)}</button>`).join('')}</div></div>
    <div class="fin-body">${body}</div>
    <div class="actions"><button class="btn primary" data-act="close">Close</button></div>`,
    'wide finance',
  );
  const reopen = () => openFinance(host);
  const done = (ok: boolean, msg: string, kind: 'money' | 'info' | 'error' = 'money') => {
    host.toast(msg, ok ? kind : 'error');
    host.invalidatePanel();
    reopen();
  };
  m.querySelector<HTMLElement>('[data-act="close"]')!.addEventListener('click', () => host.closeModal());
  m.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab as FinanceTab;
      reopen();
    }),
  );
  m.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((b) =>
    b.addEventListener('click', () => {
      state.range = b.dataset.range as 'daily' | 'weekly';
      reopen();
    }),
  );
  const on = (sel: string, fn: (b: HTMLButtonElement) => void) => m.querySelectorAll<HTMLButtonElement>(sel).forEach((b) => b.addEventListener('click', () => fn(b)));

  on('[data-act="bond"]', () => {
    const rate = game.newBondRate();
    confirmModal(host, `Issue a ${fmtMoney(FINANCE.bonds.block)} bond?`, `It costs ${(rate * 100).toFixed(2)}% a year (${fmtMoney(Math.round(FINANCE.bonds.block * rate))}) for up to ${FINANCE.bonds.termYears} years. You can repay it early.`, 'Issue bond').then((yes) => {
      if (!yes) return reopen();
      const r = game.issueBond();
      done(r.ok, r.ok ? `Issued a ${fmtMoney(FINANCE.bonds.block)} bond at ${((r.rate ?? 0) * 100).toFixed(2)}%` : r.error ?? 'Cannot issue.');
    });
  });
  on('[data-bond-repay]', (b) => {
    const r = game.repayBond(Number(b.dataset.bondRepay));
    done(r.ok, r.ok ? `Repaid ${fmtMoney(r.cost)}` : r.error ?? 'Cannot repay.');
  });
  on('[data-div]', (b) => {
    game.setDividend(c.dividendPerShare + Number(b.dataset.div) * FINANCE.dividends.step);
    reopen();
  });
  on('[data-act="issue"]', () => {
    const n = blockSize(c);
    const proceeds = n * c.stock.price * (1 - FINANCE.shares.issueDiscount);
    confirmModal(host, `Issue ${fmtInt(n)} new shares?`, `Raises about ${fmtMoney(Math.round(proceeds))}. More shares dilute every holder (your stake drops to ${((c.holding(PLAYER) / (c.shares + n)) * 100).toFixed(1)}%) and the price will dip about ${(FINANCE.shares.impact * (n / c.shares) * 100).toFixed(0)}%.`, 'Issue shares').then((yes) => {
      if (!yes) return reopen();
      const r = game.issueShares();
      done(r.ok, r.ok ? `Issued ${fmtInt(r.shares)} shares for ${fmtMoney(r.cash)}` : r.error ?? 'Cannot issue.');
    });
  });
  on('[data-act="buyback"]', () => {
    const n = Math.min(blockSize(c), c.holding('public'));
    confirmModal(host, `Buy back ${fmtInt(n)} shares?`, `Costs about ${fmtMoney(Math.round(n * c.stock.price * (1 + FINANCE.shares.buybackPremium)))} of company cash. Fewer shares raise the value of each remaining one.`, 'Buy back').then((yes) => {
      if (!yes) return reopen();
      const r = game.buybackShares();
      done(r.ok, r.ok ? `Bought back ${fmtInt(r.shares)} shares for ${fmtMoney(-r.cash)}` : r.error ?? 'Cannot buy back.');
    });
  });
  on('[data-act="split"]', () => {
    const r = game.splitStock();
    done(r.ok, r.ok ? 'Stock split 2-for-1' : r.error ?? 'Cannot split.', 'info');
  });

  on('[data-target]', (b) => {
    state.target = Number(b.dataset.target);
    reopen();
  });
  const tc = tradeTarget(game);
  const input = m.querySelector<HTMLInputElement>('#trade-n');
  const readAmount = () => Math.max(0, Math.floor(Number(input?.value) || 0));
  input?.addEventListener('input', () => {
    state.amount = readAmount();
    const v = m.querySelector('#trade-value');
    if (v) v.innerHTML = money(state.amount * tc.stock.price);
  });
  on('[data-n]', (b) => {
    state.amount = Number(b.dataset.n);
    reopen();
  });
  on('[data-trade]', (b) => {
    const n = readAmount();
    state.amount = n;
    const kind = b.dataset.trade!;
    const exec = () => {
      const r = kind === 'buy' ? game.buyStock(tc.id, n) : kind === 'sell' ? game.sellStock(tc.id, n) : kind === 'short' ? game.shortStock(tc.id, n) : game.coverStock(tc.id, n);
      const verb = kind === 'buy' ? 'Bought' : kind === 'sell' ? 'Sold' : kind === 'short' ? 'Sold short' : 'Covered';
      done(r.ok, r.ok ? `${verb} ${fmtInt(r.shares)} ${tc.ticker} at ${fmtPrice(r.price)}` : r.error ?? 'Trade failed.');
    };
    const cost = n * tc.stock.price;
    if (kind === 'short') {
      confirmModal(host, `Sell ${fmtInt(n)} ${tc.ticker} short?`, `You borrow the shares and sell them now. If the price rises you lose money — there is no limit — and a margin call may close the position.`, 'Sell short').then((yes) => (yes ? exec() : reopen()));
    } else if (kind === 'buy' && cost > game.chairman.cash) {
      confirmModal(host, `Buy ${fmtInt(n)} ${tc.ticker} on margin?`, `This borrows about ${fmtMoney(Math.round(cost - Math.max(0, game.chairman.cash)))} against your shares at ${((FINANCE.bonds.baseRate[game.economy.cycle.state] + FINANCE.margin.interestSpread) * 100).toFixed(1)}% a year. If the price falls far enough, a margin call sells your shares.`, 'Buy on margin').then((yes) => (yes ? exec() : reopen()));
    } else exec();
  });
}

// ---------------------------------------------------------------------------------------
// Year-end report
// ---------------------------------------------------------------------------------------

export function openYearEnd(host: TrainUiHost, r: YearEndReport, onClose: () => void): void {
  const c = host.game.company;
  const y = r.company;
  const p = r.previous;
  const delta = (now: number, before: number | undefined) => (before === undefined || before === 0 ? '' : ` <small class="${tone(now - before)}">${pct((now - before) / Math.abs(before), 0)}</small>`);
  const priceCh = y.price / r.priceStart - 1;
  const show = localStorageGet('ironBaron.yearEnd') !== 'off';
  const m = host.openModal(
    `<h2>${y.year} — the year in review</h2>
    <div class="fin-grid">
      <div>
        <div class="section">${esc(c.name)}</div>
        ${row('Revenue', money(y.revenue) + delta(y.revenue, p?.revenue))}
        ${row('Operating costs', money(-y.operatingCosts))}
        ${row('Net profit', money(y.netProfit) + delta(y.netProfit, p?.netProfit), 'total')}
        ${row('Book value', money(y.bookValue) + delta(y.bookValue, p?.bookValue))}
        ${row('Debt', money(-y.debt))}
        ${row('Dividends / share', fmtPrice(y.dividendsPerShare))}
      </div>
      <div>
        <div class="section">Shares & you</div>
        ${row(`${c.ticker} share price`, `${fmtPrice(r.priceStart)} → ${fmtPrice(y.price)} <small class="${tone(priceCh)}">${pct(priceCh, 0)}</small>`)}
        ${row('Your net worth', `${fmtMoney(Math.round(r.worthStart))} → ${fmtMoney(Math.round(r.worthEnd))}`)}
        ${row('Change', `<span class="${tone(r.worthEnd - r.worthStart)}">${money(r.worthEnd - r.worthStart)}</span>`, 'total')}
        <p class="hint">${y.netProfit > 0 ? 'Profitable year.' : 'The company lost money this year.'} ${priceCh > 0.1 ? 'Shareholders are pleased.' : priceCh < -0.1 ? 'Shareholders are worried.' : ''}</p>
        ${boardHtml(r)}
      </div>
    </div>
    <label class="check"><input type="checkbox" id="ye-show" ${show ? 'checked' : ''}> Show this report every year</label>
    <div class="actions"><button class="btn" data-a="books">Open the books</button><button class="btn primary" data-a="ok">Continue</button></div>`,
    'wide',
  );
  m.querySelector<HTMLInputElement>('#ye-show')!.addEventListener('change', (e) => localStorageSet('ironBaron.yearEnd', (e.target as HTMLInputElement).checked ? 'on' : 'off'));
  m.querySelector<HTMLElement>('[data-a="ok"]')!.addEventListener('click', () => {
    host.closeModal();
    onClose();
  });
  m.querySelector<HTMLElement>('[data-a="books"]')!.addEventListener('click', () => openFinance(host, 'books'));
}

function boardHtml(r: YearEndReport): string {
  const b = r.board;
  if (!b?.held) return '';
  const pctS = `${Math.round(b.support * 100)}%`;
  const verdict = b.support >= 0.5 ? `<span class="good">Confidence: ${pctS}</span>` : b.strikes >= 2 ? `<span class="bad">Voted out: ${pctS}</span>` : `<span class="bad">No confidence: ${pctS}</span>`;
  return `${row('Shareholder vote on you', verdict)}${b.support < 0.5 && b.strikes < 2 ? '<p class="warnbox">Lose next year\'s vote too and you are out. Raise the share price, make a profit, and keep a big stake yourself.</p>' : b.warn && b.support >= 0.5 ? '<p class="hint">A narrow win — the shareholders are getting restless.</p>' : ''}`;
}

export function setYearEnd(on: boolean): void {
  localStorageSet('ironBaron.yearEnd', on ? 'on' : 'off');
}

export function yearEndEnabled(): boolean {
  return localStorageGet('ironBaron.yearEnd') !== 'off';
}

function localStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function localStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode) */
  }
}
