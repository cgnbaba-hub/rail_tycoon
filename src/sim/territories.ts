import { TERRITORIES } from '../data';
import type { Rng } from './rng';
import type { World } from './world';

export interface Region {
  id: number;
  name: string;
  /** Seed tile (the region is every tile nearest to it). */
  x: number;
  y: number;
  /** Building here needs a charter. */
  restricted: boolean;
  /** Your railroad holds a charter (granted by goodwill or bought). */
  chartered: boolean;
  /** Public goodwill toward your railroad, 0–100. */
  goodwill: number;
}

/**
 * The map is divided into regions around a few seed points (nearest seed wins). Each has a
 * goodwill value toward the player's railroad; some are restricted until you hold a charter.
 * Rival railroads never build in restricted regions.
 */
export class Territories {
  readonly regions: Region[] = [];
  /** Region id per tile. */
  readonly map: Uint8Array;

  constructor(world: World, rng: Rng) {
    const T = TERRITORIES;
    const W = world.width;
    const H = world.height;
    this.map = new Uint8Array(W * H);
    const n = Math.max(T.minRegions, Math.min(T.maxRegions, Math.round((W * H) / T.tilesPerRegion)));
    // Spread the seeds out: start at the biggest town, then always the town (or tile) farthest
    // from the seeds so far.
    const towns = [...world.cities].sort((a, b) => b.population - a.population);
    const cands = towns.map((c) => [c.x, c.y] as [number, number]);
    for (let k = 0; k < 60; k++) {
      const c: [number, number] = [rng.int(2, W - 3), rng.int(2, H - 3)];
      if (!world.isWater(c[0], c[1])) cands.push(c);
    }
    const seeds: Array<[number, number]> = [cands[0] ?? [W >> 1, H >> 1]];
    while (seeds.length < n) {
      let best = cands[0];
      let bestD = -1;
      for (const c of cands) {
        const d = Math.min(...seeds.map((s) => Math.hypot(s[0] - c[0], s[1] - c[1])));
        if (d > bestD) {
          bestD = d;
          best = c;
        }
      }
      seeds.push(best);
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let r = 0;
        let bd = Infinity;
        seeds.forEach((s, k) => {
          const d = (s[0] - x) ** 2 + (s[1] - y) ** 2;
          if (d < bd) {
            bd = d;
            r = k;
          }
        });
        this.map[y * W + x] = r;
      }
    }
    // Name after the biggest town inside; restrict some (never the first, where the big town is).
    const order = seeds.map((_, k) => k).slice(1);
    for (let i = order.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [order[i], order[j]] = [order[j], order[i]];
    }
    const restricted = new Set(order.slice(0, Math.round((n - 1) * T.restrictedShare + 0.25)));
    const used = new Set<string>();
    seeds.forEach(([sx, sy], k) => {
      const town = towns.find((c) => this.map[c.y * W + c.x] === k);
      let name = town ? `${town.name} ${T.names[k % T.names.length]}` : `${['North', 'South', 'East', 'West'][k % 4]} ${T.names[(k + 3) % T.names.length]}`;
      if (used.has(name)) name = `${name} ${k + 1}`;
      used.add(name);
      this.regions.push({ id: k, name, x: sx, y: sy, restricted: restricted.has(k), chartered: false, goodwill: T.start });
    });
  }

  regionAt(tile: number): Region {
    return this.regions[this.map[tile]];
  }

  /** Can your railroad build here (no charter needed, or held)? */
  open(r: Region): boolean {
    return !r.restricted || r.chartered;
  }

  /** Construction cost factor from goodwill. */
  costFactor(r: Region): number {
    const T = TERRITORIES;
    return T.costAt0 + (T.costAt100 - T.costAt0) * (r.goodwill / 100);
  }

  /** Price of a charter in a given year. */
  charterFee(year: number): number {
    return Math.round((TERRITORIES.charterFee * (1 + Math.max(0, year - 1830) / 60)) / 1000) * 1000;
  }

  /** Tile mask of restricted regions for a company (0 = you: unchartered ones; rivals: all). */
  forbiddenFor(owner: number): Uint8Array | undefined {
    const closed = this.regions.filter((r) => r.restricted && (owner !== 0 || !r.chartered)).map((r) => r.id);
    if (!closed.length) return undefined;
    const set = new Set(closed);
    const out = new Uint8Array(this.map.length);
    for (let i = 0; i < out.length; i++) if (set.has(this.map[i])) out[i] = 1;
    return out;
  }

  change(r: Region, delta: number): void {
    r.goodwill = Math.max(0, Math.min(100, r.goodwill + delta));
  }
}
