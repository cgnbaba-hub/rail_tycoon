/**
 * Dev helper: top-down picture of a map (hand-made or random) plus its towns and industries.
 *   npx vite-node scripts/mapview.ts -- <layout id | seed> [size] [out.png] [startYear]
 * Water blue, beach sand, grass shaded by height, forest dark green, rock grey, snow white,
 * rivers light blue, town buildings red, roads grey, industries yellow (raw) / magenta.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { INDUSTRY_BY_ID, MAP_BY_ID } from '../src/data';
import { defaultMapParams, generateWorld } from '../src/sim/mapgen';
import { F, OCC_BUILDING, OCC_INDUSTRY, T, occupantIndex, occupantKind } from '../src/sim/world';

const args = process.argv.slice(2).filter((a) => a !== '--');
const id = args[0] ?? '1';
const layout = MAP_BY_ID.get(id);
const size = Number(args[1] || layout?.size || 128);
const out = args[2] ?? `/tmp/map-${id}.png`;
const startYear = Number(args[3] ?? 1860);
const t0 = performance.now();
const w = generateWorld({ ...defaultMapParams(layout ? 7 : Number(id)), size, startYear, layout: layout?.id });
const ms = performance.now() - t0;

const SC = 4;
const W = w.width * SC;
const H = w.height * SC;
const raw = Buffer.alloc((W * 4 + 1) * H);
const put = (x: number, y: number, [r, g, b]: number[]) => {
  for (let dy = 0; dy < SC; dy++) {
    for (let dx = 0; dx < SC; dx++) {
      const o = (y * SC + dy) * (W * 4 + 1) + 1 + (x * SC + dx) * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = 255;
    }
  }
};
for (let y = 0; y < w.height; y++) {
  for (let x = 0; x < w.width; x++) {
    const i = w.tileIndex(x, y);
    const h = w.tileAvgH(x, y) / w.maxHeight;
    const shade = (c: number[]) => c.map((v) => Math.min(255, Math.round(v * (0.65 + h * 0.7))));
    let c: number[];
    switch (w.terrain[i]) {
      case T.Water: c = [40, 70, 160]; break;
      case T.Sand: c = shade([210, 190, 120]); break;
      case T.Forest: c = shade([30, 100, 40]); break;
      case T.Rough: c = shade([120, 110, 100]); break;
      case T.Snow: c = [240, 240, 245]; break;
      default: c = shade([90, 160, 70]);
    }
    if (w.flags[i] & F.River) c = [80, 150, 230];
    if (w.flags[i] & F.Road) c = [150, 150, 150];
    const occ = w.occupant[i];
    if (occupantKind(occ) === OCC_BUILDING) c = [200, 60, 50];
    if (occupantKind(occ) === OCC_INDUSTRY) c = INDUSTRY_BY_ID.get(w.industries[occupantIndex(occ)].defId)?.kind === 'raw' ? [240, 220, 40] : [220, 60, 220];
    put(x, y, c);
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
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 6;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));

const hist = new Array(w.maxHeight + 1).fill(0);
for (const v of w.heights) hist[v]++;
console.log(`${out}  ${w.width}×${w.height}  ${ms.toFixed(0)} ms`);
console.log('heights', hist.join(' '));
console.log('towns', w.cities.map((c) => `${c.name} ${c.population} @${c.x},${c.y}`).join(' | '));
const counts = new Map<string, number>();
for (const i of w.industries) counts.set(i.defId, (counts.get(i.defId) ?? 0) + 1);
console.log('industries', [...counts].map(([k, v]) => `${k}:${v}`).join(' '));
