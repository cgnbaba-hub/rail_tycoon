import type { TerrainName } from '../data';
import type { Station } from './station';
import { TrackNetwork } from './track';

/** Tile terrain ids (stored in World.terrain). */
export const T = {
  Water: 0,
  Sand: 1,
  Grass: 2,
  Forest: 3,
  Rough: 4,
  Snow: 5,
} as const;
export type TerrainId = (typeof T)[keyof typeof T];

export const TERRAIN_NAMES: TerrainName[] = ['water', 'sand', 'grass', 'forest', 'rough', 'snow'];
export const TERRAIN_LABELS = ['Water', 'Beach', 'Grassland', 'Forest', 'Rocky hills', 'Snowfield'];

export function terrainIdFromName(name: TerrainName): TerrainId {
  const idx = TERRAIN_NAMES.indexOf(name);
  if (idx < 0) throw new Error(`Unknown terrain ${name}`);
  return idx as TerrainId;
}

/** Tile flag bits (stored in World.flags). */
export const F = {
  River: 1,
  Tree: 2,
  Road: 4,
} as const;

/** Occupant encoding: (kind << 24) | (index + 1). 0 = free. */
export const OCC_BUILDING = 1;
export const OCC_INDUSTRY = 2;

export function encodeOccupant(kind: number, index: number): number {
  return (kind << 24) | (index + 1);
}
export function occupantKind(v: number): number {
  return v >>> 24;
}
export function occupantIndex(v: number): number {
  return (v & 0xffffff) - 1;
}

export interface City {
  id: number;
  name: string;
  x: number;
  y: number;
  population: number;
  /** Index into MAPGEN.cities.classes. */
  classIndex: number;
  /** Radius (tiles) of the built-up area. */
  radius: number;
  buildingIds: number[];
}

export interface Building {
  id: number;
  cityId: number;
  x: number;
  y: number;
  defId: string;
  wall: string;
  roof: string;
  /** Wall height in px at 32px tiles. */
  h: number;
  /** Two small buildings share the tile. */
  pair: boolean;
  /** Torn down (e.g. for a railway). The record stays so undo can restore it. */
  demolished?: boolean;
}

export interface Industry {
  id: number;
  defId: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cityId: number;
}

export interface MapParams {
  seed: number;
  size: number;
  water: 'none' | 'low' | 'normal' | 'high';
  hills: 'flat' | 'normal' | 'mountainous';
  forests: 'few' | 'normal' | 'many';
  cities: 'few' | 'normal' | 'many';
  startYear: number;
}

/**
 * The static world: corner heightmap + per-tile layers + placed cities/industries.
 * Heights live on the (W+1)×(H+1) vertex grid; tile (x, y) has corners
 * (x,y) (x+1,y) (x+1,y+1) (x,y+1). Adjacent vertices never differ by more than 1 level.
 */
export class World {
  readonly width: number;
  readonly height: number;
  readonly maxHeight: number;
  readonly heights: Uint8Array;
  readonly terrain: Uint8Array;
  readonly flags: Uint8Array;
  readonly occupant: Int32Array;
  cities: City[] = [];
  buildings: Building[] = [];
  industries: Industry[] = [];
  readonly track: TrackNetwork;
  /** Stations by id; removed stations leave a null hole so ids stay stable. */
  stations: Array<Station | null> = [];
  /** Bumped when the whole world is replaced/regenerated (full cache flush). */
  revision = 0;
  /** Tiles changed since the renderer last looked (partial cache invalidation). */
  readonly dirty = new Set<number>();

  constructor(width: number, height: number, maxHeight: number) {
    this.width = width;
    this.height = height;
    this.maxHeight = maxHeight;
    this.heights = new Uint8Array((width + 1) * (height + 1));
    this.terrain = new Uint8Array(width * height);
    this.flags = new Uint8Array(width * height);
    this.occupant = new Int32Array(width * height);
    this.track = new TrackNetwork(width, height);
  }

  /** Incremented on every tile change; lets cached plans detect that the world moved on. */
  editVersion = 0;

  markDirty(tileIdx: number): void {
    this.dirty.add(tileIdx);
    this.editVersion++;
  }

  liveStations(): Station[] {
    return this.stations.filter((s): s is Station => s !== null);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  tileIndex(x: number, y: number): number {
    return y * this.width + x;
  }

  vertexIndex(vx: number, vy: number): number {
    return vy * (this.width + 1) + vx;
  }

  /** Height level at a vertex (clamped to the grid). */
  vh(vx: number, vy: number): number {
    const cx = vx < 0 ? 0 : vx > this.width ? this.width : vx;
    const cy = vy < 0 ? 0 : vy > this.height ? this.height : vy;
    return this.heights[cy * (this.width + 1) + cx];
  }

  /** Corner heights of a tile in world order: [ (x,y), (x+1,y), (x+1,y+1), (x,y+1) ]. */
  corners(x: number, y: number): [number, number, number, number] {
    return [this.vh(x, y), this.vh(x + 1, y), this.vh(x + 1, y + 1), this.vh(x, y + 1)];
  }

  tileMinH(x: number, y: number): number {
    const c = this.corners(x, y);
    return Math.min(c[0], c[1], c[2], c[3]);
  }

  tileMaxH(x: number, y: number): number {
    const c = this.corners(x, y);
    return Math.max(c[0], c[1], c[2], c[3]);
  }

  tileAvgH(x: number, y: number): number {
    const c = this.corners(x, y);
    return (c[0] + c[1] + c[2] + c[3]) / 4;
  }

  /** Max corner difference within a tile (0 = flat). */
  tileSlope(x: number, y: number): number {
    return this.tileMaxH(x, y) - this.tileMinH(x, y);
  }

  terrainAt(x: number, y: number): TerrainId {
    return this.terrain[this.tileIndex(x, y)] as TerrainId;
  }

  isWater(x: number, y: number): boolean {
    return this.terrain[this.tileIndex(x, y)] === T.Water;
  }

  hasFlag(x: number, y: number, flag: number): boolean {
    return (this.flags[this.tileIndex(x, y)] & flag) !== 0;
  }

  occupantAt(x: number, y: number): number {
    return this.occupant[this.tileIndex(x, y)];
  }

  /**
   * Terrain surface height (in levels) at a continuous world position, following the same
   * two-triangle split the renderer uses. The split is chosen in world space so the surface
   * is identical in all view rotations.
   */
  surfaceHeight(fx: number, fy: number): number {
    const x = Math.min(Math.max(Math.floor(fx), 0), this.width - 1);
    const y = Math.min(Math.max(Math.floor(fy), 0), this.height - 1);
    const u = Math.min(Math.max(fx - x, 0), 1);
    const v = Math.min(Math.max(fy - y, 0), 1);
    const [a, b, c, d] = this.corners(x, y);
    if (splitsAlongMainDiagonal(a, b, c, d)) {
      // Diagonal (0,0)-(1,1): triangles (a,b,c) for u>=v and (a,c,d) for u<v.
      return u >= v ? a + (b - a) * u + (c - b) * v : a + (c - d) * u + (d - a) * v;
    }
    // Diagonal (1,0)-(0,1): triangles (a,b,d) for u+v<=1 and (b,c,d) otherwise.
    return u + v <= 1 ? a + (b - a) * u + (d - a) * v : c + (d - c) * (1 - u) + (b - c) * (1 - v);
  }

  /** Distance between two tiles (Euclidean). */
  static dist(ax: number, ay: number, bx: number, by: number): number {
    return Math.hypot(ax - bx, ay - by);
  }

  nearestCity(x: number, y: number): City | undefined {
    let best: City | undefined;
    let bestD = Infinity;
    for (const c of this.cities) {
      const d = World.dist(x, y, c.x, c.y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }
}

/**
 * Which diagonal a tile's quad folds along, given corners a=(0,0) b=(1,0) c=(1,1) d=(0,1).
 * We fold along the diagonal whose endpoints are level with each other, which gives the
 * classic "one corner raised" / "three corners raised" shapes.
 */
export function splitsAlongMainDiagonal(a: number, b: number, c: number, d: number): boolean {
  if (b === d && a !== c) return false;
  if (a === c) return true;
  return false;
}
