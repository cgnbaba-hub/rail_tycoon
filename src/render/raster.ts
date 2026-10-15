import { PALETTE_U32 } from './palette';

/**
 * A 32-bit RGBA pixel buffer (little-endian ABGR words) that knows where it sits in world
 * pixel space, so ordered dithering lines up seamlessly across chunk boundaries.
 * All drawing here is aliased by construction: no blending, no sub-pixel coverage.
 */
export class PixelBuffer {
  readonly data: Uint32Array;

  constructor(
    readonly w: number,
    readonly h: number,
    /** World-pixel coordinate of pixel (0, 0). */
    readonly ox = 0,
    readonly oy = 0,
  ) {
    this.data = new Uint32Array(w * h);
  }

  get(x: number, y: number): number {
    return this.data[y * this.w + x];
  }

  /** Number of non-transparent pixels. */
  countOpaque(): number {
    let n = 0;
    for (let i = 0; i < this.data.length; i++) if (this.data[i] !== 0) n++;
    return n;
  }
}

/** Solid colour (packed u32) or an ordered dither between two colours. */
export type Paint = number | { a: number; b: number; t: number };

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

export function bayer(x: number, y: number): number {
  return BAYER4[((y & 3) << 2) | (x & 3)];
}

export function solid(paletteIndex: number): number {
  return PALETTE_U32[paletteIndex];
}

/**
 * Pick a colour along a 3-step ramp for brightness t ∈ [0, 2] (0 = darkest, 1 = mid,
 * 2 = lightest) with ordered dithering in-between.
 */
export function rampPaint(ramp: readonly [number, number, number], t: number): Paint {
  const tc = t < 0 ? 0 : t > 2 ? 2 : t;
  const lo = tc >= 1 ? 1 : 0;
  const frac = tc - lo;
  if (frac < 1 / 16) return PALETTE_U32[ramp[lo]];
  if (frac > 15 / 16) return PALETTE_U32[ramp[lo + 1]];
  return { a: PALETTE_U32[ramp[lo]], b: PALETTE_U32[ramp[lo + 1]], t: frac };
}

function paintPixel(buf: PixelBuffer, x: number, y: number, p: Paint): void {
  if (typeof p === 'number') {
    buf.data[y * buf.w + x] = p;
  } else {
    buf.data[y * buf.w + x] = bayer(x + buf.ox, y + buf.oy) < p.t ? p.b : p.a;
  }
}

export function plot(buf: PixelBuffer, x: number, y: number, color: number): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= buf.w || yi >= buf.h) return;
  buf.data[yi * buf.w + xi] = color;
}

const xsScratch: number[] = [];

/**
 * Scanline polygon fill with pixel-centre sampling. Shared edges between adjacent polygons
 * produce neither gaps nor double coverage. Coordinates are buffer-local.
 */
export function fillPolygon(buf: PixelBuffer, pts: readonly number[], paint: Paint): void {
  const n = pts.length >> 1;
  if (n < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = pts[i * 2 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const yStart = Math.max(0, Math.ceil(minY - 0.5));
  const yEnd = Math.min(buf.h - 1, Math.ceil(maxY - 0.5) - 1);
  for (let y = yStart; y <= yEnd; y++) {
    const yc = y + 0.5;
    xsScratch.length = 0;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const x0 = pts[i * 2];
      const y0 = pts[i * 2 + 1];
      const x1 = pts[j * 2];
      const y1 = pts[j * 2 + 1];
      if ((y0 <= yc && y1 > yc) || (y1 <= yc && y0 > yc)) {
        xsScratch.push(x0 + ((yc - y0) * (x1 - x0)) / (y1 - y0));
      }
    }
    if (xsScratch.length < 2) continue;
    xsScratch.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xsScratch.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xsScratch[k] - 0.5));
      const xb = Math.min(buf.w - 1, Math.ceil(xsScratch[k + 1] - 0.5) - 1);
      if (typeof paint === 'number') {
        const row = y * buf.w;
        for (let x = xa; x <= xb; x++) buf.data[row + x] = paint;
      } else {
        for (let x = xa; x <= xb; x++) paintPixel(buf, x, y, paint);
      }
    }
  }
}

/** Bresenham line between rounded endpoints. */
export function drawLine(buf: PixelBuffer, x0: number, y0: number, x1: number, y1: number, color: number): void {
  let xa = Math.round(x0);
  let ya = Math.round(y0);
  const xb = Math.round(x1);
  const yb = Math.round(y1);
  const dx = Math.abs(xb - xa);
  const dy = -Math.abs(yb - ya);
  const sx = xa < xb ? 1 : -1;
  const sy = ya < yb ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (xa >= 0 && ya >= 0 && xa < buf.w && ya < buf.h) buf.data[ya * buf.w + xa] = color;
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

export interface Sprite {
  w: number;
  h: number;
  /** Anchor (pixel inside the sprite that lands on the target point). */
  ax: number;
  ay: number;
  /** Palette indices, -1 = transparent. */
  px: Int8Array;
}

/** Parse a sprite from rows of characters using a legend char → palette index. */
export function parseSprite(rows: string[], legend: Record<string, number>, ax?: number, ay?: number): Sprite {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const px = new Int8Array(w * h).fill(-1);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      const idx = legend[ch];
      if (idx === undefined) throw new Error(`Sprite legend missing '${ch}'`);
      px[y * w + x] = idx;
    }
  });
  return { w, h, ax: ax ?? Math.floor(w / 2), ay: ay ?? h - 1, px };
}

export function blitSprite(buf: PixelBuffer, s: Sprite, x: number, y: number, scale = 1): void {
  const x0 = Math.round(x) - s.ax * scale;
  const y0 = Math.round(y) - s.ay * scale;
  for (let j = 0; j < s.h * scale; j++) {
    const ty = y0 + j;
    if (ty < 0 || ty >= buf.h) continue;
    for (let i = 0; i < s.w * scale; i++) {
      const p = s.px[Math.floor(j / scale) * s.w + Math.floor(i / scale)];
      if (p < 0) continue;
      const tx = x0 + i;
      if (tx < 0 || tx >= buf.w) continue;
      buf.data[ty * buf.w + tx] = PALETTE_U32[p];
    }
  }
}
