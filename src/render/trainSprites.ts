import { CARGO_BY_ID, CAR_BY_ID, ENGINE_BY_ID } from '../data';
import { DARKER, LIGHTER, PAL, PALETTE_U32, colorIndex } from './palette';
import { PixelBuffer, fillPolygon, solid } from './raster';

/**
 * Procedural train sprites. A vehicle is built from boxes and octagonal cylinders laid out
 * along its axis (a = along, + = front; s = sideways; z = height in levels), rasterised for
 * each of the eight view directions and outlined in ink so it reads against any ground.
 * Every (look, direction, zoom) is drawn once and cached.
 */

export interface VehicleLook {
  /** 'engine:<id>', 'tender:<engineId>' or 'car:<type>' */
  key: string;
  /** Cargo shown on open/flat cars (palette name) or '' when empty. */
  load: string;
}

interface Box {
  kind: 'box';
  a: number;
  s: number;
  len: number;
  wid: number;
  z0: number;
  z1: number;
  color: number;
  /** Top face colour (default: one step lighter). */
  top?: number;
  /** Shaded side colour (default: one step darker). */
  shade?: number;
}

interface Cyl {
  kind: 'cyl';
  a: number;
  len: number;
  /** Horizontal and vertical radius (tiles / levels) and centre height. */
  r: number;
  rz: number;
  zc: number;
  color: number;
  /** Draw the visible end cap (off for bands around a boiler). */
  cap: boolean;
}

type Part = Box | Cyl;
const NO_TOP = -1;

const box = (a: number, len: number, wid: number, z0: number, z1: number, color: number, top?: number, s = 0, shade?: number): Box => ({ kind: 'box', a, s, len, wid, z0, z1, color, top, shade });
const cyl = (a: number, len: number, r: number, rz: number, zc: number, color: number, cap = true): Cyl => ({ kind: 'cyl', a, len, r, rz, zc, color, cap });
/** A flat decal on the sides (stripe, window, door): side faces only, no top. */
const decal = (a: number, len: number, z0: number, z1: number, color: number, shade?: number): Box => box(a, len, WIDE + 0.004, z0, z1, color, NO_TOP, 0, shade ?? DARKER[color]);

/** Visual length of each vehicle (a little shorter than its spacing, leaving a coupler gap). */
const LEN = { engine: 0.5, tender: 0.3, car: 0.4 };
const WIDE = 0.17;
/** Heights (levels; 1 level = tw/8 px): top of wheels, top of frame. */
const WHEEL = 0.28;
const DECK = 0.38;

/** Two bogies with dark wheels under a frame. */
function underframe(len: number): Part[] {
  const ink = PAL.ink;
  const parts: Part[] = [box(0, len - 0.02, WIDE - 0.04, WHEEL - 0.06, DECK, ink, PAL.night)];
  const span = len / 2 - 0.075;
  for (const a of [-span, span]) parts.push(box(a, 0.1, WIDE - 0.01, 0, WHEEL, ink, PAL.night, 0, ink));
  return parts;
}

function steamEngine(body: number, trim: number, k: number): Part[] {
  const ink = PAL.ink;
  const r = 0.066 * k;
  const rz = 0.3 * k;
  const zc = DECK + 0.06 + rz;
  const top = zc + rz;
  const cabTop = Math.max(top + 0.3, 1.3);
  return [
    // Running gear: frame, three red drivers, pilot truck, running board.
    box(0.01, 0.46, WIDE - 0.05, 0.2, DECK, ink, PAL.night),
    box(-0.12, 0.085, WIDE, 0, 0.36, PAL.brick, PAL.oxblood, 0, PAL.oxblood),
    box(-0.025, 0.085, WIDE, 0, 0.36, PAL.brick, PAL.oxblood, 0, PAL.oxblood),
    box(0.07, 0.085, WIDE, 0, 0.36, PAL.brick, PAL.oxblood, 0, PAL.oxblood),
    box(0.18, 0.06, WIDE - 0.05, 0, 0.24, ink, PAL.night, 0, ink),
    box(0.01, 0.42, WIDE + 0.02, DECK, DECK + 0.06, ink, PAL.steel),
    // Boiler with brass bands, dark smokebox at the front.
    cyl(0.045, 0.3, r, rz, zc, body),
    cyl(0.11, 0.02, r + 0.006, rz + 0.03, zc, trim, false),
    cyl(-0.02, 0.02, r + 0.006, rz + 0.03, zc, trim, false),
    cyl(0.205, 0.06, r + 0.003, rz + 0.015, zc, PAL.night),
    // Stack (with flared top), steam dome, sand dome, headlight.
    box(0.2, 0.04, 0.05, top - 0.05, top + 0.42, ink, PAL.night),
    box(0.2, 0.07, 0.08, top + 0.38, top + 0.52, ink, PAL.shale),
    box(0.07, 0.055, 0.07, top - 0.05, top + 0.2, trim, LIGHTER[trim]),
    box(-0.01, 0.045, 0.06, top - 0.05, top + 0.13, body, LIGHTER[body]),
    box(0.24, 0.03, 0.06, zc + 0.06, zc + 0.26, PAL.gold, PAL.cream),
    // Cab with window and overhanging roof.
    box(-0.18, 0.13, WIDE, DECK, cabTop, body, LIGHTER[body]),
    decal(-0.175, 0.06, cabTop - 0.38, cabTop - 0.12, PAL.night, PAL.ink),
    box(-0.18, 0.16, WIDE + 0.03, cabTop, cabTop + 0.1, DARKER[body], body),
    // Cow-catcher.
    box(0.255, 0.04, WIDE - 0.02, 0.03, 0.3, trim, DARKER[trim]),
  ];
}

function tender(body: number, trim: number, fuel: string): Part[] {
  const len = LEN.tender;
  const wood = fuel === 'wood';
  return [
    ...underframe(len),
    box(0, len - 0.03, WIDE, DECK, 1.02, body, LIGHTER[body]),
    decal(0, len - 0.028, 0.76, 0.88, trim),
    box(0.02, len - 0.09, WIDE - 0.06, 1.02, 1.16, wood ? PAL.loam : PAL.ink, wood ? PAL.soil : PAL.night),
  ];
}

function dieselEngine(body: number, trim: number, k: number): Part[] {
  const ink = PAL.ink;
  const h = 1.25 * Math.min(1.1, k);
  return [
    ...underframe(LEN.engine),
    box(-0.03, 0.4, WIDE, DECK, h, body, LIGHTER[body]),
    // Rounded nose: a lower step in front of the windscreen.
    box(0.2, 0.08, WIDE - 0.02, DECK, h - 0.32, body, LIGHTER[body]),
    decal(0.155, 0.03, h - 0.32, h - 0.08, PAL.night, ink),
    decal(0.01, 0.46, 0.58, 0.72, trim),
    box(0.24, 0.02, 0.07, 0.72, 0.9, PAL.gold, PAL.cream),
    box(-0.08, 0.12, WIDE - 0.07, h, h + 0.1, PAL.steel, PAL.fog),
  ];
}

function carParts(id: string, load: number): Part[] {
  const car = CAR_BY_ID.get(id);
  const body = colorIndex(car?.body ?? 'rust');
  const roof = colorIndex(car?.roof ?? 'loam');
  const trim = colorIndex(car?.trim ?? 'soil');
  const L = LEN.car;
  const base = underframe(L);
  const windows = (z0: number, z1: number, n: number, color = PAL.night) => {
    const out: Part[] = [];
    const span = L - 0.08;
    for (let i = 0; i < n; i++) out.push(decal(-span / 2 + (span * (i + 0.5)) / n, (span / n) * 0.55, z0, z1, color));
    return out;
  };
  switch (car?.shape) {
    case 'coach': {
      const dining = id === 'dining';
      return [
        ...base,
        box(0, L - 0.02, WIDE, DECK, 1.12, body, LIGHTER[body]),
        decal(0, L - 0.018, 0.58, 0.7, trim),
        ...windows(0.74, 0.98, dining ? 3 : 4, dining ? PAL.gold : PAL.night),
        box(0, L - 0.01, WIDE + 0.016, 1.12, 1.22, roof, LIGHTER[roof]),
        box(0, L - 0.12, WIDE - 0.08, 1.22, 1.32, roof, LIGHTER[roof]),
      ];
    }
    case 'open':
      return [
        ...base,
        box(0, L - 0.03, WIDE, DECK, 0.98, body, load >= 0 ? load : DARKER[body]),
        decal(0, L - 0.026, 0.86, 0.98, LIGHTER[body]),
        ...(load >= 0 ? [box(0, L - 0.1, WIDE - 0.06, 0.98, 1.1, load, LIGHTER[load])] : []),
      ];
    case 'flat':
      return [
        ...base,
        box(0, L - 0.02, WIDE, DECK, 0.5, body, LIGHTER[body]),
        box(-L / 2 + 0.03, 0.025, WIDE + 0.006, 0.5, 0.82, PAL.ink, PAL.night),
        box(L / 2 - 0.03, 0.025, WIDE + 0.006, 0.5, 0.82, PAL.ink, PAL.night),
        ...(load >= 0 ? [box(0, L - 0.1, WIDE - 0.04, 0.5, 0.92, load, LIGHTER[load])] : []),
      ];
    case 'tank':
      return [
        ...base,
        box(0, L - 0.04, WIDE - 0.03, DECK, DECK + 0.08, PAL.ink, PAL.night),
        cyl(0, L - 0.05, 0.075, 0.32, DECK + 0.36, body),
        box(0, 0.06, 0.07, DECK + 0.62, DECK + 0.8, trim, LIGHTER[trim]),
      ];
    case 'caboose':
      return [
        ...base,
        box(0, L - 0.06, WIDE, DECK, 1.06, body, LIGHTER[body]),
        ...windows(0.7, 0.9, 2, PAL.gold),
        box(0, L - 0.04, WIDE + 0.016, 1.06, 1.15, roof, LIGHTER[roof]),
        box(0, 0.13, WIDE - 0.03, 1.15, 1.46, body, LIGHTER[body]),
        box(0, 0.08, WIDE - 0.026, 1.24, 1.38, PAL.gold, NO_TOP),
        box(0, 0.16, WIDE, 1.46, 1.54, roof, LIGHTER[roof]),
        box(L / 2 - 0.01, 0.02, WIDE - 0.02, DECK, 0.66, trim, trim),
        box(-L / 2 + 0.01, 0.02, WIDE - 0.02, DECK, 0.66, trim, trim),
      ];
    case 'slatted': {
      const out: Part[] = [...base, box(0, L - 0.02, WIDE, DECK, 1.1, DARKER[body], DARKER[body])];
      for (const z of [0.46, 0.7, 0.94]) out.push(decal(0, L - 0.018, z, z + 0.12, body));
      out.push(box(0, L - 0.01, WIDE + 0.016, 1.1, 1.2, roof, LIGHTER[roof]));
      return out;
    }
    default: {
      // Boxcar / reefer / mail: sliding door and roof.
      const isMail = id === 'mail';
      return [
        ...base,
        box(0, L - 0.02, WIDE, DECK, 1.14, body, LIGHTER[body]),
        decal(0, 0.1, 0.46, 1.04, DARKER[body]),
        ...(isMail ? [decal(0, L - 0.018, 0.84, 0.96, PAL.gold)] : []),
        box(0, L, WIDE + 0.016, 1.14, 1.24, roof, LIGHTER[roof]),
      ];
    }
  }
}

function vehicleParts(look: VehicleLook): Part[] {
  const [kind, id] = look.key.split(':');
  if (kind === 'engine' || kind === 'tender') {
    const e = ENGINE_BY_ID.get(id);
    const body = colorIndex(e?.look.body ?? 'slate');
    const trim = colorIndex(e?.look.trim ?? 'gold');
    const k = 0.85 + 0.25 * Math.min(1, Math.max(0, ((e?.look.size ?? 1) - 0.7) / 0.6));
    if (kind === 'tender') return tender(body, trim, e?.fuel ?? 'coal');
    return e?.look.diesel ? dieselEngine(body, trim, k) : steamEngine(body, trim, k);
  }
  return carParts(id, look.load ? colorIndex(look.load) : -1);
}

export interface SpriteImage {
  canvas: HTMLCanvasElement;
  /** Pixel inside the canvas that sits on the anchor point. */
  ax: number;
  ay: number;
}

type Pt = [number, number];

/** Rasterise a vehicle facing view direction vd (0–7, 45° steps in view space). */
export function rasterVehicle(look: VehicleLook, vd: number, tw: number): PixelBuffer & { ax: number; ay: number } {
  const size = Math.max(10, Math.ceil(tw * 1.4));
  const buf = new PixelBuffer(size, size) as PixelBuffer & { ax: number; ay: number };
  const ax = Math.floor(size / 2);
  const ay = Math.floor(size * 0.68);
  buf.ax = ax;
  buf.ay = ay;
  const ang = (vd * Math.PI) / 4;
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const nx = -uy;
  const ny = ux;
  const P = (x: number, y: number, z: number): Pt => [ax + ((x - y) * tw) / 2, ay + ((x + y) * tw) / 4 - (z * tw) / 8];
  const fill = (pts: Pt[], color: number) => fillPolygon(buf, pts.flat(), solid(color));
  // Back-to-front: parts further from the viewer first.
  // Painter's order: height bands bottom-up (wheels, frame, body, details), then back to
  // front inside a band; parts listed later win ties (details over their host).
  const parts = vehicleParts(look)
    .map((p, i) => {
      const z0 = p.kind === 'box' ? p.z0 : p.zc - p.rz;
      return { p, i, band: Math.floor(z0 * 4), depth: (ux + uy) * p.a + (p.kind === 'box' ? (nx + ny) * p.s : 0) };
    })
    .sort((a, b) => a.band - b.band || a.depth - b.depth || a.i - b.i)
    .map((x) => x.p);
  for (const p of parts) {
    if (p.kind === 'box') drawBox(p);
    else drawCyl(p);
  }

  function drawBox(b: Box): void {
    const cx = ux * b.a + nx * b.s;
    const cy = uy * b.a + ny * b.s;
    const hl = b.len / 2;
    const hw = b.wid / 2;
    const corners: Pt[] = [
      [cx + ux * hl + nx * hw, cy + uy * hl + ny * hw],
      [cx + ux * hl - nx * hw, cy + uy * hl - ny * hw],
      [cx - ux * hl - nx * hw, cy - uy * hl - ny * hw],
      [cx - ux * hl + nx * hw, cy - uy * hl + ny * hw],
    ];
    const faces: Array<{ i: number; depth: number; mx: number; my: number }> = [];
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = corners[i];
      const [x1, y1] = corners[(i + 1) % 4];
      const mx = (x0 + x1) / 2 - cx;
      const my = (y0 + y1) / 2 - cy;
      if (mx + my <= 1e-6) continue;
      faces.push({ i, depth: (x0 + x1 + y0 + y1) / 2, mx, my });
    }
    faces.sort((p, q) => p.depth - q.depth);
    for (const f of faces) {
      const [x0, y0] = corners[f.i];
      const [x1, y1] = corners[(f.i + 1) % 4];
      // Faces turned towards +y (screen lower-left) are lit, towards +x shaded.
      const color = f.my >= f.mx ? b.color : b.shade ?? DARKER[b.color];
      fill([P(x0, y0, b.z0), P(x1, y1, b.z0), P(x1, y1, b.z1), P(x0, y0, b.z1)], color);
    }
    if (b.top !== NO_TOP) {
      fill(
        corners.map(([x, y]) => P(x, y, b.z1)),
        b.top ?? LIGHTER[b.color],
      );
    }
  }

  function drawCyl(c: Cyl): void {
    const SEG = 8;
    const hl = c.len / 2;
    const ring = (along: number) => {
      const out: Array<[number, number, number]> = [];
      for (let k = 0; k < SEG; k++) {
        const th = ((k + 0.5) / SEG) * Math.PI * 2;
        const off = Math.cos(th) * c.r;
        out.push([ux * (c.a + along) + nx * off, uy * (c.a + along) + ny * off, c.zc + Math.sin(th) * c.rz]);
      }
      return out;
    };
    const front = ring(hl);
    const back = ring(-hl);
    // Faces whose outward normal points towards the viewer (+x +y, up).
    const faces: Array<{ k: number; lit: number; depth: number }> = [];
    for (let k = 0; k < SEG; k++) {
      const th = ((k + 1) / SEG) * Math.PI * 2;
      const hx = nx * Math.cos(th);
      const hy = ny * Math.cos(th);
      const hz = Math.sin(th);
      if (hx + hy + 1.6 * hz <= 0.02) continue;
      faces.push({ k, lit: hy - hx + 1.3 * hz, depth: hx + hy + hz });
    }
    faces.sort((p, q) => p.depth - q.depth);
    for (const f of faces) {
      const k2 = (f.k + 1) % SEG;
      const color = f.lit > 0.9 ? LIGHTER[c.color] : f.lit > -0.35 ? c.color : DARKER[c.color];
      fill([P(...front[f.k]), P(...front[k2]), P(...back[k2]), P(...back[f.k])], color);
    }
    // Visible end cap.
    const capFront = ux + uy > 0;
    if (c.cap && Math.abs(ux + uy) > 0.01) fill((capFront ? front : back).map((v) => P(...v)), DARKER[c.color]);
  }

  if (tw >= 16) outline(buf, PALETTE_U32[PAL.ink]);
  return buf;
}

/** 1-px ink outline around the sprite's silhouette (4-neighbourhood). */
function outline(buf: PixelBuffer, ink: number): void {
  const { w, h, data } = buf;
  const src = data.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (src[y * w + x]) continue;
      if ((x > 0 && src[y * w + x - 1]) || (x < w - 1 && src[y * w + x + 1]) || (y > 0 && src[(y - 1) * w + x]) || (y < h - 1 && src[(y + 1) * w + x])) data[y * w + x] = ink;
    }
  }
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
