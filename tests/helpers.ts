import { F, T, World } from '../src/sim/world';

/** A flat grass world at height `h` for construction tests. */
export function flatWorld(size = 32, h = 2): World {
  const w = new World(size, size, 16);
  w.heights.fill(h);
  w.terrain.fill(T.Grass);
  return w;
}

/** Turn a column of tiles into a river (x = const). */
export function addRiver(w: World, x: number): void {
  for (let y = 0; y < w.height; y++) w.flags[w.tileIndex(x, y)] |= F.River;
}

/** Raise a square hill of `levels` centred at (cx, cy), keeping |dh| <= 1. */
export function addHill(w: World, cx: number, cy: number, levels: number): void {
  for (let vy = 0; vy <= w.height; vy++) {
    for (let vx = 0; vx <= w.width; vx++) {
      const d = Math.max(Math.abs(vx - cx), Math.abs(vy - cy));
      const add = Math.max(0, levels - d);
      const i = w.vertexIndex(vx, vy);
      w.heights[i] = Math.max(w.heights[i], 2 + add);
    }
  }
}

/** Add a town of 3×3 houses whose block starts at (x, y). */
export function addTown(w: World, name: string, x: number, y: number, population: number, classIndex = 1): number {
  const cityId = w.cities.length;
  const ids: number[] = [];
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      const id = w.buildings.length;
      w.buildings.push({ id, cityId, x: x + dx, y: y + dy, defId: 'house', wall: 'cream', roof: 'tile', h: 9, pair: false });
      w.occupant[w.tileIndex(x + dx, y + dy)] = (1 << 24) | (id + 1);
      ids.push(id);
    }
  }
  w.cities.push({ id: cityId, name, x: x + 1, y: y + 1, population, classIndex, radius: 2, buildingIds: ids });
  return cityId;
}
