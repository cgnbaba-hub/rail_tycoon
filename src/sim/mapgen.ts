import {
  BUILDINGS,
  INDUSTRIES,
  MAPGEN,
  NAMES,
  type BuildingDef,
  type IndustryDef,
} from '../data';
import { fbm } from './noise';
import { Rng, hashFloat } from './rng';
import {
  F,
  OCC_BUILDING,
  OCC_INDUSTRY,
  T,
  World,
  encodeOccupant,
  terrainIdFromName,
  type City,
  type MapParams,
} from './world';

export function defaultMapParams(seed: number): MapParams {
  const d = MAPGEN.defaults;
  return { seed, size: d.size, water: d.water, hills: d.hills, forests: d.forests, cities: d.cities, startYear: d.startYear };
}

/** Generate a complete world. Pure function of params (deterministic). */
export function generateWorld(params: MapParams): World {
  const size = params.size;
  const world = new World(size, size, MAPGEN.maxHeight);
  const rng = new Rng(params.seed);
  generateHeights(world, params, rng.fork(1));
  classifyWater(world);
  generateRivers(world, rng.fork(2));
  classifyTerrain(world, params);
  placeCities(world, params, rng.fork(3));
  placeIndustries(world, params, rng.fork(4));
  flattenFootprints(world);
  world.revision++;
  return world;
}

// ---------------------------------------------------------------------------------------
// Heights
// ---------------------------------------------------------------------------------------

function generateHeights(world: World, params: MapParams, rng: Rng): void {
  const W = world.width;
  const H = world.height;
  const n = MAPGEN.noise;
  const seed = rng.int(0, 0x7fffffff);
  const ridgeSeed = rng.int(0, 0x7fffffff);
  const hill = MAPGEN.hills[params.hills];
  const vals = new Float32Array((W + 1) * (H + 1));
  const ef = MAPGEN.edgeFalloff;
  const useFalloff = params.water !== 'none';

  for (let vy = 0; vy <= H; vy++) {
    for (let vx = 0; vx <= W; vx++) {
      let v = fbm(vx * n.baseScale, vy * n.baseScale, seed, n);
      // Ridged component adds mountain chains on hilly maps.
      const r = 1 - Math.abs(2 * fbm(vx * n.baseScale * 0.7, vy * n.baseScale * 0.7, ridgeSeed, n) - 1);
      v = v * (1 - 0.35 * hill.range) + r * r * 0.35 * hill.range;
      if (useFalloff) {
        const ex = Math.min(vx, W - vx) / W;
        const ey = Math.min(vy, H - vy) / H;
        const e = Math.min(ex, ey);
        if (e < ef.width) {
          const k = 1 - e / ef.width;
          v -= ef.strength * k * k;
        }
      }
      vals[world.vertexIndex(vx, vy)] = v;
    }
  }

  // Sea level at the requested quantile.
  const sorted = Float32Array.from(vals).sort();
  const seaFrac = MAPGEN.water[params.water];
  const threshold = sorted[Math.min(sorted.length - 1, Math.floor(seaFrac * sorted.length))];
  const top = sorted[sorted.length - 1];
  const maxH = world.maxHeight;

  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v < threshold) {
      world.heights[i] = 0;
    } else {
      const e = Math.min(1, (v - threshold) / Math.max(1e-6, top - threshold));
      const lvl = 1 + Math.floor(Math.pow(e, hill.exponent) * hill.range * (maxH - 1) + 0.0001);
      world.heights[i] = Math.min(maxH, lvl);
    }
  }
  enforceLipschitz(world);
}

/**
 * Lower vertices so 4-neighbours differ by at most one level (L1 distance transform:
 * h'(v) = min_u h(u) + |u-v|_1). Only ever lowers, so sea stays at 0 and land stays >= 1.
 */
export function enforceLipschitz(world: World): void {
  const W = world.width + 1;
  const H = world.height + 1;
  const h = world.heights;
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let m = h[i];
        if (x > 0 && h[i - 1] + 1 < m) m = h[i - 1] + 1;
        if (y > 0 && h[i - W] + 1 < m) m = h[i - W] + 1;
        if (m !== h[i]) {
          h[i] = m;
          changed = true;
        }
      }
    }
    for (let y = H - 1; y >= 0; y--) {
      for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        let m = h[i];
        if (x < W - 1 && h[i + 1] + 1 < m) m = h[i + 1] + 1;
        if (y < H - 1 && h[i + W] + 1 < m) m = h[i + W] + 1;
        if (m !== h[i]) {
          h[i] = m;
          changed = true;
        }
      }
    }
  }
}

function classifyWater(world: World): void {
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      world.terrain[world.tileIndex(x, y)] = world.tileMaxH(x, y) === 0 ? T.Water : T.Grass;
    }
  }
}

// ---------------------------------------------------------------------------------------
// Rivers
// ---------------------------------------------------------------------------------------

const DIRS4: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function generateRivers(world: World, rng: Rng): void {
  const W = world.width;
  const H = world.height;
  const cfg = MAPGEN.rivers;
  const count = Math.round((cfg.perTenThousandTiles * W * H) / 10000);
  const minSource = cfg.minSourceHeight * world.maxHeight;
  let made = 0;
  for (let attempt = 0; attempt < count * 30 && made < count; attempt++) {
    const sx = rng.int(2, W - 3);
    const sy = rng.int(2, H - 3);
    if (world.isWater(sx, sy) || world.hasFlag(sx, sy, F.River)) continue;
    if (world.tileAvgH(sx, sy) < minSource) continue;
    const path = traceRiver(world, sx, sy, rng, cfg.maxLength);
    if (!path || path.length < cfg.minLength) continue;
    for (const idx of path) world.flags[idx] |= F.River;
    made++;
  }
}

function traceRiver(world: World, sx: number, sy: number, rng: Rng, maxLen: number): number[] | null {
  const visited = new Set<number>();
  const path: number[] = [];
  let x = sx;
  let y = sy;
  for (let step = 0; step < maxLen; step++) {
    const idx = world.tileIndex(x, y);
    visited.add(idx);
    path.push(idx);
    const here = world.tileAvgH(x, y);
    let best: [number, number] | null = null;
    let bestH = Infinity;
    for (const [dx, dy] of DIRS4) {
      const nx = x + dx;
      const ny = y + dy;
      if (!world.inBounds(nx, ny)) continue;
      const nIdx = world.tileIndex(nx, ny);
      if (visited.has(nIdx)) continue;
      if (world.isWater(nx, ny) || (world.flags[nIdx] & F.River) !== 0) {
        // Reached the sea, a lake or joined another river.
        return path;
      }
      const nh = world.tileAvgH(nx, ny) + rng.next() * 0.2;
      if (nh <= here + 0.2 && nh < bestH) {
        bestH = nh;
        best = [nx, ny];
      }
    }
    if (!best) return null;
    [x, y] = best;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Biomes
// ---------------------------------------------------------------------------------------

function classifyTerrain(world: World, params: MapParams): void {
  const W = world.width;
  const H = world.height;
  const maxH = world.maxHeight;
  const m = MAPGEN.moisture;
  const forestThreshold = MAPGEN.forests[params.forests];
  const moistSeed = (params.seed ^ 0x5bd1e995) >>> 0;
  const opts = { octaves: m.octaves, lacunarity: 2, gain: 0.5 };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = world.tileIndex(x, y);
      if (world.terrain[i] === T.Water) continue;
      const avg = world.tileAvgH(x, y);
      const minH = world.tileMinH(x, y);
      const maxT = world.tileMaxH(x, y);
      const river = (world.flags[i] & F.River) !== 0;
      let moisture = fbm(x * m.scale, y * m.scale, moistSeed, opts);
      if (river || nearFlag(world, x, y, F.River, 2)) moisture += 0.08;
      if (minH === 0 && maxT <= MAPGEN.beachMaxHeight && nearWater(world, x, y, 1)) {
        world.terrain[i] = T.Sand;
      } else if (avg >= MAPGEN.snowHeight * maxH) {
        world.terrain[i] = T.Snow;
      } else if (avg >= MAPGEN.rockHeight * maxH) {
        world.terrain[i] = moisture > forestThreshold + 0.08 && avg < MAPGEN.snowHeight * maxH * 0.9 ? T.Forest : T.Rough;
      } else if (moisture > forestThreshold && !river) {
        world.terrain[i] = T.Forest;
      } else {
        world.terrain[i] = T.Grass;
        if (!river && hashFloat(x, y, params.seed ^ 0x1234) < MAPGEN.scatteredTreeChance) world.flags[i] |= F.Tree;
      }
    }
  }
}

function nearWater(world: World, x: number, y: number, r: number): boolean {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (world.inBounds(nx, ny) && world.isWater(nx, ny)) return true;
    }
  }
  return false;
}

function nearFlag(world: World, x: number, y: number, flag: number, r: number): boolean {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (world.inBounds(nx, ny) && world.hasFlag(nx, ny, flag)) return true;
    }
  }
  return false;
}

/** Can a building/industry stand on this tile? */
function buildable(world: World, x: number, y: number): boolean {
  if (!world.inBounds(x, y)) return false;
  const i = world.tileIndex(x, y);
  if (world.terrain[i] === T.Water) return false;
  if ((world.flags[i] & (F.River | F.Road)) !== 0) return false;
  if (world.occupant[i] !== 0) return false;
  if (world.tileMinH(x, y) < 1) return false;
  return world.tileSlope(x, y) <= 1;
}

// ---------------------------------------------------------------------------------------
// Cities
// ---------------------------------------------------------------------------------------

function placeCities(world: World, params: MapParams, rng: Rng): void {
  const W = world.width;
  const H = world.height;
  const cfg = MAPGEN.cities;
  const target = Math.max(2, Math.round((cfg.perTenThousandTiles[params.cities] * W * H) / 10000));
  const spacing = cfg.minSpacing;
  const maxH = cfg.maxHeightFraction * world.maxHeight;

  type Cand = { x: number; y: number; score: number; coastal: boolean; river: boolean; hilly: boolean };
  const cands: Cand[] = [];
  const margin = 4;
  for (let y = margin; y < H - margin; y++) {
    for (let x = margin; x < W - margin; x++) {
      if (!buildable(world, x, y)) continue;
      const t = world.terrainAt(x, y);
      if (t === T.Snow || t === T.Rough) continue;
      if (world.tileAvgH(x, y) > maxH) continue;
      const coastal = nearWater(world, x, y, 3);
      const river = nearFlag(world, x, y, F.River, 2);
      let flat = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (buildable(world, x + dx, y + dy)) flat++;
      if (flat < 14) continue;
      const score = 1 + (coastal ? 1.5 : 0) + (river ? 1.5 : 0) + flat / 25;
      cands.push({ x, y, score, coastal, river, hilly: world.tileAvgH(x, y) > maxH * 0.6 });
    }
  }
  // Weighted shuffle: sort by score * random key.
  const keyed = cands.map((c) => ({ c, k: Math.pow(rng.next(), 1 / c.score) }));
  keyed.sort((a, b) => b.k - a.k);

  const usedNames = new Set<string>();
  const chosen: Cand[] = [];
  for (const { c } of keyed) {
    if (chosen.length >= target) break;
    if (chosen.some((o) => World.dist(o.x, o.y, c.x, c.y) < spacing)) continue;
    chosen.push(c);
  }

  const classes = cfg.classes;
  const classIdx = chosen.map(() => classes.indexOf(rng.weighted(classes, (k) => k.weight)));
  // Cap the biggest class by map area, and guarantee at least one proper city.
  const maxTop = Math.max(1, Math.floor((W * H) / cfg.areaPerMetropolis));
  let tops = 0;
  for (let i = 0; i < classIdx.length; i++) {
    if (classIdx[i] === classes.length - 1 && ++tops > maxTop) classIdx[i] = classes.length - 2;
  }
  if (chosen.length >= 3 && !classIdx.some((k) => k >= 2)) classIdx[0] = 2;

  chosen.forEach((c, i) => {
    const cls = classes[classIdx[i]];
    const population = rng.int(cls.popMin, cls.popMax);
    const name = makeCityName(rng, usedNames, c.coastal, c.river, c.hilly, classIdx[i]);
    const city: City = { id: world.cities.length, name, x: c.x, y: c.y, population, classIndex: classIdx[i], radius: 1, buildingIds: [] };
    world.cities.push(city);
    growCity(world, city, Math.ceil(population / cls.peoplePerBuilding), rng);
  });
}

function makeCityName(rng: Rng, used: Set<string>, coastal: boolean, river: boolean, hilly: boolean, cls: number): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    const pre = rng.pick(NAMES.prefixes);
    let suf = rng.pick(NAMES.suffixes);
    if (pre.toLowerCase().endsWith(suf[0])) suf = rng.pick(NAMES.suffixes);
    let name = pre + suf;
    if (coastal && rng.chance(0.3)) name = rng.pick(NAMES.coastalPrefixes) + name;
    else if (river && rng.chance(0.3)) name += rng.pick(NAMES.riverSuffixes);
    else if (hilly && rng.chance(0.3)) name += rng.pick(NAMES.hillSuffixes);
    else if (cls >= 2 && rng.chance(0.3)) name += rng.pick(NAMES.bigCitySuffixes);
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  const fallback = `Settlement ${used.size + 1}`;
  used.add(fallback);
  return fallback;
}

function growCity(world: World, city: City, nBuildings: number, rng: Rng): void {
  const sigma = Math.sqrt(nBuildings) * 0.55 + 0.8;
  const R = Math.ceil(sigma * 2.6) + 1;
  type Slot = { x: number; y: number; d: number; w: number };
  const slots: Slot[] = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const x = city.x + dx;
      const y = city.y + dy;
      // Street grid: every 4th row/column, crossing at the centre.
      if (dx % 4 === 0 || dy % 4 === 0) continue;
      if (!buildable(world, x, y)) continue;
      const d = Math.hypot(dx, dy);
      if (d > R) continue;
      slots.push({ x, y, d, w: Math.exp(-(d * d) / (2 * sigma * sigma)) });
    }
  }
  const keyed = slots.map((s) => ({ s, k: Math.pow(rng.next(), 1 / Math.max(1e-6, s.w)) }));
  keyed.sort((a, b) => b.k - a.k);
  const picked = keyed.slice(0, nBuildings).map((k) => k.s);
  const maxD = picked.reduce((m, s) => Math.max(m, s.d), 1);
  city.radius = Math.ceil(maxD);

  const usedUnique = new Set<string>();
  // Place inner buildings first so unique ones (church) land near the core.
  picked.sort((a, b) => a.d - b.d);
  for (const slot of picked) {
    const ring = slot.d / maxD;
    const options = BUILDINGS.filter(
      (b) => b.minClass <= city.classIndex && ring >= b.ring[0] && ring <= b.ring[1] && !(b.unique && usedUnique.has(b.id)),
    );
    if (options.length === 0) continue;
    const def: BuildingDef = rng.weighted(options, (b) => b.weight);
    if (def.unique) usedUnique.add(def.id);
    const sizeBoost = def.id === 'tower' || def.id === 'office' ? 1 + city.classIndex * 0.15 : 1;
    const h = Math.round(def.h * sizeBoost * (1 + rng.next() * def.jitter));
    const id = world.buildings.length;
    world.buildings.push({
      id,
      cityId: city.id,
      x: slot.x,
      y: slot.y,
      defId: def.id,
      wall: rng.pick(def.walls),
      roof: rng.pick(def.roofs),
      h,
      pair: rng.chance(def.pairChance),
    });
    city.buildingIds.push(id);
    const ti = world.tileIndex(slot.x, slot.y);
    world.occupant[ti] = encodeOccupant(OCC_BUILDING, id);
    world.flags[ti] &= ~F.Tree;
    if (world.terrain[ti] === T.Forest || world.terrain[ti] === T.Rough) world.terrain[ti] = T.Grass;
  }

  // Streets: grid tiles that touch at least one building.
  const R2 = city.radius + 1;
  for (let dy = -R2; dy <= R2; dy++) {
    for (let dx = -R2; dx <= R2; dx++) {
      if (!(dx % 4 === 0 || dy % 4 === 0)) continue;
      const x = city.x + dx;
      const y = city.y + dy;
      if (!world.inBounds(x, y)) continue;
      const i = world.tileIndex(x, y);
      if (world.terrain[i] === T.Water || (world.flags[i] & F.River) !== 0 || world.occupant[i] !== 0) continue;
      let touches = dx === 0 && dy === 0;
      for (const [ox, oy] of DIRS4) {
        const nx = x + ox;
        const ny = y + oy;
        if (world.inBounds(nx, ny) && world.occupant[world.tileIndex(nx, ny)] !== 0) touches = true;
      }
      if (!touches) continue;
      world.flags[i] = (world.flags[i] | F.Road) & ~F.Tree;
      if (world.terrain[i] === T.Forest || world.terrain[i] === T.Rough) world.terrain[i] = T.Grass;
    }
  }
  // Drop street stubs that connect to nothing.
  for (let dy = -R2; dy <= R2; dy++) {
    for (let dx = -R2; dx <= R2; dx++) {
      const x = city.x + dx;
      const y = city.y + dy;
      if (!world.inBounds(x, y) || !world.hasFlag(x, y, F.Road)) continue;
      const linked = DIRS4.some(([ox, oy]) => world.inBounds(x + ox, y + oy) && world.hasFlag(x + ox, y + oy, F.Road));
      if (!linked) world.flags[world.tileIndex(x, y)] &= ~F.Road;
    }
  }
}

// ---------------------------------------------------------------------------------------
// Industries
// ---------------------------------------------------------------------------------------

function placeIndustries(world: World, params: MapParams, rng: Rng): void {
  let land = 0;
  for (let i = 0; i < world.terrain.length; i++) if (world.terrain[i] !== T.Water) land++;
  const scale = MAPGEN.industries.densityScale;
  for (const def of INDUSTRIES) {
    if (params.startYear < def.era[0] || params.startYear > def.era[1]) continue;
    const expected = (def.density * land * scale) / 10000;
    let target = Math.floor(expected) + (rng.chance(expected - Math.floor(expected)) ? 1 : 0);
    if (def.kind === 'raw' && expected > 0.3) target = Math.max(1, target);
    let placed = 0;
    for (let attempt = 0; attempt < target * 80 && placed < target; attempt++) {
      const x = rng.int(1, world.width - 1 - def.size[0]);
      const y = rng.int(1, world.height - 1 - def.size[1]);
      if (!canPlaceIndustry(world, def, x, y)) continue;
      const city = world.nearestCity(x + def.size[0] / 2, y + def.size[1] / 2);
      const id = world.industries.length;
      world.industries.push({
        id,
        defId: def.id,
        name: city ? `${city.name} ${def.name}` : def.name,
        x,
        y,
        w: def.size[0],
        h: def.size[1],
        cityId: city ? city.id : -1,
      });
      for (let dy = 0; dy < def.size[1]; dy++) {
        for (let dx = 0; dx < def.size[0]; dx++) {
          const ti = world.tileIndex(x + dx, y + dy);
          world.occupant[ti] = encodeOccupant(OCC_INDUSTRY, id);
          world.flags[ti] &= ~F.Tree;
        }
      }
      placed++;
    }
  }
}

export function canPlaceIndustry(world: World, def: IndustryDef, x: number, y: number): boolean {
  const [w, h] = def.size;
  const p = def.placement;
  const allowed = p.terrain.map(terrainIdFromName);
  let minH = Infinity;
  let maxH = -Infinity;
  let sum = 0;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (!buildable(world, tx, ty)) return false;
      if (!allowed.includes(world.terrainAt(tx, ty) as never)) return false;
      const c = world.corners(tx, ty);
      for (const v of c) {
        minH = Math.min(minH, v);
        maxH = Math.max(maxH, v);
      }
      sum += world.tileAvgH(tx, ty);
    }
  }
  if (maxH - minH > 1) return false;
  const avg = sum / (w * h) / world.maxHeight;
  if (p.minHeight !== undefined && avg < p.minHeight) return false;
  if (p.maxHeight !== undefined && avg > p.maxHeight) return false;

  // Keep a gap to other occupants (cities, industries) and roads.
  const gap = MAPGEN.industries.minGap;
  for (let dy = -gap; dy < h + gap; dy++) {
    for (let dx = -gap; dx < w + gap; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (!world.inBounds(tx, ty)) continue;
      const i = world.tileIndex(tx, ty);
      if (world.occupant[i] !== 0 || (world.flags[i] & F.Road) !== 0) return false;
    }
  }

  const cx = x + w / 2;
  const cy = y + h / 2;
  for (const other of world.industries) {
    if (other.defId === def.id && World.dist(cx, cy, other.x + other.w / 2, other.y + other.h / 2) < p.spacing) return false;
  }
  const city = world.nearestCity(cx, cy);
  if (p.nearCity) {
    if (!city) return false;
    const d = World.dist(cx, cy, city.x, city.y) - city.radius;
    if (d < p.nearCity[0] || d > p.nearCity[1]) return false;
  } else if (city && World.dist(cx, cy, city.x, city.y) < city.radius + 3) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------
// Flatten building pads
// ---------------------------------------------------------------------------------------

/**
 * Lower every occupied tile to a flat pad at its minimum corner height, then restore the
 * |Δh| <= 1 invariant. Repeats until all pads are flat (heights only decrease → terminates).
 */
function flattenFootprints(world: World): void {
  const pads: Array<[number, number, number, number]> = [];
  for (const ind of world.industries) pads.push([ind.x, ind.y, ind.w, ind.h]);
  for (const b of world.buildings) pads.push([b.x, b.y, 1, 1]);
  for (let iter = 0; iter < 20; iter++) {
    let allFlat = true;
    for (const [x, y, w, h] of pads) {
      let m = Infinity;
      let M = -Infinity;
      for (let vy = y; vy <= y + h; vy++) {
        for (let vx = x; vx <= x + w; vx++) {
          const v = world.vh(vx, vy);
          m = Math.min(m, v);
          M = Math.max(M, v);
        }
      }
      if (m === M) continue;
      allFlat = false;
      for (let vy = y; vy <= y + h; vy++) for (let vx = x; vx <= x + w; vx++) world.heights[world.vertexIndex(vx, vy)] = m;
    }
    if (allFlat) return;
    enforceLipschitz(world);
  }
}
