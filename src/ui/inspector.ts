import { BUILDINGS, CARGO_BY_ID, INDUSTRY_BY_ID, MAPGEN } from '../data';
import { PALETTE, type PaletteName } from '../render/palette';
import {
  F,
  OCC_BUILDING,
  OCC_INDUSTRY,
  TERRAIN_LABELS,
  occupantIndex,
  occupantKind,
  type City,
  type Industry,
  type World,
} from '../sim/world';
import { esc, fmtInt } from './dom';

/** Feet per height level, for display only. */
export const FEET_PER_LEVEL = 80;

const BUILDING_LABEL: Record<string, string> = {
  cottage: 'Cottages',
  house: 'House',
  rowhouses: 'Row houses',
  shop: 'Shops',
  church: 'Church',
  office: 'Offices',
  tower: 'Tower block',
};

export interface Inspection {
  title: string;
  kind: 'terrain' | 'city' | 'industry';
  /** Tile rect to highlight [x, y, w, h]. */
  rect: [number, number, number, number];
  html: string;
}

function cargoChip(id: string): string {
  const c = CARGO_BY_ID.get(id);
  if (!c) return esc(id);
  const color = PALETTE[c.color as PaletteName] ?? PALETTE.bone;
  return `<span class="chip"><i class="swatch" style="background:${color}"></i>${esc(c.name)}</span>`;
}

function row(label: string, value: string): string {
  return `<div class="kv"><span>${esc(label)}</span><b>${value}</b></div>`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function slopeText(world: World, x: number, y: number): string {
  const s = world.tileSlope(x, y);
  return s === 0 ? 'Flat' : s === 1 ? 'Gentle slope' : 'Steep slope';
}

function cityHtml(world: World, city: City): string {
  const cls = MAPGEN.cities.classes[city.classIndex];
  const counts = new Map<string, number>();
  for (const id of city.buildingIds) {
    const b = world.buildings[id];
    counts.set(b.defId, (counts.get(b.defId) ?? 0) + 1);
  }
  const mix = BUILDINGS.filter((b) => counts.has(b.id))
    .map((b) => `${counts.get(b.id)} ${BUILDING_LABEL[b.id] ?? b.id}`)
    .join(', ');
  return (
    row('Size', esc(cls.name)) +
    row('Population', fmtInt(city.population)) +
    row('Built-up radius', `${city.radius} tiles`) +
    row('Buildings', esc(mix || '—')) +
    row('Location', `${city.x}, ${city.y}`) +
    `<p class="hint">Passenger & mail supply and goods demand arrive with the economy milestone.</p>`
  );
}

function industryHtml(world: World, ind: Industry): string {
  const def = INDUSTRY_BY_ID.get(ind.defId)!;
  const city = ind.cityId >= 0 ? world.cities[ind.cityId] : undefined;
  return (
    row('Type', def.kind === 'raw' ? 'Resource site' : 'Processing plant') +
    row('Produces', def.produces.map(cargoChip).join(' ') || '—') +
    row(def.kind === 'raw' ? 'Boosted by' : 'Needs', def.consumes.map(cargoChip).join(' ') || '—') +
    row('Footprint', `${ind.w}×${ind.h} tiles`) +
    row('Nearest town', city ? esc(city.name) : '—') +
    row('Location', `${ind.x}, ${ind.y}`)
  );
}

export function inspectTile(world: World, x: number, y: number): Inspection {
  const occ = world.occupantAt(x, y);
  if (occupantKind(occ) === OCC_INDUSTRY) {
    const ind = world.industries[occupantIndex(occ)];
    return { title: ind.name, kind: 'industry', rect: [ind.x, ind.y, ind.w, ind.h], html: industryHtml(world, ind) };
  }
  if (occupantKind(occ) === OCC_BUILDING) {
    const b = world.buildings[occupantIndex(occ)];
    const city = world.cities[b.cityId];
    return {
      title: city.name,
      kind: 'city',
      rect: [x, y, 1, 1],
      html: row('Building', esc(BUILDING_LABEL[b.defId] ?? b.defId)) + cityHtml(world, city),
    };
  }
  const flags: string[] = [];
  if (world.hasFlag(x, y, F.River)) flags.push('River');
  if (world.hasFlag(x, y, F.Road)) flags.push('Town street');
  if (world.hasFlag(x, y, F.Tree)) flags.push('Lone tree');
  const ter = world.terrainAt(x, y);
  const near = world.nearestCity(x, y);
  const elev = Math.round(world.tileAvgH(x, y) * FEET_PER_LEVEL);
  return {
    title: world.hasFlag(x, y, F.River) ? 'River' : TERRAIN_LABELS[ter],
    kind: 'terrain',
    rect: [x, y, 1, 1],
    html:
      row('Terrain', esc(TERRAIN_LABELS[ter])) +
      row('Elevation', `${fmtInt(elev)} ft`) +
      row('Slope', slopeText(world, x, y)) +
      (flags.length ? row('Features', esc(flags.join(', '))) : '') +
      (near ? row('Nearest town', esc(near.name)) + row('Distance', plural(Math.round(Math.hypot(near.x - x, near.y - y)), 'tile')) : '') +
      row('Location', `${x}, ${y}`),
  };
}
