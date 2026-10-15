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
import { rotatedSize, toView, vecToView, viewToTile, type Rot } from './iso';
import { DARKER, LIGHTER, PAL, colorIndex } from './palette';
import { viewCornerHeights } from './pick';
import { PixelBuffer, blitSprite, drawLine, fillPolygon, plot, rampPaint, solid, type Paint } from './raster';
import { SPRITES } from './sprites';

type PalName = keyof typeof PAL;
interface ImprovementLook {
  r: number;
  h: number;
  wall: PalName;
  roof: PalName;
  roofType: 'flat' | 'ridgeRx' | 'pyramid';
  roofH: number;
  windows?: boolean;
  stilts?: boolean;
}

/** How each station improvement looks (purely cosmetic). */
const IMPROVEMENT_LOOKS: Record<string, ImprovementLook> = {
  water_tower: { r: 0.09, h: 0, wall: 'rust', roof: 'slate', roofType: 'pyramid', roofH: 1, stilts: true },
  sand_house: { r: 0.08, h: 0.5, wall: 'sand', roof: 'loam', roofType: 'pyramid', roofH: 1 },
  maintenance_shop: { r: 0.13, h: 0.8, wall: 'brick', roof: 'slate', roofType: 'ridgeRx', roofH: 1 },
  roundhouse: { r: 0.14, h: 0.7, wall: 'stone', roof: 'shale', roofType: 'flat', roofH: 0 },
  hotel: { r: 0.12, h: 1.6, wall: 'cream', roof: 'tile', roofType: 'pyramid', roofH: 1.2, windows: true },
  restaurant: { r: 0.1, h: 0.7, wall: 'wheat', roof: 'oxblood', roofType: 'ridgeRx', roofH: 1, windows: true },
  post_office: { r: 0.1, h: 0.8, wall: 'teal', roof: 'night', roofType: 'pyramid', roofH: 1 },
  warehouse: { r: 0.13, h: 0.8, wall: 'loam', roof: 'rust', roofType: 'ridgeRx', roofH: 1 },
  cold_storage: { r: 0.11, h: 0.8, wall: 'bone', roof: 'fog', roofType: 'flat', roofH: 0 },
  livestock_pens: { r: 0.13, h: 0.25, wall: 'soil', roof: 'grass', roofType: 'flat', roofH: 0 },
};

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
  /** Palette colour name per company id: rival stations get roofs in their company colour. */
  ownerColors?: string[];
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
      if (node.station >= 0) {
        // Improvements stand across the track from the station building: paint them first
        // when that side faces away from the viewer.
        const behind = this.improvementsBehind(node);
        if (behind) this.drawImprovements(ti, node);
        this.drawStationTile(ti, node);
        if (!behind) this.drawImprovements(ti, node);
      }
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
    // One path from A's end through the edge midpoint to B's end, curved at 45° bends.
    const halfA = this.halfPath(a, b);
    const halfB = this.halfPath(b, a);
    const path = [...[...halfA].reverse(), ...halfB.slice(1)].map(([x, y]) => [x, y, surf(x, y)] as [number, number, number]);
    this.railPath(path, dbl, 'ground', this.needsCap(a, halfA), this.needsCap(b, halfB));
  }

  /** Does the path end at node `i`'s centre where other track meets it (junction, dead end)? */
  private needsCap(i: number, half: Array<[number, number]>): boolean {
    const [cx, cy] = this.center(i);
    const end = half[half.length - 1];
    if (Math.abs(end[0] - cx) > 1e-6 || Math.abs(end[1] - cy) > 1e-6) return false;
    return bitCount(this.world.track.getIdx(i)!.conn) !== 2;
  }

  /**
   * Half of the edge i–j on i's side: from the edge midpoint to i. At a plain two-way node
   * with a 45° bend it ends on a quadratic curve that meets the other half-edge smoothly.
   */
  private halfPath(i: number, j: number): Array<[number, number]> {
    const track = this.world.track;
    const [cx, cy] = this.center(i);
    const [ox, oy] = this.center(j);
    const mid: [number, number] = [(cx + ox) / 2, (cy + oy) / 2];
    const node = track.getIdx(i)!;
    if (node.kind === NODE_GROUND && node.station < 0 && bitCount(node.conn) === 2) {
      const d1 = track.dirBetween(i, j);
      let d2 = -1;
      for (let d = 0; d < 8; d++) if (d !== d1 && node.conn & (1 << d)) d2 = d;
      const diff = (d2 - d1 + 8) % 8;
      const other = track.getIdx(track.neighbor(i, d2));
      if ((diff === 3 || diff === 5) && other?.kind === NODE_GROUND && track.getIdx(j)?.kind === NODE_GROUND) {
        const l1 = Math.hypot(DX[d1], DY[d1]);
        const l2 = Math.hypot(DX[d2], DY[d2]);
        const c = 0.34;
        const p1: [number, number] = [cx + (DX[d1] / l1) * c, cy + (DY[d1] / l1) * c];
        const p2: [number, number] = [cx + (DX[d2] / l2) * c, cy + (DY[d2] / l2) * c];
        const out: Array<[number, number]> = [mid, p1];
        for (let k = 1; k <= 3; k++) {
          const t = k / 6;
          const u = 1 - t;
          out.push([u * u * p1[0] + 2 * u * t * cx + t * t * p2[0], u * u * p1[1] + 2 * u * t * cy + t * t * p2[1]]);
        }
        return out;
      }
    }
    return [mid, [cx, cy]];
  }

  private drawLoneStationTrack(i: number, node: TrackNode): void {
    const st = this.world.stations[node.station];
    if (!st) return;
    const [cx, cy] = this.center(i);
    const [dx, dy] = st.axis === 'x' ? [0.5, 0] : [0, 0.5];
    this.rails(cx - dx, cy - dy, node.z, cx + dx, cy + dy, node.z, false, 'ground', true, true);
  }

  /** Straight rails from (x0,y0,z0) to (x1,y1,z1) in world units. */
  private rails(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, dbl: boolean, bed: 'ground' | 'wood' | 'stone' | 'steel', extend0: boolean, extend1: boolean): void {
    this.railPath(
      [
        [x0, y0, z0],
        [x1, y1, z1],
      ],
      dbl,
      bed,
      extend0,
      extend1,
    );
  }

  /**
   * Track along a polyline (world x, y, z): a ballast bed with darker shoulders, wooden
   * sleepers at a steady spacing and two-tone rails. `cap0/1` push the bed a little past the
   * ends so junctions and dead ends have no gaps.
   */
  private railPath(path: Array<[number, number, number]>, dbl: boolean, bed: 'ground' | 'wood' | 'stone' | 'steel', cap0: boolean, cap1: boolean): void {
    const tw = this.tw;
    if (path.length < 2) return;
    if (tw < 16) {
      for (let k = 0; k + 1 < path.length; k++) drawLine(this.buf, ...this.PW(...path[k]), ...this.PW(...path[k + 1]), solid(PAL.night));
      return;
    }
    const hw = dbl ? 0.31 : 0.17;
    const pts = path.map((p) => [...p] as [number, number, number]);
    // Extend the ends along their tangents.
    const ext = (i: number, j: number, e: number) => {
      const dx = pts[i][0] - pts[j][0];
      const dy = pts[i][1] - pts[j][1];
      const l = Math.hypot(dx, dy) || 1;
      pts[i] = [pts[i][0] + (dx / l) * e, pts[i][1] + (dy / l) * e, pts[i][2]];
    };
    if (cap0) ext(0, 1, hw * 0.7);
    if (cap1) ext(pts.length - 1, pts.length - 2, hw * 0.7);
    // Per-point unit normals (averaged at joints).
    const n = pts.length;
    const segN: Array<[number, number]> = [];
    const segL: number[] = [];
    for (let k = 0; k + 1 < n; k++) {
      const dx = pts[k + 1][0] - pts[k][0];
      const dy = pts[k + 1][1] - pts[k][1];
      const l = Math.hypot(dx, dy) || 1e-9;
      segN.push([-dy / l, dx / l]);
      segL.push(l);
    }
    const ptN = pts.map((_, k) => {
      const a = segN[Math.max(0, k - 1)];
      const b = segN[Math.min(segN.length - 1, k)];
      const x = a[0] + b[0];
      const y = a[1] + b[1];
      const l = Math.hypot(x, y) || 1;
      // Miter length so offsets keep their width through the bend.
      const cos = (x * a[0] + y * a[1]) / l;
      const m = 1 / Math.max(0.7, cos);
      return [(x / l) * m, (y / l) * m] as [number, number];
    });
    const off = (k: number, o: number): [number, number] => this.PW(pts[k][0] + ptN[k][0] * o, pts[k][1] + ptN[k][1] * o, pts[k][2]);
    if (bed === 'ground') {
      const shoulder = solid(PAL.shale);
      const ballast = solid(PAL.stone);
      for (let k = 0; k + 1 < n; k++) this.poly(shoulder, off(k, -hw), off(k + 1, -hw), off(k + 1, hw), off(k, hw));
      const inner = hw - (tw >= 64 ? 0.035 : 0.05);
      for (let k = 0; k + 1 < n; k++) this.poly(ballast, off(k, -inner), off(k + 1, -inner), off(k + 1, inner), off(k, inner));
    }
    const tracks = dbl ? [-0.15, 0.15] : [0];
    // Sleepers at steady spacing along the arc.
    const total = segL.reduce((a, b) => a + b, 0);
    const spacing = tw >= 64 ? 0.105 : 0.16;
    const tieColor = bed === 'steel' ? PAL.night : PAL.loam;
    const tieHalfLen = 0.115;
    const tieHalfW = tw >= 64 ? 0.022 : 0;
    const count = Math.max(1, Math.round(total / spacing));
    let seg = 0;
    let segStart = 0;
    for (let t = 0; t < count; t++) {
      const s = ((t + 0.5) * total) / count;
      while (seg < segL.length - 1 && s > segStart + segL[seg]) segStart += segL[seg++];
      const f = (s - segStart) / segL[seg];
      const a = pts[seg];
      const b = pts[seg + 1];
      const x = a[0] + (b[0] - a[0]) * f;
      const y = a[1] + (b[1] - a[1]) * f;
      const z = a[2] + (b[2] - a[2]) * f;
      const [nx, ny] = segN[seg];
      const tx = ny;
      const ty = -nx;
      for (const o of tracks) {
        const cx = x + nx * o;
        const cy = y + ny * o;
        if (tieHalfW > 0) {
          const q = (u: number, v: number) => this.PW(cx + nx * u + tx * v, cy + ny * u + ty * v, z);
          this.poly(solid(tieColor), q(-tieHalfLen, -tieHalfW), q(tieHalfLen, -tieHalfW), q(tieHalfLen, tieHalfW), q(-tieHalfLen, tieHalfW));
        } else {
          drawLine(this.buf, ...this.PW(cx - nx * tieHalfLen, cy - ny * tieHalfLen, z), ...this.PW(cx + nx * tieHalfLen, cy + ny * tieHalfLen, z), solid(tieColor));
        }
      }
    }
    // Rails: a dark web line under a bright head at the closest zoom.
    const gauge = 0.06;
    const head = solid(PAL.fog);
    const web = solid(PAL.steel);
    for (const o of tracks) {
      for (const r of [-gauge, gauge]) {
        for (let k = 0; k + 1 < n; k++) {
          const [x0, y0] = off(k, o + r);
          const [x1, y1] = off(k + 1, o + r);
          if (tw >= 64) drawLine(this.buf, x0, y0 + 1, x1, y1 + 1, web);
          drawLine(this.buf, x0, y0, x1, y1, head);
        }
      }
    }
  }

  /** Height of the ground (or water surface) under a world point, for bridge supports. */
  private groundUnder(x: number, y: number): number {
    const tx = Math.min(this.W - 1, Math.max(0, Math.floor(x)));
    const ty = Math.min(this.H - 1, Math.max(0, Math.floor(y)));
    if (this.world.terrain[this.world.tileIndex(tx, ty)] === T.Water) return 0;
    return this.world.surfaceHeight(x, y);
  }

  private bridgeDeck(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, dbl: boolean, type: number): void {
    const def = CONSTRUCTION.bridges[type] ?? CONSTRUCTION.bridges[0];
    const kind = def.id as 'wood' | 'stone' | 'steel';
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const nx = -dy / len;
    const ny = dx / len;
    const hw = dbl ? 0.34 : 0.21;
    const P = (x: number, y: number, z: number) => this.PW(x, y, z);
    // Which side faces the viewer.
    const [va, vb] = toView(x0 + nx, y0 + ny, this.rot, this.W, this.H);
    const [vc, vd] = toView(x0 - nx, y0 - ny, this.rot, this.W, this.H);
    const near = va + vb > vc + vd ? 1 : -1;
    const at = (f: number, side: number, dz = 0): [number, number, number] => [x0 + dx * f + nx * hw * side, y0 + dy * f + ny * hw * side, z0 + (z1 - z0) * f + dz];
    const big = this.tw >= 32;
    const truss = (side: number) => {
      const c = solid(PAL.steel);
      const sh = solid(PAL.slate);
      const H = 2.3;
      const n = Math.max(2, Math.round(len * 2));
      const line = (a: [number, number, number], b: [number, number, number]) => {
        const [ax, ay] = P(...a);
        const [bx, by] = P(...b);
        if (this.tw >= 64) drawLine(this.buf, ax + 1, ay, bx + 1, by, sh);
        drawLine(this.buf, ax, ay, bx, by, c);
      };
      line(at(0, side, H), at(1, side, H));
      for (let k = 0; k <= n; k++) {
        line(at(k / n, side), at(k / n, side, H));
        if (k < n) line(at(k / n, side), at((k + 1) / n, side, H));
      }
    };
    if (kind === 'steel' && big) truss(-near);
    if (kind === 'stone') {
      // Solid stone wall on the near side with an arch opening.
      const n0 = at(0, near);
      const n1 = at(1, near);
      const g0 = this.groundUnder(n0[0], n0[1]);
      const g1 = this.groundUnder(n1[0], n1[1]);
      // The wall reaches the ground, or at least shows a deck edge over low water.
      const b0 = Math.min(g0, n0[2] - 0.55);
      const b1 = Math.min(g1, n1[2] - 0.55);
      this.poly(solid(DARKER[PAL.stone]), P(...n0), P(...n1), P(n1[0], n1[1], b1), P(n0[0], n0[1], b0));
      this.poly(solid(PAL.fog), P(...n0), P(...n1), P(n1[0], n1[1], n1[2] - 0.12), P(n0[0], n0[1], n0[2] - 0.12));
      if (big) {
        const top = Math.min(z0, z1) - 0.35;
        const base = Math.max(g0, g1);
        if (top - base > 0.4) {
          const arch: Array<[number, number]> = [];
          const segs = 8;
          for (let k = 0; k <= segs; k++) {
            const th = Math.PI - (k / segs) * Math.PI;
            const f = 0.5 + Math.cos(th) * 0.36;
            const h = base + (top - base) * (0.55 + 0.45 * Math.sin(th));
            const q = at(f, near);
            arch.push(P(q[0], q[1], h));
          }
          const qa = at(0.86, near);
          const qb = at(0.14, near);
          arch.push(P(qa[0], qa[1], base), P(qb[0], qb[1], base));
          this.poly(solid(PAL.night), ...arch);
        }
      }
      this.poly(solid(PAL.stone), P(...at(0, -1)), P(...at(1, -1)), P(...at(1, 1)), P(...at(0, 1)));
    } else {
      const deckColor = kind === 'wood' ? PAL.soil : PAL.slate;
      const drop = kind === 'wood' ? 0.45 : 0.6;
      this.poly(solid(DARKER[deckColor]), P(...at(0, near)), P(...at(1, near)), P(...at(1, near, -drop)), P(...at(0, near, -drop)));
      this.poly(solid(deckColor), P(...at(0, -1)), P(...at(1, -1)), P(...at(1, 1)), P(...at(0, 1)));
    }
    this.rails(x0, y0, z0, x1, y1, z1, dbl, kind, false, false);
    if (!big) return;
    if (kind === 'steel') truss(near);
    else {
      // Railings: wooden posts and rail, or a stone parapet.
      const color = solid(kind === 'stone' ? PAL.fog : PAL.loam);
      const h = kind === 'stone' ? 0.45 : 0.6;
      for (const side of [-near, near]) {
        drawLine(this.buf, ...P(...at(0, side, h)), ...P(...at(1, side, h)), color);
        if (kind === 'wood') {
          const n = Math.max(2, Math.round(len * 4));
          for (let k = 0; k <= n; k++) drawLine(this.buf, ...P(...at(k / n, side)), ...P(...at(k / n, side, h)), color);
        } else drawLine(this.buf, ...P(...at(0, side, h - 0.15)), ...P(...at(1, side, h - 0.15)), solid(PAL.stone));
      }
    }
  }

  /** Supports under a bridge node: timber trestle bents, or stone piers (also under steel spans). */
  private drawPillar(i: number, node: TrackNode): void {
    const def = CONSTRUCTION.bridges[node.span] ?? CONSTRUCTION.bridges[0];
    const [cx, cy] = this.center(i);
    const ground = this.groundUnder(cx, cy);
    const top = node.z - (def.id === 'wood' ? 0.45 : 0.6);
    if (top <= ground) return;
    let d = 0;
    while (d < 7 && !(node.conn & (1 << d))) d++;
    const l = Math.hypot(DX[d], DY[d]);
    const ux = DX[d] / l;
    const uy = DY[d] / l;
    const nx = -uy;
    const ny = ux;
    const hw = node.double ? 0.34 : 0.21;
    const P = (along: number, across: number, z: number) => this.PW(cx + ux * along + nx * across, cy + uy * along + ny * across, z);
    if (def.id === 'wood') {
      if (this.tw < 16) return;
      const post = solid(PAL.loam);
      const brace = solid(PAL.soil);
      const spread = hw + 0.12;
      for (const side of [-1, 1]) {
        if (this.tw >= 64) this.poly(post, P(-0.02, side * spread, ground), P(0.02, side * spread, ground), P(0.02, side * hw, top), P(-0.02, side * hw, top));
        else drawLine(this.buf, ...P(0, side * spread, ground), ...P(0, side * hw, top), post);
      }
      drawLine(this.buf, ...P(0, -spread, ground), ...P(0, hw, top), brace);
      drawLine(this.buf, ...P(0, spread, ground), ...P(0, -hw, top), brace);
      drawLine(this.buf, ...P(0, -hw - 0.04, top), ...P(0, hw + 0.04, top), post);
      return;
    }
    // A slab across the track; faces towards the viewer, lit side brighter.
    const color = def.id === 'stone' ? PAL.stone : PAL.shale;
    const a = def.id === 'stone' ? 0.09 : 0.07;
    const w = hw * 0.85;
    const faces: Array<[[number, number], [number, number]]> = [
      [[a, -w], [a, w]],
      [[-a, w], [-a, -w]],
      [[-a, -w], [a, -w]],
      [[a, w], [-a, w]],
    ];
    for (const [p, q] of faces) {
      const mx = (p[0] + q[0]) / 2;
      const my = (p[1] + q[1]) / 2;
      const [vx, vy] = vecToView(ux * mx + nx * my, uy * mx + ny * my, this.rot);
      if (vx + vy <= 0) continue;
      const c = vy >= vx ? color : DARKER[color];
      this.poly(solid(c), P(p[0], p[1], ground), P(q[0], q[1], ground), P(q[0], q[1], top), P(p[0], p[1], top));
    }
    this.poly(solid(LIGHTER[color]), P(a, -w, top), P(a, w, top), P(-a, w, top), P(-a, -w, top));
  }

  /** Tunnel portal: a stone face with a dark arched mouth, voussoirs and a cornice. */
  private portal(x: number, y: number, z: number, dx: number, dy: number): void {
    const len = Math.hypot(dx, dy);
    const nx = -dy / len;
    const ny = dx / len;
    const P = (o: number, h: number) => this.PW(x + nx * o, y + ny * o, z + h);
    const arch = (r: number, spring: number, rise: number): Array<[number, number]> => {
      const out: Array<[number, number]> = [P(-r, 0)];
      for (let k = 0; k <= 8; k++) {
        const th = Math.PI - (k / 8) * Math.PI;
        out.push(P(Math.cos(th) * r, spring + Math.sin(th) * rise));
      }
      out.push(P(r, 0));
      return out;
    };
    this.poly(solid(DARKER[PAL.stone]), P(-0.36, 0), P(0.36, 0), P(0.36, 1.7), P(-0.36, 1.7));
    this.poly(solid(PAL.stone), P(-0.31, 0), P(0.31, 0), P(0.31, 1.75), P(-0.31, 1.75));
    this.poly(solid(PAL.fog), ...arch(0.22, 0.95, 0.5));
    this.poly(solid(PAL.ink), ...arch(0.17, 0.95, 0.4));
    if (this.tw >= 32) {
      this.poly(solid(PAL.shale), P(-0.36, 1.75), P(0.36, 1.75), P(0.36, 1.95), P(-0.36, 1.95));
      this.poly(solid(PAL.fog), P(-0.03, 1.32), P(0.03, 1.32), P(0.035, 1.5), P(-0.035, 1.5));
    }
  }


  private drawBufferStop(i: number, node: TrackNode): void {
    if (this.tw < 16) return;
    let d = 0;
    while (!(node.conn & (1 << d))) d++;
    const [cx, cy] = this.center(i);
    // A timber buffer beam on two posts just past the centre, with a red lamp.
    const l = Math.hypot(DX[d], DY[d]);
    const ux = -DX[d] / l;
    const uy = -DY[d] / l;
    const nx = -uy;
    const ny = ux;
    const z = node.z;
    const P = (along: number, across: number, h: number) => this.PW(cx + ux * (0.2 + along) + nx * across, cy + uy * (0.2 + along) + ny * across, z + h);
    for (const side of [-0.1, 0.1]) this.poly(solid(PAL.loam), P(0, side - 0.025, 0), P(0, side + 0.025, 0), P(0, side + 0.025, 0.6), P(0, side - 0.025, 0.6));
    // Beam: front face and top.
    this.poly(solid(PAL.brick), P(-0.04, -0.16, 0.3), P(-0.04, 0.16, 0.3), P(-0.04, 0.16, 0.65), P(-0.04, -0.16, 0.65));
    this.poly(solid(PAL.tile), P(-0.04, -0.16, 0.65), P(-0.04, 0.16, 0.65), P(0.04, 0.16, 0.65), P(0.04, -0.16, 0.65));
    this.poly(solid(PAL.bone), P(-0.04, -0.03, 0.38), P(-0.04, 0.03, 0.38), P(-0.04, 0.03, 0.57), P(-0.04, -0.03, 0.57));
    if (this.tw >= 32) {
      drawLine(this.buf, ...P(0, 0, 0.6), ...P(0, 0, 0.8), solid(PAL.ink));
      const [lx, ly] = P(0, 0, 0.85);
      plot(this.buf, lx, ly, solid(PAL.tile));
      if (this.tw >= 64) plot(this.buf, lx + 1, ly, solid(PAL.ember));
    }
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
    const rival = st.owner !== 0 ? this.opts.ownerColors?.[st.owner] : undefined;
    const roof = colorIndex(rival ?? L.roof);
    this.box(vx0, vy0, vx1, vy1, z, z + L.h / 4, wall, roof, roofType, 1.25, PAL.gold);
    if (L.tower) {
      const tx0 = bx - along[0] * (L.l / 2 - 0.08);
      const ty0 = by - along[1] * (L.l / 2 - 0.08);
      const [wx0, wy0, wx1, wy1] = this.viewRect(tx0 - 0.08, ty0 - 0.08, tx0 + 0.08, ty0 + 0.08);
      this.box(wx0, wy0, wx1, wy1, z, z + L.tower / 4, wall, PAL.slate, 'pyramid', 1.5, PAL.cream);
    }
  }

  private improvementsBehind(node: TrackNode): boolean {
    const st = this.world.stations[node.station];
    if (!st) return false;
    const perp: [number, number] = st.axis === 'x' ? [0, -st.side] : [-st.side, 0];
    const [vx, vy] = vecToView(perp[0], perp[1], this.rot);
    return vx + vy < 0;
  }

  /** Small outbuildings for station improvements, in slots across the track from the station building. */
  private drawImprovements(i: number, node: TrackNode): void {
    const st = this.world.stations[node.station];
    if (!st?.improvements?.length || this.tw < 16) return;
    const k = st.tiles.indexOf(i);
    const [cx, cy] = this.center(i);
    const along: [number, number] = st.axis === 'x' ? [1, 0] : [0, 1];
    const perp: [number, number] = st.axis === 'x' ? [0, -st.side] : [-st.side, 0];
    const SLOTS = [-0.3, 0, 0.3];
    // Back-to-front within the tile.
    const [ax, ay] = vecToView(along[0], along[1], this.rot);
    const order = st.improvements.map((id, n) => ({ id, n })).filter(({ n }) => Math.floor(n / SLOTS.length) === k);
    order.sort((p, q) => (SLOTS[p.n % SLOTS.length] - SLOTS[q.n % SLOTS.length]) * (ax + ay));
    order.forEach(({ id, n }) => {
      const look = IMPROVEMENT_LOOKS[id];
      if (!look) return;
      const a = SLOTS[n % SLOTS.length];
      const px = cx + along[0] * a + perp[0] * 0.4;
      const py = cy + along[1] * a + perp[1] * 0.4;
      const r = look.r;
      const [vx0, vy0, vx1, vy1] = this.viewRect(px - r, py - r, px + r, py + r);
      const z = node.z;
      if (look.stilts) {
        // Water tower: a tank on legs.
        this.box(vx0, vy0, vx1, vy1, z + 0.9, z + 1.6, PAL[look.wall], PAL[look.roof], 'pyramid', 1, -1);
        const [lx0, ly0, lx1, ly1] = this.viewRect(px - 0.02, py - 0.02, px + 0.02, py + 0.02);
        this.box(lx0, ly0, lx1, ly1, z, z + 0.9, PAL.loam, PAL.loam, 'flat', 0, -1);
      } else {
        this.box(vx0, vy0, vx1, vy1, z, z + look.h, PAL[look.wall], PAL[look.roof], look.roofType, look.roofH, look.windows ? PAL.gold : -1);
      }
    });
  }

  // -- decorations ------------------------------------------------------------------------

  private drawTree(x: number, y: number, conifer: boolean): void {
    if (this.tw < 16) return;
    const big = this.tw >= 32;
    const sprite = conifer ? (big ? SPRITES.coniferL : SPRITES.coniferS) : big ? SPRITES.leafyL : SPRITES.leafyS;
    const [px, py] = this.PW(x, y, this.world.surfaceHeight(x, y));
    blitSprite(this.buf, sprite, px, py, this.tw >= 64 ? 2 : 1);
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
    blitSprite(this.buf, sprite, px, py, this.tw >= 64 ? 2 : 1);
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
