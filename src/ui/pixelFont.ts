import { glyphBitmaps, GLYPH_ROWS_ABOVE } from '../assets/glyphs';

/**
 * Builds a TrueType font (glyf outlines) from the 5×7 pixel glyph table, entirely at
 * runtime. Every lit pixel becomes part of a rectangle contour, so at font sizes that are a
 * multiple of 10px (1 font pixel = 1/10 em) the text renders as crisp blocks.
 */
export const FONT_FAMILY = 'BaronPixel';
const UNIT = 100; // font units per glyph pixel
const UPM = 1000; // 10 pixel rows per em
const ASCENT = 8 * UNIT;
const DESCENT = 2 * UNIT;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface GlyphOut {
  code: number;
  advance: number;
  rects: Rect[];
}

class Writer {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.buf);
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.length, v);
    this.length += 1;
  }
  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.length, v & 0xffff);
    this.length += 2;
  }
  i16(v: number): void {
    this.ensure(2);
    this.view.setInt16(this.length, v);
    this.length += 2;
  }
  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0);
    this.length += 4;
  }
  tag(s: string): void {
    for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i));
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }
  pad4(): void {
    while (this.length % 4) this.u8(0);
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

function checksum(data: Uint8Array): number {
  const padded = new Uint8Array((data.length + 3) & ~3);
  padded.set(data);
  const view = new DataView(padded.buffer);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  return sum;
}

function collectGlyphs(): GlyphOut[] {
  const out: GlyphOut[] = [];
  for (const g of glyphBitmaps().values()) {
    const rects: Rect[] = [];
    g.rows.forEach((row, r) => {
      const yTop = (GLYPH_ROWS_ABOVE - r) * UNIT;
      let x = 0;
      while (x < row.length) {
        if (!row[x]) {
          x++;
          continue;
        }
        const start = x;
        while (x < row.length && row[x]) x++;
        rects.push({ x0: start * UNIT, x1: x * UNIT, y0: yTop - UNIT, y1: yTop });
      }
    });
    out.push({ code: g.ch.codePointAt(0)!, advance: (g.width + 1) * UNIT, rects });
  }
  out.sort((a, b) => a.code - b.code);
  return out;
}

function encodeGlyph(rects: Rect[]): Uint8Array {
  const w = new Writer();
  if (rects.length === 0) return new Uint8Array(0);
  const xMin = Math.min(...rects.map((r) => r.x0));
  const yMin = Math.min(...rects.map((r) => r.y0));
  const xMax = Math.max(...rects.map((r) => r.x1));
  const yMax = Math.max(...rects.map((r) => r.y1));
  w.i16(rects.length);
  w.i16(xMin);
  w.i16(yMin);
  w.i16(xMax);
  w.i16(yMax);
  for (let i = 0; i < rects.length; i++) w.u16(i * 4 + 3);
  w.u16(0); // instructionLength
  const pts: Array<[number, number]> = [];
  for (const r of rects) {
    // Clockwise in y-up space = outer contour for TrueType.
    pts.push([r.x0, r.y0], [r.x0, r.y1], [r.x1, r.y1], [r.x1, r.y0]);
  }
  for (let i = 0; i < pts.length; i++) w.u8(0x01); // on-curve, 16-bit deltas
  let px = 0;
  for (const [x] of pts) {
    w.i16(x - px);
    px = x;
  }
  let py = 0;
  for (const [, y] of pts) {
    w.i16(y - py);
    py = y;
  }
  w.pad4();
  return w.result();
}

function utf16be(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    out[i * 2] = s.charCodeAt(i) >> 8;
    out[i * 2 + 1] = s.charCodeAt(i) & 255;
  }
  return out;
}

export function buildTrueTypeFont(): Uint8Array {
  const glyphs = collectGlyphs();
  // Glyph 0 = .notdef (hollow box).
  const notdef: Rect[] = [
    { x0: 0, x1: 400, y0: 0, y1: 100 },
    { x0: 0, x1: 400, y0: 600, y1: 700 },
    { x0: 0, x1: 100, y0: 100, y1: 600 },
    { x0: 300, x1: 400, y0: 100, y1: 600 },
  ];
  const all = [{ code: -1, advance: 500, rects: notdef }, ...glyphs];
  const numGlyphs = all.length;

  // glyf + loca
  const glyf = new Writer();
  const offsets: number[] = [];
  let maxPoints = 0;
  let maxContours = 0;
  for (const g of all) {
    offsets.push(glyf.length);
    glyf.bytes(encodeGlyph(g.rects));
    maxPoints = Math.max(maxPoints, g.rects.length * 4);
    maxContours = Math.max(maxContours, g.rects.length);
  }
  offsets.push(glyf.length);
  const loca = new Writer();
  for (const o of offsets) loca.u32(o);

  const allRects = all.flatMap((g) => g.rects);
  const xMin = Math.min(...allRects.map((r) => r.x0));
  const yMin = Math.min(...allRects.map((r) => r.y0));
  const xMax = Math.max(...allRects.map((r) => r.x1));
  const yMax = Math.max(...allRects.map((r) => r.y1));
  const advanceMax = Math.max(...all.map((g) => g.advance));

  // head
  const head = new Writer();
  head.u32(0x00010000);
  head.u32(0x00010000);
  head.u32(0); // checkSumAdjustment (patched later)
  head.u32(0x5f0f3cf5);
  head.u16(0x000b);
  head.u16(UPM);
  head.u32(0);
  head.u32(0); // created
  head.u32(0);
  head.u32(0); // modified
  head.i16(xMin);
  head.i16(yMin);
  head.i16(xMax);
  head.i16(yMax);
  head.u16(0); // macStyle
  head.u16(8); // lowestRecPPEM
  head.i16(2);
  head.i16(1); // long loca
  head.i16(0);

  // hhea
  const hhea = new Writer();
  hhea.u32(0x00010000);
  hhea.i16(ASCENT);
  hhea.i16(-DESCENT);
  hhea.i16(0);
  hhea.u16(advanceMax);
  hhea.i16(0); // minLeftSideBearing
  hhea.i16(0); // minRightSideBearing
  hhea.i16(xMax);
  hhea.i16(1);
  hhea.i16(0);
  hhea.i16(0);
  for (let i = 0; i < 4; i++) hhea.i16(0);
  hhea.i16(0);
  hhea.u16(numGlyphs);

  // hmtx
  const hmtx = new Writer();
  for (const g of all) {
    hmtx.u16(g.advance);
    hmtx.i16(g.rects.length ? Math.min(...g.rects.map((r) => r.x0)) : 0);
  }

  // maxp (TrueType 1.0)
  const maxp = new Writer();
  maxp.u32(0x00010000);
  maxp.u16(numGlyphs);
  maxp.u16(maxPoints);
  maxp.u16(maxContours);
  maxp.u16(0);
  maxp.u16(0);
  maxp.u16(2);
  for (let i = 0; i < 8; i++) maxp.u16(0);

  // cmap (format 4, BMP)
  const segments: Array<{ start: number; end: number; delta: number }> = [];
  glyphs.forEach((g, i) => {
    const gid = i + 1;
    const last = segments[segments.length - 1];
    if (last && g.code === last.end + 1 && gid - g.code === last.delta) last.end = g.code;
    else segments.push({ start: g.code, end: g.code, delta: gid - g.code });
  });
  segments.push({ start: 0xffff, end: 0xffff, delta: 1 });
  const segCount = segments.length;
  const entrySelector = Math.floor(Math.log2(segCount));
  const searchRange = 2 * 2 ** entrySelector;
  const sub = new Writer();
  sub.u16(4);
  sub.u16(16 + segCount * 8);
  sub.u16(0);
  sub.u16(segCount * 2);
  sub.u16(searchRange);
  sub.u16(entrySelector);
  sub.u16(segCount * 2 - searchRange);
  for (const s of segments) sub.u16(s.end);
  sub.u16(0);
  for (const s of segments) sub.u16(s.start);
  for (const s of segments) sub.u16((s.delta + 65536) % 65536);
  for (let i = 0; i < segCount; i++) sub.u16(0);
  const cmap = new Writer();
  cmap.u16(0);
  cmap.u16(1);
  cmap.u16(3);
  cmap.u16(1);
  cmap.u32(12);
  cmap.bytes(sub.result());

  // name
  const names: Array<[number, string]> = [
    [0, 'Original pixel font made for Iron Baron'],
    [1, FONT_FAMILY],
    [2, 'Regular'],
    [3, `${FONT_FAMILY}-Regular-1.0`],
    [4, `${FONT_FAMILY} Regular`],
    [5, 'Version 1.000'],
    [6, `${FONT_FAMILY}-Regular`],
  ];
  const strings = names.map(([, s]) => utf16be(s));
  const name = new Writer();
  name.u16(0);
  name.u16(names.length);
  name.u16(6 + names.length * 12);
  let off = 0;
  names.forEach(([id], i) => {
    name.u16(3);
    name.u16(1);
    name.u16(0x0409);
    name.u16(id);
    name.u16(strings[i].length);
    name.u16(off);
    off += strings[i].length;
  });
  for (const s of strings) name.bytes(s);

  // OS/2 version 4
  const avg = Math.round(all.reduce((a, g) => a + g.advance, 0) / all.length);
  const os2 = new Writer();
  os2.u16(4);
  os2.i16(avg);
  os2.u16(400);
  os2.u16(5);
  os2.u16(0); // fsType: installable
  os2.i16(500);
  os2.i16(500);
  os2.i16(0);
  os2.i16(100);
  os2.i16(500);
  os2.i16(500);
  os2.i16(0);
  os2.i16(300);
  os2.i16(UNIT);
  os2.i16(3 * UNIT);
  os2.i16(0);
  for (let i = 0; i < 10; i++) os2.u8(0);
  os2.u32(1); // Basic Latin
  os2.u32(0);
  os2.u32(0);
  os2.u32(0);
  os2.tag('IRBN');
  os2.u16(0x40); // REGULAR
  os2.u16(Math.min(0xffff, glyphs[0].code));
  os2.u16(Math.min(0xffff, glyphs[glyphs.length - 1].code));
  os2.i16(ASCENT);
  os2.i16(-DESCENT);
  os2.i16(0);
  os2.u16(ASCENT);
  os2.u16(DESCENT);
  os2.u32(1);
  os2.u32(0);
  os2.i16(5 * UNIT);
  os2.i16(7 * UNIT);
  os2.u16(0);
  os2.u16(32);
  os2.u16(1);

  // post 3.0
  const post = new Writer();
  post.u32(0x00030000);
  post.u32(0);
  post.i16(-UNIT);
  post.i16(UNIT);
  post.u32(0);
  for (let i = 0; i < 4; i++) post.u32(0);

  const tables: Array<[string, Uint8Array]> = [
    ['OS/2', os2.result()],
    ['cmap', cmap.result()],
    ['glyf', glyf.result()],
    ['head', head.result()],
    ['hhea', hhea.result()],
    ['hmtx', hmtx.result()],
    ['loca', loca.result()],
    ['maxp', maxp.result()],
    ['name', name.result()],
    ['post', post.result()],
  ];
  tables.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const font = new Writer();
  const numTables = tables.length;
  const es = Math.floor(Math.log2(numTables));
  const sr = 16 * 2 ** es;
  font.u32(0x00010000);
  font.u16(numTables);
  font.u16(sr);
  font.u16(es);
  font.u16(numTables * 16 - sr);
  let offset = 12 + numTables * 16;
  const placed: number[] = [];
  for (const [tag, data] of tables) {
    font.tag(tag);
    font.u32(checksum(data));
    font.u32(offset);
    font.u32(data.length);
    placed.push(offset);
    offset += (data.length + 3) & ~3;
  }
  let headOffset = 0;
  tables.forEach(([tag, data], i) => {
    if (tag === 'head') headOffset = placed[i];
    font.bytes(data);
    font.pad4();
  });
  const bytes = font.result();
  const adj = (0xb1b0afba - checksum(bytes)) >>> 0;
  new DataView(bytes.buffer).setUint32(headOffset + 8, adj);
  return bytes;
}

/** Register the generated font with the document. Resolves false if the browser rejects it. */
export async function loadPixelFont(): Promise<boolean> {
  try {
    const face = new FontFace(FONT_FAMILY, buildTrueTypeFont().buffer as ArrayBuffer);
    await face.load();
    document.fonts.add(face);
    return true;
  } catch (err) {
    console.warn('Pixel font could not be loaded, falling back to monospace', err);
    return false;
  }
}
