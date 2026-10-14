import { BUILDINGS, ECONOMY, INDUSTRIES, MAPGEN, type BuildingDef } from '../data';
import type { Economy } from './economy';
import { canPlaceIndustry } from './mapgen';
import type { Rng } from './rng';
import { F, OCC_BUILDING, OCC_INDUSTRY, T, World, encodeOccupant, type City, type Industry } from './world';

const G = ECONOMY.cityGrowth;

export interface GrowthReport {
  cityId: number;
  before: number;
  after: number;
  /** Annual growth rate used this month. */
  rate: number;
  classUp: boolean;
  newBuildings: number;
  newIndustry: Industry | null;
}

/** Town-level service figures for the month (also shown in the town inspector). */
export interface TownService {
  /** Share of the town's passengers & mail picked up, relative to the target (0–1). */
  service: number;
  /** Demanded freight delivered, relative to the target (0–1). */
  supplied: number;
}

/** How well the railway served each town this month, from station counters. */
export function townService(world: World, economy: Economy): Map<number, TownService> {
  const out = new Map<number, TownService>();
  const passengerCargo = Object.keys(ECONOMY.townSupply);
  const picked = new Map<number, number>();
  const delivered = new Map<number, number>();
  for (const [sid, se] of economy.stations()) {
    const total = se.towns.reduce((s, t) => s + t.pop, 0);
    if (total <= 0) continue;
    const sc = economy.cargoAt(sid);
    const p = passengerCargo.reduce((s, c) => s + (sc.pickedMonth[c] ?? 0), 0);
    for (const t of se.towns) {
      const share = t.pop / total;
      picked.set(t.cityId, (picked.get(t.cityId) ?? 0) + p * share);
      const city = world.cities[t.cityId];
      const wants = (ECONOMY.townDemand[city.classIndex] ?? []).filter((c) => !passengerCargo.includes(c));
      const d = wants.reduce((s, c) => s + (sc.deliveredMonth[c] ?? 0), 0);
      delivered.set(t.cityId, (delivered.get(t.cityId) ?? 0) + d * share);
    }
  }
  const perPerson = passengerCargo.reduce((s, c) => s + ECONOMY.townSupply[c], 0);
  for (const city of world.cities) {
    const supply = city.population * perPerson;
    const service = supply > 0 ? Math.min(1, (picked.get(city.id) ?? 0) / supply / G.serviceTarget) : 0;
    const target = ((city.population / 1000) * G.supplyTargetPerThousandPerYear) / 12;
    const supplied = target > 0 ? Math.min(1, (delivered.get(city.id) ?? 0) / target) : 0;
    out.set(city.id, { service, supplied });
  }
  return out;
}

function peoplePerBuilding(classIndex: number): number {
  return MAPGEN.cities.classes[classIndex].peoplePerBuilding;
}

/** Tiles growth must leave alone (e.g. ones a pending undo would restore). */
const NONE: ReadonlySet<number> = new Set();

function canBuildHere(world: World, x: number, y: number, blocked: ReadonlySet<number>): boolean {
  if (!world.inBounds(x, y)) return false;
  const i = world.tileIndex(x, y);
  if (blocked.has(i)) return false;
  if (world.terrain[i] === T.Water || world.flags[i] & (F.River | F.Road)) return false;
  if (world.occupant[i] !== 0 || world.track.getIdx(i)) return false;
  return world.tileSlope(x, y) === 0 && world.tileMinH(x, y) >= 1;
}

function chooseDef(rng: Rng, city: City, ring: number, world: World): BuildingDef | null {
  const has = new Set(city.buildingIds.map((id) => world.buildings[id].defId));
  const options = BUILDINGS.filter((b) => b.minClass <= city.classIndex && ring >= b.ring[0] && ring <= b.ring[1] + 0.15 && !(b.unique && has.has(b.id)));
  return options.length ? rng.weighted(options, (b) => b.weight) : null;
}

/** Add one building on a free flat lot near the centre. Returns false if there is no room. */
export function addBuilding(world: World, city: City, rng: Rng, blocked: ReadonlySet<number> = NONE): boolean {
  const R = city.radius + 3;
  const lots: Array<{ x: number; y: number; d: number }> = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx % 4 === 0 || dy % 4 === 0) continue; // keep the street grid clear
      const x = city.x + dx;
      const y = city.y + dy;
      if (!canBuildHere(world, x, y, blocked)) continue;
      lots.push({ x, y, d: Math.hypot(dx, dy) });
    }
  }
  if (lots.length === 0) return false;
  lots.sort((a, b) => a.d - b.d);
  const lot = lots[rng.int(0, Math.min(5, lots.length - 1))];
  const def = chooseDef(rng, city, lot.d / Math.max(1, city.radius + 1), world);
  if (!def) return false;
  const sizeBoost = def.id === 'tower' || def.id === 'office' ? 1 + city.classIndex * 0.15 : 1;
  const id = world.buildings.length;
  world.buildings.push({
    id,
    cityId: city.id,
    x: lot.x,
    y: lot.y,
    defId: def.id,
    wall: rng.pick(def.walls),
    roof: rng.pick(def.roofs),
    h: Math.round(def.h * sizeBoost * (1 + rng.next() * def.jitter)),
    pair: rng.chance(def.pairChance),
  });
  city.buildingIds.push(id);
  const ti = world.tileIndex(lot.x, lot.y);
  world.occupant[ti] = encodeOccupant(OCC_BUILDING, id);
  world.flags[ti] &= ~F.Tree;
  if (world.terrain[ti] === T.Forest || world.terrain[ti] === T.Rough) world.terrain[ti] = T.Grass;
  city.radius = Math.max(city.radius, Math.ceil(lot.d));
  world.markDirty(ti);
  return true;
}

/** Try to open a new processing industry near a town that just grew a size class. */
export function spawnIndustryNear(world: World, city: City, year: number, rng: Rng, blocked: ReadonlySet<number> = NONE): Industry | null {
  const defs = INDUSTRIES.filter((d) => d.kind === 'processor' && year >= d.era[0] && year <= d.era[1]);
  if (defs.length === 0) return null;
  for (let attempt = 0; attempt < 300; attempt++) {
    const def = rng.pick(defs);
    const r = city.radius + 4 + rng.int(0, 10);
    const x = city.x + rng.int(-r, r);
    const y = city.y + rng.int(-r, r);
    if (!world.inBounds(x, y) || !world.inBounds(x + def.size[0], y + def.size[1])) continue;
    if (!canPlaceIndustry(world, def, x, y)) continue;
    // Runtime placement never reshapes terrain (track may rely on it): the lot must be flat.
    let flat = true;
    const h0 = world.vh(x, y);
    for (let vy = y; vy <= y + def.size[1] && flat; vy++) for (let vx = x; vx <= x + def.size[0]; vx++) if (world.vh(vx, vy) !== h0) flat = false;
    for (let dy = -1; dy <= def.size[1] && flat; dy++) for (let dx = -1; dx <= def.size[0]; dx++) {
        if (world.track.has(x + dx, y + dy) || (world.inBounds(x + dx, y + dy) && blocked.has(world.tileIndex(x + dx, y + dy)))) flat = false;
      }
    if (!flat) continue;
    const id = world.industries.length;
    const ind: Industry = { id, defId: def.id, name: `${city.name} ${def.name}`, x, y, w: def.size[0], h: def.size[1], cityId: city.id };
    world.industries.push(ind);
    for (let dy = 0; dy < def.size[1]; dy++) {
      for (let dx = 0; dx < def.size[0]; dx++) {
        const ti = world.tileIndex(x + dx, y + dy);
        world.occupant[ti] = encodeOccupant(OCC_INDUSTRY, id);
        world.flags[ti] &= ~F.Tree;
        world.markDirty(ti);
      }
    }
    return ind;
  }
  return null;
}

/**
 * Monthly town growth: natural growth plus bonuses for good passenger service and for
 * delivered goods, scaled by the economic cycle. Growing towns add buildings, move up a
 * size class (unlocking new demands) and may attract a new industry.
 */
export function monthlyCityGrowth(world: World, economy: Economy, rng: Rng, year: number, blocked: ReadonlySet<number> = NONE): GrowthReport[] {
  const service = townService(world, economy);
  const reports: GrowthReport[] = [];
  const classes = MAPGEN.cities.classes;
  for (const city of world.cities) {
    const s = service.get(city.id) ?? { service: 0, supplied: 0 };
    const rate = (G.naturalPerYear + G.serviceBonusPerYear * s.service + G.supplyBonusPerYear * s.supplied) * economy.cycle.growthFactor;
    city.growth = rate;
    city.service = s.service;
    city.supplied = s.supplied;
    const before = city.population;
    city.population = before * (1 + rate / 12);
    let classUp = false;
    while (city.classIndex + 1 < classes.length && city.population >= classes[city.classIndex + 1].popMin) {
      city.classIndex++;
      classUp = true;
    }
    const live = city.buildingIds.filter((id) => !world.buildings[id].demolished).length;
    const target = Math.ceil(city.population / peoplePerBuilding(city.classIndex));
    let built = 0;
    while (live + built < target && built < G.maxNewBuildingsPerMonth && addBuilding(world, city, rng, blocked)) built++;
    let newIndustry: Industry | null = null;
    if (classUp && rng.chance(G.newIndustryChanceOnClassUp)) newIndustry = spawnIndustryNear(world, city, year, rng, blocked);
    if (built || classUp || newIndustry || Math.floor(before / 100) !== Math.floor(city.population / 100)) {
      reports.push({ cityId: city.id, before, after: city.population, rate, classUp, newBuildings: built, newIndustry });
    }
  }
  return reports;
}
