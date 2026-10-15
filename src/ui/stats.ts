import { CARGO_BY_ID } from '../data';
import { PALETTE, type PaletteName } from '../render/palette';
import type { Game } from '../sim/game';
import type { MonthSample } from '../sim/stats';
import { esc } from './dom';
import { companyColor, holderColor, holderName } from './rivals';
import { fmtMoney } from './tools';
import type { TrainUiHost } from './trains';

type StatsTab = 'revenue' | 'trains' | 'stations' | 'railroads' | 'worth';

const state = { tab: 'revenue' as StatsTab, range: 24 };

const DASHES = ['', '4 2', '1 2', '6 2 1 2'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function short(v: number): string {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : `${Math.round(a)}`;
  return `${v < 0 ? '−' : ''}$${s}`;
}

export interface Series {
  label: string;
  color: string;
  values: Array<number | null>;
  dash?: string;
}

/** Multi-line chart as crisp SVG; series differ by colour and dash pattern. */
export function lineChart(series: Series[], xLabels: string[], w = 520, h = 150): string {
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (all.length < 2 || xLabels.length < 2) return '<p class="hint">Not enough history yet — graphs fill in month by month.</p>';
  let lo = Math.min(0, ...all);
  let hi = Math.max(...all);
  if (hi - lo < 1) hi = lo + 1;
  const pad = (hi - lo) * 0.05;
  hi += pad;
  if (lo < 0) lo -= pad;
  const n = xLabels.length;
  const x = (i: number) => Math.round((i / (n - 1)) * (w - 1));
  const y = (v: number) => Math.round(h - 1 - ((v - lo) / (hi - lo)) * (h - 2));
  const lines = series
    .map((s) => {
      const parts: string[] = [];
      let cur: string[] = [];
      s.values.forEach((v, i) => {
        if (v === null) {
          if (cur.length > 1) parts.push(cur.join(' '));
          cur = [];
        } else cur.push(`${x(i)},${y(v)}`);
      });
      if (cur.length > 1) parts.push(cur.join(' '));
      return parts.map((p) => `<polyline points="${p}" stroke="${s.color}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} fill="none"/>`).join('');
    })
    .join('');
  const zero = lo < 0 ? `<line class="zero" x1="0" x2="${w}" y1="${y(0)}" y2="${y(0)}"/>` : '';
  const grid = [0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${w}" y1="${Math.round(h * f)}" y2="${Math.round(h * f)}"/>`).join('');
  const legend = series.length > 1 ? `<ul class="legend">${series.map((s) => `<li>${legendSwatch(s)}${esc(s.label)}</li>`).join('')}</ul>` : '';
  return `<div class="chart stats-chart"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="Chart">
      <g class="grid">${grid}${zero}</g><g class="lines">${lines}</g></svg>
    <div class="chart-axis"><span>${short(hi)}</span><span>${short(lo)}</span></div>
    <div class="x-axis"><span>${esc(xLabels[0])}</span><span>${esc(xLabels[n - 1])}</span></div>${legend}</div>`;
}

function legendSwatch(s: Series): string {
  return `<svg class="lg" viewBox="0 0 16 4" width="16" height="4" aria-hidden="true"><line x1="0" x2="16" y1="2" y2="2" stroke="${s.color}" stroke-width="2" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/></svg>`;
}

/** Stacked monthly bars (e.g. revenue by cargo). */
export function stackedBars(stacks: Series[], xLabels: string[], w = 520, h = 150): string {
  const n = xLabels.length;
  if (n < 1) return '<p class="hint">Not enough history yet.</p>';
  const totals = xLabels.map((_, i) => stacks.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0));
  const hi = Math.max(1, ...totals);
  const bw = Math.max(1, Math.floor(w / n) - 1);
  const rects: string[] = [];
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (const s of stacks) {
      const v = Math.max(0, s.values[i] ?? 0);
      if (v <= 0) continue;
      const y0 = Math.round(h - (acc / hi) * h);
      acc += v;
      const y1 = Math.round(h - (acc / hi) * h);
      rects.push(`<rect x="${Math.round((i * w) / n)}" y="${y1}" width="${bw}" height="${Math.max(1, y0 - y1)}" fill="${s.color}"><title>${esc(s.label)} ${esc(xLabels[i])}: ${fmtMoney(Math.round(v))}</title></rect>`);
    }
  }
  const legend = `<ul class="legend">${stacks.map((s) => `<li><i class="sw" style="background:${s.color}"></i>${esc(s.label)}</li>`).join('')}</ul>`;
  return `<div class="chart stats-chart"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="Stacked bars">${rects.join('')}</svg>
    <div class="chart-axis"><span>${short(hi)}</span><span>$0</span></div>
    <div class="x-axis"><span>${esc(xLabels[0])}</span><span>${esc(xLabels[n - 1])}</span></div>${legend}</div>`;
}

/** Tiny inline sparkline for table rows. */
function sparkline(values: Array<number | null>, w = 90, h = 16): string {
  const v = values.map((x) => x ?? 0);
  if (v.length < 2) return '';
  const lo = Math.min(0, ...v);
  const hi = Math.max(1, ...v);
  const x = (i: number) => Math.round((i / (v.length - 1)) * (w - 1));
  const y = (q: number) => Math.round(h - 1 - ((q - lo) / (hi - lo)) * (h - 2));
  const zero = lo < 0 ? `<line x1="0" x2="${w}" y1="${y(0)}" y2="${y(0)}" class="zero"/>` : '';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges" aria-hidden="true">${zero}<polyline points="${v.map((q, i) => `${x(i)},${y(q)}`).join(' ')}" fill="none"/></svg>`;
}

function label(s: MonthSample): string {
  return `${MONTHS[s.month]} ${s.year}`;
}

function cargoColor(id: string): string {
  return PALETTE[(CARGO_BY_ID.get(id)?.color ?? 'bone') as PaletteName] ?? PALETTE.bone;
}

function revenueTab(game: Game, samples: MonthSample[]): string {
  const me = game.company.id;
  const mine = samples.map((s) => s.companies.find((c) => c.id === me));
  const cargos = new Map<string, number>();
  for (const c of mine) for (const [k, v] of Object.entries(c?.revenue ?? {})) cargos.set(k, (cargos.get(k) ?? 0) + v);
  const order = [...cargos.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const stacks: Series[] = order.map((k) => ({ label: CARGO_BY_ID.get(k)?.name ?? k, color: cargoColor(k), values: mine.map((c) => c?.revenue[k] ?? 0) }));
  const net: Series = { label: 'Net profit', color: PALETTE.gold, values: mine.map((c) => (c ? c.net : null)) };
  const total = [...cargos.values()].reduce((a, b) => a + b, 0);
  const rows = order.map((k) => `<tr><td><i class="sw" style="background:${cargoColor(k)}"></i>${esc(CARGO_BY_ID.get(k)?.name ?? k)}</td><td>${fmtMoney(Math.round(cargos.get(k)!))}</td><td>${total ? Math.round((cargos.get(k)! / total) * 100) : 0}%</td></tr>`).join('');
  return `<div class="section">Revenue by cargo, per month</div>${stackedBars(stacks, samples.map(label))}
    <div class="fin-grid"><div><div class="section">Net profit per month</div>${lineChart([net], samples.map(label), 320, 110)}</div>
    <div><div class="section">Totals for the period</div>${rows ? `<table class="table compact">${rows}<tr class="sum"><td>Total</td><td>${fmtMoney(Math.round(total))}</td><td></td></tr></table>` : '<p class="hint">No revenue yet.</p>'}</div></div>`;
}

function entityTab(samples: MonthSample[], ids: Array<{ id: number; name: string }>, pick: (s: MonthSample, id: number) => number | undefined, what: string): string {
  const rows = ids
    .map((e) => {
      const vals = samples.map((s) => pick(s, e.id) ?? null);
      const total = vals.reduce<number>((a, v) => a + (v ?? 0), 0);
      return { ...e, vals, total };
    })
    .sort((a, b) => b.total - a.total);
  if (!rows.length) return `<p class="hint">No ${what} yet.</p>`;
  return `<div class="scroll stats-table"><table class="table compact"><thead><tr><th>${what === 'trains' ? 'Train' : 'Station'}</th><th>Per month</th><th>Total for the period</th><th>Best month</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td>${esc(r.name)}</td><td>${sparkline(r.vals)}</td><td class="${r.total < 0 ? 'bad' : ''}">${fmtMoney(Math.round(r.total))}</td><td>${fmtMoney(Math.max(0, ...r.vals.map((v) => v ?? 0)))}</td></tr>`)
    .join('')}</tbody></table></div>`;
}

function railroadsTab(game: Game, samples: MonthSample[]): string {
  const series: Series[] = game.companies.map((c, k) => ({
    label: `${c.name}${c.defunct ? ` (${c.defunct})` : ''}`,
    color: companyColor(c),
    dash: DASHES[k % DASHES.length],
    values: samples.map((s) => s.companies.find((x) => x.id === c.id)?.marketCap ?? null),
  }));
  const book: Series[] = game.companies.map((c, k) => ({
    label: c.name,
    color: companyColor(c),
    dash: DASHES[k % DASHES.length],
    values: samples.map((s) => s.companies.find((x) => x.id === c.id)?.net ?? null),
  }));
  return `<div class="section">Market value</div>${lineChart(series, samples.map(label))}
    <div class="section">Net profit per month</div>${lineChart(book, samples.map(label), 520, 110)}`;
}

function worthTab(game: Game, samples: MonthSample[]): string {
  const series: Series[] = game.investors.map((inv, k) => ({
    label: holderName(game, inv.key),
    color: holderColor(game, inv.key),
    dash: DASHES[k % DASHES.length],
    values: samples.map((s) => s.worth[inv.key] ?? null),
  }));
  return `<div class="section">Personal net worth (cash + shares − shorts)</div>${lineChart(series, samples.map(label), 520, 180)}`;
}

export function openStats(host: TrainUiHost): void {
  const game = host.game;
  const all = game.stats.samples;
  const samples = state.range > 0 ? all.slice(-state.range) : all;
  const me = game.company.id;
  let body = '';
  switch (state.tab) {
    case 'revenue':
      body = revenueTab(game, samples);
      break;
    case 'trains': {
      const ids = new Map<number, string>();
      for (const t of game.trains.trains) if (t.owner === me) ids.set(t.id, t.name);
      body = entityTab(samples, [...ids].map(([id, name]) => ({ id, name })), (s, id) => s.trains[id], 'trains');
      break;
    }
    case 'stations': {
      const ids = game.world.liveStations().filter((s) => s.owner === me).map((s) => ({ id: s.id, name: s.name }));
      body = entityTab(samples, ids, (s, id) => s.stations[id], 'stations');
      break;
    }
    case 'railroads':
      body = railroadsTab(game, samples);
      break;
    case 'worth':
      body = worthTab(game, samples);
      break;
  }
  const tabs: Array<[StatsTab, string]> = [
    ['revenue', 'Revenue'],
    ['trains', 'Trains'],
    ['stations', 'Stations'],
    ['railroads', 'Railroads'],
    ['worth', 'Net worth'],
  ];
  const m = host.openModal(
    `<div class="fin-head"><h2>Statistics</h2><div class="tabs" role="tablist">${tabs.map(([id, l]) => `<button class="btn small" role="tab" data-tab="${id}" aria-selected="${state.tab === id}">${l}</button>`).join('')}</div>
      <span class="seg"><button class="btn small" data-range="24" aria-pressed="${state.range === 24}">2 years</button><button class="btn small" data-range="0" aria-pressed="${state.range === 0}">All</button></span></div>
    <div class="fin-body">${body}</div>
    <div class="actions"><button class="btn primary" data-act="close">Close</button></div>`,
    'wide finance',
  );
  m.querySelector('[data-act="close"]')!.addEventListener('click', () => host.closeModal());
  m.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab as StatsTab;
      openStats(host);
    }),
  );
  m.querySelectorAll<HTMLElement>('[data-range]').forEach((b) =>
    b.addEventListener('click', () => {
      state.range = Number(b.dataset.range);
      openStats(host);
    }),
  );
}
