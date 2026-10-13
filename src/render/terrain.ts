import { BUILDINGS, CONSTRUCTION, INDUSTRY_BY_ID, STATION_BY_ID, type BuildingDef, type LookPart } from '../data';
import { DX, DY, NODE_BRIDGE, NODE_GROUND, NODE_TUNNEL, bitCount, type TrackNode } from '../sim/track';
import { hash2, hashFloat } from '../sim/rng';
import {
  F,
  OCC_BUILDING,
  OCC_INDUSTRY,
  T,
  World,
  occupantIndex,
  occupantKind,
  splitsAlongMainDiagonal,
  type Building,
  type Industry,
} from '../sim/world';
import { rotatedSize, toView, viewToTile, type Rot } from './iso';
import { DARKER, LIGHTER, PAL, colorIndex } from './palette';
import { viewCornerHeights } from './pick';
import { PixelBuffer, blitSprite, drawLine, fillPolygon, plot, rampPaint, solid, type Paint } from './raster';
import { SPRITES } from './sprites';

/** Chunk edge length in tiles (view space). */
export const CHUNK = 16;

type Ramp = readonly [number, number, number];

const RAMPS = {
  grass: [PAL.moss, PAL.grass, PAL.meadow],
  forest: [PAL.fir, PAL.pine, PAL.moss],
  sand: [PAL.dune, PAL.sand, PAL.cream],
  rough: [PAL.shale, PAL.stone, PAL.fog],
  snow: [PAL.fog, PAL.snow, PAL.snow],
  water: [PAL.deepSea, PAL.sea, PAL.shallow],
  river: [PAL.sea, PAL.shallow, PAL.foam],
  road: [PAL.loam, PAL.soil, PAL.dune],
  paved: [PAL.shale, PAL.stone, PAL.fog],
} satisfies Record<string, Ramp>;

const TERRAIN_RAMP: Ramp[] = [RAMPS.water, RAMPS.sand, RAMPS.grass, RAMPS.forest, RAMPS.rough, RAMPS.snow];

const BUILDING_BY_ID = new Map<string, BuildingDef>(BUILDINGS.map((b) => [b.id, b]));
const PAVED_BUILDINGS = new Set(['shop', 'office', 'tower', 'church']);

// Light from the upper-left of the screen (view space: -rx, slightly +ry, mostly from above).
const LIGHT = (() => {
  const v = [-0.6, 0.25, 0.76];
  const l = Math.hypot(v[0], v[1], v[2]);
  return v.map((c) => c / l) as [number, number, number];
})();
/** Vertical size of a height level relative to a tile edge, for lighting only. */
const Z_UNIT = 0.9;
const SHADE_GAIN = 2.2;

export interface SmokePoint {
  x: number;
  y: number;
  /** Height in levels of the chimney top. */
  z: number;
  seed: number;
}

/** Per-world derived data the renderer needs (computed once per world revision). */
export class WorldRenderData {
  /** For water tiles: 8-neighbour distance to land (1..4), 0 for land tiles. */
  readonly shore: Uint8Array;
  readonly smokes: SmokePoint[] = [];

  constructor(readonly world: World) {
    this.shore = computeShore(world);
    for (const ind of world.industries) {
      const def = INDUSTRY_BY_ID.get(ind.defId);
      if (!def) continue;
      const pad = world.vh(ind.x, ind.y);
      def.look.parts.forEach((p, k) => {
        if (p.t !== 'box' || !p.smoke) return;
        this.smokes.push({
          x: ind.x + p.x + (p.w ?? 0) / 2,
          y: ind.y + p.y + (p.d ?? 0) / 2,
          z: pad + ((p.z ?? 0) + (p.h ?? 0)) / 4,
          seed: hash2(ind.id, k, 77),
        });
      });
    }
  }
}

function computeShore(world: World): Uint8Array {
  const W = world.width;
  const H = world.height;
  const out = new Uint8Array(W * H);
  let frontier: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (world.terrain[i] !== T.Water) continue;
    out[i] = 4;
    const x = i % W;
    const y = (i / W) | 0;
    for (let dy = -1; dy <= 1 && out[i] === 4; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && world.terrain[ny * W + nx] !== T.Water) {
          out[i] = 1;
          frontier.push(i);
          break;
        }
      }
    }
  }
  for (let d = 2; d <= 3; d++) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % W;
      const y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (out[j] === 4) {
            out[j] = d;
            next.push(j);
          }
        }
      }
    }
    frontier = next;
  }
  return out;
}

export interface ChunkImage {
  buf: PixelBuffer;
}

/**
 * Rasterise one chunk of the world (CHUNK×CHUNK view-space tiles) at tile width `tw`.
 * Tiles are painted back-to-front; each tile's objects are drawn right after its ground,
 * multi-tile industries when their front-most tile is reached.
 */
export interface ChunkOptions {
  /** Draw a subtle tile grid. */
  grid?: boolean;
}

export function renderChunk(data: WorldRenderData, rot: Rot, tw: number, cx: number, cy: number, opts: ChunkOptions = {}): ChunkImage {
  return new ChunkPainter(data, rot, tw, cx, cy, opts).paint();
}

class ChunkPainter {
  private readonly world: World;
  private readonly W: number;
  private readonly H: number;
  private readonly RW: number;
  private readonly RH: number;
  private readonly rx0: number;
  private readonly ry0: number;
  private readonly rx1: number;
  private readonly ry1: number;
  private readonly hs: number;
  /** Quantisation grid for object coordinates so edges land on clean 2:1 pixel steps. */
  private readonly q: number;
  private buf!: PixelBuffer;
  private ox = 0;
  private oy = 0;
  private readonly pts: number[] = [];

  constructor(
    private readonly data: WorldRenderData,
    private readonly rot: Rot,
    private readonly tw: number,
    cx: number,
    cy: number,
    private readonly opts: ChunkOptions,
  ) {
    this.world = data.world;
    this.W = this.world.width;
    this.H = this.world.height;
    [this.RW, this.RH] = rotatedSize(rot, this.W, this.H);
    this.rx0 = cx * CHUNK;
    this.ry0 = cy * CHUNK;
    this.rx1 = Math.min(this.RW, this.rx0 + CHUNK);
    this.ry1 = Math.min(this.RH, this.ry0 + CHUNK);
    this.hs = tw / 8;
    this.q = tw >= 16 ? 4 / tw : 2 / tw;
  }

  paint(): ChunkImage {
    const { tw, rx0, ry0, rx1, ry1 } = this;
    let maxLevel = 0;
    for (let ry = ry0; ry < ry1; ry++) {
      for (let rx = rx0; rx < rx1; rx++) {
        const c = viewCornerHeights(this.world, this.rot, rx, ry);
        maxLevel = Math.max(maxLevel, c[0], c[1], c[2], c[3]);
      }
    }
    const k = tw / 32;
    const margin = 2 * tw;
    const overhang = Math.ceil(110 * k) + 4;
    const sxMin = ((rx0 - ry1) * tw) / 2 - margin;
    const sxMax = ((rx1 - ry0) * tw) / 2 + margin;
    const syMin = ((rx0 + ry0) * tw) / 4 - maxLevel * this.hs - overhang;
    const syMax = ((rx1 + ry1) * tw) / 4 + 2 * this.hs + 2;
    this.ox = Math.floor(sxMin);
    this.oy = Math.floor(syMin);
    this.buf = new PixelBuffer(Math.ceil(sxMax) - this.ox, Math.ceil(syMax) - this.oy, this.ox, this.oy);

    const nx = rx1 - rx0;
    const ny = ry1 - ry0;
    // Per depth row: ground, then track (edges are owned by their front-most tile so
    // diagonal rails are painted after every tile they cross), then standing objects.
    for (let d = 0; d <= nx + ny - 2; d++) {
      const i0 = Math.max(0, d - ny + 1);
      const i1 = Math.min(nx - 1, d);
      for (let i = i0; i <= i1; i++) this.groundTile(rx0 + i, ry0 + d - i);
      for (let i = i0; i <= i1; i++) this.trackTile(rx0 + i, ry0 + d - i);
      for (let i = i0; i <= i1; i++) this.objectsTile(rx0 + i, ry0 + d - i);
    }
    return { buf: this.buf };
  }

  // -- projection helpers ----------------------------------------------------------------

  /** View coords + height (levels) → buffer pixel. */
  private P(rx: number, ry: number, z: number): [number, number] {
    const tw = this.tw;
    return [((rx - ry) * tw) / 2 - this.ox, ((rx + ry) * tw) / 4 - z * this.hs - this.oy];
  }

  /** World coords + height (levels) → buffer pixel. */
  private PW(x: number, y: number, z: number): [number, number] {
    const [rx, ry] = toView(x, y, this.rot, this.W, this.H);
    return this.P(rx, ry, z);
  }

  private poly(paint: Paint, ...coords: Array<[number, number]>): void {
    const pts = this.pts;
    pts.length = 0;
    for (const [x, y] of coords) pts.push(x, y);
    fillPolygon(this.buf, pts, paint);
  }

  private snap(v: number): number {
    return Math.round(v / this.q) * this.q;
  }

  private snapZ(z: number): number {
    return Math.round(z * this.hs) / this.hs;
  }

  /** World rect → snapped view rect [x0, y0, x1, y1]. */
  private viewRect(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    const [a, b] = toView(x0, y0, this.rot, this.W, this.H);
    const [c, d] = toView(x1, y1, this.rot, this.W, this.H);
    let vx0 = this.snap(Math.min(a, c));
    let vx1 = this.snap(Math.max(a, c));
    let vy0 = this.snap(Math.min(b, d));
    let vy1 = this.snap(Math.max(b, d));
    if (vx1 <= vx0) vx1 = vx0 + this.q;
    if (vy1 <= vy0) vy1 = vy0 + this.q;
    return [vx0, vy0, vx1, vy1];
  }

  // -- tiles -----------------------------------------------------------------------------

  private shadeTri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = (bz - az) * Z_UNIT;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = (cz - az) * Z_UNIT;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    if (nz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    const dot = (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / len;
    return 1 + (dot - LIGHT[2]) * SHADE_GAIN;
  }

  private groundTile(rx: number, ry: number): void {
    const world = this.world;
    const [tx, ty] = viewToTile(rx, ry, this.rot, this.W, this.H);
    const ti = world.tileIndex(tx, ty);
    const ter = world.terrain[ti];
    const flags = world.flags[ti];
    const occ = world.occupant[ti];
    const [hN, hE, hS, hW] = viewCornerHeights(world, this.rot, rx, ry);
    const [a, b, c, d] = world.corners(tx, ty);
    const splitNS = splitsAlongMainDiagonal(a, b, c, d) !== (this.rot % 2 === 1);

    let ramp: Ramp = TERRAIN_RAMP[ter];
    let fixedT: number | null = null;
    let jitter = 0;
    let industry: Industry | null = null;
    let building: Building | null = null;
    if (occupantKind(occ) === OCC_INDUSTRY) industry = world.industries[occupantIndex(occ)];
    if (occupantKind(occ) === OCC_BUILDING) building = world.buildings[occupantIndex(occ)];

    if (ter === T.Water) {
      const s = this.data.shore[ti];
      fixedT = s === 1 ? 1.55 : s === 2 ? 1.15 : s === 3 ? 0.95 : 0.7;
    } else if (flags & F.River) {
      ramp = RAMPS.river;
    } else if (industry) {
      const def = INDUSTRY_BY_ID.get(industry.defId);
      if (def) ramp = def.look.ground.map(colorIndex) as unknown as Ramp;
    } else if (building && PAVED_BUILDINGS.has(building.defId)) {
      ramp = RAMPS.paved;
    } else {
      if (ter === T.Grass || ter === T.Forest || ter === T.Sand) jitter = (hashFloat(tx, ty, 7) - 0.5) * 0.35;
      if (ter === T.Forest && this.tw <= 8) jitter -= 0.25;
    }

    const N: [number, number, number] = [rx, ry, hN];
    const E: [number, number, number] = [rx + 1, ry, hE];
    const S: [number, number, number] = [rx + 1, ry + 1, hS];
    const Wc: [number, number, number] = [rx, ry + 1, hW];
    const tris = splitNS ? [[N, E, S], [N, S, Wc]] : [[N, E, Wc], [E, S, Wc]];
    for (const [p, q, r] of tris) {
      const t = fixedT ?? this.shadeTri(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]) + jitter;
      this.poly(rampPaint(ramp, t), this.P(p[0], p[1], p[2]), this.P(q[0], q[1], q[2]), this.P(r[0], r[1], r[2]));
    }

    if (this.opts.grid && this.tw >= 16 && ter !== T.Water) {
      const g = solid(DARKER[ramp[0]]);
      const [nx, ny] = this.P(N[0], N[1], N[2]);
      const [ex, ey] = this.P(E[0], E[1], E[2]);
      const [wx, wy] = this.P(Wc[0], Wc[1], Wc[2]);
      drawLine(this.buf, nx, ny, ex - 1, ey, g);
      drawLine(this.buf, nx - 1, ny, wx, wy, g);
    }

    // Map-edge skirts (the slab look).
    if (rx === this.RW - 1) this.skirt(this.P(rx + 1, ry, hE), this.P(rx + 1, ry + 1, hS), this.P(rx + 1, ry + 1, -2), this.P(rx + 1, ry, -2), ter === T.Water, true);
    if (ry === this.RH - 1) this.skirt(this.P(rx, ry + 1, hW), this.P(rx + 1, ry + 1, hS), this.P(rx + 1, ry + 1, -2), this.P(rx, ry + 1, -2), ter === T.Water, false);

    if (ter === T.Water) return;
    if (industry) {
      const def = INDUSTRY_BY_ID.get(industry.defId);
      if (def?.look.field) this.fieldStripes(tx, ty, world.vh(tx, ty), def.look.field);
    } else if (!building && flags & F.Road) {
      this.drawRoad(tx, ty);
    }
  }

  private objectsTile(rx: number, ry: number): void {
    const world = this.world;
    const [tx, ty] = viewToTile(rx, ry, this.rot, this.W, this.H);
    const ti = world.tileIndex(tx, ty);
    const ter = world.terrain[ti];
    const flags = world.flags[ti];
    const occ = world.occupant[ti];
    const node = world.track.getIdx(ti);
    if (node && node.kind !== NODE_TUNNEL) {
      if (node.station >= 0) this.drawStationTile(ti, node);
      else if (node.kind === NODE_GROUND && bitCount(node.conn) === 1) this.drawBufferStop(ti, node);
      if (node.kind === NODE_GROUND) return;
    }
    if (ter === T.Water) return;
    if (occupantKind(occ) === OCC_INDUSTRY) {
      const industry = world.industries[occupantIndex(occ)];
      if (this.isAnchor(rx, ry, industry)) this.drawIndustry(industry);
      return;
    }
    if (occupantKind(occ) === OCC_BUILDING) {
      this.drawBuilding(world.buildings[occupantIndex(occ)]);
      return;
    }
    if (flags & F.River || node) return;
    if (ter === T.Forest) this.drawForest(tx, ty);
    else if (flags & F.Tree) this.drawTree(tx + 0.3 + 0.4 * hashFloat(tx, ty, 41), ty + 0.3 + 0.4 * hashFloat(tx, ty, 43), false);
    else if (ter === T.Rough && hashFloat(tx, ty, 51) < 0.55) this.drawRock(tx, ty, false);
    else if (ter === T.Snow && hashFloat(tx, ty, 51) < 0.35) this.drawRock(tx, ty, true);
  }

  private skirt(a: [number, number], b: [number, number], c: [number, number], d: [number, number], water: boolean, right: boolean): void {
    const base = right ? PAL.loam : PAL.soil;
    this.poly(solid(base), a, b, c, d);
    if (water) {
      // A band of sea at the top of the cliff.
      const band = this.hs;
      this.poly(solid(right ? PAL.deepSea : PAL.sea), a, b, [b[0], b[1] + band], [a[0], a[1] + band]);
    } else {
      this.poly(solid(right ? PAL.moss : PAL.grass), a, b, [b[0], b[1] + 1], [a[0], a[1] + 1]);
    }
  }

  private isAnchor(rx: number, ry: number, ind: Industry): boolean {
    const [a, b] = toView(ind.x, ind.y, this.rot, this.W, this.H);
    const [c, d] = toView(ind.x + ind.w, ind.y + ind.h, this.rot, this.W, this.H);
    return rx === Math.max(a, c) - 1 && ry === Math.max(b, d) - 1;
  }

  // -- track -----------------------------------------------------------------------------

  private trackTile(rx: number, ry: number): void {
    const world = this.world;
    const track = world.track;
    if (track.size === 0) return;
    const [tx, ty] = viewToTile(rx, ry, this.rot, this.W, this.H);
    const ti = world.tileIndex(tx, ty);
    const node = track.getIdx(ti);
    if (node && node.kind === NODE_BRIDGE) this.drawPillar(ti, node);
    if (node && node.kind === NODE_GROUND && node.station >= 0 && node.conn === 0) this.drawLoneStationTrack(ti, node);
    // Edges whose front-most tile is this one: from W, N, NW, and the NE–SW anti-diagonal.
    const owned: Array<[number, number, number, number]> = [
      [rx - 1, ry, rx, ry],
      [rx, ry - 1, rx, ry],
      [rx - 1, ry - 1, rx, ry],
      [rx, ry - 1, rx - 1, ry],
    ];
    for (const [ax, ay, bx, by] of owned) {
      if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= this.RW || bx >= this.RW || ay >= this.RH || by >= this.RH) continue;
      const [wax, way] = viewToTile(ax, ay, this.rot, this.W, this.H);
      const [wbx, wby] = viewToTile(bx, by, this.rot, this.W, this.H);
      const a = world.tileIndex(wax, way);
      const b = world.tileIndex(wbx, wby);
      if (track.connected(a, b)) this.drawEdge(a, b);
    }
  }

  private center(i: number): [number, number] {
    return [(i % this.W) + 0.5, Math.floor(i / this.W) + 0.5];
  }

  private drawEdge(a: number, b: number): void {
    const track = this.world.track;
    const na = track.getIdx(a)!;
    const nb = track.getIdx(b)!;
    if (na.kind === NODE_TUNNEL && nb.kind === NODE_TUNNEL) return;
    const dbl = track.isDouble(a, b);
    const [ax, ay] = this.center(a);
    const [bx, by] = this.center(b);
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const surf = (x: number, y: number) => this.world.surfaceHeight(x, y);
    if (na.kind === NODE_TUNNEL || nb.kind === NODE_TUNNEL) {
      const [gx, gy, tz] = na.kind === NODE_TUNNEL ? [bx, by, nb.z] : [ax, ay, na.z];
      this.rails(gx, gy, tz, mx, my, surf(mx, my), dbl, 'ground', true, false);
      this.portal(mx, my, surf(mx, my), bx - ax, by - ay);
      return;
    }
    if (na.kind === NODE_BRIDGE || nb.kind === NODE_BRIDGE) {
      const type = na.kind === NODE_BRIDGE ? na.span : nb.span;
      this.bridgeDeck(ax, ay, na.z, bx, by, nb.z, dbl, type);
      return;
    }
    this.rails(ax, ay, surf(ax, ay), mx, my, surf(mx, my), dbl, 'ground', true, false);
    this.rails(mx, my, surf(mx, my), bx, by, surf(bx, by), dbl, 'ground', false, true);
  }

  private drawLoneStationTrack(i: number, node: TrackNode): void {
    const st = this.world.stations[node.station];
    if (!st) return;
    const [cx, cy] = this.center(i);
    const [dx, dy] = st.axis === 'x' ? [0.5, 0] : [0, 0.5];
    this.rails(cx - dx, cy - dy, node.z, cx + dx, cy + dy, node.z, false, 'ground', true, true);
  }

  /**
   * Rails from (x0,y0,z0) to (x1,y1,z1) in world units. `extend0/1` push the ballast a
   * little past node centres so turns don't show gaps.
   */
  private rails(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, dbl: boolean, bed: 'ground' | 'wood' | 'stone' | 'steel', extend0: boolean, extend1: boolean): void {
    const tw = this.tw;
    if (tw < 16) {
      drawLine(this.buf, ...this.PW(x0, y0, z0), ...this.PW(x1, y1, z1), solid(PAL.night));
      return;
    }
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const hw = dbl ? 0.31 : 0.17;
    const e0 = extend0 ? hw * 0.6 : 0;
    const e1 = extend1 ? hw * 0.6 : 0;
    const pt = (along: number, off: number, z: number): [number, number] => this.PW(x0 + ux * along + nx * off, y0 + uy * along + ny * off, z);
    const zAt = (along: number) => z0 + ((z1 - z0) * along) / len;
    if (bed === 'ground') {
      this.poly(solid(PAL.shale), pt(-e0, -hw, z0), pt(len + e1, -hw, z1), pt(len + e1, hw, z1), pt(-e0, hw, z0));
    }
    const tracks = dbl ? [-0.15, 0.15] : [0];
    const tie = solid(bed === 'steel' ? PAL.night : PAL.loam);
    const rail = solid(PAL.fog);
    const ties = Math.max(1, Math.round(len * (tw >= 32 ? 4 : 3)));
    for (const off of tracks) {
      for (let k = 0; k < ties; k++) {
        const along = ((k + 0.5) * len) / ties;
        const z = zAt(along);
        drawLine(this.buf, ...pt(along, off - 0.12, z), ...pt(along, off + 0.12, z), tie);
      }
      for (const r of [-0.065, 0.065]) drawLine(this.buf, ...pt(0, off + r, z0), ...pt(len, off + r, z1), rail);
    }
  }

  private bridgeDeck(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, dbl: boolean, type: number): void {
    const def = CONSTRUCTION.bridges[type] ?? CONSTRUCTION.bridges[0];
    const deckColor = def.id === 'wood' ? PAL.soil : def.id === 'stone' ? PAL.stone : PAL.slate;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const nx = -dy / len;
    const ny = dx / len;
    const hw = dbl ? 0.32 : 0.2;
    const P = (x: number, y: number, z: number) => this.PW(x, y, z);
    // Front fascia: the deck edge nearer the viewer.
    const [va, vb] = toView(x0 + nx, y0 + ny, this.rot, this.W, this.H);
    const [vc, vd] = toView(x0 - nx, y0 - ny, this.rot, this.W, this.H);
    const s = va + vb > vc + vd ? 1 : -1;
    const drop = 0.75;
    this.poly(solid(DARKER[deckColor]), P(x0 + nx * hw * s, y0 + ny * hw * s, z0), P(x1 + nx * hw * s, y1 + ny * hw * s, z1), P(x1 + nx * hw * s, y1 + ny * hw * s, z1 - drop), P(x0 + nx * hw * s, y0 + ny * hw * s, z0 - drop));
    this.poly(solid(deckColor), P(x0 - nx * hw, y0 - ny * hw, z0), P(x1 - nx * hw, y1 - ny * hw, z1), P(x1 + nx * hw, y1 + ny * hw, z1), P(x0 + nx * hw, y0 + ny * hw, z0));
    this.rails(x0, y0, z0, x1, y1, z1, dbl, def.id as 'wood' | 'stone' | 'steel', false, false);
    if (this.tw < 16) return;
    const railH = def.id === 'steel' ? 2.5 : 0.6;
    const c = solid(def.id === 'steel' ? PAL.steel : def.id === 'stone' ? PAL.fog : PAL.loam);
    for (const side of [-1, 1]) {
      const ox = nx * hw * side;
      const oy = ny * hw * side;
      drawLine(this.buf, ...P(x0 + ox, y0 + oy, z0 + railH), ...P(x1 + ox, y1 + oy, z1 + railH), c);
      if (def.id === 'steel') {
        const n = Math.max(2, Math.round(len * 2));
        for (let k = 0; k <= n; k++) {
          const f = k / n;
          const px = x0 + dx * f + ox;
          const py = y0 + dy * f + oy;
          const pz = z0 + (z1 - z0) * f;
          drawLine(this.buf, ...P(px, py, pz), ...P(px, py, pz + railH), c);
          if (k < n) {
            const g = (k + 1) / n;
            drawLine(this.buf, ...P(px, py, pz), ...P(x0 + dx * g + ox, y0 + dy * g + oy, z0 + (z1 - z0) * g + railH), c);
          }
        }
      }
    }
  }

  private drawPillar(i: number, node: TrackNode): void {
    const def = CONSTRUCTION.bridges[node.span] ?? CONSTRUCTION.bridges[0];
    const wet = this.world.terrain[i] === T.Water || (this.world.flags[i] & F.River) !== 0;
    const ground = wet ? 0 : this.world.surfaceHeight((i % this.W) + 0.5, Math.floor(i / this.W) + 0.5);
    const top = node.z - 0.75;
    if (top <= ground) return;
    const [cx, cy] = this.center(i);
    const size = def.id === 'stone' ? 0.13 : def.id === 'steel' ? 0.08 : 0.05;
    const color = def.id === 'wood' ? PAL.loam : def.id === 'stone' ? PAL.stone : PAL.slate;
    const [vx0, vy0, vx1, vy1] = this.viewRect(cx - size, cy - size, cx + size, cy + size);
    this.box(vx0, vy0, vx1, vy1, ground, top, color, color, 'flat', 0, -1);
  }

  private portal(x: number, y: number, z: number, dx: number, dy: number): void {
    const len = Math.hypot(dx, dy);
    const nx = -dy / len;
    const ny = dx / len;
    const P = (o: number, h: number) => this.PW(x + nx * o, y + ny * o, z + h);
    this.poly(solid(PAL.stone), P(-0.27, 0), P(0.27, 0), P(0.27, 1.9), P(-0.27, 1.9));
    this.poly(solid(PAL.ink), P(-0.16, 0), P(0.16, 0), P(0.16, 1.3), P(0, 1.55), P(-0.16, 1.3));
  }

  private drawBufferStop(i: number, node: TrackNode): void {
    if (this.tw < 16) return;
    let d = 0;
    while (!(node.conn & (1 << d))) d++;
    const [cx, cy] = this.center(i);
    // Sits just past the centre, on the dead-end side.
    const bx = cx - DX[d] * 0.18;
    const by = cy - DY[d] * 0.18;
    const [vx0, vy0, vx1, vy1] = this.viewRect(bx - 0.09, by - 0.09, bx + 0.09, by + 0.09);
    this.box(vx0, vy0, vx1, vy1, node.z, node.z + 1, PAL.brick, PAL.oxblood, 'flat', 0, -1);
  }

  private drawStationTile(i: number, node: TrackNode): void {
    const st = this.world.stations[node.station];
    if (!st) return;
    const def = STATION_BY_ID.get(st.kind);
    if (!def) return;
    const [cx, cy] = this.center(i);
    const along: [number, number] = st.axis === 'x' ? [1, 0] : [0, 1];
    const perp: [number, number] = st.axis === 'x' ? [0, st.side] : [st.side, 0];
    const z = node.z;
    // Platform strip on the building side.
    {
      const p0 = 0.19;
      const p1 = 0.33;
      const ax = cx - along[0] * 0.5 + perp[0] * p0;
      const ay = cy - along[1] * 0.5 + perp[1] * p0;
      const bx = cx + along[0] * 0.5 + perp[0] * p1;
      const by = cy + along[1] * 0.5 + perp[1] * p1;
      const [vx0, vy0, vx1, vy1] = this.viewRect(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
      this.box(vx0, vy0, vx1, vy1, z, z + 0.5, PAL.stone, PAL.fog, 'flat', 0, -1);
    }
    const mid = st.tiles[Math.floor(st.tiles.length / 2)];
    if (i !== mid) return;
    const L = def.look;
    const off = 0.5 - L.w / 2 - 0.02;
    const bx = cx + perp[0] * off;
    const by = cy + perp[1] * off;
    const hx = (along[0] * L.l + Math.abs(perp[0]) * L.w) / 2;
    const hy = (along[1] * L.l + Math.abs(perp[1]) * L.w) / 2;
    const [vx0, vy0, vx1, vy1] = this.viewRect(bx - hx, by - hy, bx + hx, by + hy);
    const ridgeAlongX = st.axis === 'x';
    const roofType = ridgeAlongX === (this.rot % 2 === 0) ? 'ridgeRx' : 'ridgeRy';
    const wall = colorIndex(L.wall);
    this.box(vx0, vy0, vx1, vy1, z, z + L.h / 4, wall, colorIndex(L.roof), roofType, 1.25, PAL.gold);
    if (L.tower) {
      const tx0 = bx - along[0] * (L.l / 2 - 0.08);
      const ty0 = by - along[1] * (L.l / 2 - 0.08);
      const [wx0, wy0, wx1, wy1] = this.viewRect(tx0 - 0.08, ty0 - 0.08, tx0 + 0.08, ty0 + 0.08);
      this.box(wx0, wy0, wx1, wy1, z, z + L.tower / 4, wall, PAL.slate, 'pyramid', 1.5, PAL.cream);
    }
  }

  // -- decorations ------------------------------------------------------------------------

  private drawTree(x: number, y: number, conifer: boolean): void {
    if (this.tw < 16) return;
    const big = this.tw >= 32;
    const sprite = conifer ? (big ? SPRITES.coniferL : SPRITES.coniferS) : big ? SPRITES.leafyL : SPRITES.leafyS;
    const [px, py] = this.PW(x, y, this.world.surfaceHeight(x, y));
    blitSprite(this.buf, sprite, px, py);
  }

  private drawForest(tx: number, ty: number): void {
    if (this.tw < 16) return;
    const slots: Array<[number, number]> = [
      [0.25, 0.3],
      [0.72, 0.28],
      [0.5, 0.55],
      [0.28, 0.78],
      [0.75, 0.76],
    ];
    const h = hash2(tx, ty, 31);
    const n = 2 + (h % 3);
    const start = (h >>> 8) % slots.length;
    const altitude = this.world.tileAvgH(tx, ty) / this.world.maxHeight;
    const trees: Array<{ x: number; y: number; depth: number; conifer: boolean }> = [];
    for (let k = 0; k < n; k++) {
      const [sx, sy] = slots[(start + k * 2) % slots.length];
      const x = tx + sx + (hashFloat(tx * 7 + k, ty, 33) - 0.5) * 0.16;
      const y = ty + sy + (hashFloat(tx, ty * 7 + k, 35) - 0.5) * 0.16;
      const [vx, vy] = toView(x, y, this.rot, this.W, this.H);
      trees.push({ x, y, depth: vx + vy, conifer: hashFloat(tx + k, ty, 37) < altitude * 1.6 + 0.15 });
    }
    trees.sort((p, q) => p.depth - q.depth);
    for (const t of trees) this.drawTree(t.x, t.y, t.conifer);
  }

  private drawRock(tx: number, ty: number, snow: boolean): void {
    if (this.tw < 16) return;
    const x = tx + 0.3 + 0.4 * hashFloat(tx, ty, 53);
    const y = ty + 0.3 + 0.4 * hashFloat(tx, ty, 55);
    const [px, py] = this.PW(x, y, this.world.surfaceHeight(x, y));
    const sprite = this.tw >= 32 ? (snow ? SPRITES.snowRockL : SPRITES.rockL) : SPRITES.rockS;
    blitSprite(this.buf, sprite, px, py);
  }

  private drawRoad(tx: number, ty: number): void {
    const world = this.world;
    const lo = 0.36;
    const hi = 0.64;
    const rects: Array<[number, number, number, number]> = [[lo, lo, hi, hi]];
    const isRoad = (x: number, y: number) => world.inBounds(x, y) && world.hasFlag(x, y, F.Road);
    if (isRoad(tx + 1, ty)) rects.push([hi, lo, 1, hi]);
    if (isRoad(tx - 1, ty)) rects.push([0, lo, lo, hi]);
    if (isRoad(tx, ty + 1)) rects.push([lo, hi, hi, 1]);
    if (isRoad(tx, ty - 1)) rects.push([lo, 0, hi, lo]);
    const paint = solid(PAL.soil);
    for (const [x0, y0, x1, y1] of rects) {
      const pt = (u: number, v: number) => this.PW(tx + u, ty + v, world.surfaceHeight(tx + u, ty + v));
      this.poly(paint, pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1));
    }
  }

  private fieldStripes(tx: number, ty: number, z: number, colors: [string, string]): void {
    const c0 = solid(colorIndex(colors[0]));
    const c1 = solid(colorIndex(colors[1]));
    const n = this.tw >= 32 ? 4 : 2;
    for (let k = 0; k < n; k++) {
      const y0 = ty + k / n;
      const y1 = ty + (k + 1) / n;
      this.poly(k % 2 === 0 ? c0 : c1, this.PW(tx, y0, z), this.PW(tx + 1, y0, z), this.PW(tx + 1, y1, z), this.PW(tx, y1, z));
    }
  }

  // -- structures -------------------------------------------------------------------------

  /**
   * Axis-aligned box in view space with optional roof. Visible faces: +ry (left, lit),
   * +rx (right, shaded) and the top.
   */
  private box(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    z0: number,
    z1: number,
    wall: number,
    roof: number,
    roofType: 'flat' | 'ridgeRx' | 'ridgeRy' | 'pyramid' | 'none',
    roofH: number,
    windows: number,
  ): void {
    const P = (x: number, y: number, z: number) => this.P(x, y, z);
    z0 = this.snapZ(z0);
    z1 = this.snapZ(z1);
    roofH = this.snapZ(roofH);
    if (z1 > z0) {
      this.poly(solid(DARKER[wall]), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1));
      this.poly(solid(wall), P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1));
      if (windows >= 0) this.windows(x0, y0, x1, y1, z0, z1, windows);
    }
    const xm = (x0 + x1) / 2;
    const ym = (y0 + y1) / 2;
    const zr = z1 + roofH;
    switch (roofType) {
      case 'none':
        break;
      case 'flat':
        this.poly(solid(roof), P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1));
        if (this.tw >= 32) {
          drawLine(this.buf, ...P(x0, y1, z1), ...P(x1, y1, z1), solid(LIGHTER[roof]));
        }
        break;
      case 'ridgeRx':
        this.poly(solid(DARKER[roof]), P(x0, y0, z1), P(x1, y0, z1), P(x1, ym, zr), P(x0, ym, zr));
        this.poly(solid(roof), P(x0, ym, zr), P(x1, ym, zr), P(x1, y1, z1), P(x0, y1, z1));
        this.poly(solid(DARKER[wall]), P(x1, y0, z1), P(x1, y1, z1), P(x1, ym, zr));
        break;
      case 'ridgeRy':
        this.poly(solid(LIGHTER[roof]), P(x0, y0, z1), P(xm, y0, zr), P(xm, y1, zr), P(x0, y1, z1));
        this.poly(solid(DARKER[roof]), P(xm, y0, zr), P(x1, y0, z1), P(x1, y1, z1), P(xm, y1, zr));
        this.poly(solid(wall), P(x0, y1, z1), P(x1, y1, z1), P(xm, y1, zr));
        break;
      case 'pyramid': {
        const apex = P(xm, ym, zr);
        this.poly(solid(DARKER[roof]), P(x0, y0, z1), P(x1, y0, z1), apex);
        this.poly(solid(LIGHTER[roof]), P(x0, y0, z1), P(x0, y1, z1), apex);
        this.poly(solid(roof), P(x0, y1, z1), P(x1, y1, z1), apex);
        this.poly(solid(DARKER[roof]), P(x1, y0, z1), P(x1, y1, z1), apex);
        break;
      }
    }
  }

  private windows(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, color: number): void {
    if (this.tw < 16) return;
    const heightPx = (z1 - z0) * this.hs;
    if (heightPx < 5) return;
    const tall = this.tw >= 32 ? 2 : 1;
    const rowStep = this.tw >= 32 ? 4 : 3;
    const lit = solid(color);
    const dark = solid(DARKER[color]);
    const face = (ax: number, ay: number, bx: number, by: number, c: number) => {
      const xa = Math.ceil(Math.min(ax, bx)) + 1;
      const xb = Math.floor(Math.max(ax, bx)) - 2;
      for (let x = xa; x <= xb; x += 3) {
        const yb = ay + ((x - ax) * (by - ay)) / (bx - ax);
        for (let zp = 3; zp + tall <= heightPx - 1; zp += rowStep) {
          for (let t = 0; t < tall; t++) plot(this.buf, x, Math.floor(yb) - zp - t, c);
        }
      }
    };
    const [lax, lay] = this.P(x0, y1, z0);
    const [lbx, lby] = this.P(x1, y1, z0);
    face(lax, lay, lbx, lby, lit);
    const [rax, ray] = this.P(x1, y1, z0);
    const [rbx, rby] = this.P(x1, y0, z0);
    face(rax, ray, rbx, rby, dark);
  }

  private drawBuilding(b: Building): void {
    const def = BUILDING_BY_ID.get(b.defId);
    if (!def) return;
    const pad = this.world.vh(b.x, b.y);
    const wall = colorIndex(b.wall);
    const roof = colorIndex(b.roof);
    const win = def.windows ? colorIndex(def.windows) : -1;
    const zTop = pad + b.h / 4;
    const roofH = def.roofH / 4;
    const place = (cx: number, cy: number, w: number, d: number) => {
      const [vx0, vy0, vx1, vy1] = this.viewRect(cx - w / 2, cy - d / 2, cx + w / 2, cy + d / 2);
      let roofType: 'flat' | 'ridgeRx' | 'ridgeRy' = 'flat';
      if (def.roofType === 'gable') {
        // Ridge along the longer world axis.
        const alongX = w >= d;
        roofType = alongX === (this.rot % 2 === 0) ? 'ridgeRx' : 'ridgeRy';
      }
      this.box(vx0, vy0, vx1, vy1, pad, zTop, wall, roof, roofType, roofH, win);
    };
    if (b.pair) {
      const parts: Array<[number, number]> = [
        [b.x + 0.3, b.y + 0.3],
        [b.x + 0.7, b.y + 0.7],
      ];
      parts.sort((p, q) => {
        const [ax, ay] = toView(p[0], p[1], this.rot, this.W, this.H);
        const [bx, by] = toView(q[0], q[1], this.rot, this.W, this.H);
        return ax + ay - (bx + by);
      });
      for (const [cx, cy] of parts) place(cx, cy, def.w * 0.8, def.d * 0.8);
    } else {
      place(b.x + 0.5, b.y + 0.5, def.w, def.d);
    }
    if (def.steeple) {
      const sx = b.x + 0.5;
      const sy = b.y + 0.5 + def.d / 2 - 0.12;
      const [vx0, vy0, vx1, vy1] = this.viewRect(sx - 0.1, sy - 0.1, sx + 0.1, sy + 0.1);
      this.box(vx0, vy0, vx1, vy1, pad, pad + def.steeple / 4, wall, PAL.slate, 'pyramid', 2, -1);
    }
  }

  private drawIndustry(ind: Industry): void {
    const def = INDUSTRY_BY_ID.get(ind.defId);
    if (!def) return;
    const pad = this.world.vh(ind.x, ind.y);
    const items = def.look.parts.map((p, k) => {
      const [a, b] = toView(ind.x + p.x + (p.w ?? 0) / 2, ind.y + p.y + (p.d ?? 0) / 2, this.rot, this.W, this.H);
      return { p, k, depth: a + b };
    });
    items.sort((u, v) => u.depth - v.depth || u.k - v.k);
    for (const { p, k } of items) this.drawPart(ind, p, k, pad);
  }

  private drawPart(ind: Industry, p: LookPart, k: number, pad: number): void {
    const x0 = ind.x + p.x;
    const y0 = ind.y + p.y;
    const x1 = x0 + (p.w ?? 0);
    const y1 = y0 + (p.d ?? 0);
    const z0 = pad + (p.z ?? 0) / 4;
    switch (p.t) {
      case 'box': {
        const [vx0, vy0, vx1, vy1] = this.viewRect(x0, y0, x1, y1);
        const wall = colorIndex(p.wall ?? 'stone');
        const roof = colorIndex(p.roof ?? 'slate');
        let roofType: 'flat' | 'ridgeRx' | 'ridgeRy' | 'pyramid' = 'flat';
        if (p.roofType === 'pyramid') roofType = 'pyramid';
        else if (p.roofType === 'gableX') roofType = this.rot % 2 === 0 ? 'ridgeRx' : 'ridgeRy';
        else if (p.roofType === 'gableY') roofType = this.rot % 2 === 0 ? 'ridgeRy' : 'ridgeRx';
        const win = p.windows ? colorIndex(p.windows) : -1;
        this.box(vx0, vy0, vx1, vy1, z0, z0 + (p.h ?? 8) / 4, wall, roof, roofType, (p.roofH ?? 0) / 4, win);
        break;
      }
      case 'pile': {
        const [vx0, vy0, vx1, vy1] = this.viewRect(x0, y0, x1, y1);
        const c = colorIndex(p.c ?? 'ink');
        this.box(vx0, vy0, vx1, vy1, z0, z0, c, c, 'pyramid', (p.h ?? 6) / 4, -1);
        break;
      }
      case 'tree':
        this.drawTree(x0, y0, false);
        break;
      case 'fence': {
        if (this.tw < 16) break;
        const c = solid(colorIndex(p.c ?? 'loam'));
        const zt = z0 + 0.5;
        const corners: Array<[number, number]> = [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ];
        for (let i = 0; i < 4; i++) {
          const [ax, ay] = corners[i];
          const [bx, by] = corners[(i + 1) % 4];
          drawLine(this.buf, ...this.PW(ax, ay, zt), ...this.PW(bx, by, zt), c);
          if (this.tw >= 32) {
            const len = Math.hypot(bx - ax, by - ay);
            const n = Math.max(1, Math.round(len / 0.3));
            for (let s = 0; s < n; s++) {
              const u = s / n;
              const px = ax + (bx - ax) * u;
              const py = ay + (by - ay) * u;
              drawLine(this.buf, ...this.PW(px, py, z0), ...this.PW(px, py, zt + 0.25), c);
            }
          }
        }
        break;
      }
      case 'dots': {
        if (this.tw < 16) break;
        const c = solid(colorIndex(p.c ?? 'bone'));
        const c2 = solid(colorIndex(p.c2 ?? p.c ?? 'bone'));
        const n = p.n ?? 4;
        for (let s = 0; s < n; s++) {
          const fx = x0 + (x1 - x0) * hashFloat(ind.id * 31 + s, k, 11);
          const fy = y0 + (y1 - y0) * hashFloat(ind.id * 31 + s, k, 13);
          const [px, py] = this.PW(fx, fy, z0);
          plot(this.buf, px, py, c);
          if (this.tw >= 32) {
            plot(this.buf, px + 1, py, c);
            plot(this.buf, px, py - 1, c2);
          }
        }
        break;
      }
      case 'derrick': {
        const c = solid(colorIndex(p.c ?? 'ink'));
        const ztop = z0 + (p.h ?? 20) / 4;
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const legs: Array<[number, number]> = [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ];
        const apex = this.PW(cx, cy, ztop);
        for (const [lx, ly] of legs) drawLine(this.buf, ...this.PW(lx, ly, z0), ...apex, c);
        if (this.tw >= 16) {
          for (const f of [0.35, 0.65]) {
            for (let i = 0; i < 4; i++) {
              const [ax, ay] = legs[i];
              const [bx, by] = legs[(i + 1) % 4];
              const pa = this.PW(ax + (cx - ax) * f, ay + (cy - ay) * f, z0 + (ztop - z0) * f);
              const pb = this.PW(bx + (cx - bx) * f, by + (cy - by) * f, z0 + (ztop - z0) * f);
              drawLine(this.buf, ...pa, ...pb, c);
            }
          }
        }
        break;
      }
    }
  }
}
