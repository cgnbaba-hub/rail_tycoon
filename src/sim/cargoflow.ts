import { ECONOMY } from '../data';
import type { Economy } from './economy';
import { tileDistance } from './routing';
import type { Train } from './train';
import { stopTile } from './train';
import type { World } from './world';

/**
 * Which stations the trains link: two stations are linked when one train calls at both.
 * Used for passenger/mail destinations (where can a traveller get to, with at most one
 * change) and for transfers (who can carry a load on). Rebuilt when any route changes.
 */
export class RouteNetwork {
  private sig = '';
  private links = new Map<number, Set<number>>();
  private reachCache = new Map<number, Set<number>>();
  private shareCache = new Map<string, Array<[number, number]>>();

  /** Bring the links up to date with the trains' routes. */
  update(trains: Train[]): void {
    let sig = '';
    for (const t of trains) sig += `${t.route.map((r) => r.station).join(',')};`;
    if (sig === this.sig) return;
    this.sig = sig;
    this.links.clear();
    this.reachCache.clear();
    this.shareCache.clear();
    for (const t of trains) {
      const stops = [...new Set(t.route.map((r) => r.station))];
      for (const a of stops) {
        let set = this.links.get(a);
        if (!set) this.links.set(a, (set = new Set()));
        for (const b of stops) if (b !== a) set.add(b);
      }
    }
  }

  /** Forget cached destination shares (populations and catchments move on). */
  refresh(): void {
    this.shareCache.clear();
  }

  /** Stations a train from `a` calls at directly. */
  linked(a: number): ReadonlySet<number> {
    return this.links.get(a) ?? EMPTY;
  }

  /** Stations reachable from `a` with at most one change of trains. */
  reach(a: number): ReadonlySet<number> {
    let r = this.reachCache.get(a);
    if (!r) {
      r = new Set(this.linked(a));
      for (const s of this.linked(a)) for (const d of this.linked(s)) if (d !== a) r.add(d);
      this.reachCache.set(a, r);
    }
    return r;
  }

  /**
   * Where new passengers (or mail) at `station` want to go: every reachable station that
   * takes the cargo, weighted by the people it serves and damped by distance. Shares sum to 1.
   */
  shares(world: World, economy: Economy, station: number, cargo: string): Array<[number, number]> {
    const key = `${station}:${cargo}`;
    const hit = this.shareCache.get(key);
    if (hit) return hit;
    const from = world.stations[station];
    const D = ECONOMY.destinations;
    const out: Array<[number, number]> = [];
    let sum = 0;
    if (from) {
      for (const d of [...this.reach(station)].sort((x, y) => x - y)) {
        const to = world.stations[d];
        if (!to || !economy.accepts(d, cargo)) continue;
        const people = (economy.station(d)?.towns ?? []).reduce((a, t) => a + t.pop, 0);
        if (people <= 0) continue;
        const w = people / (1 + tileDistance(world, stopTile(from), stopTile(to)) / D.distanceScale);
        out.push([d, w]);
        sum += w;
      }
    }
    for (const e of out) e[1] /= sum;
    this.shareCache.set(key, out);
    return out;
  }
}

const EMPTY: ReadonlySet<number> = new Set();

export function isDestinedCargo(cargo: string): boolean {
  return ECONOMY.destinations.cargos.includes(cargo);
}
