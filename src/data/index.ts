/**
 * Typed access to the JSON data files. All balancing/tuning values live in the JSON; this
 * module only declares their shapes and performs light validation at import time.
 */
import cargoJson from './cargo.json';
import industriesJson from './industries.json';
import buildingsJson from './buildings.json';
import mapgenJson from './mapgen.json';
import namesJson from './names.json';
import timeJson from './time.json';
import constructionJson from './construction.json';
import stationsJson from './stations.json';
import companyJson from './company.json';
import enginesJson from './engines.json';
import carsJson from './cars.json';
import economyJson from './economy.json';
import financeJson from './finance.json';
import aiJson from './ai.json';
import advisorJson from './advisor.json';
import eventsJson from './events.json';
import managersJson from './managers.json';
import territoriesJson from './territories.json';
import scenariosJson from './scenarios.json';
import mapsJson from './maps.json';

export type TerrainName = 'water' | 'sand' | 'grass' | 'forest' | 'rough' | 'snow';

export interface CargoDef {
  id: string;
  name: string;
  unit: string;
  color: string;
  decay: 'none' | 'slow' | 'medium' | 'fast';
  group: string;
  era: [number, number];
  /** Revenue per load: base + perMile × miles (before time/demand factors). */
  base: number;
  perMile: number;
  /** Weight of one carload in tons. */
  tons: number;
  /** Car type id that carries it. */
  car: string;
}

export interface CarDef {
  id: string;
  name: string;
  tare: number;
  price: number;
  shape: 'coach' | 'closed' | 'open' | 'tank' | 'flat' | 'slatted' | 'caboose';
  body: string;
  roof: string;
  trim: string;
  /** Extras (caboose, dining car): revenue/breakdown multipliers. */
  bonus?: { freight?: number; passengers?: number; breakdown?: number };
}

export interface ImprovementDef {
  id: string;
  name: string;
  cost: number;
  upkeep: number;
  requires?: string;
  desc: string;
  effects: {
    dwell?: number;
    adhesion?: number;
    breakdown?: number;
    maintenance?: number;
    revenue?: Record<string, number>;
    supply?: Record<string, number>;
    storage?: number;
    fresh?: number;
  };
}

export interface CycleStateDef {
  id: string;
  name: string;
  revenue: number;
  growth: number;
  confidence: number;
  symbol: string;
}

export interface EngineDef {
  id: string;
  name: string;
  era: [number, number];
  price: number;
  power: number;
  weight: number;
  adhesion: number;
  topSpeed: number;
  fuel: 'wood' | 'coal' | 'diesel' | 'electric';
  reliability: number;
  maintenance: number;
  fuelBase: number;
  fuelPerTon: number;
  maxCars: number;
  lifespan: number;
  look: { body: string; trim: string; size: number; diesel?: boolean };
}

export type EconomicModel = 'basic' | 'advanced' | 'expert';

export interface EconomyData {
  model: EconomicModel;
  models: Record<
    EconomicModel,
    { name: string; nonDemandedFactor: number; processorsNeedInputs: boolean; saturation: number; priceLevels: boolean; buyIndustries: boolean; desc: string }
  >;
  saturation: {
    townCapacityPerThousand: Record<string, number>;
    minTownCapacity: number;
    industryCapacityFactor: number;
    dropPerCapacity: number;
    recoveryHalfLifeDays: number;
    floor: number;
    historyMonths: number;
  };
  cycle: {
    states: CycleStateDef[];
    start: string;
    transitions: Record<string, Record<string, number>>;
    durationMonths: [number, number];
    warningMonths: [number, number];
    confidenceNoise: number;
    headlines: { better: string[]; worse: string[]; same: string[] };
  };
  priceLevels: { volatility: number; reversion: number; min: number; max: number };
  cityGrowth: {
    naturalPerYear: number;
    serviceBonusPerYear: number;
    supplyBonusPerYear: number;
    serviceTarget: number;
    supplyTargetPerThousandPerYear: number;
    maxNewBuildingsPerMonth: number;
    newIndustryChanceOnClassUp: number;
  };
  industryGrowth: { servedRatio: number; growth: number; neglectRatio: number; decline: number; min: number; max: number };
  ownership: { marginFraction: number; upkeepPerYear: number; priceYears: number; potentialShare: number; minPrice: number; sellFraction: number };
  improvements: ImprovementDef[];
  serviceDays: number;
  townSupply: Record<string, number>;
  townDemand: string[][];
  processorWithoutInputs: number;
  maxWaitingMonths: number;
  timeValue: { idealMph: number; halfLifeDays: Record<string, number>; graceDays: number; minFactor: number };
  loading: { hoursPerLoad: number; minDwellHours: number; maxWaitDays: number };
  platforms: Record<string, number>;
  fuelPrice: Record<string, number>;
  trackMaintenance: { perTileYear: number; doubleFactor: number; bridgeFactor: number; tunnelFactor: number; stationPerYear: Record<string, number> };
  engineWear: { maintenancePerYearOfAge: number };
  breakdowns: { perDayAtReference: number; referenceReliability: number; ageExponent: number; repairDays: [number, number]; repairCostFraction: number };
  wrecks: { enabledByDefault: boolean; perTileAtLifespan: number; ageExponent: number; overweightBridgeFactor: number };
  resale: { newFraction: number; perYear: number; floor: number };
  physics: {
    tilesPerTickPerMph: number;
    physicsSecondsPerTick: number;
    brakeMphPerTick: number;
    rollingLbfPerTon: [number, number, number];
    gradeLbfPerTonPercent: number;
    adhesionCoefficient: number;
    stationApproachMph: number;
    overweightBridgeMph: number;
    carLength: number;
    engineLength: number;
    /** Steam engines pull a tender of this length behind the loco. */
    tenderLength: number;
  };
}

export interface LookPart {
  t: 'box' | 'pile' | 'tree' | 'fence' | 'dots' | 'derrick';
  x: number;
  y: number;
  w?: number;
  d?: number;
  h?: number;
  z?: number;
  wall?: string;
  roof?: string;
  roofType?: 'flat' | 'gableX' | 'gableY' | 'pyramid';
  roofH?: number;
  windows?: string;
  smoke?: boolean;
  c?: string;
  c2?: string;
  n?: number;
}

export interface IndustryLook {
  /** Ground ramp [dark, mid, light] palette names. */
  ground: [string, string, string];
  /** Optional crop-row stripes [a, b]. */
  field?: [string, string];
  parts: LookPart[];
}

export interface IndustryDef {
  id: string;
  name: string;
  kind: 'raw' | 'processor';
  produces: string[];
  consumes: string[];
  era: [number, number];
  size: [number, number];
  /** Expected count per 10,000 land tiles. */
  density: number;
  placement: {
    terrain: TerrainName[];
    minHeight?: number;
    maxHeight?: number;
    /** [min, max] tile distance to nearest city centre. */
    nearCity?: [number, number];
    /** Minimum distance to another industry of the same type. */
    spacing: number;
  };
  look: IndustryLook;
  /** Loads per month (raw) or maximum output per month (processor). */
  rate: number;
}

export interface BuildingDef {
  id: string;
  minClass: number;
  ring: [number, number];
  weight: number;
  w: number;
  d: number;
  h: number;
  jitter: number;
  roofType: 'flat' | 'gable';
  roofH: number;
  walls: string[];
  roofs: string[];
  windows: string | null;
  steeple?: number;
  unique?: boolean;
  pairChance: number;
}

export interface CityClassDef {
  id: string;
  name: string;
  weight: number;
  popMin: number;
  popMax: number;
  peoplePerBuilding: number;
}

export type WaterSetting = 'none' | 'low' | 'normal' | 'high';
export type HillSetting = 'flat' | 'normal' | 'mountainous';
export type DensitySetting = 'few' | 'normal' | 'many';

export interface MapgenData {
  maxHeight: number;
  sizes: number[];
  startYears: [number, number];
  defaults: {
    size: number;
    water: WaterSetting;
    hills: HillSetting;
    forests: DensitySetting;
    cities: DensitySetting;
    startYear: number;
  };
  noise: { baseScale: number; octaves: number; lacunarity: number; gain: number };
  edgeFalloff: { width: number; strength: number };
  water: Record<WaterSetting, number>;
  hills: Record<HillSetting, { exponent: number; range: number }>;
  moisture: { scale: number; octaves: number };
  forests: Record<DensitySetting, number>;
  scatteredTreeChance: number;
  rockHeight: number;
  snowHeight: number;
  beachMaxHeight: number;
  rivers: { perTenThousandTiles: number; minSourceHeight: number; minLength: number; maxLength: number };
  cities: {
    perTenThousandTiles: Record<DensitySetting, number>;
    minSpacing: number;
    areaPerMetropolis: number;
    maxHeightFraction: number;
    classes: CityClassDef[];
  };
  industries: { densityScale: number; minGap: number };
}

export interface NamesData {
  prefixes: string[];
  suffixes: string[];
  coastalPrefixes: string[];
  riverSuffixes: string[];
  bigCitySuffixes: string[];
  hillSuffixes: string[];
}

export interface TimeData {
  ticksPerDay: number;
  realMsPerDayAtSpeed1: number;
  speeds: number[];
  maxTicksPerFrame: number;
  monthNames: string[];
  monthDays: number[];
}

export const CARGO: CargoDef[] = cargoJson.cargo as CargoDef[];
export const INDUSTRIES: IndustryDef[] = industriesJson.industries as unknown as IndustryDef[];
export const BUILDINGS: BuildingDef[] = buildingsJson.buildings as unknown as BuildingDef[];
export const MAPGEN: MapgenData = mapgenJson as unknown as MapgenData;
export const NAMES: NamesData = namesJson as NamesData;
export const TIME: TimeData = timeJson as TimeData;

export interface BridgeDef {
  id: string;
  name: string;
  perTile: number;
  perLevel: number;
  maxSpan: number;
  speedLimit: number;
  weightLimit: number;
  era: [number, number];
}

export interface ConstructionData {
  feetPerLevel: number;
  feetPerTile: number;
  track: {
    single: number;
    doubleExtra: number;
    terrain: Record<TerrainName, number>;
    clearForest: number;
    perLevelClimb: number;
    levelCrossing: number;
    bulldozePerTile: number;
    demolish: Record<string, number>;
  };
  planner: { gradeAvoidance: number; turnPenalty: number; reusePerTile: number; maxExpansions: number; heuristicWeight: number };
  bridges: BridgeDef[];
  tunnel: { perTile: number; maxLength: number; minCover: number; maxGradeLevelsPerTile: number };
  undo: { maxActions: number; windowDays: number };
}

export interface StationLook {
  w: number;
  l: number;
  h: number;
  wall: string;
  roof: string;
  tower?: number;
}

export interface StationDef {
  id: 'depot' | 'station' | 'terminal';
  name: string;
  length: number;
  radius: number;
  cost: number;
  look: StationLook;
}

export const CONSTRUCTION: ConstructionData = constructionJson as unknown as ConstructionData;
export const STATIONS: StationDef[] = stationsJson.stations as StationDef[];
export const STATION_NAME_SUFFIXES: string[] = stationsJson.nameSuffixes;
export const COMPANY = companyJson as { names: string[] };

export interface RatingDef {
  id: string;
  maxLeverage: number;
  spread: number;
}

export interface FinanceData {
  shares: {
    initial: number;
    ipoPrice: number;
    chairmanFraction: number;
    chairmanFortune: number;
    blockFraction: number;
    issueDiscount: number;
    buybackPremium: number;
    minMonthsBetweenIssues: number;
    splitMinPrice: number;
    impact: number;
    roundLot: number;
  };
  stock: {
    bookWeight: number;
    peByState: Record<string, number>;
    lossWeight: number;
    dividendMultiple: number;
    moodPerConfidence: number;
    reversion: number;
    volatility: number;
    profitSmoothing: number;
    minPrice: number;
    dailyHistory: number;
    weeklyHistory: number;
  };
  bonds: {
    block: number;
    termYears: number;
    baseRate: Record<string, number>;
    ratings: RatingDef[];
    coverageNotches: Array<[number, number]>;
    emergencyPenalty: number;
  };
  dividends: { months: number[]; step: number };
  accounting: { infrastructureDepreciation: number; chairmanSalaryPerYear: number };
  margin: { initial: number; maintenance: number; interestSpread: number; commission: number };
}

export const FINANCE: FinanceData = financeJson as unknown as FinanceData;

export type PersonalityId = 'builder' | 'expander' | 'speculator';
export type AiLevel = 'relaxed' | 'normal' | 'ruthless';

export interface PersonalityDef {
  name: string;
  desc: string;
  buildEveryMonths: number;
  cashReserve: number;
  maxRatingIndex: number;
  trainsPerRoute: number;
  maxTrainsPerRoute: number;
  routeTiles: [number, number];
  competition: number;
  dividendPayout: number;
  stock: { ownStake: number; buyBelow: number; sellAbove: number; short: boolean; shortAbove: number; raid: boolean; mergeAtStake: number };
}

export interface AiData {
  barons: Array<{ name: string; company: string; ticker: string; color: string; personality: PersonalityId }>;
  personalities: Record<PersonalityId, PersonalityDef>;
  levels: Record<AiLevel, { name: string; build: number; trade: number }>;
  merger: { premium: number; minStake: number; cooldownMonths: number; publicBase: number; publicPerPremium: number; badYearBonus: number };
  board: { graceYears: number; publicBase: number; perPriceChange: number; profitBonus: number; lossPenalty: number; warnBelow: number };
  bankruptcy: { monthsInsolvent: number };
}

export const AI: AiData = aiJson as unknown as AiData;
export interface AdvisorData {
  waitingLoads: number;
  lowLoadFactor: number;
  minDepartures: number;
  losingMonths: number;
  signalWaitDays: number;
  saturatedDemand: number;
  lowCash: number;
  badRatingIndex: number;
  rivalStakeNotice: number;
  confidenceDrop: number;
  maxItems: number;
}
export const ADVISOR: AdvisorData = advisorJson as AdvisorData;

/** What an event or a manager changes (see sim/modifiers.ts). */
export interface ModifierSpec {
  revenue?: Record<string, number>;
  supply?: Record<string, number>;
  construction?: number;
  fuel?: number;
  maintenance?: number;
  breakdowns?: number;
  interest?: number;
  growth?: number;
  goodwill?: number;
  /** Added to business confidence once, when the event starts. */
  confidence?: number;
}

export interface EventDef {
  id: string;
  name: string;
  era: [number, number];
  chancePerYear: number;
  /** [min, max] months; [0, 0] = permanent technology. */
  months: [number, number];
  tone: number;
  headline: string;
  effects: ModifierSpec;
}
export const EVENTS = eventsJson as unknown as { cooldownMonths: number; events: EventDef[] };

export interface ManagerDef {
  id: string;
  name: string;
  title: string;
  salary: number;
  desc: string;
  effects: ModifierSpec;
}
export const MANAGERS = managersJson as unknown as { fee: number; offered: number; managers: ManagerDef[] };
export interface TerritoriesData {
  tilesPerRegion: number;
  minRegions: number;
  maxRegions: number;
  restrictedShare: number;
  start: number;
  charterGoodwill: number;
  charterFee: number;
  costAt0: number;
  costAt100: number;
  perServedStation: number;
  perRevenue: number;
  revenueCap: number;
  idleStation: number;
  drift: number;
  perDemolished: number;
  bulldozedStation: number;
  wreck: number;
  names: string[];
}
export const TERRITORIES = territoriesJson as TerritoriesData;

/** A point in map fractions: [0, 0] is the north-west corner, [1, 1] the south-east. */
export type MapPoint = [number, number];
/** Terrain features of a hand-made map. Positions and sizes are fractions of the map size. */
export type MapFeature =
  | { type: 'sea'; edge: 'north' | 'south' | 'east' | 'west'; at: number; wobble?: number }
  | { type: 'lake'; x: number; y: number; rx: number; ry?: number; wobble?: number }
  | { type: 'ridge'; path: MapPoint[]; width: number; height: number; jagged?: number }
  | { type: 'hills'; x: number; y: number; r: number; height: number }
  | { type: 'plain'; x: number; y: number; r: number; height: number }
  | { type: 'river'; path: MapPoint[]; valley?: number }
  | { type: 'forest'; x: number; y: number; r: number; amount: number }
  | { type: 'desert'; x: number; y: number; r: number };
export type TownSize = 'village' | 'town' | 'city' | 'metropolis';
export interface MapLayoutDef {
  id: string;
  name: string;
  desc: string;
  /** Default size (sandbox); scenarios may pick another. */
  size: number;
  /** Base land elevation (0–1), noise amplitude and height exponent. */
  land?: number;
  roughness?: number;
  exponent?: number;
  features: MapFeature[];
  /** Extra random rivers. */
  rivers?: number;
  towns: Array<{ name: string; x: number; y: number; size: TownSize; pop?: number }>;
  /** Random villages and towns added between the named ones. */
  extraTowns?: number;
  industries?: Array<{ type: string; x: number; y: number }>;
  /** Density of random industries on top of the fixed ones (1 = like a random map). */
  randomIndustries?: number;
}
export const MAPS: MapLayoutDef[] = (mapsJson as unknown as { maps: MapLayoutDef[] }).maps;
export const MAP_BY_ID: ReadonlyMap<string, MapLayoutDef> = new Map(MAPS.map((m) => [m.id, m]));

export type ScenarioMetric = 'bookValue' | 'netWorth' | 'bestYearRevenue' | 'cargoLoads' | 'rank';
export interface ScenarioDef {
  id: string;
  name: string;
  tutorial?: boolean;
  brief: string;
  /** Difficulty shown in the scenario list. */
  difficulty: 'easy' | 'medium' | 'hard';
  /** Map parameters; missing ones take the defaults (and a hand-made map's own size). */
  map: {
    seed: number;
    startYear: number;
    size?: number;
    water?: WaterSetting;
    hills?: HillSetting;
    forests?: DensitySetting;
    cities?: DensitySetting;
    layout?: string;
  };
  settings: { rivals?: number; aiLevel?: AiLevel; friendlyAi?: boolean; model?: EconomicModel; charters?: boolean; wrecks?: boolean; boardVotes?: boolean };
  years: number;
  goal: { metric: ScenarioMetric; label: string; tiers: [number, number, number]; cargos?: string[]; goldNetWorth?: number };
  /** Towns by population rank (number) or by name (hand-made maps). */
  requires: Array<{ type: 'connect'; a: number | string; b: number | string }>;
}
export const SCENARIOS: ScenarioDef[] = (scenariosJson as unknown as { scenarios: ScenarioDef[] }).scenarios;
export const MANAGER_BY_ID: ReadonlyMap<string, ManagerDef> = new Map(MANAGERS.managers.map((m) => [m.id, m]));
export const STATION_BY_ID: ReadonlyMap<string, StationDef> = new Map(STATIONS.map((s) => [s.id, s]));

export const ENGINES: EngineDef[] = enginesJson.engines as EngineDef[];
export const CARS: CarDef[] = carsJson.cars as CarDef[];
export const ECONOMY: EconomyData = economyJson as unknown as EconomyData;
export const ENGINE_BY_ID: ReadonlyMap<string, EngineDef> = new Map(ENGINES.map((e) => [e.id, e]));
export const CAR_BY_ID: ReadonlyMap<string, CarDef> = new Map(CARS.map((c) => [c.id, c]));

export const IMPROVEMENTS: ImprovementDef[] = (economyJson as unknown as EconomyData).improvements;
export const IMPROVEMENT_BY_ID: ReadonlyMap<string, ImprovementDef> = new Map(IMPROVEMENTS.map((i) => [i.id, i]));

export const CARGO_BY_ID: ReadonlyMap<string, CargoDef> = new Map(CARGO.map((c) => [c.id, c]));
export const INDUSTRY_BY_ID: ReadonlyMap<string, IndustryDef> = new Map(INDUSTRIES.map((d) => [d.id, d]));

/** Throws if data files reference unknown ids. Called by tests and at startup. */
export function validateData(): void {
  for (const ind of INDUSTRIES) {
    for (const c of [...ind.produces, ...ind.consumes]) {
      if (!CARGO_BY_ID.has(c)) throw new Error(`Industry ${ind.id} references unknown cargo ${c}`);
    }
    if (ind.size[0] < 1 || ind.size[1] < 1 || ind.size[0] > 3 || ind.size[1] > 3) {
      throw new Error(`Industry ${ind.id} has unsupported footprint ${ind.size}`);
    }
  }
  for (const c of CARGO) if (!CAR_BY_ID.has(c.car)) throw new Error(`Cargo ${c.id} uses unknown car ${c.car}`);
  for (const lvl of ECONOMY.townDemand) for (const c of lvl) if (!CARGO_BY_ID.has(c)) throw new Error(`Town demand references unknown cargo ${c}`);
  for (const c of Object.keys(ECONOMY.townSupply)) if (!CARGO_BY_ID.has(c)) throw new Error(`Town supply references unknown cargo ${c}`);
  for (const e of ENGINES) if (!(e.fuel in ECONOMY.fuelPrice)) throw new Error(`Engine ${e.id} has unpriced fuel ${e.fuel}`);
  const states = new Set(ECONOMY.cycle.states.map((st) => st.id));
  for (const [from, to] of Object.entries(ECONOMY.cycle.transitions)) {
    if (!states.has(from)) throw new Error(`Cycle transition from unknown state ${from}`);
    for (const t of Object.keys(to)) if (!states.has(t)) throw new Error(`Cycle transition to unknown state ${t}`);
  }
  for (const imp of IMPROVEMENTS) if (imp.requires && !IMPROVEMENT_BY_ID.has(imp.requires)) throw new Error(`Improvement ${imp.id} requires unknown ${imp.requires}`);
  if (TIME.monthDays.length !== 12 || TIME.monthNames.length !== 12) throw new Error('time.json needs 12 months');
  for (const st of states) {
    if (!(st in FINANCE.stock.peByState)) throw new Error(`finance.json: no P/E for economic state ${st}`);
    if (!(st in FINANCE.bonds.baseRate)) throw new Error(`finance.json: no base rate for economic state ${st}`);
  }
  const townSizes = MAPGEN.cities.classes.map((c) => c.id);
  for (const m of MAPS) {
    for (const t of m.towns) if (!townSizes.includes(t.size)) throw new Error(`maps.json: ${m.id} town ${t.name} has unknown size ${t.size}`);
    for (const i of m.industries ?? []) if (!INDUSTRY_BY_ID.has(i.type)) throw new Error(`maps.json: ${m.id} uses unknown industry ${i.type}`);
  }
  for (const sc of SCENARIOS) {
    const layout = sc.map.layout ? MAP_BY_ID.get(sc.map.layout) : undefined;
    if (sc.map.layout && !layout) throw new Error(`scenarios.json: ${sc.id} uses unknown map ${sc.map.layout}`);
    for (const r of sc.requires) {
      for (const t of [r.a, r.b]) {
        if (typeof t === 'string' && !layout?.towns.some((x) => x.name === t)) throw new Error(`scenarios.json: ${sc.id} needs unknown town ${t}`);
      }
    }
  }
  const lev = FINANCE.bonds.ratings.map((r) => r.maxLeverage);
  if (lev.some((v, i) => i > 0 && v <= lev[i - 1])) throw new Error('finance.json: rating leverage limits must increase');
}
