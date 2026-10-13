import { BUILDINGS, CARGO_BY_ID, CONSTRUCTION, INDUSTRY_BY_ID, MAPGEN } from '../data';
import type { Highlight } from '../render/renderer';
import { gradePercent } from '../sim/construction';
import { catchmentRect, stationCoverage, stationDef } from '../sim/station';
import { DIR_NAMES, NODE_BRIDGE, NODE_TUNNEL, bitCount, stepLength } from '../sim/track';
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

/** Feet per height level (shared with the grade formula). */
export const FEET_PER_LEVEL = CONSTRUCTION.feetPerLevel;

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
  kind: 'terrain' | 'city' | 'industry' | 'track' | 'station';
  /** Tile rect to highlight [x, y, w, h]. */
  rect: [number, number, number, number];
  html: string;
  /** Extra outlines (e.g. a station's catchment). */
  extraHighlights?: Highlight[];
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
    if (b.demolished) continue;
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

function trackInspection(world: World, x: number, y: number): Inspection | null {
  const i = world.tileIndex(x, y);
  const node = world.track.getIdx(i);
  if (!node) return null;
  if (node.station >= 0) {
    const st = world.stations[node.station]!;
    const def = stationDef(st.kind);
    const cov = stationCoverage(world, st);
    const r = catchmentRect(world, st.tiles, def.radius);
    const W = world.width;
    const xs = st.tiles.map((t) => t % W);
    const ys = st.tiles.map((t) => Math.floor(t / W));
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const towns = cov.cities.map((c) => `${esc(c.city.name)} ${fmtInt(c.population)}`).join(', ') || '—';
    const inds = cov.industries.map((ind) => esc(INDUSTRY_BY_ID.get(ind.defId)!.name)).join(', ') || '—';
    return {
      title: `${st.name} ${def.name}`,
      kind: 'station',
      rect: [x0, y0, Math.max(...xs) - x0 + 1, Math.max(...ys) - y0 + 1],
      extraHighlights: [{ rect: [r[0], r[1], r[2] - r[0] + 1, r[3] - r[1] + 1], color: PALETTE.sky, dashed: true }],
      html:
        row('Size', `${esc(def.name)} · ${def.length} tile${def.length > 1 ? 's' : ''}`) +
        row('Catchment', `radius ${def.radius}`) +
        row('Towns served', towns) +
        row('Industries', inds) +
        `<p class="hint">Cargo supply & demand gauges arrive with trains and the economy.</p>`,
    };
  }
  const grades: string[] = [];
  for (let d = 0; d < 8; d++) {
    if (!(node.conn & (1 << d))) continue;
    const n = world.track.getIdx(world.track.neighbor(i, d));
    if (!n) continue;
    const g = gradePercent(n.z - node.z, stepLength(d));
    grades.push(`${DIR_NAMES[d]} ${g >= 0 ? '+' : ''}${g.toFixed(1)}%`);
  }
  const kind =
    node.kind === NODE_BRIDGE ? CONSTRUCTION.bridges[node.span]?.name ?? 'Bridge' : node.kind === NODE_TUNNEL ? 'Tunnel' : 'Track';
  const conns = bitCount(node.conn);
  const dbl = node.double !== 0 && node.double === node.conn ? 'Double' : node.double ? 'Mixed' : 'Single';
  const bridge = node.kind === NODE_BRIDGE ? CONSTRUCTION.bridges[node.span] : undefined;
  return {
    title: kind,
    kind: 'track',
    rect: [x, y, 1, 1],
    html:
      row('Line', dbl) +
      row('Layout', conns >= 3 ? `Junction (${conns} ways)` : conns === 1 ? 'Dead end' : 'Through') +
      row('Track height', `${fmtInt(node.z * FEET_PER_LEVEL)} ft`) +
      row('Grades', grades.join(', ') || '—') +
      (bridge ? row('Limits', `${bridge.speedLimit} mph, ${fmtInt(bridge.weightLimit)} t`) : '') +
      row('Location', `${x}, ${y}`),
  };
}

export function inspectTile(world: World, x: number, y: number): Inspection {
  const tr = trackInspection(world, x, y);
  if (tr) return tr;
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
