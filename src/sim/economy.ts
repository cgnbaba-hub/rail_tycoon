import { CARGO_BY_ID, CONSTRUCTION, ECONOMY, INDUSTRY_BY_ID, TIME, type CargoDef, type EconomicModel } from '../data';
import { stationCoverage } from './station';
import type { World } from './world';

/** Average days per month, used to spread monthly supply over days. */
export const DAYS_PER_MONTH = 365 / 12;

// ---------------------------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------------------------

export interface RevenueQuote {
  cargo: string;
  loads: number;
  miles: number;
  transitDays: number;
  idealDays: number;
  /** base + perMile × miles, per load. */
  distancePay: number;
  timeFactor: number;
  demandFactor: number;
  economyFactor: number;
  total: number;
}

/** Days an ideal train (ECONOMY.timeValue.idealMph) needs for `tiles`. */
export function idealDays(tiles: number): number {
  const tilesPerDay = ECONOMY.timeValue.idealMph * ECONOMY.physics.tilesPerTickPerMph * TIME.ticksPerDay;
  return tiles / tilesPerDay;
}

export function timeFactor(cargo: CargoDef, transitDays: number, tiles: number): number {
  const half = ECONOMY.timeValue.halfLifeDays[cargo.decay];
  if (!half) return 1;
  const late = Math.max(0, transitDays - idealDays(tiles) - ECONOMY.timeValue.graceDays);
  return Math.max(ECONOMY.timeValue.minFactor, Math.pow(0.5, late / half));
}

/**
 * Payment for delivering `loads` of `cargoId` over a straight-line distance of `tiles`
 * after `transitDays` in transit:
 *   (base + perMile · miles) · timeFactor · demandFactor · economyFactor · loads
 */
export function quoteRevenue(
  cargoId: string,
  loads: number,
  tiles: number,
  transitDays: number,
  demanded: boolean,
  model: EconomicModel,
  economyFactor = 1,
): RevenueQuote {
  const cargo = CARGO_BY_ID.get(cargoId);
  if (!cargo) throw new Error(`Unknown cargo ${cargoId}`);
  const miles = (tiles * CONSTRUCTION.feetPerTile) / 5280;
  const distancePay = cargo.base + cargo.perMile * miles;
  const tf = timeFactor(cargo, transitDays, tiles);
  const df = demanded ? 1 : ECONOMY.models[model].nonDemandedFactor;
  return {
    cargo: cargoId,
    loads,
    miles,
    transitDays,
    idealDays: idealDays(tiles),
    distancePay,
    timeFactor: tf,
    demandFactor: df,
    economyFactor,
    total: Math.round(distancePay * tf * df * economyFactor * loads),
  };
}

// ---------------------------------------------------------------------------------------
// Station supply & demand
// ---------------------------------------------------------------------------------------

export interface StationCargo {
  /** Loads waiting, by cargo id (fractional while accumulating). */
  waiting: Record<string, number>;
  /** Loads delivered this year, by cargo id. */
  delivered: Record<string, number>;
  /** Revenue earned by deliveries here this year. */
  revenue: number;
}

export interface StationEconomy {
  /** Loads per month, by cargo id. */
  supply: Record<string, number>;
  /** Cargo ids this station pays full price for. */
  accepts: Set<string>;
  /** Industries (ids) in the catchment that consume each cargo. */
  consumers: Record<string, number[]>;
  /** All industry ids in the catchment. */
  industries: number[];
}

/**
 * Supply and demand of every live station, derived from catchments. Town population and
 * industry output covered by several stations are shared equally between them.
 */
export function computeStationEconomy(world: World): Map<number, StationEconomy> {
  const out = new Map<number, StationEconomy>();
  const stations = world.liveStations();
  const coverages = stations.map((s) => stationCoverage(world, s));
  const buildingShare = new Map<number, number>();
  const industryShare = new Map<number, number>();
  coverages.forEach((cov) => {
    for (const c of cov.cities) for (const t of c.tiles) buildingShare.set(t, (buildingShare.get(t) ?? 0) + 1);
    for (const ind of cov.industries) industryShare.set(ind.id, (industryShare.get(ind.id) ?? 0) + 1);
  });
  stations.forEach((st, k) => {
    const cov = coverages[k];
    const supply: Record<string, number> = {};
    const accepts = new Set<string>();
    const consumers: Record<string, number[]> = {};
    for (const c of cov.cities) {
      const live = c.city.buildingIds.filter((id) => !world.buildings[id].demolished).length || 1;
      const perBuilding = c.city.population / live;
      let pop = 0;
      for (const t of c.tiles) pop += perBuilding / (buildingShare.get(t) ?? 1);
      for (const [cargo, rate] of Object.entries(ECONOMY.townSupply)) supply[cargo] = (supply[cargo] ?? 0) + pop * rate;
      for (const cargo of ECONOMY.townDemand[c.city.classIndex] ?? []) accepts.add(cargo);
    }
    for (const ind of cov.industries) {
      const def = INDUSTRY_BY_ID.get(ind.defId)!;
      for (const cargo of def.consumes) {
        accepts.add(cargo);
        (consumers[cargo] ??= []).push(ind.id);
      }
      if (def.kind === 'raw' && def.produces.length) {
        const share = 1 / (industryShare.get(ind.id) ?? 1);
        for (const cargo of def.produces) supply[cargo] = (supply[cargo] ?? 0) + (def.rate / def.produces.length) * share;
      }
    }
    out.set(st.id, { supply, accepts, consumers, industries: cov.industries.map((i) => i.id) });
  });
  return out;
}

/**
 * Cargo flowing through stations and industries. Raw supply trickles in daily; processing
 * industries turn delivered inputs into outputs monthly (one input load → one output load,
 * up to their monthly rate).
 */
export class Economy {
  readonly cargo = new Map<number, StationCargo>();
  /** Input loads delivered to processing industries, waiting to be processed. */
  readonly industryStock = new Map<number, number>();
  /** Output produced by processors last month (for display). */
  readonly industryOutput = new Map<number, number>();
  private cache: { version: number; stations: number; data: Map<number, StationEconomy> } | null = null;

  constructor(
    private readonly world: World,
    public model: EconomicModel = ECONOMY.model,
  ) {}

  /** Supply/demand per station, recomputed when the world changes. */
  stations(): Map<number, StationEconomy> {
    const v = this.world.editVersion;
    const n = this.world.stations.length;
    if (!this.cache || this.cache.version !== v || this.cache.stations !== n) {
      this.cache = { version: v, stations: n, data: computeStationEconomy(this.world) };
    }
    return this.cache.data;
  }

  station(id: number): StationEconomy | undefined {
    return this.stations().get(id);
  }

  cargoAt(id: number): StationCargo {
    let c = this.cargo.get(id);
    if (!c) {
      c = { waiting: {}, delivered: {}, revenue: 0 };
      this.cargo.set(id, c);
    }
    return c;
  }

  accepts(stationId: number, cargo: string): boolean {
    return this.station(stationId)?.accepts.has(cargo) ?? false;
  }

  /** Daily trickle of raw supply into station stockpiles (capped). */
  daily(): void {
    const cap = ECONOMY.maxWaitingMonths;
    for (const [id, se] of this.stations()) {
      const sc = this.cargoAt(id);
      for (const [cargo, perMonth] of Object.entries(se.supply)) {
        const max = perMonth * cap;
        sc.waiting[cargo] = Math.min(max, (sc.waiting[cargo] ?? 0) + perMonth / DAYS_PER_MONTH);
      }
    }
  }

  /** Monthly industry processing: delivered inputs become outputs at covering stations. */
  monthly(): void {
    const needInputs = ECONOMY.models[this.model].processorsNeedInputs;
    const stations = this.stations();
    for (const ind of this.world.industries) {
      const def = INDUSTRY_BY_ID.get(ind.defId);
      if (!def || def.kind !== 'processor' || def.produces.length === 0) continue;
      const stock = this.industryStock.get(ind.id) ?? 0;
      let out = Math.min(stock, def.rate);
      this.industryStock.set(ind.id, stock - out);
      if (!needInputs) out = Math.max(out, ECONOMY.processorWithoutInputs);
      this.industryOutput.set(ind.id, out);
      if (out <= 0) continue;
      // Hand the output to every station that covers the industry, split evenly.
      const covering = [...stations.entries()].filter(([, se]) => se.industries.includes(ind.id));
      if (covering.length === 0) continue;
      for (const [sid] of covering) {
        const sc = this.cargoAt(sid);
        for (const cargo of def.produces) {
          sc.waiting[cargo] = (sc.waiting[cargo] ?? 0) + out / def.produces.length / covering.length;
        }
      }
    }
  }

  /** Take up to `max` whole loads of a cargo from a station. */
  take(stationId: number, cargo: string, max: number): number {
    const sc = this.cargoAt(stationId);
    const have = Math.floor((sc.waiting[cargo] ?? 0) + 1e-9);
    const n = Math.max(0, Math.min(have, max));
    if (n > 0) sc.waiting[cargo] = (sc.waiting[cargo] ?? 0) - n;
    return n;
  }

  /** Record a delivery and feed processing industries that use the cargo. */
  deliver(stationId: number, cargo: string, loads: number, revenue: number): void {
    const sc = this.cargoAt(stationId);
    sc.delivered[cargo] = (sc.delivered[cargo] ?? 0) + loads;
    sc.revenue += revenue;
    const consumers = this.station(stationId)?.consumers[cargo] ?? [];
    for (const id of consumers) {
      const def = INDUSTRY_BY_ID.get(this.world.industries[id].defId);
      if (def?.kind !== 'processor') continue;
      this.industryStock.set(id, (this.industryStock.get(id) ?? 0) + loads / consumers.length);
    }
  }

  /** Reset yearly counters. */
  yearly(): void {
    for (const sc of this.cargo.values()) {
      sc.delivered = {};
      sc.revenue = 0;
    }
  }
}
