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
export const COMPANY = companyJson as { startingCash: number; names: string[] };
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
}
