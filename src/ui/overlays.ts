import { CARGO, CARGO_BY_ID, ECONOMY, INDUSTRIES, INDUSTRY_BY_ID } from '../data';
import { PALETTE } from '../render/palette';
import type { HeatMap, Highlight } from '../render/renderer';
import type { Game } from '../sim/game';
import { OVERLAY_KINDS, computeOverlay, type OverlayField, type OverlayKind } from '../sim/overlays';
import { $, esc } from './dom';
import { fmtMoney } from './tools';
import type { TrainUiHost } from './trains';

/** Colour-blind-safe ramps: light blue → orange/red for amounts, orange ↔ blue around zero. */
const SEQ = { colors: [PALETTE.foam, PALETTE.sky, PALETTE.gold, PALETTE.ember, PALETTE.tile], density: [0.25, 0.5, 0.5, 0.75, 0.75] };
const DIV = { colors: [PALETTE.tile, PALETTE.ember, PALETTE.fog, PALETTE.shallow, PALETTE.sky], density: [0.75, 0.5, 0.25, 0.5, 0.75] };

export interface OverlayState {
  kind: OverlayKind | null;
  cargo: string;
  field: OverlayField | null;
  heat: HeatMap | null;
  /** Industries highlighted by the supply-chain explorer. */
  chain: Highlight[];
  chainCargo: string | null;
}

export const overlay: OverlayState = { kind: null, cargo: 'passengers', field: null, heat: null, chain: [], chainCargo: null };

function fmtValue(f: OverlayField, v: number): string {
  if (f.unit === '$/yr') return fmtMoney(Math.round(v));
  if (f.unit === 'stations') return String(Math.round(v));
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/** Bucket thresholds for a field. */
function thresholds(f: OverlayField): number[] {
  if (f.kind === 'gradient') return [1, 2, 3.5, 5];
  if (f.kind === 'catchment') return [2, 3, 4, 5];
  if (f.diverging) {
    const a = Math.max(Math.abs(f.min), Math.abs(f.max), 1e-6) * 0.5;
    return [-a, -a * 0.2, a * 0.2, a];
  }
  const m = Math.max(f.max, 1e-6);
  return [m * 0.1, m * 0.25, m * 0.45, m * 0.7];
}

/** (Re)compute the active overlay from the game state. */
export function refreshOverlay(game: Game): void {
  if (!overlay.kind) {
    overlay.field = null;
    overlay.heat = null;
    renderLegend();
    return;
  }
  const f = computeOverlay(game, overlay.kind, overlay.cargo);
  const ramp = f.diverging ? DIV : SEQ;
  overlay.field = f;
  overlay.heat = { values: f.values, thresholds: thresholds(f), colors: ramp.colors, density: ramp.density };
  renderLegend();
}

export function setOverlay(game: Game, kind: OverlayKind | null, cargo?: string): void {
  overlay.kind = kind;
  if (cargo) overlay.cargo = cargo;
  refreshOverlay(game);
}

function legendEl(): HTMLElement {
  let el = document.getElementById('legend');
  if (!el) {
    el = document.createElement('div');
    el.id = 'legend';
    el.setAttribute('aria-live', 'polite');
    $('#app').appendChild(el);
  }
  return el;
}

function swatch(color: string, density: number): string {
  const cls = density >= 0.75 ? 'd3' : density >= 0.5 ? 'd2' : 'd1';
  return `<i class="dither ${cls}" style="--c:${color}"></i>`;
}

function renderLegend(): void {
  const el = legendEl();
  const f = overlay.field;
  const h = overlay.heat;
  if (!f || !h) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const def = OVERLAY_KINDS.find((k) => k.id === f.kind)!;
  const t = h.thresholds;
  const label = (k: number) => {
    if (k === 0) return `&lt; ${fmtValue(f, t[0])}`;
    if (k === t.length) return `≥ ${fmtValue(f, t[t.length - 1])}`;
    return `${fmtValue(f, t[k - 1])} – ${fmtValue(f, t[k])}`;
  };
  const rows = h.colors.map((c, k) => `<li>${swatch(c, h.density[k])}<span>${label(k)}</span></li>`).join('');
  const cargo = f.cargo ? ` · ${esc(CARGO_BY_ID.get(f.cargo)?.name ?? f.cargo)}` : '';
  el.innerHTML = `<div class="lg-title"><b>${esc(def.name)}${cargo}</b> <small>${esc(f.unit)}</small></div>
    <ul>${rows}</ul>
    <small>${esc(def.desc)}</small>
    <div class="lg-keys"><kbd>J</kbd> change · <kbd>Shift+J</kbd> off</div>`;
  el.hidden = false;
}

/** Cargo that appears on this map in this era (produced or demanded somewhere). */
function cargoOnMap(game: Game): string[] {
  const seen = new Set<string>(Object.keys(ECONOMY.townSupply));
  for (const ind of game.world.industries) {
    const d = INDUSTRY_BY_ID.get(ind.defId);
    for (const c of d?.produces ?? []) seen.add(c);
    for (const c of d?.consumes ?? []) seen.add(c);
  }
  for (const lvl of ECONOMY.townDemand) for (const c of lvl) seen.add(c);
  return CARGO.filter((c) => seen.has(c.id) && game.year >= c.era[0] && game.year <= c.era[1]).map((c) => c.id);
}

export function openOverlayPicker(host: TrainUiHost, onChange: () => void): void {
  const game = host.game;
  const cargos = cargoOnMap(game);
  const opts = cargos.map((id) => `<option value="${id}"${id === overlay.cargo ? ' selected' : ''}>${esc(CARGO_BY_ID.get(id)?.name ?? id)}</option>`).join('');
  const m = host.openModal(`
    <h2>Map overlays</h2>
    <div class="overlay-grid">
      <button class="btn" data-ov="" aria-pressed="${overlay.kind === null}">Off</button>
      ${OVERLAY_KINDS.map((k) => `<button class="btn" data-ov="${k.id}" aria-pressed="${overlay.kind === k.id}" data-tip="${esc(k.desc)}">${esc(k.name)}${k.cargo ? '…' : ''}</button>`).join('')}
    </div>
    <div class="row"><label for="ov-cargo">Cargo (supply / demand)</label><select id="ov-cargo">${opts}</select></div>
    <p class="hint">Overlays update every month. Colours run from light blue (little) to red (a lot); profit and growth run from orange (negative) to blue (positive). The dither density grows with the value too, so you can read them without colour.</p>
    <div class="actions"><button class="btn" data-act="chains">Supply chains…</button><button class="btn primary" data-act="close">Close</button></div>`);
  const sel = m.querySelector<HTMLSelectElement>('#ov-cargo')!;
  m.querySelectorAll<HTMLButtonElement>('[data-ov]').forEach((b) =>
    b.addEventListener('click', () => {
      setOverlay(game, (b.dataset.ov || null) as OverlayKind | null, sel.value);
      onChange();
      host.closeModal();
    }),
  );
  sel.addEventListener('change', () => {
    overlay.cargo = sel.value;
    if (overlay.kind === 'supply' || overlay.kind === 'demand') {
      refreshOverlay(game);
      onChange();
    }
  });
  m.querySelector<HTMLElement>('[data-act="chains"]')!.addEventListener('click', () => openSupplyChains(host, onChange));
  m.querySelector<HTMLElement>('[data-act="close"]')!.addEventListener('click', () => host.closeModal());
}

// ---------------------------------------------------------------------------------------
// Supply-chain explorer
// ---------------------------------------------------------------------------------------

interface ChainNode {
  id: string;
  label: string;
  kind: 'industry' | 'cargo' | 'towns';
  col: number;
  count: number;
  cargo?: string;
}

/** Industry types, cargo and towns on this map as a layered graph: producers → cargo → users. */
export function chainGraph(game: Game): { nodes: ChainNode[]; edges: Array<[string, string]> } {
  const counts = new Map<string, number>();
  for (const ind of game.world.industries) counts.set(ind.defId, (counts.get(ind.defId) ?? 0) + 1);
  const defs = INDUSTRIES.filter((d) => counts.has(d.id));
  const cargos = new Set(cargoOnMap(game));
  const nodes = new Map<string, ChainNode>();
  const edges: Array<[string, string]> = [];
  // Depth: raw industries 0, their cargo 1, processors 2, products 3, …
  const indDepth = new Map<string, number>();
  const cargoDepth = new Map<string, number>();
  for (const c of Object.keys(ECONOMY.townSupply)) cargoDepth.set(c, 1);
  for (const d of defs) if (d.kind === 'raw') indDepth.set(d.id, 0);
  for (let pass = 0; pass < 6; pass++) {
    for (const d of defs) {
      const dd = indDepth.get(d.id);
      if (dd !== undefined) for (const c of d.produces) cargoDepth.set(c, Math.max(cargoDepth.get(c) ?? 0, dd + 1));
      if (d.kind !== 'raw') {
        const ins = d.consumes.map((c) => cargoDepth.get(c) ?? 1);
        indDepth.set(d.id, Math.max(...ins, 1) + 1);
      }
    }
  }
  const townCol = Math.max(2, ...[...cargoDepth.values()].map((v) => v + 1));
  nodes.set('towns-src', { id: 'towns-src', label: 'Towns', kind: 'towns', col: 0, count: game.world.cities.length });
  nodes.set('towns', { id: 'towns', label: 'Towns', kind: 'towns', col: townCol, count: game.world.cities.length });
  for (const d of defs) nodes.set(`i:${d.id}`, { id: `i:${d.id}`, label: d.name, kind: 'industry', col: indDepth.get(d.id) ?? 0, count: counts.get(d.id) ?? 0 });
  const addCargo = (c: string) => {
    if (!cargos.has(c) || nodes.has(`c:${c}`)) return;
    nodes.set(`c:${c}`, { id: `c:${c}`, label: CARGO_BY_ID.get(c)?.name ?? c, kind: 'cargo', col: cargoDepth.get(c) ?? 1, count: 0, cargo: c });
  };
  for (const c of Object.keys(ECONOMY.townSupply)) {
    addCargo(c);
    if (nodes.has(`c:${c}`)) edges.push(['towns-src', `c:${c}`]);
  }
  for (const d of defs) {
    for (const c of d.produces) {
      addCargo(c);
      if (nodes.has(`c:${c}`)) edges.push([`i:${d.id}`, `c:${c}`]);
    }
    for (const c of d.consumes) {
      addCargo(c);
      if (nodes.has(`c:${c}`)) edges.push([`c:${c}`, `i:${d.id}`]);
    }
  }
  const townWants = new Set<string>();
  const classes = new Set(game.world.cities.map((c) => c.classIndex));
  for (const k of classes) for (const c of ECONOMY.townDemand[k] ?? []) townWants.add(c);
  for (const c of townWants) {
    addCargo(c);
    if (nodes.has(`c:${c}`)) edges.push([`c:${c}`, 'towns']);
  }
  return { nodes: [...nodes.values()], edges };
}

export function openSupplyChains(host: TrainUiHost, onChange: () => void): void {
  const game = host.game;
  const { nodes, edges } = chainGraph(game);
  const cols = Math.max(...nodes.map((n) => n.col)) + 1;
  const byCol: ChainNode[][] = Array.from({ length: cols }, () => []);
  for (const n of nodes) byCol[n.col].push(n);
  const BW = 176;
  const BH = 24;
  const GX = 16;
  const GY = 6;
  const height = Math.max(...byCol.map((c) => c.length)) * (BH + GY) + GY;
  const width = cols * (BW + GX) - GX + 8;
  const pos = new Map<string, [number, number]>();
  byCol.forEach((col, ci) => {
    const off = (height - col.length * (BH + GY)) / 2;
    col.forEach((n, k) => pos.set(n.id, [4 + ci * (BW + GX), Math.round(off + k * (BH + GY) + GY / 2)]));
  });
  const sel = overlay.chainCargo;
  const related = (e: [string, string]) => sel !== null && (e[0] === `c:${sel}` || e[1] === `c:${sel}`);
  const lines = edges
    .map((e) => {
      const [ax, ay] = pos.get(e[0])!;
      const [bx, by] = pos.get(e[1])!;
      const x0 = ax + BW;
      const y0 = ay + BH / 2;
      const x1 = bx;
      const y1 = by + BH / 2;
      const mx = Math.round((x0 + x1) / 2);
      return `<polyline class="${related(e) ? 'hot' : ''}" points="${x0},${y0} ${mx},${y0} ${mx},${y1} ${x1},${y1}"/>`;
    })
    .join('');
  const boxes = nodes
    .map((n) => {
      const [x, y] = pos.get(n.id)!;
      const color = n.cargo ? PALETTE[(CARGO_BY_ID.get(n.cargo)?.color ?? 'bone') as keyof typeof PALETTE] ?? PALETTE.bone : '';
      const label = `${n.label}${n.kind !== 'cargo' && n.count ? ` ×${n.count}` : ''}`;
      const cls = `node ${n.kind}${n.cargo && n.cargo === sel ? ' sel' : ''}`;
      return `<g class="${cls}" ${n.cargo ? `data-cargo="${n.cargo}" tabindex="0" role="button" aria-label="Show ${esc(n.label)} on the map"` : ''}>
        <rect x="${x}" y="${y}" width="${BW}" height="${BH}"/>
        ${n.cargo ? `<rect class="sw" x="${x + 4}" y="${y + 7}" width="10" height="10" style="fill:${color}"/>` : ''}
        <text x="${x + (n.cargo ? 19 : 5)}" y="${y + 17}">${esc(label.length > 17 ? `${label.slice(0, 16)}…` : label)}</text></g>`;
    })
    .join('');
  const m = host.openModal(
    `<h2>Supply chains on this map</h2>
    <p class="hint" style="margin-top:0">Raw industries and towns produce cargo (left); processors turn it into goods; towns and plants use them (right). Click a cargo to see where it is made and used.</p>
    <div class="chains scroll"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="crispEdges" role="img" aria-label="Supply chain diagram">
      <g class="edges">${lines}</g>${boxes}</svg></div>
    <div class="actions"><button class="btn" data-act="clear" ${sel ? '' : 'disabled'}>Clear highlight</button><button class="btn primary" data-act="close">Close</button></div>`,
    'wide chains-modal',
  );
  const pick = (cargo: string) => {
    showChain(game, cargo);
    setOverlay(game, 'supply', cargo);
    onChange();
    host.closeModal();
  };
  m.querySelectorAll<SVGGElement>('[data-cargo]').forEach((g) => {
    g.addEventListener('click', () => pick(g.dataset.cargo!));
    g.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && pick(g.dataset.cargo!));
  });
  m.querySelector<HTMLElement>('[data-act="clear"]')!.addEventListener('click', () => {
    clearChain();
    onChange();
    openSupplyChains(host, onChange);
  });
  m.querySelector<HTMLElement>('[data-act="close"]')!.addEventListener('click', () => host.closeModal());
}

/** Outline every industry that makes `cargo` (solid gold) or uses it (dashed sky); towns too. */
export function showChain(game: Game, cargo: string): void {
  const hl: Highlight[] = [];
  for (const ind of game.world.industries) {
    const d = INDUSTRY_BY_ID.get(ind.defId);
    if (!d) continue;
    if (d.produces.includes(cargo)) hl.push({ rect: [ind.x, ind.y, ind.w, ind.h], color: PALETTE.gold });
    else if (d.consumes.includes(cargo)) hl.push({ rect: [ind.x, ind.y, ind.w, ind.h], color: PALETTE.sky, dashed: true });
  }
  const supplies = (ECONOMY.townSupply[cargo] ?? 0) > 0;
  for (const c of game.world.cities) {
    const wants = (ECONOMY.townDemand[c.classIndex] ?? []).includes(cargo);
    if (!supplies && !wants) continue;
    const r = c.radius;
    hl.push({ rect: [c.x - r, c.y - r, 2 * r + 1, 2 * r + 1], color: supplies ? PALETTE.gold : PALETTE.sky, dashed: !supplies });
  }
  overlay.chain = hl;
  overlay.chainCargo = cargo;
}

export function clearChain(): void {
  overlay.chain = [];
  overlay.chainCargo = null;
}

