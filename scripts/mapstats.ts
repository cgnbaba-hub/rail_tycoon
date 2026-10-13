/** Dev helper: print map statistics.  npx vite-node scripts/mapstats.ts -- <seed> <size> */
import { generateWorld, defaultMapParams } from '../src/sim/mapgen';
import { TERRAIN_LABELS } from '../src/sim/world';

const args = process.argv.slice(2).filter((a) => a !== '--');
const w = generateWorld({ ...defaultMapParams(Number(args[0] ?? 1)), size: Number(args[1] ?? 128) });
const h = new Array(w.maxHeight + 1).fill(0);
for (const v of w.heights) h[v]++;
console.log('height histogram', h.join(' '));
const t = new Array(TERRAIN_LABELS.length).fill(0);
for (const v of w.terrain) t[v]++;
console.log('terrain', TERRAIN_LABELS.map((l, i) => `${l}:${t[i]}`).join(' '));
console.log('cities', w.cities.map((c) => `${c.name}(${c.population},r${c.radius})`).join(', '));
const counts = new Map<string, number>();
for (const i of w.industries) counts.set(i.defId, (counts.get(i.defId) ?? 0) + 1);
console.log('industries', [...counts].map(([k, v]) => `${k}:${v}`).join(' '));
console.log('classes', w.cities.map((c) => c.classIndex).join(','));
