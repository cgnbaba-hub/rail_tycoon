import { glyphBitmaps, GLYPH_ROWS_ABOVE } from '../assets/glyphs';

/** Pixel text for the world canvas, drawn from the same glyph table as the UI font. */
const LINE = GLYPH_ROWS_ABOVE + 2;

export function measureText(text: string): number {
  const glyphs = glyphBitmaps();
  let w = 0;
  for (const ch of text) w += (glyphs.get(ch) ?? glyphs.get('?')!).width + 1;
  return Math.max(0, w - 1);
}

const atlasCache = new Map<string, { canvas: HTMLCanvasElement; pos: Map<string, number> }>();

function atlas(color: string) {
  let a = atlasCache.get(color);
  if (a) return a;
  const glyphs = [...glyphBitmaps().values()];
  const total = glyphs.reduce((s, g) => s + g.width + 1, 0);
  const canvas = document.createElement('canvas');
  canvas.width = total;
  canvas.height = LINE;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  const pos = new Map<string, number>();
  let x = 0;
  for (const g of glyphs) {
    pos.set(g.ch, x);
    g.rows.forEach((row, r) => row.forEach((on, c) => on && ctx.fillRect(x + c, r, 1, 1)));
    x += g.width + 1;
  }
  a = { canvas, pos };
  atlasCache.set(color, a);
  return a;
}

/** Draw text with its top-left at (x, y) (top = cap height). */
export function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  const glyphs = glyphBitmaps();
  const a = atlas(color);
  let cx = Math.round(x);
  const cy = Math.round(y);
  for (const ch of text) {
    const g = glyphs.get(ch) ?? glyphs.get('?')!;
    const sx = a.pos.get(g.ch)!;
    ctx.drawImage(a.canvas, sx, 0, g.width, LINE, cx, cy, g.width, LINE);
    cx += g.width + 1;
  }
}

export const TEXT_HEIGHT = GLYPH_ROWS_ABOVE;
