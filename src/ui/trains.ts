import { CARGO, CARGO_BY_ID, CAR_BY_ID, ECONOMY, ENGINE_BY_ID, TIME } from '../data';
import { PALETTE, type PaletteName } from '../render/palette';
import { estimateTrain, suggestConsist, type TrainEstimate } from '../sim/estimate';
import { tilesToMiles } from '../sim/construction';
import { selectTrains, sellTrains, setRoutes, upgradeEngines, type BulkResult } from '../sim/fleet';
import { consistPrice, type Game } from '../sim/game';
import { stationDef, type Station } from '../sim/station';
import {
  annualProfit,
  carForCargo,
  engineAgeYears,
  engineDef,
  engineTradeIn,
  enginesAvailable,
  isSpecialCar,
  resaleValue,
  SPECIAL_CARS,
  stationPlatforms,
  type RouteStop,
  type Train,
} from '../sim/train';
import { esc, fmtInt } from './dom';
import { companyTag } from './rivals';
import type { Sfx } from '../audio/engine';
import { cargoChip, lastDeliveryHtml } from './economy';
import { fmtMoney } from './tools';

export interface TrainUiHost {
  game: Game;
  openModal(html: string, cls?: string): HTMLElement;
  closeModal(): void;
  toast(message: string, kind?: 'info' | 'error' | 'money'): void;
  selectTrain(id: number | null): void;
  invalidatePanel(): void;
  /** Play a sound effect (optional). */
  sfx?(kind: Sfx): void;
}

const STATE_LABEL: Record<Train['state'], string> = {
  running: 'Running',
  signal: 'Waiting at signal',
  loading: 'At station',
  broken: 'Broken down',
  noroute: 'No route!',
};

function chip(cargo: string, loaded = true): string {
  if (isSpecialCar(cargo)) return cargoChip(cargo);
  const c = CARGO_BY_ID.get(cargo);
  if (!c) return esc(cargo);
  const color = PALETTE[c.color as PaletteName] ?? PALETTE.bone;
  return `<span class="chip${loaded ? '' : ' empty'}" data-tip="${esc(c.name)}${loaded ? ' (loaded)' : ' (empty)'}"><i class="swatch" style="background:${loaded ? color : 'transparent'};border-color:${color}"></i>${esc(c.name)}</span>`;
}

function row(label: string, value: string, cls = ''): string {
  return `<div class="kv ${cls}"><span>${esc(label)}</span><b>${value}</b></div>`;
}

function years(n: number): string {
  return n < 1 ? `${Math.round(n * 12)} mo` : `${n.toFixed(1)} yr`;
}

export function trainStatus(game: Game, t: Train): string {
  const st = game.world.stations[t.route[t.stop]?.station];
  switch (t.state) {
    case 'loading':
      return st ? `At ${esc(st.name)}` : 'At station';
    case 'broken':
      return `Broken down · ${Math.max(1, Math.ceil((t.brokenUntil - game.tick) / TIME.ticksPerDay))} days to repair`;
    case 'signal':
      return `Waiting for the line ahead to clear (${Math.floor((game.tick - t.waitSince) / TIME.ticksPerDay)} d)`;
    case 'noroute':
      return 'No route to the next stop — check the track';
    default:
      return `${Math.round(t.speed)} mph to ${st ? esc(st.name) : '—'}${t.struggling ? ' · struggling up a grade' : ''}`;
  }
}

// ---------------------------------------------------------------------------------------
// Train panel (context card)
// ---------------------------------------------------------------------------------------

export function trainPanelHtml(game: Game, t: Train): string {
  const e = engineDef(t);
  const age = engineAgeYears(t, game.tick);
  const best = game.bestEngineFor(t);
  const stops = t.route
    .map((r, i) => {
      const st = game.world.stations[r.station];
      const cur = i === t.stop ? ' class="cur"' : '';
      return `<li${cur}>${st ? esc(st.name) : '<em class="bad">removed</em>'}<small>${r.load === 'auto' ? 'auto' : 'keep'}${r.waitFull ? ' · full load' : ''}${r.transfer ? ' · transfer' : ''}</small></li>`;
    })
    .join('');
  const profit = t.stats.revenue - t.stats.costs;
  const last = t.stats.lastRevenue - t.stats.lastCosts;
  const owner = game.companyById(t.owner);
  const mine = t.owner === game.company.id && !game.over;
  const actions = mine
    ? `<button class="btn small" data-act="edit">Edit route & cars</button>
      <button class="btn small" data-act="follow">Follow</button>
      <button class="btn small" data-act="dup">Duplicate</button>
      <button class="btn small" data-act="template" data-tip="Save engine, cars and route as a template for new trains">Save template</button>
      <button class="btn small" data-act="upgrade" ${best ? '' : 'disabled'} data-tip="${best ? `Replace with ${esc(best.name)}` : 'No better engine on sale'}">Upgrade engine</button>
      <button class="btn small danger" data-act="sell">Sell</button>`
    : '<button class="btn small" data-act="follow">Follow</button>';
  return `
    <div class="card-title"><span class="tag">Train</span><span class="grow">${esc(t.name)}</span>
      <button class="icon-btn" data-act="close" aria-label="Deselect" data-tip="Deselect" data-key="Esc">×</button></div>
    ${t.owner !== game.company.id && owner ? row('Owner', companyTag(owner)) : ''}
    ${row('Engine', esc(e.name))}
    ${row('Status', `<span class="${t.state === 'noroute' || t.state === 'broken' ? 'bad' : ''}">${esc(STATE_LABEL[t.state])}</span>`)}
    <p class="hint" style="margin:0.1em 0 0.3em">${trainStatus(game, t)}</p>
    <div class="section">Cars</div>
    <div class="cars">${t.cars.map((c) => chip(c.cargo, c.loads > 0)).join(' ')}</div>
    ${aboardHtml(game, t)}
    <div class="section">Route</div>
    <ol class="route">${stops}</ol>
    ${row('Profit this year', `<span class="${profit < 0 ? 'bad' : ''}">${fmtMoney(profit)}</span>`)}
    ${row('Last year', fmtMoney(last))}
    ${row('Revenue / costs', `${fmtMoney(t.stats.revenue)} / ${fmtMoney(t.stats.costs)}`)}
    ${row('Loads delivered', fmtInt(t.stats.deliveries))}
    <div class="kv" data-tip="Share of cargo cars loaded when the train leaves a station (moving average over recent departures)"><span>Load factor</span><b>${t.stats.loadFactor >= 0 ? `${Math.round(t.stats.loadFactor * 100)}%` : '—'}</b></div>
    ${row('Profit / yr (12 months)', `<span class="${annualProfit(t) < 0 ? 'bad' : ''}">${fmtMoney(Math.round(annualProfit(t)))}</span>`)}
    ${lastDeliveryHtml(game, t)}
    ${row('Engine age', `${years(age)} of ~${e.lifespan} yr`)}
    ${row('Reliability', `${Math.round(e.reliability * 100)}% · ${t.stats.breakdowns} breakdown${t.stats.breakdowns === 1 ? '' : 's'}`)}
    ${row('Resale value', fmtMoney(resaleValue(t, game.tick)))}
    <div class="actions wrap">${actions}</div>`;
}

/** Travellers aboard and where they are going (destinations mode), transferred loads. */
function aboardHtml(game: Game, t: Train): string {
  const to = new Map<number, number>();
  let via = 0;
  for (const c of t.cars) {
    if (c.loads <= 0) continue;
    if (c.dest !== undefined && c.dest >= 0) to.set(c.dest, (to.get(c.dest) ?? 0) + c.loads);
    if (c.legs?.length) via += c.loads;
  }
  const list = [...to].map(([d, n]) => `${esc(game.world.stations[d]?.name ?? '?')} ×${n}`).join(' · ');
  return `${list ? `<p class="hint" style="margin:0.2em 0">Bound for ${list}</p>` : ''}${via ? `<p class="hint" style="margin:0.2em 0">${via} load${via === 1 ? '' : 's'} came by transfer</p>` : ''}`;
}

export function bindTrainPanel(root: HTMLElement, host: TrainUiHost & { follow(id: number): void }, t: Train): void {
  root.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      const g = host.game;
      switch (b.dataset.act) {
        case 'close':
          host.selectTrain(null);
          break;
        case 'edit':
          openTrainDialog(host, t.id);
          break;
        case 'follow':
          host.follow(t.id);
          break;
        case 'template': {
          const tpl = g.saveTemplate(t.id);
          if (tpl) host.toast(`Saved template “${tpl.name}”`, 'info');
          break;
        }
        case 'dup': {
          const r = g.duplicateTrain(t.id);
          host.toast(r.ok ? `Bought ${r.train!.name} (${fmtMoney(r.cost)})` : r.error ?? 'Cannot duplicate.', r.ok ? 'money' : 'error');
          if (r.ok) host.selectTrain(r.train!.id);
          break;
        }
        case 'upgrade': {
          const best = g.bestEngineFor(t);
          if (!best) return;
          const ok = confirmModal(host, `Replace ${engineDef(t).name} with a new ${best.name}?`, `After the trade-in the upgrade costs ${fmtMoney(best.price - engineTradeIn(t, g.tick))}.`, 'Upgrade');
          ok.then((yes) => {
            if (!yes) return;
            const r = g.upgradeEngine(t.id);
            host.toast(r.ok ? `${t.name} now runs a ${best.name} (${fmtMoney(r.cost)})` : r.error ?? 'Cannot upgrade.', r.ok ? 'money' : 'error');
            host.invalidatePanel();
          });
          break;
        }
        case 'sell': {
          confirmModal(host, `Sell ${t.name}?`, `You will receive ${fmtMoney(resaleValue(t, g.tick))}. Cargo on board is lost.`, 'Sell').then((yes) => {
            if (!yes) return;
            const r = g.sellTrain(t.id);
            host.toast(r.ok ? `Sold ${t.name} for ${fmtMoney(-r.cost)}` : r.error ?? 'Cannot sell.', r.ok ? 'money' : 'error');
            host.selectTrain(null);
          });
          break;
        }
      }
      host.invalidatePanel();
    }),
  );
}

/** Small confirmation dialog for risky actions. */
export function confirmModal(host: TrainUiHost, title: string, body: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const m = host.openModal(`<h2>${esc(title)}</h2><p>${esc(body)}</p>
      <div class="actions"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="yes">${esc(okLabel)}</button></div>`);
    m.querySelector<HTMLElement>('[data-a="no"]')!.addEventListener('click', () => {
      host.closeModal();
      resolve(false);
    });
    const yes = m.querySelector<HTMLElement>('[data-a="yes"]')!;
    yes.addEventListener('click', () => {
      host.closeModal();
      resolve(true);
    });
    yes.focus();
  });
}

// ---------------------------------------------------------------------------------------
// Station cargo (appended to the station inspector)
// ---------------------------------------------------------------------------------------

export function stationEconomyHtml(game: Game, st: Station): string {
  const se = game.economy.station(st.id);
  const sc = game.economy.cargoAt(st.id);
  if (!se) return '';
  const cap = ECONOMY.maxWaitingMonths;
  const waiting = Object.entries(se.supply)
    .filter(([, rate]) => rate > 0.01)
    .sort((a, b) => b[1] - a[1])
    .map(([cargo, rate]) => {
      const have = sc.waiting[cargo] ?? 0;
      const pct = Math.min(100, (have / Math.max(0.01, rate * cap)) * 100);
      return `<div class="gauge" data-tip="${esc(CARGO_BY_ID.get(cargo)?.name ?? cargo)}: ${have.toFixed(1)} loads waiting, ${rate.toFixed(1)} per month (holds up to ${cap} months)">
        ${chip(cargo)}<span class="bar"><i style="width:${pct.toFixed(0)}%"></i></span><b>${Math.floor(have)}</b><small>+${rate.toFixed(1)}/mo</small></div>`;
    })
    .join('');
  // Processor output arrives monthly and is not part of the steady supply.
  const extra = Object.entries(sc.waiting)
    .filter(([cargo, v]) => v >= 0.5 && !(cargo in se.supply))
    .map(([cargo, v]) => `<div class="gauge">${chip(cargo)}<span class="bar"><i style="width:100%"></i></span><b>${Math.floor(v)}</b><small>made here</small></div>`)
    .join('');
  const accepts = [...se.accepts].map((c) => chip(c)).join(' ');
  // Loads set down for other trains, by cargo and (travellers) destination.
  const lots = new Map<string, { cargo: string; dest: number; n: number }>();
  for (const l of sc.transfer ?? []) {
    const k = `${l.cargo}:${l.dest}`;
    const e = lots.get(k) ?? { cargo: l.cargo, dest: l.dest, n: 0 };
    e.n++;
    lots.set(k, e);
  }
  const transfer = [...lots.values()]
    .sort((a, b) => b.n - a.n)
    .map((e) => `<div class="kv">${chip(e.cargo)}<span class="grow">${e.dest >= 0 ? `→ ${esc(game.world.stations[e.dest]?.name ?? '?')}` : ''}</span><b>${e.n}</b></div>`)
    .join('');
  const bound = Object.entries(sc.dest ?? {})
    .map(([cargo, b]) => {
      const list = Object.entries(b)
        .filter(([, v]) => v >= 0.5)
        .sort((x, y) => y[1] - x[1])
        .slice(0, 5)
        .map(([d, v]) => `${esc(game.world.stations[Number(d)]?.name ?? '?')} ${Math.floor(v)}`)
        .join(' · ');
      return list ? `<div class="kv">${chip(cargo)}<small class="grow">${list}</small></div>` : '';
    })
    .join('');
  const delivered = Object.entries(sc.delivered)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => row(CARGO_BY_ID.get(c)?.name ?? c, `${fmtInt(n)} loads`, 'sub'))
    .join('');
  return `
    <div class="section">Waiting (supply)</div>
    ${waiting || extra ? waiting + extra : '<p class="hint">Nothing produced in reach.</p>'}
    ${bound ? `<div class="section" data-tip="Passengers and mail wait for a train towards their own station">Travelling to</div>${bound}` : ''}
    ${transfer ? `<div class="section" data-tip="Set down by trains with a transfer order (or travellers changing trains); picked up by any train that can carry them on">Waiting to transfer</div>${transfer}` : ''}
    <div class="section">Pays full price for (demand)</div>
    <div class="cars">${accepts || '<span class="hint">Nothing — other cargo pays ' + Math.round(ECONOMY.models[game.economy.model].nonDemandedFactor * 100) + '%</span>'}</div>
    <div class="section">Delivered here this year · ${fmtMoney(sc.revenue)}</div>
    ${delivered || '<p class="hint">Nothing yet.</p>'}
    ${row('Platforms in use', `${game.trains.signals.platformCount(st.id)} / ${stationPlatforms(st)}`)}
    ${st.owner === game.company.id && !game.over ? `<div class="actions"><button class="btn small" data-act="newtrain" data-station="${st.id}">New train from here</button></div>` : ''}`;
}

// ---------------------------------------------------------------------------------------
// Buy / edit train dialog
// ---------------------------------------------------------------------------------------

interface Draft {
  engine: string;
  cars: string[];
  route: RouteStop[];
}

function estimateHtml(est: TrainEstimate, game: Game): string {
  if (!est.ok) return `<p class="bad">${esc(est.error ?? '')}</p>`;
  const legs = est.legs
    .map((l) => {
      const a = game.world.stations[l.from]!;
      const b = game.world.stations[l.to]!;
      return `<tr><td>${esc(a.name)} → ${esc(b.name)}</td><td>${tilesToMiles(l.tiles).toFixed(1)} mi</td><td>${l.days.toFixed(1)} d</td><td class="${l.maxGrade > 3.5 ? 'bad' : ''}">${l.maxGrade.toFixed(1)}%</td><td>${Math.round(l.crawl)} mph</td><td>${fmtMoney(l.revenue)}</td></tr>`;
    })
    .join('');
  const pay = Number.isFinite(est.paybackYears) ? `${est.paybackYears.toFixed(1)} years` : 'never at current supply';
  return `
    <table class="table compact"><thead><tr><th>Leg</th><th>Length</th><th>Time</th><th>Max grade</th><th>Slowest</th><th>Revenue/yr</th></tr></thead><tbody>${legs}</tbody></table>
    <div class="est">
      ${row('Round trip', `${est.roundTripDays.toFixed(1)} days (${est.tripsPerYear.toFixed(1)}/yr)`)}
      ${row('Revenue / yr', fmtMoney(est.revenuePerYear))}
      ${row('Running costs / yr', fmtMoney(est.costsPerYear), 'sub')}
      ${row('Profit / yr', `<span class="${est.profitPerYear < 0 ? 'bad' : ''}">${fmtMoney(est.profitPerYear)}</span>`, 'total')}
      ${row('Payback (train)', pay)}
    </div>
    <p class="hint">Estimate from current supply, demand and grades: revenue = (base + per-mile × miles) × time × demand (incl. saturation at the steady rate this train delivers) × economy × bonuses, per load.</p>`;
}

export function openTrainDialog(host: TrainUiHost, trainId?: number, presetStations?: number[]): void {
  const game = host.game;
  const existing = trainId !== undefined ? game.trains.byId(trainId) : undefined;
  if (game.over) {
    host.toast('You no longer run a railroad.', 'error');
    return;
  }
  if (existing && existing.owner !== game.company.id) return;
  const stations = game.world
    .liveStations()
    .filter((s) => s.owner === game.company.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (stations.length < 2) {
    host.toast('Build at least two connected stations first.', 'error');
    return;
  }
  const engines = enginesAvailable(game.year);
  const startStations = presetStations ?? [stations[0].id, stations[1].id];
  const draft: Draft = existing
    ? { engine: existing.engine, cars: existing.cars.map((c) => c.cargo), route: existing.route.map((r) => ({ ...r })) }
    : {
        engine: engines[0]?.id ?? '',
        cars: [],
        route: startStations.map((s) => ({ station: s, load: 'auto', waitFull: false })),
      };
  if (!existing) draft.cars = suggestConsist(game, draft.engine, draft.route);
  const cargoOptions = CARGO.filter((c) => game.year >= c.era[0] && game.year <= c.era[1]);

  const m = host.openModal('<div class="traindlg"></div>', 'wide');
  const root = m.querySelector<HTMLElement>('.traindlg')!;

  const render = () => {
    const e = engines.find((x) => x.id === draft.engine) ?? (existing ? engineDef(existing) : undefined);
    const maxCars = e?.maxCars ?? 1;
    if (draft.cars.length > maxCars) draft.cars.length = maxCars;
    const price = existing ? 0 : consistPrice(draft.engine, draft.cars);
    const est = estimateTrain(game, draft.engine, draft.cars, draft.route, existing ? resaleValue(existing, game.tick) : price);
    const engineCards = existing
      ? `<p>${esc(engineDef(existing).name)} — use <b>Upgrade engine</b> in the train panel to replace it.</p>`
      : `<div class="engines">${engines
          .map(
            (x) => `<button class="btn engine" data-engine="${x.id}" aria-pressed="${x.id === draft.engine}" ${x.price > game.company.cash ? 'data-poor="1"' : ''}>
            <b>${esc(x.name)}</b><small>${fmtMoney(x.price)} · ${x.topSpeed} mph · ${fmtInt(x.power)} hp · ${x.maxCars} cars · ${Math.round(x.reliability * 100)}% · ${x.fuel}</small></button>`,
          )
          .join('')}</div>`;
    const stationOpts = (sel: number) => stations.map((s) => `<option value="${s.id}"${s.id === sel ? ' selected' : ''}>${esc(s.name)} (${esc(stationDef(s.kind).name)})</option>`).join('');
    const routeRows = draft.route
      .map(
        (r, i) => `<li><span class="num">${i + 1}</span><select data-stop="${i}">${stationOpts(r.station)}</select>
          <button class="btn small" data-del="${i}" ${draft.route.length <= 2 ? 'disabled' : ''} aria-label="Remove stop">×</button>
          <select data-load="${i}" data-tip="Loading at this stop"><option value="auto"${r.load === 'auto' ? ' selected' : ''}>Auto-load best paying</option><option value="keep"${r.load === 'keep' ? ' selected' : ''}>Keep car types</option></select>
          <label class="check"><input type="checkbox" data-full="${i}"${r.waitFull ? ' checked' : ''}/> wait for full load</label>
          <label class="check" data-tip="Set everything down here for other trains to carry on. It is paid when it reaches a station that wants it — from the station it was first loaded at — and shared between the trains by distance."><input type="checkbox" data-transfer="${i}"${r.transfer ? ' checked' : ''}/> transfer</label>
</li>`,
      )
      .join('');
    const specials = Object.entries(SPECIAL_CARS).map(([id, car]) => {
      const def = CAR_BY_ID.get(car);
      const b = def?.bonus ?? {};
      const what = [b.freight ? `freight +${Math.round((b.freight - 1) * 100)}%` : '', b.passengers ? `passengers +${Math.round((b.passengers - 1) * 100)}%` : '', b.breakdown ? `breakdowns −${Math.round((1 - b.breakdown) * 100)}%` : ''].filter(Boolean).join(', ');
      return { id, label: `${def?.name ?? car} (${what})` };
    });
    const cargoOpts = (sel: string) =>
      cargoOptions.map((c) => `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${esc(c.name)} (${esc(CAR_BY_ID.get(c.car)?.name ?? c.car)})</option>`).join('') +
      `<optgroup label="Extras (one counts per train)">${specials.map((x) => `<option value="${x.id}"${x.id === sel ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</optgroup>`;
    const carRows = draft.cars
      .map((c, i) => `<li><span class="num">${i + 1}</span><select data-car="${i}">${cargoOpts(c)}</select><button class="btn small" data-delcar="${i}" ${draft.cars.length <= 1 ? 'disabled' : ''} aria-label="Remove car">×</button></li>`)
      .join('');
    const extraCost = existing ? consistDelta(existing, draft.cars) : 0;
    root.innerHTML = `
      <h2>${existing ? `Edit ${esc(existing.name)}` : 'New train'}</h2>
      ${
        !existing && game.templates.length
          ? `<div class="row tpl-row"><label for="tpl">From template</label><select id="tpl"><option value="">—</option>${game.templates
              .map((t) => `<option value="${t.id}">${esc(t.name)}</option>`)
              .join('')}</select><button class="btn small" data-act="tplrev" data-tip="Load the selected template with its route reversed">Reversed</button></div>`
          : ''
      }
      <div class="cols">
        <section>
          <div class="section">Engine</div>
          ${engineCards}
        </section>
        <section>
          <div class="section">Route</div>
          <ol class="stops">${routeRows}</ol>
          <button class="btn small" data-act="addstop">+ Add stop</button>
          <div class="section">Cars (${draft.cars.length}/${maxCars})</div>
          <ol class="stops">${carRows}</ol>
          <button class="btn small" data-act="addcar" ${draft.cars.length >= maxCars ? 'disabled' : ''}>+ Add car</button>
          <button class="btn small" data-act="suggest">Suggest cars</button>
        </section>
      </div>
      <div class="section">Estimate</div>
      ${estimateHtml(est, game)}
      <div class="actions">
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="ok">${existing ? `Apply${extraCost ? ` (${fmtMoney(extraCost)})` : ''}` : `Buy for ${fmtMoney(price)}`}</button>
      </div>`;
    bind();
  };

  const bind = () => {
    root.querySelectorAll<HTMLButtonElement>('[data-engine]').forEach((b) =>
      b.addEventListener('click', () => {
        draft.engine = b.dataset.engine!;
        render();
      }),
    );
    root.querySelectorAll<HTMLSelectElement>('[data-stop]').forEach((s) =>
      s.addEventListener('change', () => {
        draft.route[Number(s.dataset.stop)].station = Number(s.value);
        render();
      }),
    );
    root.querySelectorAll<HTMLSelectElement>('[data-load]').forEach((s) =>
      s.addEventListener('change', () => {
        draft.route[Number(s.dataset.load)].load = s.value as RouteStop['load'];
        render();
      }),
    );
    root.querySelectorAll<HTMLInputElement>('[data-full]').forEach((s) =>
      s.addEventListener('change', () => {
        draft.route[Number(s.dataset.full)].waitFull = s.checked;
        render();
      }),
    );
    root.querySelectorAll<HTMLInputElement>('[data-transfer]').forEach((s) =>
      s.addEventListener('change', () => {
        const r = draft.route[Number(s.dataset.transfer)];
        if (s.checked) r.transfer = true;
        else delete r.transfer;
        render();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) =>
      b.addEventListener('click', () => {
        draft.route.splice(Number(b.dataset.del), 1);
        render();
      }),
    );
    root.querySelectorAll<HTMLSelectElement>('[data-car]').forEach((s) =>
      s.addEventListener('change', () => {
        draft.cars[Number(s.dataset.car)] = s.value;
        render();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-delcar]').forEach((b) =>
      b.addEventListener('click', () => {
        draft.cars.splice(Number(b.dataset.delcar), 1);
        render();
      }),
    );
    const act = (name: string, fn: () => void) => root.querySelector<HTMLElement>(`[data-act="${name}"]`)?.addEventListener('click', fn);
    act('addstop', () => {
      const last = draft.route[draft.route.length - 1].station;
      const next = stations.find((s) => s.id !== last) ?? stations[0];
      draft.route.push({ station: next.id, load: 'auto', waitFull: false });
      render();
    });
    act('addcar', () => {
      draft.cars.push([...draft.cars].reverse().find((c) => !isSpecialCar(c)) ?? 'passengers');
      render();
    });
    const loadTemplate = (reverse: boolean) => {
      const id = Number(root.querySelector<HTMLSelectElement>('#tpl')?.value);
      const tpl = game.templates.find((x) => x.id === id);
      if (!tpl) return;
      if (engines.some((x) => x.id === tpl.engine)) draft.engine = tpl.engine;
      draft.cars = [...tpl.cargos];
      const r = tpl.route.map((x) => ({ ...x }));
      draft.route = reverse ? r.reverse() : r;
      render();
      const sel = root.querySelector<HTMLSelectElement>('#tpl');
      if (sel) sel.value = String(id);
    };
    root.querySelector<HTMLSelectElement>('#tpl')?.addEventListener('change', () => loadTemplate(false));
    act('tplrev', () => loadTemplate(true));
    act('suggest', () => {
      draft.cars = suggestConsist(game, draft.engine, draft.route);
      render();
    });
    act('cancel', () => host.closeModal());
    act('ok', () => {
      if (existing) {
        const r1 = game.setRoute(existing.id, draft.route);
        if (!r1.ok) return host.toast(r1.error ?? 'Invalid route.', 'error');
        const r2 = game.setConsist(existing.id, draft.cars);
        if (!r2.ok) return host.toast(r2.error ?? 'Cannot change cars.', 'error');
        host.toast(`${existing.name} updated${r2.cost ? ` (${fmtMoney(r2.cost)})` : ''}`, 'money');
        host.closeModal();
        host.invalidatePanel();
        return;
      }
      const r = game.buyTrain(draft.engine, draft.cars, draft.route);
      if (!r.ok) return host.toast(r.error ?? 'Cannot buy this train.', 'error');
      host.toast(`${r.train!.name} (${engineDef(r.train!).name}) bought for ${fmtMoney(r.cost)}`, 'money');
      host.sfx?.('whistle');
      host.closeModal();
      host.selectTrain(r.train!.id);
    });
  };
  render();
}

function consistDelta(t: Train, cargos: string[]): number {
  let buy = 0;
  let sell = 0;
  cargos.forEach((c, i) => {
    const type = carForCargo(c);
    if (t.cars[i]?.type !== type) buy += CAR_BY_ID.get(type)?.price ?? 2000;
  });
  t.cars.forEach((c, i) => {
    if (cargos[i] === undefined || carForCargo(cargos[i]) !== c.type) sell += (CAR_BY_ID.get(c.type)?.price ?? 2000) * 0.5;
  });
  return Math.round(buy - sell);
}

// ---------------------------------------------------------------------------------------
// Fleet list
// ---------------------------------------------------------------------------------------

type SortKey = 'name' | 'engine' | 'state' | 'age' | 'reliability' | 'load' | 'profit' | 'last' | 'breakdown';

const fleetState = { sort: 'profit' as SortKey, desc: true, selected: new Set<number>() };

export function openFleet(host: TrainUiHost & { follow(id: number): void }): void {
  const game = host.game;
  const st = fleetState;
  const m = host.openModal('<div class="fleet"></div>', 'wide fleet-modal');
  const root = m.querySelector<HTMLElement>('.fleet')!;
  const value = (t: Train, k: SortKey): number | string => {
    switch (k) {
      case 'name':
        return t.id;
      case 'engine':
        return engineDef(t).name;
      case 'state':
        return t.state;
      case 'age':
        return engineAgeYears(t, game.tick);
      case 'reliability':
        return engineDef(t).reliability;
      case 'load':
        return t.stats.loadFactor;
      case 'profit':
        return annualProfit(t);
      case 'last':
        return t.stats.lastRevenue - t.stats.lastCosts;
      case 'breakdown':
        return t.stats.lastBreakdownTick;
    }
  };
  const ago = (tick: number) => {
    if (tick < 0) return 'never';
    const d = (game.tick - tick) / TIME.ticksPerDay;
    return d < 60 ? `${Math.floor(d)} d ago` : `${Math.floor(d / 30.4)} mo ago`;
  };
  const render = () => {
    const mine = game.trains.trains.filter((t) => t.owner === game.company.id);
    for (const id of [...st.selected]) if (!mine.some((t) => t.id === id)) st.selected.delete(id);
    const rows = [...mine].sort((a, b) => {
      const va = value(a, st.sort);
      const vb = value(b, st.sort);
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return st.desc ? -c : c;
    });
    const th = (k: SortKey, label: string, tip = '') =>
      `<th><button class="sort" data-sort="${k}" ${tip ? `data-tip="${esc(tip)}"` : ''} aria-sort="${st.sort === k ? (st.desc ? 'descending' : 'ascending') : 'none'}">${esc(label)}${st.sort === k ? (st.desc ? ' ▼' : ' ▲') : ''}</button></th>`;
    const total = rows.reduce((s2, t) => s2 + annualProfit(t), 0);
    const n = st.selected.size;
    const tpls = game.templates;
    root.innerHTML = `
      <h2>Trains (${rows.length}) · ${fmtMoney(Math.round(total))}/yr over the last 12 months</h2>
      <div class="fleet-tools">
        <span>Select:</span>
        <button class="btn small" data-selq="all">All</button>
        <button class="btn small" data-selq="none">None</button>
        <button class="btn small" data-selq="old" data-tip="Engines older than their design life">Worn out</button>
        <button class="btn small" data-selq="old25" data-tip="Engines older than 25 years">&gt; 25 yrs</button>
        <button class="btn small" data-selq="losing" data-tip="Losing money over the last 12 months">Losing</button>
        <button class="btn small" data-selq="low" data-tip="Leaving stations less than 30% full">Low load</button>
        <span class="grow"></span>
        <b>${n} selected</b>
        <button class="btn small" data-bulk="upgrade" ${n ? '' : 'disabled'} data-tip="Replace the engines of the selected trains with the best on sale">Upgrade engines</button>
        <button class="btn small" data-bulk="route" ${n && tpls.length ? '' : 'disabled'} data-tip="Give the selected trains the route of a template">Route from template</button>
        <button class="btn small danger" data-bulk="sell" ${n ? '' : 'disabled'}>Sell</button>
      </div>
      ${
        rows.length
          ? `<div class="scroll"><table class="table fleet-table"><thead><tr><th><input type="checkbox" data-all aria-label="Select all" ${n && n === rows.length ? 'checked' : ''}></th>${th('name', 'Train')}${th('engine', 'Engine')}${th('state', 'Status')}${th('age', 'Age')}${th('reliability', 'Rel.', 'Engine reliability')}${th('load', 'Load', 'Share of cars loaded on departure')}${th('profit', 'Profit/yr', 'Net profit over the last 12 months')}${th('last', 'Last year')}${th('breakdown', 'Breakdown', 'Last breakdown')}</tr></thead><tbody>
        ${rows
          .map((t) => {
            const e = engineDef(t);
            const age = engineAgeYears(t, game.tick);
            const p = annualProfit(t);
            return `<tr data-train="${t.id}" tabindex="0" class="${st.selected.has(t.id) ? 'sel' : ''}">
              <td><input type="checkbox" data-pick="${t.id}" aria-label="Select ${esc(t.name)}" ${st.selected.has(t.id) ? 'checked' : ''}></td>
              <td>${esc(t.name)}</td><td>${esc(e.name)}</td>
              <td class="${t.state === 'noroute' || t.state === 'broken' ? 'bad' : ''}">${esc(STATE_LABEL[t.state])}</td>
              <td class="${age > e.lifespan ? 'warn' : ''}">${years(age)}</td>
              <td>${Math.round(e.reliability * 100)}%</td>
              <td class="${t.stats.loadFactor >= 0 && t.stats.loadFactor < 0.3 ? 'warn' : ''}">${t.stats.loadFactor >= 0 ? `${Math.round(t.stats.loadFactor * 100)}%` : '—'}</td>
              <td class="${p < 0 ? 'bad' : ''}">${fmtMoney(Math.round(p))}</td>
              <td>${fmtMoney(t.stats.lastRevenue - t.stats.lastCosts)}</td>
              <td>${ago(t.stats.lastBreakdownTick)}</td></tr>`;
          })
          .join('')}
        </tbody></table></div>`
          : '<p class="hint">No trains yet. Build two stations, connect them with track and buy a train.</p>'
      }
      <div class="section">Route templates</div>
      ${
        tpls.length
          ? `<table class="table compact"><tbody>${tpls
              .map(
                (t) => `<tr><td>${esc(t.name)}</td><td>${esc(ENGINE_NAME(t.engine))} · ${t.cargos.length} cars</td>
                <td class="right"><button class="btn small" data-tbuy="${t.id}">Buy</button> <button class="btn small" data-tbuyr="${t.id}">Buy reversed</button> <button class="btn small" data-tdel="${t.id}" aria-label="Delete template">×</button></td></tr>`,
              )
              .join('')}</tbody></table>`
          : '<p class="hint">Save a train as a template from its panel (<b>Save template</b>) to buy copies or reuse its route.</p>'
      }
      <div class="actions"><button class="btn" data-act="close">Close</button><button class="btn primary" data-act="new">New train</button></div>`;
    bind(rows);
  };
  const done = (r: BulkResult, verb: string) => {
    host.toast(r.done ? `${verb} ${r.done} train${r.done === 1 ? '' : 's'}${r.cost ? ` (${fmtMoney(Math.round(r.cost))})` : ''}${r.failed ? ` · ${r.failed} failed: ${r.errors.join(' ')}` : ''}` : r.errors.join(' ') || 'Nothing to do.', r.done ? 'money' : 'error');
    host.invalidatePanel();
    openFleet(host);
  };
  const bind = (rows: Train[]) => {
    root.querySelectorAll<HTMLButtonElement>('[data-sort]').forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.sort as SortKey;
        if (k === st.sort) st.desc = !st.desc;
        else {
          st.sort = k;
          st.desc = true;
        }
        render();
      }),
    );
    root.querySelectorAll<HTMLInputElement>('[data-pick]').forEach((c) => {
      c.addEventListener('click', (e) => e.stopPropagation());
      c.addEventListener('change', () => {
        const id = Number(c.dataset.pick);
        if (c.checked) st.selected.add(id);
        else st.selected.delete(id);
        render();
      });
    });
    root.querySelector<HTMLInputElement>('[data-all]')?.addEventListener('change', (e) => {
      st.selected = new Set((e.target as HTMLInputElement).checked ? rows.map((t) => t.id) : []);
      render();
    });
    root.querySelectorAll<HTMLButtonElement>('[data-selq]').forEach((b) =>
      b.addEventListener('click', () => {
        const q = b.dataset.selq;
        const pick =
          q === 'all' ? rows : q === 'none' ? [] : selectTrains(game, q === 'old' ? { pastLifespan: true } : q === 'old25' ? { olderThan: 25 } : q === 'losing' ? { losing: true } : { loadBelow: 0.3 });
        st.selected = new Set(pick.map((t) => t.id));
        render();
      }),
    );
    root.querySelector('[data-bulk="upgrade"]')?.addEventListener('click', () => {
      const ids = [...st.selected];
      const cost = ids.reduce((a, id) => {
        const t = game.trains.byId(id);
        const best = t && game.bestEngineFor(t);
        return a + (t && best ? best.price - engineTradeIn(t, game.tick) : 0);
      }, 0);
      confirmModal(host, `Upgrade ${ids.length} engine${ids.length === 1 ? '' : 's'}?`, `Each gets the best engine on sale; after trade-ins this costs about ${fmtMoney(Math.round(cost))}.`, 'Upgrade').then((yes) => {
        if (!yes) return openFleet(host);
        done(upgradeEngines(game, ids), 'Upgraded');
      });
    });
    root.querySelector('[data-bulk="sell"]')?.addEventListener('click', () => {
      const ids = [...st.selected];
      const value = ids.reduce((a, id) => {
        const t = game.trains.byId(id);
        return a + (t ? resaleValue(t, game.tick) : 0);
      }, 0);
      confirmModal(host, `Sell ${ids.length} train${ids.length === 1 ? '' : 's'}?`, `You receive about ${fmtMoney(Math.round(value))}. Cargo on board is lost.`, 'Sell').then((yes) => {
        if (!yes) return openFleet(host);
        st.selected.clear();
        done(sellTrains(game, ids), 'Sold');
      });
    });
    root.querySelector('[data-bulk="route"]')?.addEventListener('click', () => {
      const ids = [...st.selected];
      const mm = host.openModal(`<h2>Route for ${ids.length} train${ids.length === 1 ? '' : 's'}</h2>
        <p>Pick a template; its route replaces theirs (cars stay as they are).</p>
        <div class="actions wrap">${game.templates.map((t) => `<button class="btn small" data-use="${t.id}">${esc(t.name)}</button>`).join('')}</div>
        <div class="actions"><button class="btn" data-a="no">Cancel</button></div>`);
      mm.querySelector('[data-a="no"]')!.addEventListener('click', () => openFleet(host));
      mm.querySelectorAll<HTMLElement>('[data-use]').forEach((b) =>
        b.addEventListener('click', () => {
          const tpl = game.templates.find((t) => t.id === Number(b.dataset.use))!;
          done(setRoutes(game, ids, tpl.route), 'Re-routed');
        }),
      );
    });
    root.querySelectorAll<HTMLElement>('[data-tbuy], [data-tbuyr]').forEach((b) =>
      b.addEventListener('click', () => {
        const rev = b.dataset.tbuyr !== undefined;
        const r = game.buyFromTemplate(Number(b.dataset.tbuy ?? b.dataset.tbuyr), rev);
        host.toast(r.ok ? `Bought ${r.train!.name} (${fmtMoney(r.cost)})` : r.error ?? 'Cannot buy.', r.ok ? 'money' : 'error');
        host.invalidatePanel();
        render();
      }),
    );
    root.querySelectorAll<HTMLElement>('[data-tdel]').forEach((b) =>
      b.addEventListener('click', () => {
        game.deleteTemplate(Number(b.dataset.tdel));
        render();
      }),
    );
    root.querySelectorAll<HTMLElement>('tr[data-train]').forEach((r) => {
      const go = () => {
        host.closeModal();
        host.selectTrain(Number(r.dataset.train));
        host.follow(Number(r.dataset.train));
      };
      r.addEventListener('click', go);
      r.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    });
    root.querySelector('[data-act="close"]')?.addEventListener('click', () => host.closeModal());
    root.querySelector('[data-act="new"]')?.addEventListener('click', () => openTrainDialog(host));
  };
  render();
}

const ENGINE_NAME = (id: string) => ENGINE_BY_ID.get(id)?.name ?? id;
