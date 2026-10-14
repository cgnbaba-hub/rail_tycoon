import { CARGO_BY_ID, CAR_BY_ID, ENGINE_BY_ID } from '../data';
import { DARKER, LIGHTER, PAL, colorIndex } from './palette';
import { PixelBuffer, drawLine, fillPolygon, solid } from './raster';

/**
 * Procedural train sprites. A vehicle is a handful of boxes oriented along one of eight
 * view directions; each (vehicle look, direction, zoom) is rasterised once and cached.
 */

export interface VehicleLook {
  /** 'engine:<id>' or 'car:<type>' */
  key: string;
  /** Cargo shown on open/flat cars (palette name) or '' when empty. */
  load: string;
}

interface BoxSpec {
  /** Offset along the vehicle axis (tiles, + = front) and sideways. */
  a: number;
  s: number;
  len: number;
  wid: number;
  z0: number;
  z1: number;
  color: number;
  top?: number;
}

function vehicleBoxes(look: VehicleLook): BoxSpec[] {
  const [kind, id] = look.key.split(':');
  const ink = PAL.ink;
  if (kind === 'engine') {
    const e = ENGINE_BY_ID.get(id);
    const body = colorIndex(e?.look.body ?? 'slate');
    const trim = colorIndex(e?.look.trim ?? 'gold');
    const k = e?.look.size ?? 1;
    if (e?.look.diesel) {
      return [
        { a: 0, s: 0, len: 0.5 * k, wid: 0.2, z0: 0.1, z1: 0.4, color: ink },
        { a: 0, s: 0, len: 0.48 * k, wid: 0.19, z0: 0.4, z1: 2.0, color: body, top: LIGHTER[body] },
        { a: 0.17 * k, s: 0, len: 0.1, wid: 0.2, z0: 1.2, z1: 2.1, color: trim, top: trim },
      ];
    }
    return [
      { a: 0, s: 0, len: 0.48 * k, wid: 0.18, z0: 0.1, z1: 0.45, color: ink },
      { a: 0.04 * k, s: 0, len: 0.32 * k, wid: 0.13, z0: 0.45, z1: 1.45, color: body, top: LIGHTER[body] },
      { a: -0.16 * k, s: 0, len: 0.14 * k, wid: 0.19, z0: 0.45, z1: 2.3, color: body, top: ink },
      { a: 0.17 * k, s: 0, len: 0.06, wid: 0.06, z0: 1.45, z1: 2.5, color: ink, top: PAL.shale },
      { a: 0.04 * k, s: 0, len: 0.06, wid: 0.07, z0: 1.45, z1: 1.85, color: trim, top: trim },
      { a: 0.25 * k, s: 0, len: 0.04, wid: 0.18, z0: 0.1, z1: 0.6, color: trim, top: trim },
    ];
  }
  const car = CAR_BY_ID.get(id);
  const body = colorIndex(car?.body ?? 'rust');
  const roof = colorIndex(car?.roof ?? 'loam');
  const trim = colorIndex(car?.trim ?? 'soil');
  const load = look.load ? colorIndex(look.load) : -1;
  const frame: BoxSpec = { a: 0, s: 0, len: 0.38, wid: 0.17, z0: 0.1, z1: 0.35, color: ink };
  switch (car?.shape) {
    case 'coach':
      return [
        frame,
        { a: 0, s: 0, len: 0.38, wid: 0.18, z0: 0.35, z1: 1.8, color: body, top: roof },
        // Window band.
        { a: 0, s: 0, len: 0.32, wid: 0.186, z0: 1.05, z1: 1.4, color: trim, top: body },
        { a: 0, s: 0, len: 0.3, wid: 0.1, z0: 1.8, z1: 2.0, color: roof, top: roof },
      ];
    case 'open':
      return [frame, { a: 0, s: 0, len: 0.36, wid: 0.18, z0: 0.35, z1: 1.35, color: body, top: load >= 0 ? load : DARKER[body] }];
    case 'flat':
      return load >= 0
        ? [frame, { a: 0, s: 0, len: 0.38, wid: 0.18, z0: 0.35, z1: 0.55, color: body, top: body }, { a: 0, s: 0, len: 0.3, wid: 0.14, z0: 0.55, z1: 1.2, color: load, top: LIGHTER[load] }]
        : [frame, { a: 0, s: 0, len: 0.38, wid: 0.18, z0: 0.35, z1: 0.55, color: body, top: body }];
    case 'tank':
      return [
        frame,
        { a: 0, s: 0, len: 0.36, wid: 0.15, z0: 0.35, z1: 1.45, color: body, top: LIGHTER[body] },
        { a: 0, s: 0, len: 0.06, wid: 0.07, z0: 1.45, z1: 1.7, color: trim, top: trim },
      ];
    case 'caboose':
      return [
        frame,
        { a: 0, s: 0, len: 0.34, wid: 0.18, z0: 0.35, z1: 1.6, color: body, top: roof },
        { a: 0, s: 0, len: 0.14, wid: 0.14, z0: 1.6, z1: 2.2, color: body, top: roof },
      ];
    case 'slatted':
      return [frame, { a: 0, s: 0, len: 0.38, wid: 0.18, z0: 0.35, z1: 1.6, color: body, top: roof }];
    default:
      return [frame, { a: 0, s: 0, len: 0.38, wid: 0.18, z0: 0.35, z1: 1.7, color: body, top: roof }];
  }
}

export interface SpriteImage {
  canvas: HTMLCanvasElement;
  /** Pixel inside the canvas that sits on the anchor point. */
  ax: number;
  ay: number;
}

/** Rasterise a vehicle facing view direction vd (0–7, 45° steps in view space). */
export function rasterVehicle(look: VehicleLook, vd: number, tw: number): PixelBuffer & { ax: number; ay: number } {
  const size = Math.max(8, Math.ceil(tw * 1.2));
  const buf = new PixelBuffer(size, size) as PixelBuffer & { ax: number; ay: number };
  const ax = Math.floor(size / 2);
  const ay = Math.floor(size * 0.7);
  buf.ax = ax;
  buf.ay = ay;
  const ang = (vd * Math.PI) / 4;
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const nx = -uy;
  const ny = ux;
  const P = (x: number, y: number, z: number): [number, number] => [ax + ((x - y) * tw) / 2, ay + ((x + y) * tw) / 4 - (z * tw) / 8];
  const boxes = vehicleBoxes(look);
  for (const b of boxes) {
    const cx = ux * b.a + nx * b.s;
    const cy = uy * b.a + ny * b.s;
    const hl = b.len / 2;
    const hw = b.wid / 2;
    const corners: Array<[number, number]> = [
      [cx + ux * hl + nx * hw, cy + uy * hl + ny * hw],
      [cx + ux * hl - nx * hw, cy + uy * hl - ny * hw],
      [cx - ux * hl - nx * hw, cy - uy * hl - ny * hw],
      [cx - ux * hl + nx * hw, cy - uy * hl + ny * hw],
    ];
    // Side faces facing the viewer (+x/+y in view space), far ones first.
    const faces: Array<{ i: number; depth: number; nxv: number; nyv: number }> = [];
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = corners[i];
      const [x1, y1] = corners[(i + 1) % 4];
      const mx = (x0 + x1) / 2 - cx;
      const my = (y0 + y1) / 2 - cy;
      if (mx + my <= 1e-6) continue;
      faces.push({ i, depth: (x0 + x1 + y0 + y1) / 2, nxv: mx, nyv: my });
    }
    faces.sort((p, q) => p.depth - q.depth);
    for (const f of faces) {
      const [x0, y0] = corners[f.i];
      const [x1, y1] = corners[(f.i + 1) % 4];
      // Faces turned towards +y (screen lower-left) are lit, towards +x shaded.
      const color = f.nyv >= f.nxv ? b.color : DARKER[b.color];
      fillPolygon(buf, [...P(x0, y0, b.z0), ...P(x1, y1, b.z0), ...P(x1, y1, b.z1), ...P(x0, y0, b.z1)], solid(color));
    }
    const top = b.top ?? LIGHTER[b.color];
    fillPolygon(buf, corners.flatMap(([x, y]) => P(x, y, b.z1)), solid(top));
  }
  // A 1px highlight line on the engine's boiler top for readability at 1×.
  if (tw >= 32 && look.key.startsWith('engine')) {
    drawLine(buf, ...P(ux * 0.12, uy * 0.12, 1.5), ...P(-ux * 0.06, -uy * 0.06, 1.5), solid(PAL.fog));
  }
  return buf;
}

const cache = new Map<string, SpriteImage>();

export function vehicleSprite(look: VehicleLook, vd: number, tw: number): SpriteImage {
  const key = `${look.key}|${look.load}|${vd}|${tw}`;
  let s = cache.get(key);
  if (s) return s;
  const buf = rasterVehicle(look, vd, tw);
  const canvas = document.createElement('canvas');
  canvas.width = buf.w;
  canvas.height = buf.h;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(buf.data.buffer as ArrayBuffer), buf.w, buf.h), 0, 0);
  s = { canvas, ax: buf.ax, ay: buf.ay };
  cache.set(key, s);
  return s;
}

/** Palette name to show for a car's load ('' if empty or not visible). */
export function loadLook(type: string, cargo: string, loads: number): string {
  if (loads <= 0) return '';
  const shape = CAR_BY_ID.get(type)?.shape;
  if (shape !== 'open' && shape !== 'flat') return '';
  return CARGO_BY_ID.get(cargo)?.color ?? 'shale';
}
