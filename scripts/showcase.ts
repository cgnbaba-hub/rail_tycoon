/**
 * Dev helper: render a railway showcase (all track features and rolling stock) to PNGs
 * without a browser, for iterating on the pixel art.
 *   npx vite-node scripts/showcase.ts -- [outDir] [tw]
 * Writes showcase-r0..r3.png (one per rotation) into outDir (default: showcase/).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { CONSTRUCTION, TIME } from '../src/data';
import { defaultTrackOptions, type TrackOptions } from '../src/sim/construction';
import { Game } from '../src/sim/game';
import { defaultMapParams } from '../src/sim/mapgen';
import type { RouteStop } from '../src/sim/train';
import { F, T, World } from '../src/sim/world';
import { CHUNK, WorldRenderData, renderChunk } from '../src/render/terrain';
import { project, rotatedSize, toView, vecToView, type Rot } from '../src/render/iso';
import { PALETTE_U32, PAL } from '../src/render/palette';
import { loadLook, rasterVehicle } from '../src/render/trainSprites';

const args = process.argv.slice(2).filter((a) => a !== '--');
const outDir = args[0] ?? 'showcase';
const tw = Number(args[1] ?? 32);
mkdirSync(outDir, { recursive: true });

// -- scene ------------------------------------------------------------------------------
const N = 48;
const w = new World(N, N, 16);
w.heights.fill(4);
w.terrain.fill(T.Grass);
for (let y = 14; y < N; y++) w.flags[w.tileIndex(24, y)] |= F.River;
// A narrow ridge for the tunnel (|Δh| ≤ 1 per vertex step).
for (let vy = 0; vy <= N; vy++) {
  for (let vx = 0; vx <= N; vx++) {
    const add = Math.max(0, Math.min(4 - Math.abs(vy - 28), vx - 30));
    if (add > 0) w.heights[w.vertexIndex(vx, vy)] = 4 + add;
  }
}
for (let y = 0; y < N; y++) for (let x = 30; x < N; x++) if (w.tileSlope(x, y) > 0 || w.tileMinH(x, y) > 5) w.terrain[w.tileIndex(x, y)] = T.Rough;

const g = new Game({ ...defaultMapParams(1), size: N }, w, { wrecks: false });
g.company.cash = 1e9;
CONSTRUCTION.tunnel.perTile = 500; // dev only: make the tunnel the cheapest route
const opts = (o: Partial<TrackOptions> = {}): TrackOptions => ({ ...defaultTrackOptions(1880), ...o });
const ti = (x: number, y: number) => w.tileIndex(x, y);
const st = (x: number, y: number, kind: 'depot' | 'station' | 'terminal', axis: 'x' | 'y' = 'x') => {
  const r = g.buildStation(x, y, kind, axis);
  if (!r.ok) throw new Error(`station ${x},${y}: ${r.error}`);
  return r.station!;
};
const track = (ax: number, ay: number, bx: number, by: number, o: Partial<TrackOptions> = {}) => {
  const r = g.buildTrack(ti(ax, ay), ti(bx, by), opts(o));
  if (!r.ok) throw new Error(`track ${ax},${ay} → ${bx},${by}: ${r.error}`);
  return r;
};

const A = st(5, 4, 'terminal');
const B = st(36, 4, 'station');
track(7, 4, 36, 4, { double: true });
track(37, 4, 44, 10);
const C = st(26, 11, 'depot');
track(16, 4, 26, 11);
const D = st(12, 17, 'depot');
const E = st(36, 17, 'depot');
track(12, 17, 36, 17, { bridge: 'wood' });
st(10, 30, 'depot');
track(10, 30, 22, 30);
track(22, 30, 27, 30, { bridge: 'stone' });
track(4, 42, 30, 42, { bridge: 'steel', double: true });
console.log('tunnel tiles', track(38, 19, 38, 37, { tunnels: true }).plan.tunnels);
const route = (a: number, b: number): RouteStop[] => [
  { station: a, load: 'keep', waitFull: false },
  { station: b, load: 'keep', waitFull: false },
];
g.buyTrain('columbia', ['passengers', 'passengers', 'mail', '@dining'], route(A.id, B.id));
g.buyTrain('columbia', ['coal', 'coal', 'steel', 'oil', 'logs', '@caboose'], route(B.id, A.id));
g.buyTrain('columbia', ['grain', 'livestock', 'milk', '@caboose'], route(C.id, A.id));
g.buyTrain('columbia', ['goods', 'goods', 'passengers'], route(D.id, E.id));
for (let i = 0; i < 2.2 * TIME.ticksPerDay; i++) g.step();

// -- render ---------------------------------------------------------------------------------
const data = new WorldRenderData(w);
for (const rot of [0, 1, 2, 3] as Rot[]) {
  const [RW, RH] = rotatedSize(rot, N, N);
  const chunks = [];
  for (let cy = 0; cy < Math.ceil(RH / CHUNK); cy++) for (let cx = 0; cx < Math.ceil(RW / CHUNK); cx++) chunks.push(renderChunk(data, rot, tw, cx, cy));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of chunks) {
    minX = Math.min(minX, c.buf.ox);
    minY = Math.min(minY, c.buf.oy);
    maxX = Math.max(maxX, c.buf.ox + c.buf.w);
    maxY = Math.max(maxY, c.buf.oy + c.buf.h);
  }
  const vw = maxX - minX;
  const vh = maxY - minY;
  const img = new Uint32Array(vw * vh).fill(PALETTE_U32[PAL.ink]);
  const blit = (data: Uint32Array, bw: number, bh: number, ox: number, oy: number) => {
    for (let y = 0; y < bh; y++) {
      const ty = oy + y;
      if (ty < 0 || ty >= vh) continue;
      for (let x = 0; x < bw; x++) {
        const v = data[y * bw + x];
        const tx = ox + x;
        if (v && tx >= 0 && tx < vw) img[ty * vw + tx] = v;
      }
    }
  };
  for (const c of chunks) blit(c.buf.data, c.buf.w, c.buf.h, c.buf.ox - minX, c.buf.oy - minY);
  // Trains on top, back to front (as the browser renderer does).
  const items: Array<{ depth: number; draw: () => void }> = [];
  for (const t of g.trains.trains) {
    g.trains.vehiclePositions(t).forEach((v, i) => {
      if (v.tunnel) return;
      const [vx, vy] = vecToView(v.dx, v.dy, rot);
      const vd = ((Math.round(Math.atan2(vy, vx) / (Math.PI / 4)) % 8) + 8) % 8;
      const car = v.car >= 0 ? t.cars[v.car] : undefined;
      const look = car ? { key: `car:${car.type}`, load: loadLook(car.type, car.cargo, car.loads || 1) } : { key: `${v.kind}:${t.engine}`, load: '' };
      const [rx, ry] = toView(v.x, v.y, rot, N, N);
      const [sx, sy] = project(rx, ry, v.z, tw);
      items.push({
        depth: rx + ry,
        draw: () => {
          const s = rasterVehicle(look, vd, tw);
          blit(s.data, s.w, s.h, Math.round(sx - minX - s.ax), Math.round(sy - minY - s.ay));
        },
      });
    });
  }
  items.sort((a, b) => a.depth - b.depth);
  for (const it of items) it.draw();
  writePng(`${outDir}/showcase-r${rot}.png`, img, vw, vh);
  console.log(`${outDir}/showcase-r${rot}.png ${vw}×${vh}`);
}

// -- sprite sheet: every vehicle in all eight directions, enlarged ---------------------------
{
  const looks = [
    'engine:cricket',
    'engine:columbia',
    'tender:columbia',
    'engine:mountain',
    'engine:streamliner',
    ...['coach', 'dining', 'mail', 'box', 'reefer', 'hopper', 'flat', 'tank', 'stock', 'caboose'].map((c) => `car:${c}`),
  ];
  const cell = Math.ceil(tw * 0.8);
  const zoom = 6;
  const W = cell * 8;
  const H = cell * looks.length;
  const sheet = new Uint32Array(W * H);
  for (let i = 0; i < sheet.length; i++) sheet[i] = PALETTE_U32[((Math.floor(i / W / 4) + (i % W >> 2)) & 1) ? PAL.grass : PAL.moss];
  looks.forEach((key, row) => {
    for (let vd = 0; vd < 8; vd++) {
      const load = key === 'car:hopper' ? 'night' : key === 'car:flat' ? 'loam' : '';
      const sp = rasterVehicle({ key, load }, vd, tw);
      const ox = Math.floor(cell / 2) - sp.ax;
      const oy = Math.floor(cell * 0.7) - sp.ay;
      for (let y = 0; y < sp.h; y++) for (let x = 0; x < sp.w; x++) {
        const v = sp.data[y * sp.w + x];
        const X = x + ox;
        const Y = y + oy;
        if (v && X >= 0 && X < cell && Y >= 0 && Y < cell) sheet[(row * cell + Y) * W + vd * cell + X] = v;
      }
    }
  });
  const big = new Uint32Array(W * zoom * H * zoom);
  for (let y = 0; y < H * zoom; y++) for (let x = 0; x < W * zoom; x++) big[y * W * zoom + x] = sheet[Math.floor(y / zoom) * W + Math.floor(x / zoom)];
  writePng(`${outDir}/sprites.png`, big, W * zoom, H * zoom);
  console.log(`${outDir}/sprites.png`);
}

function writePng(file: string, img: Uint32Array, vw: number, vh: number): void {
  const raw = Buffer.alloc((vw * 4 + 1) * vh);
  for (let y = 0; y < vh; y++) {
    raw[y * (vw * 4 + 1)] = 0;
    for (let x = 0; x < vw; x++) {
      const v = img[y * vw + x];
      const o = y * (vw * 4 + 1) + 1 + x * 4;
      raw[o] = v & 255;
      raw[o + 1] = (v >> 8) & 255;
      raw[o + 2] = (v >> 16) & 255;
      raw[o + 3] = 255;
    }
  }
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf: Buffer) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, d: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(type), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(vw, 0);
  ihdr.writeUInt32BE(vh, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// Print where interesting features land in the rotation-0 image (for cropping).
{
  const [RW, RH] = rotatedSize(0, N, N);
  void RW;
  void RH;
  const at = (label: string, x: number, y: number) => {
    const [rx, ry] = toView(x + 0.5, y + 0.5, 0, N, N);
    const [sx, sy] = project(rx, ry, 2, tw);
    console.log(`${label}: ${Math.round(sx)},${Math.round(sy)} (relative to the map's top corner)`);
  };
  at('wood bridge', 24, 17);
  at('stone bridge', 24, 30);
  at('steel bridge', 24, 42);
  at('tunnel north', 38, 24);
  at('tunnel south', 38, 32);
  at('buffer stop', 44, 10);
}
