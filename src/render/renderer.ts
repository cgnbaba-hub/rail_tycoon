import type { World } from '../sim/world';
import { drawText, measureText, TEXT_HEIGHT } from './bitmapText';
import type { Camera } from './camera';
import { project, rotatedSize } from './iso';
import { PALETTE } from './palette';
import { pickTile } from './pick';
import { CHUNK, WorldRenderData, renderChunk } from './terrain';

interface CachedChunk {
  canvas: HTMLCanvasElement;
  ox: number;
  oy: number;
  bytes: number;
  used: number;
}

export interface Highlight {
  /** World tile rect [x, y, w, h]. */
  rect: [number, number, number, number];
  color: string;
}

const CACHE_BUDGET_BYTES = 192 * 1024 * 1024;
const BUILD_BUDGET_MS = 12;

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
  showLabels = true;
  hover: Highlight | null = null;
  selection: Highlight | null = null;
  /** Number of chunks still missing after the last frame (for a loading hint). */
  pendingChunks = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
  }

  setWorld(world: World): void {
    this.world = world;
    this.data = new WorldRenderData(world);
    this.worldRevision = world.revision;
    this.clearCache();
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
    this.frame++;
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    camera.viewW = this.canvas.width;
    camera.viewH = this.canvas.height;

    this.drawChunks(camera);
    if (this.selection) this.drawHighlight(camera, this.selection);
    if (this.hover) this.drawHighlight(camera, this.hover);
    this.drawSmoke(camera, time);
    if (this.showLabels) this.drawCityLabels(camera);
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

    // Build missing chunks nearest-first within a time budget.
    const start = performance.now();
    let missing = 0;
    const byDist = [...visible].sort((a, b) => a.dist - b.dist);
    for (const v of byDist) {
      const key = this.key(v.cx, v.cy, rot, tw);
      if (this.cache.has(key)) continue;
      if (performance.now() - start > BUILD_BUDGET_MS) {
        missing++;
        continue;
      }
      this.buildChunk(key, v.cx, v.cy, rot, tw);
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

  private buildChunk(key: string, cx: number, cy: number, rot: 0 | 1 | 2 | 3, tw: number): void {
    const { buf } = renderChunk(this.data, rot, tw, cx, cy, { grid: this.showGrid });
    const canvas = document.createElement('canvas');
    canvas.width = buf.w;
    canvas.height = buf.h;
    const cctx = canvas.getContext('2d')!;
    cctx.putImageData(new ImageData(new Uint8ClampedArray(buf.data.buffer as ArrayBuffer), buf.w, buf.h), 0, 0);
    const bytes = buf.w * buf.h * 4;
    this.cache.set(key, { canvas, ox: buf.ox, oy: buf.oy, bytes, used: this.frame });
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

  /** Aliased 1px line in buffer space. */
  private pixelLine(x0: number, y0: number, x1: number, y1: number, color: string): void {
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
    for (let guard = 0; guard < 4096; guard++) {
      ctx.fillRect(xa, ya, 1, 1);
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
    // Outline every edge on the rect perimeter, following the terrain.
    const P = (vx: number, vy: number) => camera.worldToScreen(vx, vy, world.vh(vx, vy));
    const edge = (ax: number, ay: number, bx: number, by: number) => {
      const [sx0, sy0] = P(ax, ay);
      const [sx1, sy1] = P(bx, by);
      this.pixelLine(sx0, sy0 - 1, sx1, sy1 - 1, hl.color);
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

  private drawCityLabels(camera: Camera): void {
    const ctx = this.ctx;
    for (const city of this.world.cities) {
      if (camera.zoom === 0 && city.classIndex === 0) continue;
      const z = this.world.vh(city.x, city.y);
      const [sx, sy] = camera.worldToScreen(city.x + 0.5, city.y + 0.5, z);
      const label = city.name;
      const w = measureText(label);
      const lx = Math.round(sx - w / 2);
      const ly = Math.round(sy - 26 * (camera.tw / 32) * camera.scale - 14);
      if (lx > this.canvas.width || ly > this.canvas.height || lx + w < 0 || ly + 12 < 0) continue;
      ctx.fillStyle = PALETTE.ink;
      ctx.fillRect(lx - 3, ly - 3, w + 6, TEXT_HEIGHT + 6);
      ctx.fillStyle = city.classIndex >= 2 ? PALETTE.gold : PALETTE.fog;
      ctx.fillRect(lx - 3, ly + TEXT_HEIGHT + 2, w + 6, 1);
      drawText(ctx, label, lx, ly, PALETTE.bone);
    }
  }
}
