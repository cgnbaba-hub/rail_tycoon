import { ENGINE_BY_ID } from '../data';
import type { TrackPlan } from '../sim/construction';
import { NODE_TUNNEL } from '../sim/track';
import type { TrainSystem } from '../sim/train';
import type { World } from '../sim/world';
import { drawText, measureText, TEXT_HEIGHT } from './bitmapText';
import type { Camera } from './camera';
import { project, rotatedSize, tileToView, toView, vecToView, type Rot } from './iso';
import { PALETTE } from './palette';
import { pickTile } from './pick';
import { CHUNK, WorldRenderData, renderChunk } from './terrain';
import { loadLook, vehicleSprite } from './trainSprites';

interface CachedChunk {
  canvas: HTMLCanvasElement;
  ox: number;
  oy: number;
  bytes: number;
  used: number;
  /** World changed under this chunk; keep drawing it until the rebuild is done. */
  stale: boolean;
}

export interface Highlight {
  /** World tile rect [x, y, w, h]. */
  rect: [number, number, number, number];
  color: string;
  /** Draw every other pixel run (a pattern, so meaning isn't carried by colour alone). */
  dashed?: boolean;
}

/** Transient drawings requested by the active tool. */
export interface Overlay {
  plan?: TrackPlan | null;
  /** Dim the plan (e.g. unaffordable or still searching). */
  planDim?: boolean;
  highlights: Highlight[];
}

interface Puff {
  x: number;
  y: number;
  z: number;
  born: number;
}

interface Floater {
  x: number;
  y: number;
  z: number;
  text: string;
  color: string;
  born: number;
}

/** Screen position of a vehicle (for picking). */
interface VehicleHit {
  train: number;
  sx: number;
  sy: number;
}

const PUFF_LIFE = 36; // sim ticks
const FLOATER_MS = 2400;

const CACHE_BUDGET_BYTES = 192 * 1024 * 1024;
const BUILD_BUDGET_MS = 12;

/** Grade classes for the route preview: colour + label. */
export const GRADE_CLASSES = [
  { max: 1, color: PALETTE.meadow, label: '≤1%' },
  { max: 2, color: PALETTE.gold, label: '≤2%' },
  { max: 3.5, color: PALETTE.ember, label: '≤3.5%' },
  { max: Infinity, color: PALETTE.tile, label: '>3.5%' },
];

export function gradeClass(gradeAbs: number): number {
  return GRADE_CLASSES.findIndex((g) => gradeAbs <= g.max);
}

/**
 * Composes a frame: cached terrain chunks (back to front), then dynamic overlays.
 * Draws into a low-resolution canvas that CSS scales up with `image-rendering: pixelated`.
 */
export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  private data!: WorldRenderData;
  private world!: World;
  private worldRevision = -1;
  private cache = new Map<string, CachedChunk>();
  private cacheBytes = 0;
  private frame = 0;
  showGrid = false;
  /** Palette colour name per company id (index 0 = the player). */
  ownerColors: string[] = [];
  showLabels = true;
  hover: Highlight | null = null;
  selection: Highlight | null = null;
  overlay: Overlay = { highlights: [] };
  /** Number of chunks still missing after the last frame (for a loading hint). */
  pendingChunks = 0;
  /** Incremented whenever world tiles changed (minimap etc. can refresh). */
  changeCounter = 0;
  trains: TrainSystem | null = null;
  selectedTrain = -1;
  private puffs: Puff[] = [];
  private lastPuffTime = 0;
  private floaters: Floater[] = [];
  private hits: VehicleHit[] = [];

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
  }

  setWorld(world: World): void {
    this.world = world;
    this.data = new WorldRenderData(world);
    this.worldRevision = world.revision;
    world.dirty.clear();
    this.clearCache();
    this.changeCounter++;
  }

  clearCache(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }

  resize(w: number, h: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** World tile under a buffer pixel, if any. */
  pick(camera: Camera, sx: number, sy: number): [number, number] | null {
    const [wx, wy] = camera.toWorldPx(sx, sy);
    return pickTile(this.world, camera.rot, camera.tw, wx, wy);
  }

  render(camera: Camera, time: number): void {
    if (this.world.revision !== this.worldRevision) this.setWorld(this.world);
    this.processDirty();
    this.frame++;
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    camera.viewW = this.canvas.width;
    camera.viewH = this.canvas.height;

    this.drawChunks(camera);
    for (const h of this.overlay.highlights) this.drawHighlight(camera, h);
    if (this.selection) this.drawHighlight(camera, this.selection);
    if (this.hover) this.drawHighlight(camera, this.hover);
    if (this.overlay.plan?.ok) this.drawPlan(camera, this.overlay.plan, !!this.overlay.planDim);
    this.drawTrains(camera, time);
    this.drawSmoke(camera, time);
    this.drawPuffs(camera, time);
    if (this.showLabels) {
      this.drawCityLabels(camera);
      this.drawStationLabels(camera);
    }
    this.drawFloaters(camera);
  }

  /** Show a rising money/label text in the world (e.g. delivery revenue). */
  addFloater(x: number, y: number, z: number, text: string, color: string = PALETTE.gold): void {
    this.floaters.push({ x, y, z, text, color, born: performance.now() });
    if (this.floaters.length > 40) this.floaters.shift();
  }

  /** Train whose vehicle is drawn nearest to a buffer pixel (within a few pixels). */
  pickTrain(sx: number, sy: number, radius = 9): number {
    let best = -1;
    let bestD = radius;
    for (const h of this.hits) {
      const d = Math.hypot(h.sx - sx, h.sy - sy);
      if (d < bestD) {
        bestD = d;
        best = h.train;
      }
    }
    return best;
  }

  private drawTrains(camera: Camera, time: number): void {
    this.hits = [];
    const sys = this.trains;
    if (!sys) return;
    const W = this.world.width;
    const H = this.world.height;
    type Item = { depth: number; sx: number; sy: number; sprite: ReturnType<typeof vehicleSprite>; train: number; engine: boolean };
    const items: Item[] = [];
    const emit = Math.floor(time / 3) !== Math.floor(this.lastPuffTime / 3) && time > this.lastPuffTime;
    for (const t of sys.trains) {
      const vehicles = sys.vehiclePositions(t);
      vehicles.forEach((v, i) => {
        if (v.tunnel) return;
        const [vx, vy] = vecToView(v.dx, v.dy, camera.rot);
        const vd = (((Math.round(Math.atan2(vy, vx) / (Math.PI / 4)) % 8) + 8) % 8);
        const car = v.car >= 0 ? t.cars[v.car] : undefined;
        const look = car ? { key: `car:${car.type}`, load: loadLook(car.type, car.cargo, car.loads) } : { key: `${v.kind}:${t.engine}`, load: '' };
        const sprite = vehicleSprite(look, vd, camera.tw);
        const [sx, sy] = camera.worldToScreen(v.x, v.y, v.z);
        const [rx, ry] = toView(v.x, v.y, camera.rot, W, H);
        items.push({ depth: rx + ry, sx, sy, sprite, train: t.id, engine: i === 0 });
        this.hits.push({ train: t.id, sx, sy: sy - 4 * (camera.tw / 32) * camera.scale });
        if (i === 0 && emit && t.speed > 1 && !ENGINE_BY_ID.get(t.engine)?.look.diesel) {
          this.puffs.push({ x: v.x + v.dx * 0.2, y: v.y + v.dy * 0.2, z: v.z + 1.7, born: time });
        }
      });
    }
    if (time > this.lastPuffTime || time < this.lastPuffTime - 100) this.lastPuffTime = time;
    items.sort((a, b) => a.depth - b.depth);
    const s = camera.scale;
    for (const it of items) {
      const { canvas, ax, ay } = it.sprite;
      const x = Math.round(it.sx - ax * s);
      const y = Math.round(it.sy - ay * s);
      if (x > this.canvas.width || y > this.canvas.height || x + canvas.width * s < 0 || y + canvas.height * s < 0) continue;
      this.ctx.drawImage(canvas, x, y, canvas.width * s, canvas.height * s);
      if (it.engine && it.train === this.selectedTrain) {
        // Marker above the selected train's engine.
        const mx = Math.round(it.sx);
        const my = Math.round(it.sy - (camera.tw * 0.42 + 8) * s);
        this.ctx.fillStyle = PALETTE.ink;
        this.ctx.fillRect(mx - 4, my - 1, 9, 6);
        this.ctx.fillStyle = PALETTE.gold;
        this.ctx.fillRect(mx - 3, my, 7, 1);
        this.ctx.fillRect(mx - 2, my + 1, 5, 1);
        this.ctx.fillRect(mx - 1, my + 2, 3, 1);
        this.ctx.fillRect(mx, my + 3, 1, 1);
      }
    }
  }

  private drawPuffs(camera: Camera, time: number): void {
    if (camera.tw < 16) {
      this.puffs = [];
      return;
    }
    this.puffs = this.puffs.filter((p) => time - p.born < PUFF_LIFE && time >= p.born);
    const k = (camera.tw / 32) * camera.scale;
    for (const p of this.puffs) {
      const age = (time - p.born) / PUFF_LIFE;
      const [sx, sy] = camera.worldToScreen(p.x, p.y, p.z + age * 4);
      const r = Math.max(1, Math.round((1 + age * 2.2) * k));
      const x = Math.round(sx);
      const y = Math.round(sy);
      const body = age < 0.4 ? PALETTE.bone : age < 0.75 ? PALETTE.fog : PALETTE.steel;
      const rim = age < 0.4 ? PALETTE.fog : age < 0.75 ? PALETTE.steel : PALETTE.slate;
      // A pixel disc: shaded rim on the lower right, body, small highlight.
      this.disc(x + Math.max(1, Math.round(r / 4)), y + Math.max(1, Math.round(r / 4)), r, rim);
      this.disc(x, y, r, body);
      if (r >= 3 && age < 0.5) this.disc(x - Math.round(r / 3), y - Math.round(r / 3), Math.max(1, Math.round(r / 3)), PALETTE.snow);
    }
  }

  /** Filled pixel circle (row spans, no anti-aliasing). */
  private disc(cx: number, cy: number, r: number, color: string): void {
    this.ctx.fillStyle = color;
    for (let dy = -r; dy <= r; dy++) {
      const half = Math.floor(Math.sqrt(r * r - dy * dy) + 0.35);
      this.ctx.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
    }
  }

  private drawFloaters(camera: Camera): void {
    const now = performance.now();
    this.floaters = this.floaters.filter((f) => now - f.born < FLOATER_MS);
    for (const f of this.floaters) {
      const age = (now - f.born) / FLOATER_MS;
      const [sx, sy] = camera.worldToScreen(f.x, f.y, f.z);
      const w = measureText(f.text);
      const x = Math.round(sx - w / 2);
      const y = Math.round(sy - 22 * camera.scale - age * 18);
      this.ctx.fillStyle = PALETTE.ink;
      this.ctx.fillRect(x - 2, y - 2, w + 4, TEXT_HEIGHT + 4);
      drawText(this.ctx, f.text, x, y, f.color);
    }
  }

  /** Mark cached chunks around changed tiles as stale (all rotations and zooms). */
  private processDirty(): void {
    const dirty = this.world.dirty;
    if (dirty.size === 0) return;
    const W = this.world.width;
    const H = this.world.height;
    const affected = new Set<string>();
    for (const t of dirty) {
      const x = t % W;
      const y = Math.floor(t / W);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          for (let rot = 0; rot < 4; rot++) {
            const [rx, ry] = tileToView(nx, ny, rot as Rot, W, H);
            affected.add(`${Math.floor(rx / CHUNK)},${Math.floor(ry / CHUNK)},${rot}`);
          }
        }
      }
    }
    for (const [key, c] of this.cache) {
      const parts = key.split(',');
      if (affected.has(`${parts[0]},${parts[1]},${parts[2]}`)) c.stale = true;
    }
    dirty.clear();
    this.changeCounter++;
  }

  private drawChunks(camera: Camera): void {
    const world = this.world;
    const { tw, scale, rot } = camera;
    const [RW, RH] = rotatedSize(rot, world.width, world.height);
    const [vx0, vy0] = camera.toWorldPx(0, 0);
    const [vx1, vy1] = camera.toWorldPx(this.canvas.width, this.canvas.height);
    const hs = tw / 8;
    const overhang = Math.ceil((110 * tw) / 32) + 4;
    const nCx = Math.ceil(RW / CHUNK);
    const nCy = Math.ceil(RH / CHUNK);
    const visible: Array<{ cx: number; cy: number; dist: number }> = [];
    const [ccx, ccy] = camera.toWorldPx(this.canvas.width / 2, this.canvas.height / 2);
    for (let cy = 0; cy < nCy; cy++) {
      for (let cx = 0; cx < nCx; cx++) {
        const rx0 = cx * CHUNK;
        const ry0 = cy * CHUNK;
        const rx1 = Math.min(RW, rx0 + CHUNK);
        const ry1 = Math.min(RH, ry0 + CHUNK);
        const sx0 = ((rx0 - ry1) * tw) / 2 - 2 * tw;
        const sx1 = ((rx1 - ry0) * tw) / 2 + 2 * tw;
        const sy0 = ((rx0 + ry0) * tw) / 4 - world.maxHeight * hs - overhang;
        const sy1 = ((rx1 + ry1) * tw) / 4 + 2 * hs + 2;
        if (sx1 < vx0 || sx0 > vx1 || sy1 < vy0 || sy0 > vy1) continue;
        const [mx, my] = project((rx0 + rx1) / 2, (ry0 + ry1) / 2, 0, tw);
        visible.push({ cx, cy, dist: Math.hypot(mx - ccx, my - ccy) });
      }
    }

    // Build missing chunks first, then refresh stale ones, nearest-first within a budget.
    const start = performance.now();
    let missing = 0;
    const byDist = [...visible].sort((a, b) => a.dist - b.dist);
    for (const pass of [0, 1]) {
      for (const v of byDist) {
        const key = this.key(v.cx, v.cy, rot, tw);
        const c = this.cache.get(key);
        if (pass === 0 ? c : !c?.stale) continue;
        if (performance.now() - start > BUILD_BUDGET_MS) {
          missing++;
          continue;
        }
        this.buildChunk(key, v.cx, v.cy, rot, tw);
      }
    }
    this.pendingChunks = missing;

    visible.sort((a, b) => a.cx + a.cy - (b.cx + b.cy));
    for (const v of visible) {
      const c = this.cache.get(this.key(v.cx, v.cy, rot, tw));
      if (!c) continue;
      c.used = this.frame;
      const [sx, sy] = camera.toScreen(c.ox, c.oy);
      this.ctx.drawImage(c.canvas, sx, sy, c.canvas.width * scale, c.canvas.height * scale);
    }
    this.evict();
  }

  private key(cx: number, cy: number, rot: number, tw: number): string {
    return `${cx},${cy},${rot},${tw},${this.showGrid ? 1 : 0}`;
  }

  private buildChunk(key: string, cx: number, cy: number, rot: Rot, tw: number): void {
    const { buf } = renderChunk(this.data, rot, tw, cx, cy, { grid: this.showGrid, ownerColors: this.ownerColors });
    const old = this.cache.get(key);
    if (old) this.cacheBytes -= old.bytes;
    const canvas = document.createElement('canvas');
    canvas.width = buf.w;
    canvas.height = buf.h;
    const cctx = canvas.getContext('2d')!;
    cctx.putImageData(new ImageData(new Uint8ClampedArray(buf.data.buffer as ArrayBuffer), buf.w, buf.h), 0, 0);
    const bytes = buf.w * buf.h * 4;
    this.cache.set(key, { canvas, ox: buf.ox, oy: buf.oy, bytes, used: this.frame, stale: false });
    this.cacheBytes += bytes;
  }

  private evict(): void {
    if (this.cacheBytes <= CACHE_BUDGET_BYTES) return;
    const entries = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k, c] of entries) {
      if (this.cacheBytes <= CACHE_BUDGET_BYTES * 0.8 || c.used === this.frame) break;
      this.cache.delete(k);
      this.cacheBytes -= c.bytes;
    }
  }

  /** Aliased 1px line in buffer space; `dash` skips every other 2px run. */
  private pixelLine(x0: number, y0: number, x1: number, y1: number, color: string, dash = false): void {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    let xa = Math.round(x0);
    let ya = Math.round(y0);
    const xb = Math.round(x1);
    const yb = Math.round(y1);
    const dx = Math.abs(xb - xa);
    const dy = -Math.abs(yb - ya);
    const sx = xa < xb ? 1 : -1;
    const sy = ya < yb ? 1 : -1;
    let err = dx + dy;
    for (let n = 0; n < 4096; n++) {
      if (!dash || (n & 2) === 0) ctx.fillRect(xa, ya, 1, 1);
      if (xa === xb && ya === yb) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        xa += sx;
      }
      if (e2 <= dx) {
        err += dx;
        ya += sy;
      }
    }
  }

  private drawHighlight(camera: Camera, hl: Highlight): void {
    const world = this.world;
    const [x, y, w, h] = hl.rect;
    const P = (vx: number, vy: number) => camera.worldToScreen(vx, vy, world.vh(vx, vy));
    const edge = (ax: number, ay: number, bx: number, by: number) => {
      const [sx0, sy0] = P(ax, ay);
      const [sx1, sy1] = P(bx, by);
      if (Math.max(sx0, sx1) < -2 || Math.min(sx0, sx1) > this.canvas.width + 2) return;
      if (Math.max(sy0, sy1) < -2 || Math.min(sy0, sy1) > this.canvas.height + 2) return;
      this.pixelLine(sx0, sy0 - 1, sx1, sy1 - 1, hl.color, hl.dashed);
    };
    for (let i = 0; i < w; i++) {
      edge(x + i, y, x + i + 1, y);
      edge(x + i, y + h, x + i + 1, y + h);
    }
    for (let j = 0; j < h; j++) {
      edge(x, y + j, x, y + j + 1);
      edge(x + w, y + j, x + w, y + j + 1);
    }
  }

  /** Route preview: centre line per step, coloured by grade class; bridges/tunnels dashed. */
  private drawPlan(camera: Camera, plan: TrackPlan, dim: boolean): void {
    const W = this.world.width;
    const c = (i: number): [number, number] => [(i % W) + 0.5, Math.floor(i / W) + 0.5];
    const lift = 0.5;
    for (const st of plan.steps) {
      const [ax, ay] = c(st.from);
      const [bx, by] = c(st.to);
      const color = dim ? PALETTE.steel : st.kind === 'reuse' && !st.upgrade ? PALETTE.fog : GRADE_CLASSES[gradeClass(Math.abs(st.grade))].color;
      const [sx0, sy0] = camera.worldToScreen(ax, ay, st.z0 + lift);
      const [sx1, sy1] = camera.worldToScreen(bx, by, st.z1 + lift);
      const dash = st.kind === 'tunnel' || st.kind === 'bridge';
      this.pixelLine(sx0, sy0, sx1, sy1, color, dash);
      this.pixelLine(sx0, sy0 - 1, sx1, sy1 - 1, color, dash && st.kind === 'tunnel');
    }
    const ends: Array<[number, number]> = [
      [plan.from, plan.profile[0]?.z ?? 0],
      [plan.to, plan.profile[plan.profile.length - 1]?.z ?? 0],
    ];
    for (const [i, z] of ends) {
      const [x, y] = c(i);
      const [sx, sy] = camera.worldToScreen(x, y, z + lift);
      this.ctx.fillStyle = PALETTE.ink;
      this.ctx.fillRect(Math.round(sx) - 2, Math.round(sy) - 3, 5, 5);
      this.ctx.fillStyle = PALETTE.snow;
      this.ctx.fillRect(Math.round(sx) - 1, Math.round(sy) - 2, 3, 3);
    }
  }

  private drawSmoke(camera: Camera, time: number): void {
    const ctx = this.ctx;
    const k = (camera.tw / 32) * camera.scale;
    if (camera.tw < 16) return;
    for (const s of this.data.smokes) {
      const [bx, by] = camera.worldToScreen(s.x, s.y, s.z);
      if (bx < -40 || by < -60 || bx > this.canvas.width + 40 || by > this.canvas.height + 20) continue;
      const seedPhase = (s.seed % 1000) / 1000;
      for (let p = 0; p < 4; p++) {
        const phase = (time / 40 + p / 4 + seedPhase) % 1;
        const r = Math.max(1, Math.round((1 + phase * 2.2) * k));
        const px = Math.round(bx + phase * 7 * k);
        const py = Math.round(by - 2 * k - phase * 16 * k);
        ctx.fillStyle = phase < 0.45 ? PALETTE.bone : phase < 0.8 ? PALETTE.fog : PALETTE.steel;
        ctx.fillRect(px - r, py - r + 1, r * 2, r * 2 - 2 > 0 ? r * 2 - 2 : 1);
        ctx.fillRect(px - r + 1, py - r, r * 2 - 2 > 0 ? r * 2 - 2 : 1, r * 2);
      }
    }
  }

  private label(x: number, y: number, text: string, fg: string, bg: string, rule: string): void {
    const w = measureText(text);
    const lx = Math.round(x - w / 2);
    const ly = Math.round(y);
    if (lx > this.canvas.width || ly > this.canvas.height || lx + w < 0 || ly + 12 < 0) return;
    const ctx = this.ctx;
    ctx.fillStyle = bg;
    ctx.fillRect(lx - 3, ly - 3, w + 6, TEXT_HEIGHT + 6);
    ctx.fillStyle = rule;
    ctx.fillRect(lx - 3, ly + TEXT_HEIGHT + 2, w + 6, 1);
    drawText(ctx, text, lx, ly, fg);
  }

  private drawCityLabels(camera: Camera): void {
    for (const city of this.world.cities) {
      if (camera.zoom === 0 && city.classIndex === 0) continue;
      const z = this.world.vh(city.x, city.y);
      const [sx, sy] = camera.worldToScreen(city.x + 0.5, city.y + 0.5, z);
      const y = sy - 26 * (camera.tw / 32) * camera.scale - 14;
      this.label(sx, y, city.name, PALETTE.bone, PALETTE.ink, city.classIndex >= 2 ? PALETTE.gold : PALETTE.fog);
    }
  }

  private drawStationLabels(camera: Camera): void {
    if (camera.tw < 16) return;
    const W = this.world.width;
    for (const st of this.world.liveStations()) {
      const mid = st.tiles[Math.floor(st.tiles.length / 2)];
      const node = this.world.track.getIdx(mid);
      if (!node || node.kind === NODE_TUNNEL) continue;
      const [sx, sy] = camera.worldToScreen((mid % W) + 0.5, Math.floor(mid / W) + 0.5, node.z);
      const rival = st.owner !== 0 ? PALETTE[this.ownerColors[st.owner] as keyof typeof PALETTE] : undefined;
      if (rival) this.label(sx, sy + 6 * camera.scale, st.name, PALETTE.cream, PALETTE.night, rival);
      else this.label(sx, sy + 6 * camera.scale, st.name, PALETTE.cream, PALETTE.oxblood, PALETTE.gold);
    }
  }
}
