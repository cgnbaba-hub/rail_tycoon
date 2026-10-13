import { describe, expect, it } from 'vitest';
import { GLYPHS, glyphBitmaps } from '../src/assets/glyphs';
import { buildTrueTypeFont } from '../src/ui/pixelFont';
import { crispFontSize } from '../src/ui/theme';

function tables(bytes: Uint8Array): Map<string, { offset: number; length: number; checksum: number }> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = v.getUint16(4);
  const out = new Map();
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 16;
    const tag = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    out.set(tag, { checksum: v.getUint32(p + 4), offset: v.getUint32(p + 8), length: v.getUint32(p + 12) });
  }
  return out;
}

/** Look up a code point through the format-4 cmap. */
function cmapLookup(bytes: Uint8Array, offset: number, code: number): number {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sub = offset + v.getUint32(offset + 8);
  const segX2 = v.getUint16(sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  for (let i = 0; i < segX2 / 2; i++) {
    const end = v.getUint16(ends + i * 2);
    if (code <= end) {
      const start = v.getUint16(starts + i * 2);
      if (code < start) return 0;
      return (code + v.getUint16(deltas + i * 2)) & 0xffff;
    }
  }
  return 0;
}

describe('pixel font', () => {
  it('glyph table is well formed', () => {
    const g = glyphBitmaps();
    expect(g.size).toBe(Object.keys(GLYPHS).length);
    for (let c = 32; c < 127; c++) expect(g.has(String.fromCharCode(c))).toBe(true);
    for (const glyph of g.values()) expect(glyph.rows.every((r) => r.length === glyph.width)).toBe(true);
  });

  it('builds a structurally valid TrueType file', () => {
    const font = buildTrueTypeFont();
    const v = new DataView(font.buffer, font.byteOffset, font.byteLength);
    expect(v.getUint32(0)).toBe(0x00010000);
    const t = tables(font);
    for (const tag of ['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']) {
      expect(t.has(tag)).toBe(true);
      const { offset, length } = t.get(tag)!;
      expect(offset % 4).toBe(0);
      expect(offset + length).toBeLessThanOrEqual(font.length);
    }
    expect(v.getUint32(t.get('head')!.offset + 12)).toBe(0x5f0f3cf5);
    // Whole-file checksum must equal the magic constant once the adjustment is applied.
    let sum = 0;
    for (let i = 0; i < font.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
    expect(sum).toBe(0xb1b0afba);
    const numGlyphs = v.getUint16(t.get('maxp')!.offset + 4);
    expect(numGlyphs).toBe(glyphBitmaps().size + 1);
    expect(t.get('loca')!.length).toBe((numGlyphs + 1) * 4);
  });

  it('maps every glyph character through cmap to a distinct glyph', () => {
    const font = buildTrueTypeFont();
    const cmap = tables(font).get('cmap')!;
    const ids = new Set<number>();
    for (const ch of glyphBitmaps().keys()) {
      const gid = cmapLookup(font, cmap.offset, ch.codePointAt(0)!);
      expect(gid).toBeGreaterThan(0);
      ids.add(gid);
    }
    expect(ids.size).toBe(glyphBitmaps().size);
    expect(cmapLookup(font, cmap.offset, 0x4e00)).toBe(0);
  });

  it('chooses font sizes that land on whole device pixels', () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      const fs = crispFontSize(dpr, 17);
      expect(((fs * dpr) / 10) % 1).toBeCloseTo(0);
    }
    expect(crispFontSize(1, 17)).toBe(20);
    expect(crispFontSize(2, 17)).toBe(15);
  });
});
