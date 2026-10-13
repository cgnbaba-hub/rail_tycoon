/**
 * Dev helper: render a world view to a PNG without a browser.
 *   npx vite-node scripts/preview.ts -- <seed> <size> <rot> <tw> <out.png> [cx cy w h]
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { generateWorld, defaultMapParams } from '../src/sim/mapgen';
import { CHUNK, WorldRenderData, renderChunk } from '../src/render/terrain';
import { rotatedSize, type Rot } from '../src/render/iso';
import { PALETTE_U32, PAL } from '../src/render/palette';

const args = process.argv.slice(2).filter((a) => a !== '--');
const seed = Number(args[0] ?? 1);
const size = Number(args[1] ?? 64);
const rot = Number(args[2] ?? 0) as Rot;
const tw = Number(args[3] ?? 32);
const out = args[4] ?? 'preview.png';

const t0 = performance.now();
const world = generateWorld({ ...defaultMapParams(seed), size });
const t1 = performance.now();
const data = new WorldRenderData(world);
const [RW, RH] = rotatedSize(rot, size, size);
const nCx = Math.ceil(RW / CHUNK);
const nCy = Math.ceil(RH / CHUNK);
const chunks = [];
for (let cy = 0; cy < nCy; cy++) for (let cx = 0; cx < nCx; cx++) chunks.push({ cx, cy, img: renderChunk(data, rot, tw, cx, cy) });
const t2 = performance.now();
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const c of chunks) {
  minX = Math.min(minX, c.img.buf.ox); minY = Math.min(minY, c.img.buf.oy);
  maxX = Math.max(maxX, c.img.buf.ox + c.img.buf.w); maxY = Math.max(maxY, c.img.buf.oy + c.img.buf.h);
}
let [vx, vy, vw, vh] = [minX, minY, maxX - minX, maxY - minY];
if (args.length >= 9) [vx, vy, vw, vh] = [minX + Number(args[5]), minY + Number(args[6]), Number(args[7]), Number(args[8])];
const img = new Uint32Array(vw * vh).fill(PALETTE_U32[PAL.ink]);
chunks.sort((a, b) => a.cx + a.cy - (b.cx + b.cy));
for (const c of chunks) {
  const b = c.img.buf;
  for (let y = 0; y < b.h; y++) {
    const ty = b.oy + y - vy;
    if (ty < 0 || ty >= vh) continue;
    for (let x = 0; x < b.w; x++) {
      const v = b.data[y * b.w + x];
      if (!v) continue;
      const tx = b.ox + x - vx;
      if (tx < 0 || tx >= vw) continue;
      img[ty * vw + tx] = v;
    }
  }
}
// PNG encode (RGBA)
const raw = Buffer.alloc((vw * 4 + 1) * vh);
for (let y = 0; y < vh; y++) {
  raw[y * (vw * 4 + 1)] = 0;
  for (let x = 0; x < vw; x++) {
    const v = img[y * vw + x];
    const o = y * (vw * 4 + 1) + 1 + x * 4;
    raw[o] = v & 255; raw[o + 1] = (v >> 8) & 255; raw[o + 2] = (v >> 16) & 255; raw[o + 3] = 255;
  }
}
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (buf: Buffer) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(vw, 0); ihdr.writeUInt32BE(vh, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`mapgen ${(t1 - t0).toFixed(0)}ms, render ${(t2 - t1).toFixed(0)}ms (${chunks.length} chunks), image ${vw}x${vh}`);
console.log(`cities ${world.cities.length}: ${world.cities.map((c) => c.name + ' ' + c.population).join(', ')}`);
console.log(`industries ${world.industries.length}`);
