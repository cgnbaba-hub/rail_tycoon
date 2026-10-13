import { MAPGEN, TIME } from '../data';
import { Camera, ZOOMS } from '../render/camera';
import { Renderer } from '../render/renderer';
import { Game } from '../sim/game';
import { defaultMapParams } from '../sim/mapgen';
import { seedFromString } from '../sim/rng';
import { FixedStepper, formatDate } from '../sim/time';
import type { MapParams } from '../sim/world';
import { $, esc, h } from './dom';
import { icon } from './icons';
import { inspectTile, type Inspection } from './inspector';
import { Minimap } from './minimap';
import { crispFontSize } from './theme';

const COMPASS = ['N', 'E', 'S', 'W'];
const PAN_SPEED = 520; // buffer px per second for keyboard panning

interface ToolButton {
  id: string;
  icon: string;
  tip: string;
  key: string;
  action: () => void;
  toggled?: () => boolean;
}

export class App {
  private game!: Game;
  private camera!: Camera;
  private readonly renderer: Renderer;
  private readonly minimap: Minimap;
  private readonly stepper = new FixedStepper();
  private readonly canvas: HTMLCanvasElement;
  /** 0 = paused, otherwise 1-based index into TIME.speeds. */
  private speed = 1;
  private lastSpeed = 1;
  private hoverTile: [number, number] | null = null;
  private pinned: [number, number] | null = null;
  private lastInspectKey = '';
  private lastDateText = '';
  private keysDown = new Set<string>();
  private pixelScale = 3;
  private lastFrame = performance.now();
  private toolButtons: ToolButton[] = [];

  constructor() {
    this.canvas = $('#world') as HTMLCanvasElement;
    this.renderer = new Renderer(this.canvas);
    this.minimap = new Minimap($('#minimap') as HTMLCanvasElement, (x, y) => this.camera.centerOn(x, y));
    this.buildTopbar();
    this.buildRail();
    this.bindCanvas();
    this.bindKeys();
    this.bindTooltips();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  // -------------------------------------------------------------------------------------
  // Game lifecycle
  // -------------------------------------------------------------------------------------

  newGame(params: MapParams): void {
    this.game = new Game(params);
    const world = this.game.world;
    this.camera = new Camera(world.width, world.height);
    const biggest = [...world.cities].sort((a, b) => b.population - a.population)[0];
    if (biggest) this.camera.centerOn(biggest.x + 0.5, biggest.y + 0.5);
    this.renderer.setWorld(world);
    this.minimap.setWorld(world);
    this.pinned = null;
    this.hoverTile = null;
    this.lastInspectKey = '';
    this.stepper.reset();
    this.setSpeed(1);
    $('#seed').textContent = `Seed ${params.seed}`;
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(params.seed));
    url.searchParams.set('size', String(params.size));
    window.history.replaceState(null, '', url);
    this.renderInspector();
  }

  start(): void {
    const loop = (now: number) => {
      const dt = now - this.lastFrame;
      this.lastFrame = now;
      this.frame(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private frame(dt: number): void {
    // Simulation: whole fixed ticks only.
    const speedMul = this.speed === 0 ? 0 : TIME.speeds[this.speed - 1];
    const ticks = this.stepper.advance(dt, speedMul);
    for (let i = 0; i < ticks; i++) this.game.step();

    // Keyboard panning (works while paused too).
    let px = 0;
    let py = 0;
    if (this.keysDown.has('arrowleft') || this.keysDown.has('a')) px -= 1;
    if (this.keysDown.has('arrowright') || this.keysDown.has('d')) px += 1;
    if (this.keysDown.has('arrowup') || this.keysDown.has('w')) py -= 1;
    if (this.keysDown.has('arrowdown') || this.keysDown.has('s')) py += 1;
    if (px || py) {
      const step = (PAN_SPEED * Math.min(dt, 50)) / 1000;
      this.camera.panByScreen(-px * step, -py * step);
    }

    const time = this.game.tick + this.stepper.alpha;
    this.renderer.render(this.camera, time);
    this.minimap.draw(this.camera);
    this.updateHud();
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const devW = Math.round(window.innerWidth * dpr);
    const devH = Math.round(window.innerHeight * dpr);
    this.pixelScale = Math.max(1, Math.floor(devW / 560));
    const bw = Math.ceil(devW / this.pixelScale);
    const bh = Math.ceil(devH / this.pixelScale);
    this.renderer.resize(bw, bh);
    this.canvas.style.width = `${(bw * this.pixelScale) / dpr}px`;
    this.canvas.style.height = `${(bh * this.pixelScale) / dpr}px`;
    document.documentElement.style.setProperty('--fs', `${crispFontSize(dpr, window.innerWidth < 760 ? 12 : 17)}px`);
  }

  // -------------------------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------------------------

  private buildTopbar(): void {
    const speed = $('#speed');
    const labels = ['pause', ...TIME.speeds.map((s) => `${s}×`)];
    labels.forEach((label, i) => {
      const b = h('button', {
        class: 'btn',
        'data-speed': String(i),
        'data-tip': i === 0 ? 'Pause — you can still build and inspect' : `Speed ${label}`,
        'data-key': i === 0 ? 'Space' : String(i),
        'aria-label': i === 0 ? 'Pause' : `Speed ${label}`,
      });
      b.innerHTML = i === 0 ? icon('pause') : esc(label);
      b.addEventListener('click', () => this.setSpeed(i === 0 && this.speed === 0 ? this.lastSpeed : i));
      speed.appendChild(b);
    });
    $('#btn-new').innerHTML = `${icon('newmap')}<span>New map</span>`;
    $('#btn-new').addEventListener('click', () => this.openNewGameDialog());
    $('#btn-help').innerHTML = icon('help');
    $('#btn-help').setAttribute('aria-label', 'Help');
    $('#btn-help').addEventListener('click', () => this.openHelp());
  }

  private buildRail(): void {
    const rail = $('#rail');
    this.toolButtons = [
      { id: 'inspect', icon: 'inspect', tip: 'Inspect — click a tile to pin its details', key: 'I', action: () => {}, toggled: () => true },
      { id: 'sep1', icon: '', tip: '', key: '', action: () => {} },
      { id: 'grid', icon: 'grid', tip: 'Toggle tile grid', key: 'G', action: () => this.toggleGrid(), toggled: () => this.renderer.showGrid },
      { id: 'labels', icon: 'labels', tip: 'Toggle town labels', key: 'L', action: () => (this.renderer.showLabels = !this.renderer.showLabels), toggled: () => this.renderer.showLabels },
      { id: 'sep2', icon: '', tip: '', key: '', action: () => {} },
      { id: 'rotl', icon: 'rotl', tip: 'Rotate view left', key: 'Q', action: () => this.camera.rotate(-1) },
      { id: 'rotr', icon: 'rotr', tip: 'Rotate view right', key: 'E', action: () => this.camera.rotate(1) },
      { id: 'zin', icon: 'zoomin', tip: 'Zoom in', key: '+', action: () => this.zoomBy(1) },
      { id: 'zout', icon: 'zoomout', tip: 'Zoom out', key: '-', action: () => this.zoomBy(-1) },
      { id: 'center', icon: 'center', tip: 'Centre on pinned tile or largest town', key: 'C', action: () => this.centerOnFocus() },
    ];
    for (const t of this.toolButtons) {
      if (t.id.startsWith('sep')) {
        rail.appendChild(h('div', { class: 'sep', role: 'separator' }));
        continue;
      }
      const b = h('button', { class: 'btn', id: `tool-${t.id}`, 'data-tip': t.tip, 'data-key': t.key, 'aria-label': t.tip });
      b.innerHTML = icon(t.icon);
      b.addEventListener('click', () => t.action());
      rail.appendChild(b);
    }
  }

  private toggleGrid(): void {
    this.renderer.showGrid = !this.renderer.showGrid;
  }

  private zoomBy(d: number): void {
    this.camera.zoomAt(this.canvas.width / 2, this.canvas.height / 2, this.camera.zoom + d);
  }

  private centerOnFocus(): void {
    if (this.pinned) {
      this.camera.centerOn(this.pinned[0] + 0.5, this.pinned[1] + 0.5);
      return;
    }
    const biggest = [...this.game.world.cities].sort((a, b) => b.population - a.population)[0];
    if (biggest) this.camera.centerOn(biggest.x + 0.5, biggest.y + 0.5);
  }

  private setSpeed(i: number): void {
    if (i > 0) this.lastSpeed = i;
    this.speed = i;
    document.querySelectorAll<HTMLButtonElement>('#speed .btn').forEach((b) => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === i));
    });
  }

  private updateHud(): void {
    const text = formatDate(this.game.date);
    if (text !== this.lastDateText) {
      $('#date').textContent = text;
      this.lastDateText = text;
    }
    for (const t of this.toolButtons) {
      if (!t.toggled) continue;
      document.getElementById(`tool-${t.id}`)?.setAttribute('aria-pressed', String(t.toggled()));
    }
    const tile = this.pinned ?? this.hoverTile;
    const status = [
      `Zoom ${ZOOMS[this.camera.zoom].label}`,
      `View ${COMPASS[this.camera.rot]}`,
      tile ? `Tile ${tile[0]},${tile[1]}` : '',
      this.speed === 0 ? 'PAUSED' : '',
      this.renderer.pendingChunks ? 'drawing…' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const st = $('#status');
    if (st.textContent !== status) st.textContent = status;
    this.renderInspector();
  }

  private renderInspector(): void {
    const tile = this.pinned ?? this.hoverTile;
    const world = this.game.world;
    let insp: Inspection | null = null;
    if (tile) insp = inspectTile(world, tile[0], tile[1]);
    const key = tile ? `${tile[0]},${tile[1]},${this.pinned ? 1 : 0}` : 'none';
    // Highlights.
    this.renderer.hover = insp && !this.pinned ? { rect: insp.rect, color: '#f2c84a' } : null;
    this.renderer.selection = insp && this.pinned ? { rect: insp.rect, color: '#f3f5fb' } : null;
    if (key === this.lastInspectKey) return;
    this.lastInspectKey = key;
    const el = $('#inspector');
    if (!insp) {
      el.innerHTML = `
        <div class="card-title"><span class="grow">Welcome, Chairman</span></div>
        <p class="hint" style="margin-top:0">Survey the land before laying your first rails.
        Hover to inspect, click to pin. Right-drag or WASD to pan, wheel to zoom, Q/E to rotate.</p>
        <div class="kv"><span>Towns</span><b>${world.cities.length}</b></div>
        <div class="kv"><span>Industries</span><b>${world.industries.length}</b></div>
        <div class="kv"><span>Map</span><b>${world.width}×${world.height}</b></div>`;
      return;
    }
    const tag = insp.kind === 'city' ? 'Town' : insp.kind === 'industry' ? 'Industry' : 'Land';
    el.innerHTML = `
      <div class="card-title">
        <span class="tag">${tag}</span><span class="grow" title="${esc(insp.title)}">${esc(insp.title)}</span>
        ${this.pinned ? `<button class="icon-btn" id="unpin" aria-label="Unpin" data-tip="Unpin" data-key="Esc">${icon('close')}</button>` : ''}
      </div>
      ${insp.html}`;
    document.getElementById('unpin')?.addEventListener('click', () => (this.pinned = null));
  }

  // -------------------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------------------

  private toBuffer(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * this.canvas.width) / r.width, ((e.clientY - r.top) * this.canvas.height) / r.height];
  }

  private bindCanvas(): void {
    const c = this.canvas;
    let drag: { id: number; x: number; y: number; moved: number; button: number } | null = null;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      if (!this.game) return;
      c.setPointerCapture(e.pointerId);
      const [x, y] = this.toBuffer(e);
      drag = { id: e.pointerId, x, y, moved: 0, button: e.button };
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.game) return;
      const [x, y] = this.toBuffer(e);
      if (drag && drag.id === e.pointerId) {
        const dx = x - drag.x;
        const dy = y - drag.y;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        // Any button pans once the pointer really moves (left-drag too, for trackpads).
        if (drag.moved > 3) {
          c.classList.add('panning');
          this.camera.panByScreen(dx, dy);
        }
        drag.x = x;
        drag.y = y;
        return;
      }
      this.hoverTile = this.renderer.pick(this.camera, x, y);
    });
    const end = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return;
      const wasClick = drag.moved <= 3 && drag.button === 0;
      drag = null;
      c.classList.remove('panning');
      if (wasClick) {
        const [x, y] = this.toBuffer(e);
        this.pinned = this.renderer.pick(this.camera, x, y);
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (!drag) this.hoverTile = null;
    });
    let wheelAcc = 0;
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (!this.game) return;
        wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
        if (Math.abs(wheelAcc) < 50) return;
        const [x, y] = this.toBuffer(e);
        this.camera.zoomAt(x, y, this.camera.zoom + (wheelAcc < 0 ? 1 : -1));
        wheelAcc = 0;
      },
      { passive: false },
    );
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      if (!this.game) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, select, textarea')) return;
      if (document.querySelector('.modal-backdrop')) {
        if (e.key === 'Escape') this.closeModal();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'w', 'a', 's', 'd'].includes(k)) {
        this.keysDown.add(k);
        e.preventDefault();
        return;
      }
      switch (k) {
        case ' ':
        case 'p':
          this.setSpeed(this.speed === 0 ? this.lastSpeed : 0);
          break;
        case '1':
        case '2':
        case '3':
        case '4':
          this.setSpeed(Number(k));
          break;
        case 'q':
          this.camera.rotate(-1);
          break;
        case 'e':
          this.camera.rotate(1);
          break;
        case '+':
        case '=':
          this.zoomBy(1);
          break;
        case '-':
        case '_':
          this.zoomBy(-1);
          break;
        case 'g':
          this.toggleGrid();
          break;
        case 'l':
          this.renderer.showLabels = !this.renderer.showLabels;
          break;
        case 'c':
          this.centerOnFocus();
          break;
        case 'n':
          this.openNewGameDialog();
          break;
        case 'h':
        case '?':
          this.openHelp();
          break;
        case 'escape':
          this.pinned = null;
          break;
        default:
          return;
      }
      e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keysDown.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keysDown.clear());
  }

  private bindTooltips(): void {
    const tip = $('#tooltip');
    document.addEventListener('pointerover', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
      if (!el || !el.dataset.tip) {
        tip.hidden = true;
        return;
      }
      tip.innerHTML = esc(el.dataset.tip) + (el.dataset.key ? `<kbd>${esc(el.dataset.key)}</kbd>` : '');
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      let left = r.right + 8;
      let top = r.top;
      if (left + tr.width > window.innerWidth - 4) {
        left = Math.max(4, r.left);
        top = r.bottom + 6;
      }
      if (left + tr.width > window.innerWidth - 4) left = window.innerWidth - tr.width - 4;
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
    });
    document.addEventListener('pointerdown', () => (tip.hidden = true));
  }

  // -------------------------------------------------------------------------------------
  // Dialogs
  // -------------------------------------------------------------------------------------

  private closeModal(): void {
    $('#modal-root').innerHTML = '';
  }

  private openModal(html: string): HTMLElement {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const backdrop = root.firstElementChild as HTMLElement;
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) this.closeModal();
    });
    return backdrop.firstElementChild as HTMLElement;
  }

  openNewGameDialog(): void {
    const p = this.game?.params ?? defaultMapParams(1);
    const sel = (name: string, options: string[], value: string) =>
      `<select name="${name}">${options.map((o) => `<option value="${o}"${o === value ? ' selected' : ''}>${o[0].toUpperCase() + o.slice(1)}</option>`).join('')}</select>`;
    const m = this.openModal(`
      <h2>New map</h2>
      <form id="newgame">
        <div class="row"><label for="ng-seed">Seed</label>
          <div class="seg"><input id="ng-seed" name="seed" value="${randomSeed()}" size="10" autocomplete="off" />
          <button type="button" class="btn" id="ng-dice">Random</button></div></div>
        <div class="row"><label>Map size</label>${sel('size', MAPGEN.sizes.map(String), String(p.size))}</div>
        <div class="row"><label>Water</label>${sel('water', ['none', 'low', 'normal', 'high'], p.water)}</div>
        <div class="row"><label>Terrain</label>${sel('hills', ['flat', 'normal', 'mountainous'], p.hills)}</div>
        <div class="row"><label>Forests</label>${sel('forests', ['few', 'normal', 'many'], p.forests)}</div>
        <div class="row"><label>Towns</label>${sel('cities', ['few', 'normal', 'many'], p.cities)}</div>
        <div class="row"><label for="ng-year">Start year</label>
          <input id="ng-year" name="startYear" type="number" min="${MAPGEN.startYears[0]}" max="${MAPGEN.startYears[1]}" step="1" value="${p.startYear}" /></div>
        <div class="actions">
          <button type="button" class="btn" id="ng-cancel">Cancel</button>
          <button type="submit" class="btn primary">Survey land</button>
        </div>
      </form>`);
    const form = m.querySelector('form') as HTMLFormElement;
    (m.querySelector('#ng-dice') as HTMLElement).addEventListener('click', () => {
      (m.querySelector('#ng-seed') as HTMLInputElement).value = randomSeed();
    });
    (m.querySelector('#ng-cancel') as HTMLElement).addEventListener('click', () => this.closeModal());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const year = Math.round(Number(fd.get('startYear')));
      const params: MapParams = {
        seed: seedFromString(String(fd.get('seed') || randomSeed())),
        size: Number(fd.get('size')),
        water: fd.get('water') as MapParams['water'],
        hills: fd.get('hills') as MapParams['hills'],
        forests: fd.get('forests') as MapParams['forests'],
        cities: fd.get('cities') as MapParams['cities'],
        startYear: Math.min(MAPGEN.startYears[1], Math.max(MAPGEN.startYears[0], Number.isFinite(year) ? year : 1850)),
      };
      this.closeModal();
      withLoading('Surveying the land…', () => this.newGame(params));
    });
    (m.querySelector('#ng-seed') as HTMLInputElement).focus();
  }

  openHelp(): void {
    const keys: Array<[string, string]> = [
      ['Right/middle drag', 'Pan the map (left-drag works too)'],
      ['W A S D / arrows', 'Pan'],
      ['Mouse wheel  + / -', 'Zoom'],
      ['Q / E', 'Rotate view 90°'],
      ['Click', 'Pin tile details  (Esc to unpin)'],
      ['Space / P', 'Pause / resume'],
      ['1 2 3 4', 'Speed 1× 2× 4× 8×'],
      ['G', 'Tile grid'],
      ['L', 'Town labels'],
      ['C', 'Centre on pinned tile / largest town'],
      ['N', 'New map'],
      ['H / ?', 'This help'],
    ];
    const m = this.openModal(`
      <h2>Iron Baron — controls</h2>
      <div class="keys">${keys.map(([k, v]) => `<kbd>${esc(k)}</kbd><span>${esc(v)}</span>`).join('')}</div>
      <p class="hint">Milestone 1: explore the generated world. Track, stations and trains arrive in the next milestones.</p>
      <div class="actions"><button class="btn primary" id="help-ok">Got it</button></div>`);
    const ok = m.querySelector('#help-ok') as HTMLElement;
    ok.addEventListener('click', () => this.closeModal());
    ok.focus();
  }
}

function randomSeed(): string {
  return String(Math.floor(Math.random() * 1_000_000));
}

/** Show a full-screen message, let the browser paint it, then run a blocking task. */
export function withLoading(message: string, task: () => void): void {
  const el = h('div', { class: 'loading', role: 'status' }, esc(message));
  document.body.appendChild(el);
  requestAnimationFrame(() =>
    setTimeout(() => {
      try {
        task();
      } finally {
        el.remove();
      }
    }, 0),
  );
}
