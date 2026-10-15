import { MAPGEN, TIME } from '../data';
import { Camera, ZOOMS } from '../render/camera';
import { Renderer, type Overlay } from '../render/renderer';
import { Game, type GameSettings } from '../sim/game';
import { defaultMapParams } from '../sim/mapgen';
import { seedFromString } from '../sim/rng';
import { FixedStepper, formatDate } from '../sim/time';
import type { MapParams } from '../sim/world';
import { $, esc, h } from './dom';
import { icon } from './icons';
import { inspectTile, type Inspection } from './inspector';
import { Minimap } from './minimap';
import { crispFontSize } from './theme';
import { BulldozeTool, StationTool, TrackTool, fmtMoney, type Tool, type ToolHost } from './tools';
import { cashTip, openFinance, openYearEnd, personalChipHtml, personalTip, stockChipHtml, stockTip, yearEndEnabled } from './finance';
import { bindImprovements, bindIndustry, economyChipHtml, economyTip, improvementsHtml, industryEconomyHtml, openEconomy, stationDemandHtml, townGrowthHtml } from './economy';
import { bindTrainPanel, openFleet, openTrainDialog, stationEconomyHtml, trainPanelHtml, type TrainUiHost } from './trains';
import { stopTile } from '../sim/train';
import { ECONOMY } from '../data';
import { AI, type AiLevel, type EconomicModel } from '../data';
import { companyTag, openCompanies, openGameOver } from './rivals';
import { adviceCount, logDelivery, logEvent, openAdvisor, refreshAdvice, resetFeed, type AdvisorHost } from './advisor';
import { clearChain, openOverlayPicker, openSupplyChains, overlay, refreshOverlay, setOverlay } from './overlays';
import { openStats } from './stats';
import type { Advice } from '../sim/advisor';

const COMPASS = ['N', 'E', 'S', 'W'];
const PAN_SPEED = 520; // buffer px per second for keyboard panning

interface RailButton {
  id: string;
  icon: string;
  tip: string;
  key: string;
  action: () => void;
  pressed?: () => boolean;
  disabled?: () => boolean;
}

export class App implements ToolHost, TrainUiHost, AdvisorHost {
  game!: Game;
  camera!: Camera;
  private readonly renderer: Renderer;
  private readonly minimap: Minimap;
  private readonly stepper = new FixedStepper();
  private readonly canvas: HTMLCanvasElement;
  /** 0 = paused, otherwise 1-based index into TIME.speeds. */
  private speed = 1;
  private lastSpeed = 1;
  private hoverTile: [number, number] | null = null;
  private pinned: [number, number] | null = null;
  private lastPanelKey = '';
  private panelDirty = true;
  private lastDateText = '';
  private lastCash = NaN;
  private keysDown = new Set<string>();
  private pixelScale = 3;
  private lastFrame = performance.now();
  private railButtons: RailButton[] = [];
  private tools: Record<string, Tool> = {};
  private tool: Tool | null = null;
  private minimapStamp = -1;
  private inspectOverlay: Overlay = { highlights: [] };
  /** Selected train (inspect mode) and whether the camera follows it. */
  private selectedTrain: number | null = null;
  private following: number | null = null;
  private lastTrainPanel = 0;
  private lastPanelDay = -1;
  private pendingBreakdowns: string[] = [];
  private breakdownTimer: number | null = null;
  private econDirty = true;
  private lastStockKey = '';

  constructor() {
    this.canvas = $('#world') as HTMLCanvasElement;
    this.renderer = new Renderer(this.canvas);
    this.minimap = new Minimap($('#minimap') as HTMLCanvasElement, (x, y) => this.camera.centerOn(x, y));
    this.buildTopbar();
    this.bindCanvas();
    this.bindKeys();
    this.bindTooltips();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  // -------------------------------------------------------------------------------------
  // Game lifecycle
  // -------------------------------------------------------------------------------------

  newGame(params: MapParams, settings?: Partial<GameSettings>): void {
    this.tool?.deactivate?.();
    this.tool = null;
    this.game = new Game(params, undefined, { rivals: 2, ...settings });
    this.selectedTrain = null;
    this.following = null;
    this.econDirty = true;
    $('#news').textContent = '';
    resetFeed();
    clearChain();
    this.renderer.trains = this.game.trains;
    this.game.on((e) => this.onGameEvent(e));
    const world = this.game.world;
    this.camera = new Camera(world.width, world.height);
    const biggest = [...world.cities].sort((a, b) => b.population - a.population)[0];
    if (biggest) this.camera.centerOn(biggest.x + 0.5, biggest.y + 0.5);
    this.renderer.ownerColors = this.game.companies.map((c) => c.color);
    this.minimap.ownerColors = this.renderer.ownerColors;
    this.renderer.setWorld(world);
    this.minimap.setWorld(world);
    this.tools = { track: new TrackTool(this), station: new StationTool(this), bulldoze: new BulldozeTool(this) };
    setOverlay(this.game, null);
    refreshAdvice(this.game);
    this.buildRail();
    this.pinned = null;
    this.hoverTile = null;
    this.stepper.reset();
    this.setSpeed(1);
    $('#seed').textContent = `Seed ${params.seed}`;
    $('#company').textContent = this.game.company.name;
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(params.seed));
    url.searchParams.set('size', String(params.size));
    window.history.replaceState(null, '', url);
    this.invalidatePanel();
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

    if (this.following !== null) {
      const t = this.game.trains.byId(this.following);
      if (t) {
        const [x, y] = this.game.trains.headPosition(t);
        this.camera.centerOn(x, y);
      } else this.following = null;
    }
    this.renderer.selectedTrain = this.selectedTrain ?? -1;
    this.tool?.update?.();
    const ov = this.tool ? this.tool.overlay() : this.inspectOverlay;
    this.renderer.overlay = overlay.chain.length ? { ...ov, highlights: [...overlay.chain, ...ov.highlights] } : ov;
    this.renderer.heat = overlay.heat;
    const time = this.game.tick + this.stepper.alpha;
    this.renderer.render(this.camera, time);
    if (this.renderer.changeCounter !== this.minimapStamp) {
      this.minimapStamp = this.renderer.changeCounter;
      this.minimap.refresh();
      this.panelDirty = true;
    }
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
  // ToolHost
  // -------------------------------------------------------------------------------------

  toast(message: string, kind: 'info' | 'error' | 'money' = 'info'): void {
    const root = $('#toasts');
    const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, esc(message));
    root.appendChild(el);
    while (root.children.length > 4) root.firstElementChild?.remove();
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3700);
  }

  invalidatePanel(): void {
    this.panelDirty = true;
  }

  selectTrain(id: number | null): void {
    this.selectedTrain = id;
    if (id === null) this.following = null;
    if (id !== null) {
      this.setTool('inspect');
      this.pinned = null;
    }
    this.invalidatePanel();
  }

  private openOverlays(): void {
    openOverlayPicker(this, () => this.invalidatePanel());
  }

  /** Jump to whatever an advice or log entry is about. */
  focusTarget(target: NonNullable<Advice['target']>): void {
    const g = this.game;
    if (target.train !== undefined && g.trains.byId(target.train)) {
      this.selectTrain(target.train);
      this.follow(target.train);
    } else if (target.station !== undefined && g.world.stations[target.station]) {
      const st = g.world.stations[target.station]!;
      const W = g.world.width;
      const mid = st.tiles[Math.floor(st.tiles.length / 2)];
      this.setTool('inspect');
      this.selectTrain(null);
      this.pinned = [mid % W, Math.floor(mid / W)];
      this.camera.centerOn((mid % W) + 0.5, Math.floor(mid / W) + 0.5);
    } else if (target.company !== undefined) openCompanies(this, target.company);
    this.invalidatePanel();
  }

  follow(id: number): void {
    this.following = id;
    this.selectedTrain = id;
    this.invalidatePanel();
  }

  private onGameEvent(e: import('../sim/game').GameEvent): void {
    const g = this.game;
    const W = g.world.width;
    switch (e.type) {
      case 'delivery': {
        const st = g.world.stations[e.station];
        if (!st) break;
        if (g.trains.byId(e.train)?.owner === g.company.id) logDelivery(g, e.train, e.station, e.revenue, e.quotes);
        const tile = stopTile(st);
        const z = g.world.track.getIdx(tile)?.z ?? 0;
        this.renderer.addFloater((tile % W) + 0.5, Math.floor(tile / W) + 0.5, z, `+${fmtMoney(e.revenue)}`);
        break;
      }
      case 'breakdown': {
        // Batch breakdown notices so a big fleet doesn't flood the screen.
        const t = g.trains.byId(e.train);
        if (t?.owner !== g.company.id) break;
        logEvent(g, 'trains', `${t.name} broke down: ${e.days} days of repairs, ${fmtMoney(e.cost)}.`, -1, { train: t.id });
        this.pendingBreakdowns.push(`${t?.name ?? 'A train'} (${e.days} d)`);
        if (this.breakdownTimer === null) {
          this.breakdownTimer = window.setTimeout(() => {
            const list = this.pendingBreakdowns;
            this.pendingBreakdowns = [];
            this.breakdownTimer = null;
            this.toast(list.length === 1 ? `${list[0]} broke down — repairs under way` : `${list.length} trains broke down: ${list.slice(0, 3).join(', ')}${list.length > 3 ? '…' : ''}`, 'error');
          }, 1500);
        }
        break;
      }
      case 'wreck':
        logEvent(g, 'trains', `${e.name} was wrecked.`, -1);
        this.toast(`${e.name} was wrecked! Engine and cargo are lost.`, 'error');
        this.renderer.addFloater(e.x, e.y, 1, 'WRECK', '#cf5a39');
        if (this.selectedTrain === e.train) this.selectTrain(null);
        break;
      case 'news':
        this.showNews(e.headline.text, e.headline.tone);
        logEvent(g, 'news', e.headline.text, e.headline.tone);
        break;
      case 'cycle': {
        const s = g.economy.cycle.current;
        logEvent(g, 'news', `The economy enters ${s.name.toLowerCase()} (revenue ×${s.revenue.toFixed(2)}).`, s.revenue >= 1 ? 1 : -1);
        this.toast(`The economy enters ${s.name.toLowerCase() === 'normal' ? 'normal times' : `a ${s.name.toLowerCase()}`}: revenue ×${s.revenue.toFixed(2)}.`, s.revenue >= 1 ? 'money' : 'error');
        break;
      }
      case 'growth': {
        for (const r of e.reports) {
          const city = g.world.cities[r.cityId];
          if (r.classUp) logEvent(g, 'towns', `${city.name} has grown into a ${(MAPGEN.cities.classes[city.classIndex]?.name ?? 'town').toLowerCase()}.`, 1);
          if (r.newIndustry) logEvent(g, 'towns', `A new ${r.newIndustry.name} opened near ${city.name}.`, 1);
          if (r.classUp) this.toast(`${city.name} has grown into a ${(MAPGEN.cities.classes[city.classIndex]?.name ?? 'town').toLowerCase()}!`, 'money');
          if (r.newIndustry) this.toast(`A new ${r.newIndustry.name} opened near ${city.name}.`);
        }
        break;
      }
      case 'finance':
        if (e.company === g.company.id) logEvent(g, 'money', e.text, e.tone);
        else break;
        this.toast(e.text, e.tone < 0 ? 'error' : 'info');
        this.showNews(e.text, e.tone);
        break;
      case 'rival':
        logEvent(g, 'rivals', e.text, e.tone, { company: e.company });
        this.showNews(e.text, e.tone);
        if (e.tone !== 0) this.toast(e.text, e.tone < 0 ? 'error' : 'money');
        break;
      case 'gameOver':
        this.setSpeed(0);
        this.selectTrain(null);
        this.setTool('inspect');
        $('#company').textContent = `${this.game.company.name} — game over`;
        openGameOver(this, e.over);
        break;
      case 'marginCall': {
        const n = e.call.sold.reduce((a, s) => a + s.shares, 0);
        logEvent(g, 'money', `Margin call: your broker closed ${n.toLocaleString('en-US')} shares.`, -1);
        this.toast(`Margin call! Your broker closed ${n.toLocaleString('en-US')} shares to cover your loan.`, 'error');
        break;
      }
      case 'yearEnd':
        if (yearEndEnabled()) {
          const resume = this.speed;
          this.setSpeed(0);
          openYearEnd(this, e.report, () => this.setSpeed(resume || this.lastSpeed));
        }
        break;
      case 'noroute': {
        const t = g.trains.byId(e.train);
        if (t?.owner !== g.company.id) break;
        logEvent(g, 'trains', `${t.name} has no route to its next stop.`, -1, { train: t.id });
        this.toast(`${t?.name ?? 'A train'} has no route to its next stop.`, 'error');
        break;
      }
    }
    if (e.type === 'month') {
      this.econDirty = true;
      refreshAdvice(g);
      if (overlay.kind) refreshOverlay(g);
    }
    if (e.type !== 'day' && e.type !== 'month') this.invalidatePanel();
  }

  setTool(id: string): void {
    const next = id === 'inspect' ? null : this.tools[id] ?? null;
    if (next === this.tool) return;
    this.tool?.deactivate?.();
    this.tool = next;
    this.tool?.activate?.();
    if (this.tool) this.pinned = null;
    this.canvas.dataset.tool = this.tool?.id ?? 'inspect';
    this.tool?.pointerMove?.(this.hoverTile);
    this.invalidatePanel();
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
    $('#econ').addEventListener('click', () => openEconomy(this));
    $('#stock').addEventListener('click', () => openFinance(this, 'stock'));
    $('#personal').addEventListener('click', () => openFinance(this, 'portfolio'));
    $('#btn-new').innerHTML = `${icon('newmap')}<span>New map</span>`;
    $('#btn-new').addEventListener('click', () => this.openNewGameDialog());
    $('#btn-help').innerHTML = icon('help');
    $('#btn-help').setAttribute('aria-label', 'Help');
    $('#btn-help').addEventListener('click', () => this.openHelp());
  }

  private buildRail(): void {
    const rail = $('#rail');
    rail.innerHTML = '';
    this.railButtons = [
      { id: 'inspect', icon: 'inspect', tip: 'Inspect — hover for details, click to pin', key: 'I', action: () => this.setTool('inspect'), pressed: () => this.tool === null },
      { id: 'track', icon: 'track', tip: 'Lay track — drag to auto-route', key: 'T', action: () => this.setTool('track'), pressed: () => this.tool?.id === 'track' },
      { id: 'station', icon: 'station', tip: 'Build station — shows catchment', key: 'B', action: () => this.setTool('station'), pressed: () => this.tool?.id === 'station' },
      { id: 'bulldoze', icon: 'bulldoze', tip: 'Bulldoze track or stations', key: 'X', action: () => this.setTool('bulldoze'), pressed: () => this.tool?.id === 'bulldoze' },
      { id: 'trains', icon: 'train', tip: 'Trains — fleet list and new trains', key: 'F', action: () => openFleet(this) },
      { id: 'finance', icon: 'finance', tip: 'Finance — books, bonds, stock and your portfolio', key: 'M', action: () => openFinance(this) },
      { id: 'advisor', icon: 'bell', tip: 'Advisor — advice, news log and delivery formulas', key: 'U', action: () => openAdvisor(this) },
      { id: 'stats', icon: 'chart', tip: 'Statistics — revenue by cargo, trains, stations, rivals, net worth', key: 'K', action: () => openStats(this) },
      { id: 'overlays', icon: 'heat', tip: 'Map overlays — supply, demand, growth, profit, congestion, gradient', key: 'J', action: () => this.openOverlays(), pressed: () => overlay.kind !== null },
      { id: 'chains', icon: 'chain', tip: 'Supply chains on this map', key: 'Y', action: () => openSupplyChains(this, () => this.invalidatePanel()), pressed: () => overlay.chainCargo !== null },
      { id: 'companies', icon: 'rivals', tip: 'Railroads — rivals, stakes, takeovers and board confidence', key: 'O', action: () => openCompanies(this) },
      {
        id: 'undo',
        icon: 'undo',
        tip: 'Undo last construction (full refund)',
        key: 'Ctrl+Z',
        action: () => this.undo(),
        disabled: () => !this.game.undoable,
      },
      { id: 'sep1', icon: '', tip: '', key: '', action: () => {} },
      { id: 'grid', icon: 'grid', tip: 'Toggle tile grid', key: 'G', action: () => (this.renderer.showGrid = !this.renderer.showGrid), pressed: () => this.renderer.showGrid },
      { id: 'labels', icon: 'labels', tip: 'Toggle labels', key: 'L', action: () => (this.renderer.showLabels = !this.renderer.showLabels), pressed: () => this.renderer.showLabels },
      { id: 'sep2', icon: '', tip: '', key: '', action: () => {} },
      { id: 'rotl', icon: 'rotl', tip: 'Rotate view left', key: 'Q', action: () => this.camera.rotate(-1) },
      { id: 'rotr', icon: 'rotr', tip: 'Rotate view right', key: 'E', action: () => this.camera.rotate(1) },
      { id: 'zin', icon: 'zoomin', tip: 'Zoom in', key: '+', action: () => this.zoomBy(1) },
      { id: 'zout', icon: 'zoomout', tip: 'Zoom out', key: '-', action: () => this.zoomBy(-1) },
      { id: 'center', icon: 'center', tip: 'Centre on pinned tile or largest town', key: 'C', action: () => this.centerOnFocus() },
    ];
    for (const t of this.railButtons) {
      if (t.id.startsWith('sep')) {
        rail.appendChild(h('div', { class: 'sep', role: 'separator' }));
        continue;
      }
      const b = h('button', { class: 'btn', id: `tool-${t.id}`, 'data-tip': t.tip, 'data-key': t.key, 'aria-label': t.tip });
      b.innerHTML = icon(t.icon) + (t.id === 'advisor' ? '<span class="badge" hidden></span>' : '');
      b.addEventListener('click', () => t.action());
      rail.appendChild(b);
    }
  }

  private undo(): void {
    const label = this.game.undoable?.label;
    const r = this.game.undo();
    if (r.ok) this.toast(`Undid ${label} (+${fmtMoney(-r.cost)})`, 'money');
    else this.toast(r.error ?? 'Nothing to undo.', 'error');
    this.tool?.pointerMove?.(this.hoverTile);
    this.invalidatePanel();
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
    const cash = Math.round(this.game.company.cash);
    if (cash !== this.lastCash) {
      const el = $('#cash');
      el.textContent = fmtMoney(cash);
      el.classList.toggle('neg', cash < 0);
      this.lastCash = cash;
      this.panelDirty = true;
    }
    const stockKey = `${this.game.company.stock.price.toFixed(2)}|${Math.round(this.game.netWorth())}`;
    if (stockKey !== this.lastStockKey) {
      this.lastStockKey = stockKey;
      $('#stock').innerHTML = stockChipHtml(this.game);
      $('#personal').innerHTML = personalChipHtml(this.game);
      $('#stock').dataset.tip = stockTip(this.game);
      $('#personal').dataset.tip = personalTip(this.game);
      $('#cash-wrap').dataset.tip = cashTip(this.game);
    }
    const n = adviceCount();
    const badge = document.querySelector<HTMLElement>('#tool-advisor .badge');
    if (badge && badge.textContent !== String(n)) {
      badge.textContent = String(n);
      badge.hidden = n === 0;
    }
    if (this.econDirty) {
      this.econDirty = false;
      const el = $('#econ');
      el.innerHTML = economyChipHtml(this.game);
      el.dataset.tip = economyTip(this.game);
    }
    for (const t of this.railButtons) {
      const el = document.getElementById(`tool-${t.id}`) as HTMLButtonElement | null;
      if (!el) continue;
      if (t.pressed) el.setAttribute('aria-pressed', String(t.pressed()));
      if (t.disabled) el.disabled = t.disabled();
    }
    const tile = this.pinned ?? this.hoverTile;
    const status = [
      `Zoom ${ZOOMS[this.camera.zoom].label}`,
      `View ${COMPASS[this.camera.rot]}`,
      tile ? `Tile ${tile[0]},${tile[1]}` : '',
      this.tool ? this.tool.hint() : '',
      this.speed === 0 ? 'PAUSED' : '',
      this.renderer.pendingChunks ? 'drawing…' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const st = $('#status');
    if (st.textContent !== status) st.textContent = status;
    this.renderPanel();
  }

  private renderPanel(): void {
    const el = $('#inspector');
    if (this.tool) {
      this.renderer.hover = null;
      this.renderer.selection = null;
      if (!this.panelDirty) return;
      this.panelDirty = false;
      this.lastPanelKey = '';
      el.innerHTML = this.tool.panelHtml();
      this.tool.bindPanel?.(el);
      return;
    }
    if (this.selectedTrain !== null) {
      const t = this.game.trains.byId(this.selectedTrain);
      if (!t) {
        this.selectedTrain = null;
      } else {
        this.renderer.hover = null;
        this.renderer.selection = null;
        this.inspectOverlay = { highlights: [] };
        const now = performance.now();
        if (!this.panelDirty && now - this.lastTrainPanel < 400) return;
        if (el.matches(':hover') && !this.panelDirty && now - this.lastTrainPanel < 1500) return;
        this.lastTrainPanel = now;
        this.panelDirty = false;
        this.lastPanelKey = '';
        el.innerHTML = trainPanelHtml(this.game, t);
        bindTrainPanel(el, this, t);
        return;
      }
    }
    const tile = this.pinned ?? this.hoverTile;
    const world = this.game.world;
    let insp: Inspection | null = null;
    if (tile) insp = inspectTile(world, tile[0], tile[1]);
    this.renderer.hover = insp && !this.pinned ? { rect: insp.rect, color: '#f2c84a' } : null;
    this.renderer.selection = insp && this.pinned ? { rect: insp.rect, color: '#f3f5fb' } : null;
    this.inspectOverlay = { highlights: insp?.extraHighlights ?? [] };
    const key = tile ? `${tile[0]},${tile[1]},${this.pinned ? 1 : 0}` : 'none';
    // Station cargo and industry figures change daily.
    if (insp && insp.kind !== 'terrain' && insp.kind !== 'track' && this.game.day !== this.lastPanelDay && !el.matches(':hover')) this.panelDirty = true;
    this.lastPanelDay = this.game.day;
    if (key === this.lastPanelKey && !this.panelDirty) return;
    this.lastPanelKey = key;
    this.panelDirty = false;
    if (!insp) {
      el.innerHTML = `
        <div class="card-title"><span class="grow">Welcome, Chairman</span></div>
        <p class="hint" style="margin-top:0">You run <b>${esc(this.game.company.name)}</b>. Connect towns and industries:
        <kbd>B</kbd> places stations, <kbd>T</kbd> lays track (drag), <kbd>F</kbd> buys and manages trains. Right-drag or WASD pans, wheel zooms, Q/E rotates.</p>
        <div class="kv"><span>Towns</span><b>${world.cities.length}</b></div>
        <div class="kv"><span>Industries</span><b>${world.industries.length}</b></div>
        <div class="kv"><span>Stations</span><b>${world.liveStations().length}</b></div>
        <div class="kv"><span>Trains</span><b>${this.game.trains.trains.length}</b></div>
        <div class="kv"><span>Revenue this year</span><b>${fmtMoney(this.game.company.revenueIn(this.game.year))}</b></div>
        <div class="kv"><span>Map</span><b>${world.width}×${world.height}</b></div>
        ${this.game.companies.length > 1 ? `<div class="section">Railroads</div>${this.game.companies.map((c) => `<div class="kv"><span>${companyTag(c)}</span><b>${c.defunct ? c.defunct : `$${c.stock.price.toFixed(2)}`}</b></div>`).join('')}<p class="hint"><kbd>O</kbd> shows rivals, stakes and takeovers.</p>` : ''}`;
      return;
    }
    const tag = insp.kind === 'city' ? 'Town' : insp.kind === 'industry' ? 'Industry' : insp.kind === 'station' ? 'Station' : insp.kind === 'track' ? 'Track' : 'Land';
    el.innerHTML = `
      <div class="card-title">
        <span class="tag">${tag}</span><span class="grow" title="${esc(insp.title)}">${esc(insp.title)}</span>
        ${this.pinned ? `<button class="icon-btn" id="unpin" aria-label="Unpin" data-tip="Unpin" data-key="Esc">${icon('close')}</button>` : ''}
      </div>
      ${insp.html}
      ${this.inspectionExtras(insp)}`;
    const st = insp.stationId !== undefined ? this.game.world.stations[insp.stationId] : null;
    if (st) bindImprovements(el, this, st);
    bindIndustry(el, this);
    document.getElementById('unpin')?.addEventListener('click', () => (this.pinned = null));
    el.querySelector<HTMLElement>('[data-act="newtrain"]')?.addEventListener('click', (ev) => {
      const sid = Number((ev.currentTarget as HTMLElement).dataset.station);
      const other = this.game.world.liveStations().find((s) => s.id !== sid && s.owner === this.game.company.id);
      openTrainDialog(this, undefined, other ? [sid, other.id] : undefined);
    });
  }

  /** Economy sections appended to the inspector card. */
  private inspectionExtras(insp: Inspection): string {
    const g = this.game;
    const st = insp.stationId !== undefined ? g.world.stations[insp.stationId] : null;
    const tile = this.pinned ?? this.hoverTile;
    const node = tile && (insp.kind === 'track' || insp.kind === 'station') ? g.world.track.get(tile[0], tile[1]) : undefined;
    const owner = node ? g.companyById(node.owner) : undefined;
    const ownerRow = owner ? `<div class="kv"><span>Owner</span><b>${companyTag(owner)}</b></div>` : '';
    if (st) return ownerRow + stationEconomyHtml(g, st) + stationDemandHtml(g, st) + (st.owner === g.company.id ? improvementsHtml(g, st) : '');
    if (ownerRow) return ownerRow;
    if (insp.industryId !== undefined) return industryEconomyHtml(g, g.world.industries[insp.industryId]);
    if (insp.cityId !== undefined) return townGrowthHtml(g, g.world.cities[insp.cityId]);
    return '';
  }

  private newsTimer: number | null = null;

  /** Show a headline in the top-bar ticker for a while. */
  private showNews(text: string, tone: number): void {
    const el = $('#news');
    el.textContent = text;
    el.className = `news show ${tone > 0 ? 'good' : tone < 0 ? 'bad' : ''}`;
    el.title = text;
    if (this.newsTimer !== null) clearTimeout(this.newsTimer);
    this.newsTimer = window.setTimeout(() => el.classList.remove('show'), 12000);
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
    type Drag = { id: number; x: number; y: number; moved: number; button: number; toolOwned: boolean };
    let drag: Drag | null = null;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      if (!this.game) return;
      c.setPointerCapture(e.pointerId);
      const [x, y] = this.toBuffer(e);
      const tile = this.renderer.pick(this.camera, x, y);
      let toolOwned = false;
      if (this.tool?.pointerDown) toolOwned = this.tool.pointerDown(tile, e.button) && (e.button === 0 || e.button === 2);
      if (toolOwned && e.button === 2) {
        // Right-click consumed as "cancel" by the tool.
        drag = null;
        return;
      }
      drag = { id: e.pointerId, x, y, moved: 0, button: e.button, toolOwned: toolOwned && e.button === 0 && !this.tool?.leftDragPans };
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.game) return;
      const [x, y] = this.toBuffer(e);
      const tile = this.renderer.pick(this.camera, x, y);
      if (drag && drag.id === e.pointerId) {
        const dx = x - drag.x;
        const dy = y - drag.y;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        drag.x = x;
        drag.y = y;
        if (drag.toolOwned) {
          this.hoverTile = tile;
          this.tool?.pointerMove?.(tile);
          return;
        }
        if (drag.moved > 3) {
          c.classList.add('panning');
          this.following = null;
          this.camera.panByScreen(dx, dy);
        }
        return;
      }
      if (tile?.[0] !== this.hoverTile?.[0] || tile?.[1] !== this.hoverTile?.[1]) {
        this.hoverTile = tile;
        this.tool?.pointerMove?.(tile);
      }
    });
    const end = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return;
      const d = drag;
      drag = null;
      c.classList.remove('panning');
      const [x, y] = this.toBuffer(e);
      const tile = this.renderer.pick(this.camera, x, y);
      if (d.toolOwned) {
        this.tool?.pointerUp?.(tile);
        return;
      }
      const wasClick = d.moved <= 3 && d.button === 0;
      if (!wasClick) return;
      if (this.tool) this.tool.pointerUp?.(tile);
      else {
        const hit = this.renderer.pickTrain(x, y, 9 * (this.camera.tw / 32) * this.camera.scale);
        if (hit >= 0) this.selectTrain(hit);
        else {
          this.selectedTrain = null;
          this.pinned = tile;
        }
      }
      this.invalidatePanel();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (!drag) {
        this.hoverTile = null;
        this.tool?.pointerMove?.(null);
      }
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
      // Escape closes a dialog even while one of its fields has focus.
      if (document.querySelector('.modal-backdrop')) {
        if (e.key === 'Escape') {
          this.closeModal();
          e.preventDefault();
        }
        return;
      }
      if (target.closest('input, select, textarea')) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') {
        this.undo();
        e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'w', 'a', 's', 'd'].includes(k)) {
        this.keysDown.add(k);
        this.following = null;
        e.preventDefault();
        return;
      }
      if (this.tool?.key?.(k)) {
        this.invalidatePanel();
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
        case 'i':
          this.setTool('inspect');
          break;
        case 't':
          this.setTool('track');
          break;
        case 'b':
          this.setTool('station');
          break;
        case 'x':
          this.setTool('bulldoze');
          break;
        case 'f':
          openFleet(this);
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
          this.renderer.showGrid = !this.renderer.showGrid;
          break;
        case 'l':
          this.renderer.showLabels = !this.renderer.showLabels;
          break;
        case 'c':
          this.centerOnFocus();
          break;
        case 'm':
          openFinance(this);
          break;
        case 'o':
          openCompanies(this);
          break;
        case 'j':
          if (e.shiftKey) {
            setOverlay(this.game, null);
            clearChain();
          } else this.openOverlays();
          break;
        case 'y':
          openSupplyChains(this, () => this.invalidatePanel());
          break;
        case 'u':
          openAdvisor(this);
          break;
        case 'k':
          openStats(this);
          break;
        case 'n':
          this.openNewGameDialog();
          break;
        case 'h':
        case '?':
          this.openHelp();
          break;
        case 'escape':
          if (this.tool) this.setTool('inspect');
          else if (this.selectedTrain !== null) this.selectTrain(null);
          else this.pinned = null;
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

  closeModal(): void {
    $('#modal-root').innerHTML = '';
  }

  openModal(html: string, cls = ''): HTMLElement {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
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
        <div class="row"><label>Economy</label>${sel('model', Object.keys(ECONOMY.models), this.game?.settings.model ?? ECONOMY.model)}</div>
        <div class="row"><label>Rivals</label>${sel('rivals', ['0', '1', '2', '3'], String(this.game?.settings.rivals ?? 2))}</div>
        <div class="row"><label>Rival skill</label>${sel('aiLevel', Object.keys(AI.levels), this.game?.settings.aiLevel ?? 'normal')}</div>
        <div class="row"><label>Rival attitude</label>${sel('friendly', ['ruthless', 'friendly'], this.game?.settings.friendlyAi ? 'friendly' : 'ruthless')}</div>
        <div class="row"><label>Wrecks</label>${sel('wrecks', ['on', 'off'], this.game ? (this.game.settings.wrecks ? 'on' : 'off') : ECONOMY.wrecks.enabledByDefault ? 'on' : 'off')}</div>
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
      const settings: Partial<GameSettings> = {
        model: fd.get('model') as EconomicModel,
        wrecks: fd.get('wrecks') === 'on',
        rivals: Number(fd.get('rivals')),
        aiLevel: fd.get('aiLevel') as AiLevel,
        friendlyAi: fd.get('friendly') === 'friendly',
      };
      this.closeModal();
      withLoading('Surveying the land…', () => this.newGame(params, settings));
    });
    (m.querySelector('#ng-seed') as HTMLInputElement).focus();
  }

  openHelp(): void {
    const keys: Array<[string, string]> = [
      ['T', 'Lay track: drag from A to B, auto-routed'],
      ['V', 'Toggle single/double track (track tool)'],
      ['B', 'Build station (B again cycles size, R rotates)'],
      ['X', 'Bulldoze track / stations'],
      ['F', 'Trains: fleet list, buy & edit trains'],
      ['M', 'Finance: books, bonds, stock, your portfolio'],
      ['O', 'Railroads: rivals, stakes, mergers, board vote'],
      ['U', 'Advisor: advice, news log, delivery formulas'],
      ['K', 'Statistics: revenue, trains, stations, rivals, net worth'],
      ['J / Shift+J', 'Map overlay picker / overlay off'],
      ['Y', 'Supply-chain explorer'],
      ['Click a train', 'Select it (panel shows cargo, route, profit)'],
      ['Ctrl+Z', 'Undo construction (full refund, within 7 days)'],
      ['I / Esc', 'Back to Inspect · Esc cancels a drag'],
      ['Right/middle drag', 'Pan the map'],
      ['W A S D / arrows', 'Pan'],
      ['Mouse wheel  + / -', 'Zoom'],
      ['Q / E', 'Rotate view 90°'],
      ['Click (Inspect)', 'Pin tile details'],
      ['Space / P', 'Pause / resume (building works while paused)'],
      ['1 2 3 4', 'Speed 1× 2× 4× 8×'],
      ['G / L', 'Tile grid / labels'],
      ['C', 'Centre on pinned tile / largest town'],
      ['N', 'New map'],
      ['H / ?', 'This help'],
    ];
    const m = this.openModal(`
      <h2>Iron Baron — controls</h2>
      <div class="keys">${keys.map(([k, v]) => `<kbd>${esc(k)}</kbd><span>${esc(v)}</span>`).join('')}</div>
      <p class="hint">Grades matter: heavy trains crawl up steep track. Single track carries one train at a time between stations (which act as passing points); double track lets trains pass anywhere.</p>
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
