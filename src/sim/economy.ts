import {
  CARGO,
  CARGO_BY_ID,
  CONSTRUCTION,
  ECONOMY,
  INDUSTRY_BY_ID,
  TIME,
  type CargoDef,
  type EconomicModel,
} from '../data';
import { EconomicCycle } from './cycle';
import type { Rng } from './rng';
import { stationCoverage, stationEffects } from './station';
import type { Industry, World } from './world';

/** Average days per month, used to spread monthly supply over days. */
export const DAYS_PER_MONTH = 365 / 12;
const SAT = ECONOMY.saturation;

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
  /** Demanded-or-not factor × current demand level (saturation). */
  demandFactor: number;
  /** Economic cycle × cargo price level (Expert). */
  economyFactor: number;
  /** Station improvements and consist extras (hotel, dining car, …). */
  bonusFactor: number;
  total: number;
}

export interface QuoteExtras {
  /** Demand level at the destination (1 = unsaturated). */
  demandLevel?: number;
  economy?: number;
  bonus?: number;
  /** Extra grace days before perishables lose value (cold storage). */
  graceBonus?: number;
}

/** Days an ideal train (ECONOMY.timeValue.idealMph) needs for `tiles`. */
export function idealDays(tiles: number): number {
  const tilesPerDay = ECONOMY.timeValue.idealMph * ECONOMY.physics.tilesPerTickPerMph * TIME.ticksPerDay;
  return tiles / tilesPerDay;
}

export function timeFactor(cargo: CargoDef, transitDays: number, tiles: number, graceBonus = 0): number {
  const half = ECONOMY.timeValue.halfLifeDays[cargo.decay];
  if (!half) return 1;
  const late = Math.max(0, transitDays - idealDays(tiles) - ECONOMY.timeValue.graceDays - graceBonus);
  return Math.max(ECONOMY.timeValue.minFactor, Math.pow(0.5, late / half));
}

/**
 * Payment for delivering `loads` of `cargoId` over a straight-line distance of `tiles`
 * after `transitDays` in transit:
 *   (base + perMile · miles) · timeFactor · demandFactor · economyFactor · bonusFactor · loads
 * where demandFactor = (1 if demanded, else the model's factor) · demand level.
 */
export function quoteRevenue(
  cargoId: string,
  loads: number,
  tiles: number,
  transitDays: number,
  demanded: boolean,
  model: EconomicModel,
  extras: QuoteExtras = {},
): RevenueQuote {
  const cargo = CARGO_BY_ID.get(cargoId);
  if (!cargo) throw new Error(`Unknown cargo ${cargoId}`);
  const miles = (tiles * CONSTRUCTION.feetPerTile) / 5280;
  const distancePay = cargo.base + cargo.perMile * miles;
  const tf = timeFactor(cargo, transitDays, tiles, extras.graceBonus ?? 0);
  const df = (demanded ? 1 : ECONOMY.models[model].nonDemandedFactor) * (extras.demandLevel ?? 1);
  const ef = extras.economy ?? 1;
  const bf = extras.bonus ?? 1;
  return {
    cargo: cargoId,
    loads,
    miles,
    transitDays,
    idealDays: idealDays(tiles),
    distancePay,
    timeFactor: tf,
    demandFactor: df,
    economyFactor: ef,
    bonusFactor: bf,
    total: Math.round(distancePay * tf * df * ef * bf * loads),
  };
}

// ---------------------------------------------------------------------------------------
// Saturation (pure helpers)
// ---------------------------------------------------------------------------------------

/** Demand level after delivering `loads` into a catchment absorbing `capacity` loads/month. */
export function saturate(level: number, loads: number, capacity: number, model: EconomicModel): number {
  const drop = (SAT.dropPerCapacity * ECONOMY.models[model].saturation * loads) / Math.max(0.5, capacity);
  return Math.max(SAT.floor, level - drop);
}

/** Demand level after `days` of recovery. */
export function recover(level: number, days: number): number {
  return 1 - (1 - level) * Math.pow(0.5, days / SAT.recoveryHalfLifeDays);
}

/** Days until a demand level is back at `target` (0 if already there). */
export function daysToRecover(level: number, target = 0.9): number {
  if (level >= target) return 0;
  return (Math.log((1 - target) / (1 - level)) / Math.log(0.5)) * SAT.recoveryHalfLifeDays;
}

/**
 * Demand level a station settles at when it receives `loadsPerMonth` steadily: monthly
 * saturation drop equals monthly recovery, (1 − L)·(1 − ½^(30.4/halfLife)).
 */
export function steadyDemand(loadsPerMonth: number, capacity: number, model: EconomicModel): number {
  const drop = (SAT.dropPerCapacity * ECONOMY.models[model].saturation * loadsPerMonth) / Math.max(0.5, capacity);
  const recoverRate = 1 - Math.pow(0.5, DAYS_PER_MONTH / SAT.recoveryHalfLifeDays);
  return Math.max(SAT.floor, 1 - drop / recoverRate);
}

// ---------------------------------------------------------------------------------------
// Station supply & demand
// ---------------------------------------------------------------------------------------

export interface StationCargo {
  /** Loads waiting, by cargo id (fractional while accumulating). */
  waiting: Record<string, number>;
  /** Demand level per accepted cargo (missing = 1). */
  demand: Record<string, number>;
  /** Monthly demand-level history per cargo (newest last). */
  history: Record<string, number[]>;
  /** Loads delivered / revenue this year. */
  delivered: Record<string, number>;
  revenue: number;
  /** Revenue since the statistics last sampled it. */
  revenueSample: number;
  /** Counters for the current month and year (picked up, supplied, delivered). */
  pickedMonth: Record<string, number>;
  suppliedMonth: Record<string, number>;
  deliveredMonth: Record<string, number>;
  pickedYear: Record<string, number>;
  suppliedYear: Record<string, number>;
}

export interface StationEconomy {
  /** Loads per month, by cargo id. */
  supply: Record<string, number>;
  /** Cargo ids this station pays full price for. */
  accepts: Set<string>;
  /** Loads per month the catchment absorbs before demand drops (per accepted cargo). */
  capacity: Record<string, number>;
  /** Industries (ids) in the catchment that consume each cargo. */
  consumers: Record<string, number[]>;
  /** All industry ids in the catchment. */
  industries: number[];
  /** Towns in the catchment and the population this station serves in each. */
  towns: Array<{ cityId: number; pop: number }>;
}

function townCapacity(cargo: string, pop: number): number {
  const per = SAT.townCapacityPerThousand[cargo] ?? SAT.townCapacityPerThousand.default;
  return (pop / 1000) * per;
}

/**
 * Supply and demand of every live station, derived from catchments. Town population and
 * industry output covered by several stations are shared equally between them.
 */
export function computeStationEconomy(world: World, industryLevel: (id: number) => number): Map<number, StationEconomy> {
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
    const fx = stationEffects(st);
    const supply: Record<string, number> = {};
    const accepts = new Set<string>();
    const capacity: Record<string, number> = {};
    const consumers: Record<string, number[]> = {};
    const towns: Array<{ cityId: number; pop: number }> = [];
    for (const c of cov.cities) {
      const live = c.city.buildingIds.filter((id) => !world.buildings[id].demolished).length || 1;
      const perBuilding = c.city.population / live;
      let pop = 0;
      for (const t of c.tiles) pop += perBuilding / (buildingShare.get(t) ?? 1);
      towns.push({ cityId: c.city.id, pop });
      for (const [cargo, rate] of Object.entries(ECONOMY.townSupply)) supply[cargo] = (supply[cargo] ?? 0) + pop * rate;
      for (const cargo of ECONOMY.townDemand[c.city.classIndex] ?? []) {
        accepts.add(cargo);
        capacity[cargo] = (capacity[cargo] ?? 0) + townCapacity(cargo, pop);
      }
    }
    for (const ind of cov.industries) {
      const def = INDUSTRY_BY_ID.get(ind.defId)!;
      for (const cargo of def.consumes) {
        accepts.add(cargo);
        (consumers[cargo] ??= []).push(ind.id);
        capacity[cargo] = (capacity[cargo] ?? 0) + def.rate * SAT.industryCapacityFactor;
      }
      if (def.kind === 'raw' && def.produces.length) {
        const share = 1 / (industryShare.get(ind.id) ?? 1);
        const rate = def.rate * industryLevel(ind.id);
        for (const cargo of def.produces) supply[cargo] = (supply[cargo] ?? 0) + (rate / def.produces.length) * share;
      }
    }
    for (const cargo of Object.keys(capacity)) capacity[cargo] = Math.max(SAT.minTownCapacity, capacity[cargo]);
    for (const [cargo, f] of Object.entries(fx.supply)) if (supply[cargo]) supply[cargo] *= f;
    out.set(st.id, { supply, accepts, capacity, consumers, industries: cov.industries.map((i) => i.id), towns });
  });
  return out;
}

function emptyCargo(): StationCargo {
  return {
    waiting: {},
    demand: {},
    history: {},
    delivered: {},
    revenue: 0,
    revenueSample: 0,
    pickedMonth: {},
    suppliedMonth: {},
    deliveredMonth: {},
    pickedYear: {},
    suppliedYear: {},
  };
}

function add(rec: Record<string, number>, key: string, v: number): void {
  rec[key] = (rec[key] ?? 0) + v;
}

export interface IndustryIncome {
  industry: number;
  amount: number;
}

/**
 * Cargo flowing through stations and industries: raw supply trickles in daily; demand
 * saturates with deliveries and recovers; processing industries turn delivered inputs into
 * outputs monthly; industries grow or shrink with service; the economic cycle and (Expert)
 * cargo price levels scale payments.
 */
export class Economy {
  readonly cargo = new Map<number, StationCargo>();
  /** Input loads delivered to processing industries, waiting to be processed. */
  readonly industryStock = new Map<number, number>();
  /** Output produced by processors last month (for display). */
  readonly industryOutput = new Map<number, number>();
  /** Production multiplier of raw industries (grows with good service). */
  readonly industryLevel = new Map<number, number>();
  /** Industries owned by the player (Expert). */
  readonly owned = new Set<number>();
  /** Price index per cargo (Expert). */
  readonly priceLevel: Record<string, number> = {};
  readonly cycle: EconomicCycle;
  /** Bumped when supply-relevant data (industry levels, improvements, populations) changes. */
  private dataVersion = 0;
  private cache: { version: string; data: Map<number, StationEconomy> } | null = null;

  constructor(
    private readonly world: World,
    public model: EconomicModel,
    private readonly rng: Rng,
  ) {
    this.cycle = new EconomicCycle(rng);
    for (const c of CARGO) this.priceLevel[c.id] = 1;
  }

  invalidate(): void {
    this.dataVersion++;
  }

  levelOf(industryId: number): number {
    return this.industryLevel.get(industryId) ?? 1;
  }

  /** Supply/demand per station, recomputed when the world or economy data changes. */
  stations(): Map<number, StationEconomy> {
    const v = `${this.world.editVersion}:${this.world.stations.length}:${this.dataVersion}`;
    if (!this.cache || this.cache.version !== v) {
      this.cache = { version: v, data: computeStationEconomy(this.world, (id) => this.levelOf(id)) };
    }
    return this.cache.data;
  }

  station(id: number): StationEconomy | undefined {
    return this.stations().get(id);
  }

  cargoAt(id: number): StationCargo {
    let c = this.cargo.get(id);
    if (!c) {
      c = emptyCargo();
      this.cargo.set(id, c);
    }
    return c;
  }

  accepts(stationId: number, cargo: string): boolean {
    return this.station(stationId)?.accepts.has(cargo) ?? false;
  }

  demandLevel(stationId: number, cargo: string): number {
    return this.cargo.get(stationId)?.demand[cargo] ?? 1;
  }

  /** Cycle revenue factor × price level (Expert). */
  economyFactor(cargo: string): number {
    const price = ECONOMY.models[this.model].priceLevels ? this.priceLevel[cargo] ?? 1 : 1;
    return this.cycle.revenueFactor * price;
  }

  /** Revenue for delivering at `stationId`, with all economy factors applied. */
  quote(
    stationId: number,
    cargo: string,
    loads: number,
    tiles: number,
    days: number,
    extras: { bonus?: number; graceBonus?: number; demandLevel?: number } = {},
  ): RevenueQuote {
    const station = this.world.stations[stationId];
    const fx = stationEffects(station);
    return quoteRevenue(cargo, loads, tiles, days, this.accepts(stationId, cargo), this.model, {
      demandLevel: extras.demandLevel ?? this.demandLevel(stationId, cargo),
      economy: this.economyFactor(cargo),
      bonus: (extras.bonus ?? 1) * (fx.revenue[cargo] ?? 1),
      graceBonus: extras.graceBonus,
    });
  }

  /** Loads/month a station absorbs for a cargo before its demand drops noticeably. */
  capacityOf(stationId: number, cargo: string): number {
    return this.station(stationId)?.capacity[cargo] ?? SAT.minTownCapacity;
  }

  /** Daily: supply trickles in (capped), demand recovers. */
  daily(): void {
    const recoverStep = Math.pow(0.5, 1 / SAT.recoveryHalfLifeDays);
    for (const [id, se] of this.stations()) {
      const sc = this.cargoAt(id);
      const cap = ECONOMY.maxWaitingMonths * stationEffects(this.world.stations[id]).storage;
      for (const [cargo, perMonth] of Object.entries(se.supply)) {
        const inc = perMonth / DAYS_PER_MONTH;
        sc.waiting[cargo] = Math.min(perMonth * cap, (sc.waiting[cargo] ?? 0) + inc);
        add(sc.suppliedMonth, cargo, inc);
        add(sc.suppliedYear, cargo, inc);
      }
      for (const cargo of Object.keys(sc.demand)) {
        sc.demand[cargo] = 1 - (1 - sc.demand[cargo]) * recoverStep;
        if (sc.demand[cargo] > 0.999) delete sc.demand[cargo];
      }
    }
  }

  /** Monthly: processing, demand history, price levels, cycle, owned-industry profits. */
  monthly(day: number): IndustryIncome[] {
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
      const covering = [...stations.entries()].filter(([, se]) => se.industries.includes(ind.id));
      for (const [sid] of covering) {
        const sc = this.cargoAt(sid);
        for (const cargo of def.produces) {
          const v = out / def.produces.length / covering.length;
          add(sc.waiting, cargo, v);
          add(sc.suppliedMonth, cargo, v);
          add(sc.suppliedYear, cargo, v);
        }
      }
    }
    // Demand history for the station panel graphs.
    for (const [id, se] of stations) {
      const sc = this.cargoAt(id);
      for (const cargo of se.accepts) {
        const h = (sc.history[cargo] ??= []);
        h.push(this.demandLevel(id, cargo));
        if (h.length > SAT.historyMonths) h.shift();
      }
    }
    if (ECONOMY.models[this.model].priceLevels) {
      const P = ECONOMY.priceLevels;
      for (const c of CARGO) {
        const p = this.priceLevel[c.id] ?? 1;
        const shock = (this.rng.next() * 2 - 1) * P.volatility;
        this.priceLevel[c.id] = Math.min(P.max, Math.max(P.min, p * (1 + shock) + (1 - p) * P.reversion));
      }
    }
    this.cycle.monthly(day);
    return [...this.owned].map((id) => ({ industry: id, amount: this.industryMonthlyProfit(this.world.industries[id]) }));
  }

  /** Call after city growth has read the month's counters. */
  resetMonth(): void {
    for (const sc of this.cargo.values()) {
      sc.pickedMonth = {};
      sc.suppliedMonth = {};
      sc.deliveredMonth = {};
    }
  }

  /** Yearly: industries grow with good service; reset yearly counters. */
  yearly(): void {
    const G = ECONOMY.industryGrowth;
    const stations = this.stations();
    for (const ind of this.world.industries) {
      const def = INDUSTRY_BY_ID.get(ind.defId);
      if (!def || def.kind !== 'raw') continue;
      const covering = [...stations.entries()].filter(([, se]) => se.industries.includes(ind.id));
      const lvl = this.levelOf(ind.id);
      if (covering.length === 0) {
        this.industryLevel.set(ind.id, lvl + (1 - lvl) * 0.2);
        continue;
      }
      let ratio = 0;
      let n = 0;
      for (const [sid] of covering) {
        const sc = this.cargoAt(sid);
        for (const cargo of def.produces) {
          const supplied = sc.suppliedYear[cargo] ?? 0;
          if (supplied <= 0.5) continue;
          ratio += Math.min(1, (sc.pickedYear[cargo] ?? 0) / supplied);
          n++;
        }
      }
      ratio = n ? ratio / n : 0;
      if (ratio >= G.servedRatio) this.industryLevel.set(ind.id, Math.min(G.max, lvl * (1 + G.growth)));
      else if (ratio < G.neglectRatio) this.industryLevel.set(ind.id, Math.max(G.min, lvl * (1 - G.decline)));
    }
    for (const sc of this.cargo.values()) {
      sc.delivered = {};
      sc.revenue = 0;
      sc.pickedYear = {};
      sc.suppliedYear = {};
    }
    this.invalidate();
  }

  /** Take up to `max` whole loads of a cargo from a station. */
  take(stationId: number, cargo: string, max: number): number {
    const sc = this.cargoAt(stationId);
    const have = Math.floor((sc.waiting[cargo] ?? 0) + 1e-9);
    const n = Math.max(0, Math.min(have, max));
    if (n > 0) {
      sc.waiting[cargo] = (sc.waiting[cargo] ?? 0) - n;
      add(sc.pickedMonth, cargo, n);
      add(sc.pickedYear, cargo, n);
    }
    return n;
  }

  /** Record a delivery: saturate demand and feed processing industries that use the cargo. */
  deliver(stationId: number, cargo: string, loads: number, revenue: number): void {
    const sc = this.cargoAt(stationId);
    add(sc.delivered, cargo, loads);
    add(sc.deliveredMonth, cargo, loads);
    sc.revenue += revenue;
    sc.revenueSample += revenue;
    const se = this.station(stationId);
    const capacity = se?.capacity[cargo] ?? SAT.minTownCapacity;
    sc.demand[cargo] = saturate(sc.demand[cargo] ?? 1, loads, capacity, this.model);
    const consumers = se?.consumers[cargo] ?? [];
    for (const id of consumers) {
      const def = INDUSTRY_BY_ID.get(this.world.industries[id].defId);
      if (def?.kind !== 'processor') continue;
      this.industryStock.set(id, (this.industryStock.get(id) ?? 0) + loads / consumers.length);
    }
  }

  // -- industry ownership (Expert) ------------------------------------------------------------

  /** Loads an industry turns out per month at the moment. */
  industryOutputPerMonth(ind: Industry): number {
    const def = INDUSTRY_BY_ID.get(ind.defId);
    if (!def) return 0;
    if (def.kind === 'raw') return def.rate * this.levelOf(ind.id);
    const needInputs = ECONOMY.models[this.model].processorsNeedInputs;
    return this.industryOutput.get(ind.id) ?? (needInputs ? 0 : ECONOMY.processorWithoutInputs);
  }

  /** Owner's monthly profit at the current output (or at `output` loads/month). */
  industryMonthlyProfit(ind: Industry, output?: number): number {
    const def = INDUSTRY_BY_ID.get(ind.defId);
    if (!def || def.produces.length === 0) return -ECONOMY.ownership.upkeepPerYear / 12;
    const O = ECONOMY.ownership;
    const out = output ?? this.industryOutputPerMonth(ind);
    let gross = 0;
    for (const cargo of def.produces) {
      const c = CARGO_BY_ID.get(cargo);
      if (c) gross += (out / def.produces.length) * c.base * O.marginFraction * this.economyFactor(cargo);
    }
    return gross - O.upkeepPerYear / 12;
  }

  industryPrice(ind: Industry): number {
    const O = ECONOMY.ownership;
    const def = INDUSTRY_BY_ID.get(ind.defId);
    const capacity = def ? def.rate * (def.kind === 'raw' ? this.levelOf(ind.id) : 1) : 0;
    const value = Math.max(this.industryMonthlyProfit(ind), O.potentialShare * this.industryMonthlyProfit(ind, capacity));
    return Math.round(Math.max(O.minPrice, value * 12 * O.priceYears) / 1000) * 1000;
  }
}
