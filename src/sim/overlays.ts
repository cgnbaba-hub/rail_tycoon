import { ECONOMY, INDUSTRY_BY_ID, STATION_BY_ID, TIME } from '../data';
import { gradePercent } from './construction';
import type { Game } from './game';
import { catchmentRect, stationDef } from './station';
import { DX, DY, NODE_GROUND, stepLength } from './track';
import { TRAFFIC_DECAY } from './train';
import { OCC_BUILDING, occupantIndex, occupantKind } from './world';

/**
 * Heat-map fields for the map overlays: one number per tile (NaN = nothing to show).
 * Everything is derived from the current game state; the UI recomputes it monthly.
 */

export type OverlayKind = 'supply' | 'demand' | 'growth' | 'catchment' | 'profit' | 'traffic' | 'congestion' | 'gradient';

export const OVERLAY_KINDS: Array<{ id: OverlayKind; name: string; cargo: boolean; desc: string }> = [
  { id: 'supply', name: 'Supply', cargo: true, desc: 'Loads per month a station here would collect (station-size catchment).' },
  { id: 'demand', name: 'Demand', cargo: true, desc: 'Loads per month the industries and towns in reach absorb at full price.' },
  { id: 'growth', name: 'Town growth', cargo: false, desc: 'Yearly growth rate of each town.' },
  { id: 'catchment', name: 'Catchment', cargo: false, desc: 'How many stations cover each tile.' },
  { id: 'profit', name: 'Route profit', cargo: false, desc: 'Average yearly profit of the trains using each track tile.' },
  { id: 'traffic', name: 'Traffic', cargo: false, desc: 'Trains passing per month.' },
  { id: 'congestion', name: 'Congestion', cargo: false, desc: 'Days per month trains spend waiting for the line ahead (and broken down).' },
  { id: 'gradient', name: 'Gradient', cargo: false, desc: 'Track grade, or land slope where there is no track.' },
];

export interface OverlayField {
  kind: OverlayKind;
  cargo?: string;
  values: Float32Array;
  min: number;
  max: number;
  /** Values around zero matter (e.g. profit): coloured from negative to positive. */
  diverging: boolean;
  unit: string;
}

/** Catchment radius used for the supply/demand fields (a normal station). */
const RADIUS = STATION_BY_ID.get('station')?.radius ?? 3;

export function computeOverlay(game: Game, kind: OverlayKind, cargo = 'passengers'): OverlayField {
  const w = game.world;
  const n = w.width * w.height;
  const values = new Float32Array(n).fill(NaN);
  let diverging = false;
  let unit = '';
  switch (kind) {
    case 'supply':
    case 'demand': {
      const src = kind === 'supply' ? supplySources(game, cargo) : demandSources(game, cargo);
      const sum = windowSum(src, w.width, w.height, RADIUS);
      for (let i = 0; i < n; i++) if (sum[i] > 0.05) values[i] = sum[i];
      unit = 'loads/mo';
      break;
    }
    case 'growth': {
      diverging = true;
      unit = '%/yr';
      for (const city of w.cities) {
        const r = city.radius + 1;
        const g = (city.growth ?? 0) * 100;
        for (let y = Math.max(0, city.y - r); y <= Math.min(w.height - 1, city.y + r); y++) {
          for (let x = Math.max(0, city.x - r); x <= Math.min(w.width - 1, city.x + r); x++) values[w.tileIndex(x, y)] = g;
        }
      }
      break;
    }
    case 'catchment': {
      unit = 'stations';
      for (const st of w.liveStations()) {
        const [x0, y0, x1, y1] = catchmentRect(w, st.tiles, stationDef(st.kind).radius);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const i = w.tileIndex(x, y);
            values[i] = (Number.isNaN(values[i]) ? 0 : values[i]) + 1;
          }
        }
      }
      break;
    }
    case 'profit':
    case 'traffic':
    case 'congestion': {
      const T = game.trains;
      const perMonth = 1 - TRAFFIC_DECAY;
      diverging = kind === 'profit';
      unit = kind === 'profit' ? '$/yr' : kind === 'traffic' ? 'trains/mo' : 'days/mo';
      for (const i of w.track.nodes.keys()) {
        if (kind === 'profit') {
          if (T.traffic[i] > 0.05) values[i] = T.profitSum[i] / T.traffic[i];
        } else if (kind === 'traffic') {
          if (T.traffic[i] > 0.05) values[i] = T.traffic[i] * perMonth;
        } else if (T.waits[i] > TIME.ticksPerDay * 0.05) values[i] = (T.waits[i] * perMonth) / TIME.ticksPerDay;
      }
      break;
    }
    case 'gradient': {
      unit = '%';
      for (let y = 0; y < w.height; y++) {
        for (let x = 0; x < w.width; x++) {
          const i = w.tileIndex(x, y);
          const node = w.track.getIdx(i);
          if (node && node.kind === NODE_GROUND) {
            let g = 0;
            for (let d = 0; d < 8; d++) {
              if (!(node.conn & (1 << d))) continue;
              const nb = w.track.get(x + DX[d], y + DY[d]);
              if (nb) g = Math.max(g, gradePercent(Math.abs(nb.z - node.z), stepLength(d)));
            }
            values[i] = g;
          } else if (!w.isWater(x, y)) {
            // Land: average fall over three tiles, so the map shows hills rather than every bump.
            const gx = (w.vh(x + 2, y) + w.vh(x + 2, y + 1) - w.vh(x - 1, y) - w.vh(x - 1, y + 1)) / 6;
            const gy = (w.vh(x, y + 2) + w.vh(x + 1, y + 2) - w.vh(x, y - 1) - w.vh(x + 1, y - 1)) / 6;
            const g = gradePercent(Math.hypot(gx, gy), 1);
            if (g > 0.05) values[i] = g;
          }
        }
      }
      break;
    }
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) min = max = 0;
  return { kind, cargo: kind === 'supply' || kind === 'demand' ? cargo : undefined, values, min, max, diverging, unit };
}

/** Per tile: loads per month of `cargo` produced there. */
function supplySources(game: Game, cargo: string): Float32Array {
  const w = game.world;
  const out = new Float32Array(w.width * w.height);
  for (const ind of w.industries) {
    const def = INDUSTRY_BY_ID.get(ind.defId);
    if (!def || !def.produces.includes(cargo)) continue;
    const rate = game.economy.industryOutputPerMonth(ind) / def.produces.length;
    spread(out, w.width, ind.x, ind.y, ind.w, ind.h, rate);
  }
  const perPerson = ECONOMY.townSupply[cargo] ?? 0;
  if (perPerson > 0) forTownBuildings(game, (i, pop) => (out[i] += pop * perPerson));
  return out;
}

/** Per tile: loads per month of `cargo` the consumers there absorb before demand drops. */
function demandSources(game: Game, cargo: string): Float32Array {
  const w = game.world;
  const S = ECONOMY.saturation;
  const out = new Float32Array(w.width * w.height);
  for (const ind of w.industries) {
    const def = INDUSTRY_BY_ID.get(ind.defId);
    if (!def || !def.consumes.includes(cargo)) continue;
    spread(out, w.width, ind.x, ind.y, ind.w, ind.h, def.rate * S.industryCapacityFactor);
  }
  const perThousand = S.townCapacityPerThousand[cargo] ?? S.townCapacityPerThousand.default ?? 0;
  forTownBuildings(game, (i, pop, classIndex) => {
    if ((ECONOMY.townDemand[classIndex] ?? []).includes(cargo)) out[i] += (pop / 1000) * perThousand;
  });
  return out;
}

function spread(out: Float32Array, W: number, x: number, y: number, w: number, h: number, total: number): void {
  const each = total / (w * h);
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) out[(y + dy) * W + x + dx] += each;
}

/** Calls fn(tile, people living there, town class) for every standing town building. */
function forTownBuildings(game: Game, fn: (tile: number, pop: number, classIndex: number) => void): void {
  const w = game.world;
  const live = new Map<number, number>();
  for (const b of w.buildings) if (!b.demolished) live.set(b.cityId, (live.get(b.cityId) ?? 0) + 1);
  for (let i = 0; i < w.occupant.length; i++) {
    const occ = w.occupant[i];
    if (occupantKind(occ) !== OCC_BUILDING) continue;
    const b = w.buildings[occupantIndex(occ)];
    if (!b || b.demolished) continue;
    const city = w.cities[b.cityId];
    if (!city) continue;
    fn(i, city.population / (live.get(city.id) || 1), city.classIndex);
  }
}

/** Sum over the (2r+1)² window around every tile (summed-area table). */
export function windowSum(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const S = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += src[y * W + x];
      S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(W, x + r + 1);
      out[y * W + x] = S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0];
    }
  }
  return out;
}
