import { MAPGEN, type MapFeature, type MapLayoutDef, type MapPoint, type TownSize } from '../data';
import { fbm, valueNoise } from './noise';
import type { Rng } from './rng';
import { F, World } from './world';

/**
 * Terrain of hand-made maps (maps.json): a gentle noise base shaped by features — seas,
 * lakes, ridges, hills, plains, river valleys, forests and deserts. Positions are map
 * fractions, so a layout works at every map size. Towns get flat ground around them.
 */

export const TOWN_SIZES: TownSize[] = ['village', 'town', 'city', 'metropolis'];

/** Flattened radius (tiles) around a named town of each size. */
const TOWN_PAD = [3, 5, 7, 9];

const smooth = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

/** Distance from (x, y) to a polyline. */
export function distToPath(x: number, y: number, path: MapPoint[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, ay] = path[i];
    const [bx, by] = path[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  if (path.length === 1) best = Math.hypot(x - path[0][0], y - path[0][1]);
  return best;
}

/** Shore lowering: land within this distance (map fraction) of water slopes down to it. */
const SHORE = 0.05;

/** Fill the vertex heights of `world` from a layout. */
export function layoutHeights(world: World, layout: MapLayoutDef, rng: Rng): void {
  const W = world.width;
  const H = world.height;
  const S = Math.max(W, H);
  const n = MAPGEN.noise;
  const seed = rng.int(0, 0x7fffffff);
  const ridgeSeed = rng.int(0, 0x7fffffff);
  const shoreSeed = rng.int(0, 0x7fffffff);
  const land = layout.land ?? 0.18;
  const rough = layout.roughness ?? 0.22;
  const exponent = layout.exponent ?? 1.3;
  const maxH = world.maxHeight;
  const elev = new Float32Array((W + 1) * (H + 1));
  const water = new Uint8Array(elev.length);
  const shoreOpts = { octaves: 3, lacunarity: 2, gain: 0.5 };

  for (let vy = 0; vy <= H; vy++) {
    for (let vx = 0; vx <= W; vx++) {
      const fx = vx / S;
      const fy = vy / S;
      const base = fbm(vx * n.baseScale, vy * n.baseScale, seed, n);
      const ridged = 1 - Math.abs(2 * fbm(vx * n.baseScale * 1.6, vy * n.baseScale * 1.6, ridgeSeed, n) - 1);
      const wob = (fbm(vx * 0.05, vy * 0.05, shoreSeed, shoreOpts) - 0.5) * 2;
      let e = land + rough * (base - 0.5) * 2;
      let wet = false;
      let shore = 0;
      for (const f of layout.features) {
        switch (f.type) {
          case 'ridge': {
            const k = smooth(1 - distToPath(fx, fy, f.path) / f.width);
            const jag = f.jagged ?? 0.5;
            e += f.height * k * (1 - jag + jag * ridged * ridged * 1.4);
            break;
          }
          case 'hills': {
            const k = smooth(1 - Math.hypot(fx - f.x, fy - f.y) / f.r);
            e += f.height * k * (0.35 + ridged * 0.9);
            break;
          }
          case 'plain': {
            const k = smooth(1 - Math.hypot(fx - f.x, fy - f.y) / f.r);
            e += (f.height - e) * k;
            break;
          }
          case 'river': {
            const k = smooth(1 - distToPath(fx, fy, f.path) / (f.valley ?? 0.035));
            e += (0.03 - e) * k * 0.9;
            break;
          }
          case 'sea': {
            const wobble = (f.wobble ?? 0.03) * wob;
            const pos = f.edge === 'west' ? fx : f.edge === 'east' ? 1 - fx : f.edge === 'north' ? fy : 1 - fy;
            const into = f.at + wobble - pos;
            if (into > 0) wet = true;
            else shore = Math.max(shore, smooth(1 + into / SHORE));
            break;
          }
          case 'lake': {
            const ry = f.ry ?? f.rx;
            const q = Math.hypot((fx - f.x) / f.rx, (fy - f.y) / ry) * (1 + (f.wobble ?? 0.15) * wob);
            if (q < 1) wet = true;
            else shore = Math.max(shore, smooth(1 - ((q - 1) * Math.min(f.rx, ry)) / SHORE));
            break;
          }
          default:
            break;
        }
      }
      const i = world.vertexIndex(vx, vy);
      if (shore > 0) e += (0.02 - e) * shore * 0.85;
      elev[i] = e;
      water[i] = wet ? 1 : 0;
    }
  }

  // Flat ground for the named towns.
  for (const t of layout.towns) {
    const cx = Math.round(t.x * W);
    const cy = Math.round(t.y * H);
    if (!world.inBounds(cx, cy)) continue;
    const ci = world.vertexIndex(cx, cy);
    if (water[ci]) continue;
    const target = Math.max(0.03, Math.min(elev[ci], 0.5));
    const r = TOWN_PAD[TOWN_SIZES.indexOf(t.size)] ?? 4;
    for (let vy = Math.max(0, cy - r - 2); vy <= Math.min(H, cy + r + 2); vy++) {
      for (let vx = Math.max(0, cx - r - 2); vx <= Math.min(W, cx + r + 2); vx++) {
        const k = smooth((r + 2 - Math.hypot(vx - cx, vy - cy)) / 3);
        const i = world.vertexIndex(vx, vy);
        elev[i] += (target - elev[i]) * k * 0.95;
      }
    }
  }

  for (let i = 0; i < elev.length; i++) {
    if (water[i] || elev[i] <= 0) {
      world.heights[i] = 0;
    } else {
      const e = Math.min(1, elev[i]);
      world.heights[i] = Math.min(maxH, 1 + Math.floor(Math.pow(e, exponent) * (maxH - 1) + 0.0001));
    }
  }
}

/** Mark the layout's rivers (meandering 4-connected tile paths) until they reach water. */
export function layoutRivers(world: World, layout: MapLayoutDef, seed: number): void {
  const S = Math.max(world.width, world.height);
  layout.features.forEach((f, fi) => {
    if (f.type !== 'river') return;
    const pts = meander(f.path.map((p) => [p[0] * S, p[1] * S] as MapPoint), (seed + fi * 7919) >>> 0);
    let [x, y] = toTile(pts[0], world);
    outer: for (let k = 1; k < pts.length; k++) {
      const [tx, ty] = toTile(pts[k], world);
      while (x !== tx || y !== ty) {
        if (world.isWater(x, y)) break outer;
        world.flags[world.tileIndex(x, y)] |= F.River;
        // Step along the axis with the larger remaining distance.
        if (Math.abs(tx - x) >= Math.abs(ty - y)) x += Math.sign(tx - x);
        else y += Math.sign(ty - y);
      }
    }
    if (!world.isWater(x, y)) world.flags[world.tileIndex(x, y)] |= F.River;
  });
}

/** Points every few tiles along a path (in tiles), pushed sideways by smooth noise. */
function meander(path: MapPoint[], seed: number): MapPoint[] {
  const out: MapPoint[] = [path[0]];
  const STEP = 3;
  const AMP = 2.5;
  let along = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, ay] = path[i];
    const [bx, by] = path[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / STEP));
    const px = -(by - ay) / (len || 1);
    const py = (bx - ax) / (len || 1);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const last = i + 2 === path.length && k === n;
      const off = last ? 0 : (valueNoise((along + t * len) * 0.08, 0.5, seed) - 0.5) * 2 * AMP;
      out.push([ax + (bx - ax) * t + px * off, ay + (by - ay) * t + py * off]);
    }
    along += len;
  }
  return out;
}

function toTile(p: MapPoint, world: World): [number, number] {
  return [Math.max(0, Math.min(world.width - 1, Math.round(p[0]))), Math.max(0, Math.min(world.height - 1, Math.round(p[1])))];
}

/** Moisture added by forest features at tile (x, y) (negative = drier). */
export function layoutMoisture(layout: MapLayoutDef, x: number, y: number, S: number): number {
  let m = 0;
  for (const f of layout.features) {
    if (f.type !== 'forest') continue;
    m += f.amount * smooth(1 - Math.hypot(x / S - f.x, y / S - f.y) / f.r);
  }
  return m;
}

/** Is tile (x, y) inside a desert feature (edges frayed by `jitter`, 0–1)? */
export function layoutDesert(layout: MapLayoutDef, x: number, y: number, S: number, jitter: number): boolean {
  for (const f of layout.features) {
    if (f.type !== 'desert') continue;
    if (Math.hypot(x / S - f.x, y / S - f.y) < f.r * (0.85 + 0.3 * jitter)) return true;
  }
  return false;
}

/** Feature list helper for tests and tools. */
export function featuresOf(layout: MapLayoutDef, type: MapFeature['type']): MapFeature[] {
  return layout.features.filter((f) => f.type === type);
}
