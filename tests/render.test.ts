import { describe, expect, it } from 'vitest';
import { BUILDINGS, INDUSTRIES } from '../src/data';
import { rotatedSize, type Rot } from '../src/render/iso';
import { DARKER, LIGHTER, PALETTE, PALETTE_NAMES, PALETTE_U32, colorIndex } from '../src/render/palette';
import { PixelBuffer, bayer, fillPolygon, parseSprite, rampPaint } from '../src/render/raster';
import { CHUNK, WorldRenderData, renderChunk } from '../src/render/terrain';
import { defaultMapParams, generateWorld } from '../src/sim/mapgen';

describe('palette', () => {
  it('has exactly 32 unique colours and complete shade maps', () => {
    expect(PALETTE_NAMES.length).toBe(32);
    expect(new Set(Object.values(PALETTE)).size).toBe(32);
    expect(DARKER.length).toBe(32);
    expect(LIGHTER.length).toBe(32);
  });

  it('every colour referenced by data files exists', () => {
    for (const ind of INDUSTRIES) {
      ind.look.ground.forEach(colorIndex);
      ind.look.field?.forEach(colorIndex);
      for (const p of ind.look.parts) {
        for (const c of [p.wall, p.roof, p.windows, p.c, p.c2]) if (c) colorIndex(c);
      }
    }
    for (const b of BUILDINGS) {
      [...b.walls, ...b.roofs].forEach(colorIndex);
      if (b.windows) colorIndex(b.windows);
    }
    expect(() => colorIndex('mauve')).toThrow();
  });
});

describe('rasterizer', () => {
  it('fills adjacent polygons without gaps or double coverage', () => {
    const buf = new PixelBuffer(64, 64);
    const counts = new Uint8Array(64 * 64);
    const tris = [
      [2, 2, 60, 5, 30, 61],
      [60, 5, 62, 62, 30, 61],
    ];
    for (const t of tris) {
      buf.data.fill(0);
      fillPolygon(buf, t, 1);
      for (let i = 0; i < counts.length; i++) if (buf.data[i]) counts[i]++;
    }
    expect(Math.max(...counts)).toBe(1);
    // A point well inside the union is covered.
    expect(counts[40 * 64 + 40]).toBe(1);
  });

  it('dithers ramps with ordered Bayer thresholds', () => {
    const ramp = [0, 1, 2] as const;
    expect(rampPaint(ramp, 1)).toBe(PALETTE_U32[1]);
    expect(rampPaint(ramp, 0)).toBe(PALETTE_U32[0]);
    expect(rampPaint(ramp, 2)).toBe(PALETTE_U32[2]);
    expect(rampPaint(ramp, 5)).toBe(PALETTE_U32[2]);
    const mixed = rampPaint(ramp, 1.5);
    expect(typeof mixed).toBe('object');
    let lit = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (bayer(x, y) < 0.5) lit++;
    expect(lit).toBe(8);
  });

  it('parses sprites with a legend', () => {
    const s = parseSprite(['.a.', 'aba'], { a: 3, b: 4 });
    expect(s.w).toBe(3);
    expect(s.h).toBe(2);
    expect(Array.from(s.px)).toEqual([-1, 3, -1, 3, 4, 3]);
    expect(() => parseSprite(['z'], {})).toThrow();
  });
});

describe('chunk renderer', () => {
  const world = generateWorld({ ...defaultMapParams(3), size: 40 });
  const data = new WorldRenderData(world);

  it('renders every chunk for all rotations and zoom levels', () => {
    for (const rot of [0, 1, 2, 3] as Rot[]) {
      const [RW, RH] = rotatedSize(rot, 40, 40);
      for (const tw of [8, 16, 32]) {
        for (let cy = 0; cy < Math.ceil(RH / CHUNK); cy++) {
          for (let cx = 0; cx < Math.ceil(RW / CHUNK); cx++) {
            const { buf } = renderChunk(data, rot, tw, cx, cy, { grid: tw === 16 });
            expect(buf.countOpaque()).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('only writes palette colours and is deterministic', () => {
    const allowed = new Set(PALETTE_U32);
    const a = renderChunk(data, 0, 32, 1, 1).buf;
    const b = renderChunk(data, 0, 32, 1, 1).buf;
    expect(a.data).toEqual(b.data);
    for (const v of a.data) if (v !== 0) expect(allowed.has(v)).toBe(true);
  });

  it('computes shore distances for water tiles only', () => {
    for (let i = 0; i < world.terrain.length; i++) {
      if (world.terrain[i] === 0) expect(data.shore[i]).toBeGreaterThanOrEqual(1);
      else expect(data.shore[i]).toBe(0);
    }
  });
});

describe('chunk renderer with railways', () => {
  it('draws track, bridges, tunnels and stations in every rotation and zoom', async () => {
    const { flatWorld, addRiver, addHill } = await import('./helpers');
    const { Game } = await import('../src/sim/game');
    const { defaultTrackOptions } = await import('../src/sim/construction');
    const { CONSTRUCTION } = await import('../src/data');
    const w = flatWorld(40);
    addRiver(w, 8);
    addHill(w, 26, 20, 7);
    const g = new Game({ ...defaultMapParams(1), size: 40 }, w);
    g.company.cash = 1e9;
    const saved = CONSTRUCTION.tunnel.perTile;
    CONSTRUCTION.tunnel.perTile = 1000;
    try {
      expect(g.buildTrack(w.tileIndex(2, 20), w.tileIndex(38, 20), { ...defaultTrackOptions(1850), double: true }).ok).toBe(true);
    } finally {
      CONSTRUCTION.tunnel.perTile = saved;
    }
    expect(g.buildStation(4, 10, 'terminal', 'x').ok).toBe(true);
    const data = new WorldRenderData(w);
    const rail = PALETTE_U32[PALETTE_NAMES.indexOf('fog')];
    for (const rot of [0, 1, 2, 3] as Rot[]) {
      for (const tw of [8, 16, 32]) {
        let rails = 0;
        const [RW, RH] = rotatedSize(rot, 40, 40);
        for (let cy = 0; cy < Math.ceil(RH / CHUNK); cy++) {
          for (let cx = 0; cx < Math.ceil(RW / CHUNK); cx++) {
            const { buf } = renderChunk(data, rot, tw, cx, cy);
            for (const v of buf.data) if (v === rail) rails++;
          }
        }
        if (tw >= 16) expect(rails).toBeGreaterThan(50);
      }
    }
  });
});
