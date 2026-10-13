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

export type TerrainName = 'water' | 'sand' | 'grass' | 'forest' | 'rough' | 'snow';

export interface CargoDef {
  id: string;
  name: string;
  unit: string;
  color: string;
  decay: 'none' | 'slow' | 'medium' | 'fast';
  group: string;
  era: [number, number];
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
  if (TIME.monthDays.length !== 12 || TIME.monthNames.length !== 12) throw new Error('time.json needs 12 months');
}
