import { CONSTRUCTION, STATIONS } from '../data';
import type { Camera } from '../render/camera';
import { PALETTE, type PaletteName } from '../render/palette';
import { GRADE_CLASSES, gradeClass, type Highlight, type Overlay } from '../render/renderer';
import {
  PlannerScratch,
  TrackPlanner,
  bridgesAvailable,
  canHostTrack,
  defaultTrackOptions,
  planBulldoze,
  tilesToMiles,
  type CostBreakdown,
  type StationPlan,
  type TrackOptions,
  type TrackPlan,
} from '../sim/construction';
import type { Game } from '../sim/game';
import { catchmentRect, stationDef, type Coverage } from '../sim/station';
import { CARGO_BY_ID, INDUSTRY_BY_ID } from '../data';
import { estimateConnection } from '../sim/estimate';
import { esc, fmtInt } from './dom';
import { FEET_PER_LEVEL } from './inspector';

export function fmtMoney(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${fmtInt(Math.abs(n))}`;
}

export interface ToolHost {
  game: Game;
  camera: Camera;
  toast(message: string, kind?: 'info' | 'error' | 'money'): void;
  /** Ask the host to re-render the context panel. */
  invalidatePanel(): void;
  setTool(id: string): void;
}

export interface Tool {
  readonly id: string;
  readonly name: string;
  /** Left-drag pans the map when the tool doesn't use it. */
  readonly leftDragPans: boolean;
  activate?(): void;
  deactivate?(): void;
  /** Called with the tile under the pointer (null = off-map). Return true if handled. */
  pointerDown?(tile: [number, number] | null, button: number): boolean;
  pointerMove?(tile: [number, number] | null): void;
  pointerUp?(tile: [number, number] | null): void;
  key?(key: string): boolean;
  /** Per-frame work (e.g. time-sliced route search). */
  update?(): void;
  panelHtml(): string;
  bindPanel?(root: HTMLElement): void;
  overlay(): Overlay;
  /** Short status-bar hint. */
  hint(): string;
}

// ---------------------------------------------------------------------------------------
// Shared panel fragments
// ---------------------------------------------------------------------------------------

function row(label: string, value: string, cls = ''): string {
  return `<div class="kv ${cls}"><span>${esc(label)}</span><b>${value}</b></div>`;
}

const BREAKDOWN_LABELS: Array<[keyof CostBreakdown, string]> = [
  ['track', 'Rails'],
  ['earthworks', 'Earthworks'],
  ['clearing', 'Clearing'],
  ['crossings', 'Crossings'],
  ['doubling', 'Second track'],
  ['demolition', 'Demolition'],
  ['bridges', 'Bridges'],
  ['tunnels', 'Tunnels'],
  ['stations', 'Station'],
];

function breakdownHtml(b: CostBreakdown): string {
  return BREAKDOWN_LABELS.filter(([k]) => b[k] !== 0)
    .map(([k, label]) => row(label, fmtMoney(b[k]), 'sub'))
    .join('');
}

function costRow(cost: number, cash: number): string {
  const short = cost > cash;
  return row('Cost', `${fmtMoney(cost)}${short ? ' <em class="bad">(short ' + fmtMoney(cost - cash) + ')</em>' : ''}`, 'total');
}

function seg(name: string, options: Array<[string, string, boolean?]>, value: string): string {
  return `<div class="seg" role="group" data-seg="${name}">${options
    .map(
      ([v, label, disabled]) =>
        `<button class="btn small" data-value="${v}" aria-pressed="${v === value}"${disabled ? ' disabled' : ''}>${esc(label)}</button>`,
    )
    .join('')}</div>`;
}

function bindSegs(root: HTMLElement, onChange: (name: string, value: string) => void): void {
  root.querySelectorAll<HTMLElement>('[data-seg]').forEach((g) => {
    g.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.addEventListener('click', () => onChange(g.dataset.seg!, b.dataset.value!)),
    );
  });
}

/** Elevation profile as a crisp inline SVG, with grade-coloured segments and labels. */
export function profileSvg(plan: TrackPlan): string {
  const pts = plan.profile;
  if (pts.length < 2) return '';
  const Wd = 200;
  const Hd = 56;
  const total = pts[pts.length - 1].dist || 1;
  let zmin = Infinity;
  let zmax = -Infinity;
  for (const p of pts) {
    zmin = Math.min(zmin, p.z);
    zmax = Math.max(zmax, p.z);
  }
  const range = Math.max(2, zmax - zmin);
  const X = (d: number) => Math.round((d / total) * (Wd - 2)) + 1;
  const Y = (z: number) => Math.round(Hd - 4 - ((z - zmin) / range) * (Hd - 12));
  let segs = '';
  let fill = `M${X(0)},${Hd} `;
  for (const p of pts) fill += `L${X(p.dist)},${Y(p.z)} `;
  fill += `L${X(total)},${Hd} Z`;
  let k = 0;
  for (const st of plan.steps) {
    const cls = gradeClass(Math.abs(st.grade));
    const n = st.interior.length + 1;
    for (let j = 0; j < n; j++) {
      const a = pts[k + j];
      const b = pts[k + j + 1];
      if (!a || !b) continue;
      const dash = st.kind === 'bridge' || st.kind === 'tunnel' ? ' stroke-dasharray="3 2"' : '';
      segs += `<line x1="${X(a.dist)}" y1="${Y(a.z)}" x2="${X(b.dist)}" y2="${Y(b.z)}" stroke="${GRADE_CLASSES[cls].color}" stroke-width="2"${dash}/>`;
    }
    k += n;
  }
  const ft = (z: number) => `${fmtInt(z * FEET_PER_LEVEL)} ft`;
  return `<figure class="profile" aria-label="Elevation profile: from ${ft(pts[0].z)} to ${ft(pts[pts.length - 1].z)}, steepest grade ${plan.maxGrade.toFixed(1)} percent">
    <svg viewBox="0 0 ${Wd} ${Hd}" preserveAspectRatio="none" shape-rendering="crispEdges">
      <path d="${fill}" fill="${PALETTE.slate}"/>${segs}
    </svg>
    <figcaption><span>${ft(pts[0].z)}</span><span>${tilesToMiles(total).toFixed(1)} mi</span><span>${ft(pts[pts.length - 1].z)}</span></figcaption>
  </figure>`;
}

function gradeLegend(): string {
  return `<div class="legend">${GRADE_CLASSES.map((g) => `<span><i class="swatch" style="background:${g.color}"></i>${esc(g.label)}</span>`).join('')}</div>`;
}

function coverageHtml(cov: Coverage, radius: number): string {
  const towns = cov.cities.length
    ? cov.cities.map((c) => row(c.city.name, `${fmtInt(c.population)} people (${Math.round((100 * c.covered) / c.total)}%)`, 'sub')).join('')
    : `<p class="hint">No town in reach.</p>`;
  const inds = cov.industries.length
    ? cov.industries
        .map((ind) => {
          const def = INDUSTRY_BY_ID.get(ind.defId)!;
          const chips = def.produces
            .map((c) => {
              const cd = CARGO_BY_ID.get(c);
              return cd ? `<i class="swatch" style="background:${PALETTE[cd.color as PaletteName]}" title="${esc(cd.name)}"></i>${esc(cd.name)}` : '';
            })
            .join(' ');
          return row(def.name, chips, 'sub');
        })
        .join('')
    : `<p class="hint">No industry in reach.</p>`;
  return `<div class="section">Catchment (radius ${radius})</div>${towns}${inds}`;
}

// ---------------------------------------------------------------------------------------
// Track tool
// ---------------------------------------------------------------------------------------

export class TrackTool implements Tool {
  readonly id = 'track';
  readonly name = 'Lay track';
  readonly leftDragPans = false;
  opts: TrackOptions;
  private from: number | null = null;
  private hoverTile: number | null = null;
  private planner: TrackPlanner | null = null;
  private plan: TrackPlan | null = null;
  private readonly scratch = new PlannerScratch();

  constructor(private readonly host: ToolHost) {
    this.opts = defaultTrackOptions(host.game.year);
  }

  activate(): void {
    this.opts.year = this.host.game.year;
  }

  deactivate(): void {
    this.cancel();
  }

  private idx(t: [number, number] | null): number | null {
    return t ? this.host.game.world.tileIndex(t[0], t[1]) : null;
  }

  private cancel(): void {
    this.from = null;
    this.planner = null;
    this.plan = null;
    this.host.invalidatePanel();
  }

  /**
   * Where the route should end: the hovered tile, or — if that tile can't take track
   * (industry, water…) — its buildable neighbour nearest to the start.
   */
  private goal(): number | null {
    if (this.hoverTile === null || this.from === null) return null;
    const world = this.host.game.world;
    if (canHostTrack(world, this.hoverTile, this.opts)) return this.hoverTile;
    const fx = this.from % world.width;
    const fy = Math.floor(this.from / world.width);
    let best: number | null = null;
    let bestD = Infinity;
    for (let d = 0; d < 8; d++) {
      const n = world.track.neighbor(this.hoverTile, d);
      if (n < 0 || !canHostTrack(world, n, this.opts)) continue;
      const dist = Math.hypot((n % world.width) - fx, Math.floor(n / world.width) - fy);
      if (dist < bestD) {
        bestD = dist;
        best = n;
      }
    }
    return best ?? this.hoverTile;
  }

  private replan(): void {
    const goal = this.goal();
    if (this.from === null || goal === null) return;
    if (this.planner && this.planner.to === goal && this.planner.from === this.from) return;
    this.opts.year = this.host.game.year;
    this.planner = new TrackPlanner(this.host.game.world, this.from, goal, { ...this.opts }, this.scratch);
    this.update();
  }

  pointerDown(tile: [number, number] | null, button: number): boolean {
    if (button === 2 && this.from !== null) {
      this.cancel();
      return true;
    }
    if (button !== 0 || !tile) return false;
    this.from = this.idx(tile);
    this.hoverTile = this.from;
    this.plan = null;
    this.planner = null;
    this.host.invalidatePanel();
    return true;
  }

  pointerMove(tile: [number, number] | null): void {
    const i = this.idx(tile);
    if (i === this.hoverTile) return;
    this.hoverTile = i;
    if (this.from !== null) this.replan();
  }

  pointerUp(): void {
    if (this.from === null) return;
    const from = this.from;
    const to = this.goal();
    let plan = this.planner && this.planner.to === to ? this.planner.run(Infinity) : null;
    this.from = null;
    this.planner = null;
    if (to === null || to === from) {
      this.plan = null;
      this.host.invalidatePanel();
      return;
    }
    const r = this.host.game.buildTrack(from, to, { ...this.opts }, plan ?? undefined);
    plan = r.plan;
    if (r.ok) {
      this.host.toast(`Built ${tilesToMiles(plan.lengthTiles).toFixed(1)} mi of track for ${fmtMoney(r.cost)}`, 'money');
      this.plan = null;
    } else {
      this.host.toast(r.error ?? 'Cannot build here.', 'error');
      this.plan = null;
    }
    this.host.invalidatePanel();
  }

  key(k: string): boolean {
    if (k === 'escape' && this.from !== null) {
      this.cancel();
      return true;
    }
    if (k === 'v') {
      this.setOpt('double', this.opts.double ? 'single' : 'double');
      return true;
    }
    return false;
  }

  update(): void {
    if (!this.planner) return;
    const res = this.planner.run(6);
    if (res && res !== this.plan) {
      this.plan = res;
      this.host.invalidatePanel();
    }
  }

  private setOpt(name: string, value: string): void {
    if (name === 'double') this.opts.double = value === 'double';
    if (name === 'bridge') this.opts.bridge = value;
    if (name === 'tunnels') this.opts.tunnels = value === 'on';
    if (name === 'demolish') this.opts.demolish = value === 'on';
    this.planner = null;
    this.replan();
    this.host.invalidatePanel();
  }

  panelHtml(): string {
    const game = this.host.game;
    const avail = new Set(bridgesAvailable(game.year).map((b) => b.id));
    const options = `
      <div class="opt"><span>Track</span>${seg('double', [['single', 'Single'], ['double', 'Double']], this.opts.double ? 'double' : 'single')}</div>
      <div class="opt"><span>Bridges</span>${seg(
        'bridge',
        [['auto', 'Auto'], ...CONSTRUCTION.bridges.map((b): [string, string, boolean] => [b.id, b.id[0].toUpperCase() + b.id.slice(1), !avail.has(b.id)])],
        this.opts.bridge,
      )}</div>
      <div class="opt"><span>Tunnels</span>${seg('tunnels', [['on', 'Allow'], ['off', 'Avoid']], this.opts.tunnels ? 'on' : 'off')}</div>
      <div class="opt"><span>Houses</span>${seg('demolish', [['on', 'Raze'], ['off', 'Avoid']], this.opts.demolish ? 'on' : 'off')}</div>`;
    let body = '';
    const searching = this.from !== null && this.planner && !this.planner.done;
    if (this.from === null && !this.plan) {
      body = `<p class="hint">Drag from a tile (or the end of existing track) to where the line should go — the route follows the terrain automatically. Right-click or Esc cancels. <kbd>V</kbd> toggles double track.</p>`;
    } else if (searching && !this.plan) {
      body = `<p class="hint">Surveying a route…</p>`;
    } else if (this.plan && !this.plan.ok) {
      body = `<p class="bad">${esc(this.plan.error ?? 'No route.')}</p>`;
    } else if (this.plan) {
      const p = this.plan;
      const steep = p.maxGrade > 3.5 ? ' <em class="bad">steep</em>' : p.maxGrade > 2 ? ' <em class="warn">heavy</em>' : '';
      body = `
        ${costRow(p.cost, game.company.cash)}
        ${row('Length', `${tilesToMiles(p.lengthTiles).toFixed(1)} mi`)}
        ${row('Steepest grade', `${p.maxGrade.toFixed(1)}%${steep}`)}
        ${this.revenueHtml(p)}
        ${profileSvg(p)}
        ${gradeLegend()}
        ${searching ? '<p class="hint">Refining route…</p>' : ''}
        <div class="section">Cost breakdown</div>
        ${breakdownHtml(p.breakdown)}
        ${p.bridges ? row('Bridges', String(p.bridges)) : ''}
        ${p.tunnels ? row('Tunnels', String(p.tunnels)) : ''}
        ${p.demolished.length ? row('Buildings razed', String(p.demolished.length)) : ''}`;
    }
    return `<div class="card-title"><span class="tag">Tool</span><span class="grow">Lay track</span></div>${options}${body}`;
  }

  bindPanel(root: HTMLElement): void {
    bindSegs(root, (n, v) => this.setOpt(n, v));
  }

  /** If the drag joins two stations, what a typical train there would earn. */
  private revenueHtml(p: TrackPlan): string {
    const world = this.host.game.world;
    const sa = world.track.getIdx(p.from)?.station ?? -1;
    const sb = world.track.getIdx(p.to)?.station ?? -1;
    if (sa < 0 || sb < 0 || sa === sb) return '<p class="hint">Drag from station to station to see revenue and payback.</p>';
    const est = estimateConnection(this.host.game, sa, sb, p.lengthTiles, p.maxGrade);
    if (!est || !est.ok) return '';
    const total = p.cost + est.price;
    const payback = est.profitPerYear > 0 ? `${(total / est.profitPerYear).toFixed(1)} yr` : 'never';
    return `<div title="Best engine on sale with a suggested consist, using current supply and demand at both stations">
      ${row('Train revenue / yr', fmtMoney(est.revenuePerYear))}
      ${row('Train profit / yr', fmtMoney(est.profitPerYear))}
      ${row('Payback (track + train)', payback, 'total')}</div>`;
  }

  overlay(): Overlay {
    const hl: Highlight[] = [];
    const W = this.host.game.world.width;
    if (this.hoverTile !== null && this.from === null) {
      hl.push({ rect: [this.hoverTile % W, Math.floor(this.hoverTile / W), 1, 1], color: PALETTE.gold });
    }
    const dim = !!this.plan && this.plan.ok && this.plan.cost > this.host.game.company.cash;
    return { plan: this.from !== null ? this.plan : null, planDim: dim, highlights: hl };
  }

  hint(): string {
    return this.from !== null ? 'Release to build · right-click cancels' : 'Drag to lay track';
  }
}

// ---------------------------------------------------------------------------------------
// Station tool
// ---------------------------------------------------------------------------------------

export class StationTool implements Tool {
  readonly id = 'station';
  readonly name = 'Build station';
  readonly leftDragPans = true;
  kind: StationPlan['kind'] = 'station';
  axis: 'x' | 'y' = 'x';
  private hover: [number, number] | null = null;
  private plan: StationPlan | null = null;

  constructor(private readonly host: ToolHost) {}

  deactivate(): void {
    this.hover = null;
    this.plan = null;
  }

  /** Align with straight track under the cursor automatically. */
  private effectiveAxis(): 'x' | 'y' {
    if (!this.hover) return this.axis;
    const n = this.host.game.world.track.get(this.hover[0], this.hover[1]);
    if (n && n.conn) {
      const xMask = 1 | (1 << 4);
      const yMask = (1 << 2) | (1 << 6);
      if ((n.conn & ~xMask) === 0) return 'x';
      if ((n.conn & ~yMask) === 0) return 'y';
    }
    return this.axis;
  }

  private refresh(): void {
    this.plan = this.hover ? this.host.game.planStation(this.hover[0], this.hover[1], this.kind, this.effectiveAxis()) : null;
    this.host.invalidatePanel();
  }

  pointerMove(tile: [number, number] | null): void {
    if (tile && this.hover && tile[0] === this.hover[0] && tile[1] === this.hover[1]) return;
    this.hover = tile;
    this.refresh();
  }

  pointerDown(tile: [number, number] | null, button: number): boolean {
    return button === 0 && !!tile;
  }

  pointerUp(tile: [number, number] | null): void {
    if (!tile) return;
    const r = this.host.game.buildStation(tile[0], tile[1], this.kind, this.effectiveAxis());
    if (r.ok) this.host.toast(`${r.station!.name} ${stationDef(this.kind).name.toLowerCase()} opened (${fmtMoney(r.cost)})`, 'money');
    else this.host.toast(r.error ?? 'Cannot build here.', 'error');
    this.refresh();
  }

  key(k: string): boolean {
    if (k === 'r') {
      this.axis = this.axis === 'x' ? 'y' : 'x';
      this.refresh();
      return true;
    }
    if (k === 'b') {
      const i = STATIONS.findIndex((s) => s.id === this.kind);
      this.kind = STATIONS[(i + 1) % STATIONS.length].id;
      this.refresh();
      return true;
    }
    return false;
  }

  panelHtml(): string {
    const sizes = STATIONS.map(
      (s) => `<button class="btn size" data-kind="${s.id}" aria-pressed="${s.id === this.kind}">
        <b>${esc(s.name)}</b><small>${fmtMoney(s.cost)} · ${s.length} tile${s.length > 1 ? 's' : ''} · reach ${s.radius}</small></button>`,
    ).join('');
    let body = `<p class="hint">Hover to see the catchment, click to build. Stations snap to straight track; <kbd>R</kbd> rotates, <kbd>B</kbd> cycles size.</p>`;
    const p = this.plan;
    if (p) {
      body = `
        <div class="section">${esc(p.name)} ${esc(stationDef(p.kind).name)}</div>
        ${p.ok ? costRow(p.cost, this.host.game.company.cash) + breakdownHtml(p.breakdown) : `<p class="bad">${esc(p.error ?? '')}</p>`}
        ${row('Facing', p.axis === 'x' ? 'East–west' : 'North–south')}
        ${coverageHtml(p.coverage, stationDef(p.kind).radius)}`;
    }
    return `<div class="card-title"><span class="tag">Tool</span><span class="grow">Build station</span></div><div class="sizes">${sizes}</div>${body}`;
  }

  bindPanel(root: HTMLElement): void {
    root.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) =>
      b.addEventListener('click', () => {
        this.kind = b.dataset.kind as StationPlan['kind'];
        this.refresh();
      }),
    );
  }

  overlay(): Overlay {
    const world = this.host.game.world;
    const W = world.width;
    const hl: Highlight[] = [];
    // Existing catchments, dashed.
    for (const st of world.liveStations()) {
      const r = catchmentRect(world, st.tiles, stationDef(st.kind).radius);
      hl.push({ rect: [r[0], r[1], r[2] - r[0] + 1, r[3] - r[1] + 1], color: PALETTE.steel, dashed: true });
    }
    const p = this.plan;
    if (p) {
      const r = p.rect;
      hl.push({ rect: [r[0], r[1], r[2] - r[0] + 1, r[3] - r[1] + 1], color: p.ok ? PALETTE.sky : PALETTE.tile, dashed: !p.ok });
      for (const ind of p.coverage.industries) hl.push({ rect: [ind.x, ind.y, ind.w, ind.h], color: PALETTE.meadow });
      for (const c of p.coverage.cities) for (const t of c.tiles) hl.push({ rect: [t % W, Math.floor(t / W), 1, 1], color: PALETTE.cream });
      for (const t of p.tiles) hl.push({ rect: [t % W, Math.floor(t / W), 1, 1], color: p.ok ? PALETTE.gold : PALETTE.tile, dashed: !p.ok });
    }
    return { highlights: hl };
  }

  hint(): string {
    return `${stationDef(this.kind).name} · R rotate · B size`;
  }
}

// ---------------------------------------------------------------------------------------
// Bulldoze tool
// ---------------------------------------------------------------------------------------

export class BulldozeTool implements Tool {
  readonly id = 'bulldoze';
  readonly name = 'Bulldoze';
  readonly leftDragPans = false;
  private dragging = false;
  private targets = new Set<number>();
  private hover: number | null = null;

  constructor(private readonly host: ToolHost) {}

  deactivate(): void {
    this.dragging = false;
    this.targets.clear();
  }

  pointerDown(tile: [number, number] | null, button: number): boolean {
    if (button === 2 && this.dragging) {
      this.dragging = false;
      this.targets.clear();
      this.host.invalidatePanel();
      return true;
    }
    if (button !== 0 || !tile) return false;
    this.dragging = true;
    this.targets.clear();
    this.add(tile);
    return true;
  }

  private add(tile: [number, number]): void {
    const i = this.host.game.world.tileIndex(tile[0], tile[1]);
    if (this.host.game.world.track.getIdx(i)) this.targets.add(i);
    this.host.invalidatePanel();
  }

  pointerMove(tile: [number, number] | null): void {
    this.hover = tile ? this.host.game.world.tileIndex(tile[0], tile[1]) : null;
    if (this.dragging && tile) this.add(tile);
    else this.host.invalidatePanel();
  }

  pointerUp(): void {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.targets.size) {
      const r = this.host.game.bulldoze([...this.targets]);
      if (r.ok) this.host.toast(`Bulldozed (${fmtMoney(r.cost)}) — Ctrl+Z to undo`, 'money');
      else this.host.toast(r.error ?? 'Nothing to remove.', 'error');
    }
    this.targets.clear();
    this.host.invalidatePanel();
  }

  private currentPlan() {
    const tiles = this.targets.size ? [...this.targets] : this.hover !== null ? [this.hover] : [];
    return planBulldoze(this.host.game.world, tiles);
  }

  panelHtml(): string {
    const plan = this.currentPlan();
    const what = [
      plan.stations.length ? `${plan.stations.length} station(s)` : '',
      plan.tiles.length ? `${plan.tiles.length} track tile(s)` : '',
    ]
      .filter(Boolean)
      .join(', ');
    return `<div class="card-title"><span class="tag">Tool</span><span class="grow">Bulldoze</span></div>
      <p class="hint">Click or drag over track to remove it. Clicking a station removes the station but keeps its track. Bridges and tunnels go as a whole.</p>
      ${what ? row('Removes', esc(what)) + costRow(plan.cost, this.host.game.company.cash) : ''}`;
  }

  overlay(): Overlay {
    const plan = this.currentPlan();
    const world = this.host.game.world;
    const W = world.width;
    const hl: Highlight[] = plan.tiles.map((t) => ({ rect: [t % W, Math.floor(t / W), 1, 1] as [number, number, number, number], color: PALETTE.tile }));
    for (const id of plan.stations) {
      for (const t of world.stations[id]?.tiles ?? []) hl.push({ rect: [t % W, Math.floor(t / W), 1, 1], color: PALETTE.tile, dashed: true });
    }
    return { highlights: hl };
  }

  hint(): string {
    return 'Click/drag to remove track or stations';
  }
}
