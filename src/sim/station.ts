import { STATION_BY_ID, STATION_NAME_SUFFIXES, type StationDef } from '../data';
import type { City, Industry, World } from './world';

export interface Station {
  id: number;
  name: string;
  kind: StationDef['id'];
  /** Tile indices of the platform, in order along the axis. */
  tiles: number[];
  /** 'x' = track runs east–west, 'y' = north–south. */
  axis: 'x' | 'y';
  /** Which side of the track the station building stands on (+1 / -1, perpendicular). */
  side: 1 | -1;
  /** Nearest town at the time of building. */
  cityId: number;
  /** Day the station opened. */
  builtDay: number;
}

/** Inclusive tile rectangle [x0, y0, x1, y1]. */
export type TileRect = [number, number, number, number];

export function stationDef(kind: string): StationDef {
  const d = STATION_BY_ID.get(kind);
  if (!d) throw new Error(`Unknown station kind ${kind}`);
  return d;
}

/** Catchment = footprint grown by the radius (Chebyshev), clamped to the map. */
export function catchmentRect(world: World, tiles: number[], radius: number): TileRect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const t of tiles) {
    const x = t % world.width;
    const y = Math.floor(t / world.width);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [
    Math.max(0, x0 - radius),
    Math.max(0, y0 - radius),
    Math.min(world.width - 1, x1 + radius),
    Math.min(world.height - 1, y1 + radius),
  ];
}

export function inRect(r: TileRect, x: number, y: number): boolean {
  return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
}

export interface CityCoverage {
  city: City;
  covered: number;
  total: number;
  /** Population living in covered buildings (population spread evenly over buildings). */
  population: number;
  /** Building tile indices inside the catchment. */
  tiles: number[];
}

export interface Coverage {
  cities: CityCoverage[];
  industries: Industry[];
}

/** Which towns (and how much of them) and industries fall inside a catchment rectangle. */
export function coverage(world: World, r: TileRect): Coverage {
  const cities: CityCoverage[] = [];
  for (const city of world.cities) {
    const live = city.buildingIds.map((id) => world.buildings[id]).filter((b) => !b.demolished);
    if (live.length === 0) continue;
    const inside = live.filter((b) => inRect(r, b.x, b.y));
    if (inside.length === 0) continue;
    cities.push({
      city,
      covered: inside.length,
      total: live.length,
      population: Math.round((city.population * inside.length) / live.length),
      tiles: inside.map((b) => world.tileIndex(b.x, b.y)),
    });
  }
  cities.sort((a, b) => b.population - a.population);
  const industries = world.industries.filter((ind) => {
    for (let dy = 0; dy < ind.h; dy++) for (let dx = 0; dx < ind.w; dx++) if (inRect(r, ind.x + dx, ind.y + dy)) return true;
    return false;
  });
  return { cities, industries };
}

export function stationCoverage(world: World, st: Station): Coverage {
  return coverage(world, catchmentRect(world, st.tiles, stationDef(st.kind).radius));
}

/** "Ashford", then "Ashford Junction", "Ashford Central", … */
export function stationName(world: World, city: City | undefined): string {
  const base = city ? city.name : 'Wilderness';
  const taken = new Set(world.liveStations().map((s) => s.name));
  if (!taken.has(base)) return base;
  for (const suf of STATION_NAME_SUFFIXES) if (!taken.has(`${base} ${suf}`)) return `${base} ${suf}`;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
