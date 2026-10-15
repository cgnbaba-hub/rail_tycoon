import { CARGO, CARGO_BY_ID, CAR_BY_ID, ECONOMY, IMPROVEMENTS, IMPROVEMENT_BY_ID, INDUSTRY_BY_ID, MAPGEN } from '../data';
import { PALETTE, type PaletteName } from '../render/palette';
import { cycleState } from '../sim/cycle';
import { daysToRecover } from '../sim/economy';
import type { Game } from '../sim/game';
import { townService } from '../sim/growth';
import type { Station } from '../sim/station';
import { isSpecialCar, type Train } from '../sim/train';
import type { City, Industry } from '../sim/world';
import { formatDate, dayToDate } from '../sim/time';
import { esc, fmtInt } from './dom';
import { fmtMoney } from './tools';
import type { TrainUiHost } from './trains';

function row(label: string, value: string, cls = ''): string {
  return `<div class="kv ${cls}"><span>${esc(label)}</span><b>${value}</b></div>`;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function cargoChip(cargo: string): string {
  if (isSpecialCar(cargo)) return `<span class="chip">${esc(CAR_BY_ID.get(cargo.slice(1))?.name ?? cargo)}</span>`;
  const c = CARGO_BY_ID.get(cargo);
  if (!c) return esc(cargo);
  const color = PALETTE[c.color as PaletteName] ?? PALETTE.bone;
  return `<span class="chip"><i class="swatch" style="background:${color}"></i>${esc(c.name)}</span>`;
}

/** Tiny bar chart: values 0..max, newest right. */
export function sparkline(values: number[], max = 1, cls = ''): string {
  if (values.length === 0) return '<span class="spark empty"></span>';
  const bars = values.map((v) => `<i style="height:${Math.max(6, Math.min(100, (v / max) * 100)).toFixed(0)}%"></i>`).join('');
  return `<span class="spark ${cls}" aria-hidden="true">${bars}</span>`;
}

function levelClass(level: number): string {
  return level >= 0.85 ? 'ok' : level >= 0.55 ? 'warn' : 'low';
}

// ---------------------------------------------------------------------------------------
// Top bar: economy chip + news ticker
// ---------------------------------------------------------------------------------------

/** Trend of business confidence over the last three months. */
export function confidenceTrend(game: Game): number {
  const h = game.economy.cycle.history;
  if (h.length < 2) return 0;
  const recent = h[h.length - 1];
  const before = h[Math.max(0, h.length - 4)];
  return recent - before;
}

export function economyChipHtml(game: Game): string {
  const c = game.economy.cycle;
  const s = c.current;
  const trend = confidenceTrend(game);
  const arrow = trend > 4 ? '▲' : trend < -4 ? '▼' : '•';
  return `<span class="econ-state s-${s.id}">${esc(s.symbol)} ${esc(s.name)}</span><span class="econ-conf" data-tip="Business confidence">${Math.round(c.confidence)} <i class="${trend > 4 ? 'up' : trend < -4 ? 'down' : ''}">${arrow}</i></span>`;
}

export function economyTip(game: Game): string {
  const c = game.economy.cycle;
  const s = c.current;
  return `Economy: ${s.name} — revenue ×${s.revenue.toFixed(2)}, town growth ×${s.growth.toFixed(2)}. Business confidence ${Math.round(c.confidence)} (leading indicator). Click for the economic report.`;
}

// ---------------------------------------------------------------------------------------
// Economic report (modal)
// ---------------------------------------------------------------------------------------

export function openEconomy(host: TrainUiHost): void {
  const game = host.game;
  const econ = game.economy;
  const c = econ.cycle;
  const model = ECONOMY.models[econ.model];
  const states = ECONOMY.cycle.states
    .map(
      (s) => `<tr class="${s.id === c.state ? 'cur' : ''}"><td><span class="econ-state s-${s.id}">${esc(s.symbol)} ${esc(s.name)}</span></td>
        <td>×${s.revenue.toFixed(2)}</td><td>×${s.growth.toFixed(2)}</td><td>~${s.confidence}</td></tr>`,
    )
    .join('');
  const outlook = c.warningActive
    ? c.upcoming.revenue > c.current.revenue
      ? '<span class="good">Improving — confidence is rising, a better economy is coming.</span>'
      : c.upcoming.revenue < c.current.revenue
        ? '<span class="bad">Worsening — confidence is falling, harder times are coming.</span>'
        : 'Changing — watch confidence.'
    : 'Steady — no warning signs.';
  const news = [...c.news]
    .reverse()
    .slice(0, 12)
    .map((n) => `<li class="${n.tone > 0 ? 'good' : n.tone < 0 ? 'bad' : ''}"><small>${esc(formatDate(dayToDate(n.day, game.params.startYear)))}</small> ${esc(n.text)}</li>`)
    .join('');
  const prices = model.priceLevels
    ? `<div class="section">Cargo prices</div><div class="prices">${CARGO.filter((x) => game.year >= x.era[0] && game.year <= x.era[1])
        .map((x) => {
          const p = econ.priceLevel[x.id] ?? 1;
          return `<span class="${p >= 1.05 ? 'good' : p <= 0.95 ? 'bad' : ''}">${cargoChip(x.id)} ${Math.round(p * 100)}</span>`;
        })
        .join('')}</div>`
    : '';
  const owned = [...econ.owned].map((id) => game.world.industries[id]);
  const ownedHtml = owned.length
    ? `<div class="section">Your industries</div>${owned.map((ind) => row(ind.name, `${fmtMoney(econ.industryMonthlyProfit(ind))}/mo`)).join('')}`
    : '';
  const m = host.openModal(
    `<h2>Economic report</h2>
    <div class="econ-report">
      <div>
        ${row('Economy', `<span class="econ-state s-${c.state}">${esc(c.current.symbol)} ${esc(c.current.name)}</span>`)}
        ${row('Business confidence', `${Math.round(c.confidence)} / 100`)}
        ${row('Outlook', outlook)}
        <div class="conf-chart">${sparkline(c.history, 100, 'tall')}<small>Confidence, last ${c.history.length} months. It turns several months <em>before</em> the economy does.</small></div>
        <table class="table compact"><thead><tr><th>State</th><th>Revenue</th><th>Town growth</th><th>Confidence</th></tr></thead><tbody>${states}</tbody></table>
        ${row('Economic model', esc(model.name))}
        <p class="hint">${esc(model.desc)}</p>
        ${ownedHtml}
      </div>
      <div>
        <div class="section">News</div>
        <ul class="news-list">${news || '<li class="hint">No news yet.</li>'}</ul>
        ${prices}
      </div>
    </div>
    <div class="actions"><button class="btn primary" data-a="ok">Close</button></div>`,
    'wide',
  );
  m.querySelector<HTMLElement>('[data-a="ok"]')!.addEventListener('click', () => host.closeModal());
}

// ---------------------------------------------------------------------------------------
// Station: demand gauges & improvements
// ---------------------------------------------------------------------------------------

export function stationDemandHtml(game: Game, st: Station): string {
  const se = game.economy.station(st.id);
  if (!se || se.accepts.size === 0) return '';
  const sc = game.economy.cargoAt(st.id);
  const rows = [...se.accepts]
    .map((cargo) => {
      const level = game.economy.demandLevel(st.id, cargo);
      const days = daysToRecover(level);
      const cap = se.capacity[cargo] ?? 0;
      const SAT = ECONOMY.saturation;
      const perLoad = (SAT.dropPerCapacity * ECONOMY.models[game.economy.model].saturation) / Math.max(0.5, cap);
      const tip = [
        `${CARGO_BY_ID.get(cargo)?.name ?? cargo}: demand ${pct(level)} (share of the full price paid).`,
        `Each load delivered lowers it by ${SAT.dropPerCapacity} × ${ECONOMY.models[game.economy.model].saturation} ÷ ${cap.toFixed(1)} loads/month capacity = ${(perLoad * 100).toFixed(1)} points (floor ${pct(SAT.floor)}).`,
        `Half the gap to 100% recovers every ${SAT.recoveryHalfLifeDays} days: ${days > 0 ? `back to 90% in ~${Math.ceil(days)} days without deliveries` : 'fully recovered'}.`,
      ].join('\n');
      return `<div class="gauge demand" data-tip="${esc(tip)}">${cargoChip(cargo)}<span class="bar"><i class="${levelClass(level)}" style="width:${pct(level)}"></i></span><b>${pct(level)}</b>${sparkline(sc.history[cargo] ?? [])}</div>`;
    })
    .join('');
  return `<div class="section">Demand (price paid) · ${esc(ECONOMY.models[game.economy.model].name)}</div>${rows}
    <p class="hint">Each delivery lowers demand a little; it recovers over weeks. Spread deliveries over several stations to keep prices high.</p>`;
}

export function improvementsHtml(game: Game, st: Station): string {
  const have = st.improvements ?? [];
  const built = have.map((id) => IMPROVEMENT_BY_ID.get(id)).filter((d) => d !== undefined);
  const builtHtml = built.length ? `<div class="cars">${built.map((d) => `<span class="chip" data-tip="${esc(d.desc)}">✓ ${esc(d.name)}</span>`).join(' ')}</div>` : '';
  const options = IMPROVEMENTS.filter((d) => !have.includes(d.id))
    .map((d) => {
      const blocker = game.improvementBlocker(st.id, d.id);
      const tip = `${d.desc} Upkeep ${fmtMoney(d.upkeep)}/yr.${blocker ? ` — ${blocker}` : ''}`;
      return `<button class="btn small impr" data-impr="${d.id}" ${blocker ? 'disabled' : ''} data-tip="${esc(tip)}">${esc(d.name)} <small>${fmtMoney(d.cost)}</small></button>`;
    })
    .join('');
  return `<div class="section">Improvements</div>${builtHtml}<div class="actions wrap impr-list">${options || '<span class="hint">All built.</span>'}</div>`;
}

export function bindImprovements(root: HTMLElement, host: TrainUiHost, st: Station): void {
  root.querySelectorAll<HTMLButtonElement>('[data-impr]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.impr!;
      const r = host.game.buildImprovement(st.id, id);
      host.toast(r.ok ? `Built ${IMPROVEMENT_BY_ID.get(id)?.name} at ${st.name} (${fmtMoney(r.cost)})` : r.error ?? 'Cannot build.', r.ok ? 'money' : 'error');
      host.invalidatePanel();
    }),
  );
}

// ---------------------------------------------------------------------------------------
// Industries & towns
// ---------------------------------------------------------------------------------------

export function industryEconomyHtml(game: Game, ind: Industry): string {
  const econ = game.economy;
  const def = INDUSTRY_BY_ID.get(ind.defId)!;
  const out = econ.industryOutputPerMonth(ind);
  let html = '<div class="section">Business</div>';
  if (def.kind === 'raw') {
    const lvl = econ.levelOf(ind.id);
    html += row('Production level', `<span class="${lvl > 1.01 ? 'good' : lvl < 0.99 ? 'bad' : ''}">${pct(lvl)}</span>`);
    html += row('Output now', `${out.toFixed(1)} loads / month`);
  } else {
    html += row('Inputs waiting', `${(econ.industryStock.get(ind.id) ?? 0).toFixed(1)} loads`);
    html += row('Made last month', `${out.toFixed(1)} loads`);
  }
  const owned = econ.owned.has(ind.id);
  if (game.canBuyIndustries()) {
    const profit = econ.industryMonthlyProfit(ind);
    html += row('Owner', owned ? `<b class="good">${esc(game.company.name)}</b>` : 'Independent');
    html += row('Profit to owner', `<span class="${profit < 0 ? 'bad' : ''}">${fmtMoney(profit)}/mo</span>`);
    const price = econ.industryPrice(ind);
    html += owned
      ? `<div class="actions"><button class="btn small" data-ind="sell" data-id="${ind.id}">Sell for ${fmtMoney(Math.round(price * ECONOMY.ownership.sellFraction))}</button></div>`
      : `<div class="actions"><button class="btn small" data-ind="buy" data-id="${ind.id}" ${game.company.canAfford(price) ? '' : 'disabled'}>Buy for ${fmtMoney(price)}</button></div>`;
  }
  html +=
    def.kind === 'raw'
      ? '<p class="hint">Picking up most of the output grows production each year; neglected sites shrink.</p>'
      : `<p class="hint">${ECONOMY.models[econ.model].processorsNeedInputs ? 'Produces only from delivered inputs.' : 'Runs slowly even without inputs (Basic economy).'}</p>`;
  return html;
}

export function bindIndustry(root: HTMLElement, host: TrainUiHost): void {
  root.querySelectorAll<HTMLButtonElement>('[data-ind]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = Number(b.dataset.id);
      const ind = host.game.world.industries[id];
      const r = b.dataset.ind === 'buy' ? host.game.buyIndustry(id) : host.game.sellIndustry(id);
      if (r.ok) host.toast(b.dataset.ind === 'buy' ? `Bought ${ind.name} (${fmtMoney(r.cost)})` : `Sold ${ind.name} (+${fmtMoney(-r.cost)})`, 'money');
      else host.toast(r.error ?? 'Not possible.', 'error');
      host.invalidatePanel();
    }),
  );
}

export function townGrowthHtml(game: Game, city: City): string {
  const classes = MAPGEN.cities.classes;
  const next = classes[city.classIndex + 1];
  // Before the first month passes, show the live figures.
  const live = city.service === undefined ? townService(game.world, game.economy).get(city.id) : undefined;
  const service = city.service ?? live?.service ?? 0;
  const supplied = city.supplied ?? live?.supplied ?? 0;
  const g = city.growth ?? ECONOMY.cityGrowth.naturalPerYear * game.economy.cycle.growthFactor;
  return `<div class="section">Growth</div>
    ${row('Growth rate', `<span class="${g > 0.02 ? 'good' : g <= 0 ? 'bad' : ''}">${(g * 100).toFixed(1)}% / yr</span>`)}
    <div class="gauge" data-tip="Share of the town's passengers and mail your trains pick up (vs. target)">Passengers<span class="bar"><i class="${levelClass(service)}" style="width:${pct(service)}"></i></span><b>${pct(service)}</b><small></small></div>
    <div class="gauge" data-tip="Demanded goods delivered to the town (vs. target)">Goods<span class="bar"><i class="${levelClass(supplied)}" style="width:${pct(supplied)}"></i></span><b>${pct(supplied)}</b><small></small></div>
    ${next ? row(`${next.name} at`, fmtInt(next.popMin)) : ''}
    <p class="hint">Towns grow faster with good passenger service and deliveries of what they demand; the economic cycle speeds or stalls growth.</p>`;
}

// ---------------------------------------------------------------------------------------
// Train: revenue formula of the last delivery
// ---------------------------------------------------------------------------------------

export function lastDeliveryHtml(game: Game, t: Train): string {
  const d = t.lastDelivery;
  if (!d) return '';
  const st = game.world.stations[d.station];
  const f = (v: number) => v.toFixed(2);
  const rows = d.quotes
    .map(
      (q) => `<div class="formula-row">
        <div class="kv"><span>${cargoChip(q.cargo)} ×${fmtInt(q.loads)}</span><b>${fmtMoney(q.total)}</b></div>
        <small data-tip="Pay per load (base + per mile × ${q.miles.toFixed(1)} mi) × time × demand × economy × bonus">${fmtMoney(q.distancePay)} × ${f(q.timeFactor)} time × ${f(q.demandFactor)} demand × ${f(q.economyFactor)} econ × ${f(q.bonusFactor)} bonus</small>
      </div>`,
    )
    .join('');
  return `<div class="section">Last delivery${st ? ` · ${esc(st.name)}` : ''}</div>${rows}`;
}

export function cycleName(id: string): string {
  return cycleState(id).name;
}
