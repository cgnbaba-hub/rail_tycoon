import type { Game } from './game';
import { annualProfit, engineAgeYears, engineDef, isSpecialCar, type RouteStop, type Train } from './train';

/** Selections and bulk commands for the train table. */

export interface FleetFilter {
  /** Engine older than this many years. */
  olderThan?: number;
  /** Losing money over the last 12 months (needs 3 months of history). */
  losing?: boolean;
  /** Load factor below this (needs a few departures). */
  loadBelow?: number;
  /** Older than its engine's design life. */
  pastLifespan?: boolean;
}

/** The player's trains matching every given criterion. */
export function selectTrains(game: Game, f: FleetFilter): Train[] {
  return game.trains.trains.filter((t) => {
    if (t.owner !== game.company.id) return false;
    const age = engineAgeYears(t, game.tick);
    if (f.olderThan !== undefined && age <= f.olderThan) return false;
    if (f.pastLifespan && age <= engineDef(t).lifespan) return false;
    if (f.losing && !(t.stats.months.length >= 3 && annualProfit(t) < 0)) return false;
    if (f.loadBelow !== undefined && !(t.stats.departures >= 3 && t.stats.loadFactor >= 0 && t.stats.loadFactor < f.loadBelow && t.cars.some((c) => !isSpecialCar(c.cargo)))) return false;
    return true;
  });
}

export interface BulkResult {
  done: number;
  failed: number;
  /** Net cash spent (negative = received). */
  cost: number;
  errors: string[];
}

function bulk(ids: number[], fn: (id: number) => { ok: boolean; cost: number; error?: string }): BulkResult {
  const r: BulkResult = { done: 0, failed: 0, cost: 0, errors: [] };
  for (const id of ids) {
    const x = fn(id);
    if (x.ok) {
      r.done++;
      r.cost += x.cost;
    } else {
      r.failed++;
      if (x.error && !r.errors.includes(x.error)) r.errors.push(x.error);
    }
  }
  return r;
}

/** Replace the engines of the given trains with the best on sale (stops when cash runs out). */
export function upgradeEngines(game: Game, ids: number[]): BulkResult {
  return bulk(ids, (id) => game.upgradeEngine(id));
}

export function sellTrains(game: Game, ids: number[]): BulkResult {
  return bulk(ids, (id) => game.sellTrain(id));
}

/** Give several trains the same route (e.g. from a template). */
export function setRoutes(game: Game, ids: number[], route: RouteStop[]): BulkResult {
  return bulk(ids, (id) => game.setRoute(id, route.map((r) => ({ ...r }))));
}
