import type { World } from '../sim/world';
import { fromView, project, rotatedSize, unproject, viewToTile, type Rot } from './iso';

/** View-space corner heights of view tile (rx, ry): [N, E, S, W] = (rx,ry) (rx+1,ry) (rx+1,ry+1) (rx,ry+1). */
export function viewCornerHeights(world: World, rot: Rot, rx: number, ry: number): [number, number, number, number] {
  const W = world.width;
  const H = world.height;
  const v = (a: number, b: number): number => {
    const [x, y] = fromView(a, b, rot, W, H);
    return world.vh(Math.round(x), Math.round(y));
  };
  return [v(rx, ry), v(rx + 1, ry), v(rx + 1, ry + 1), v(rx, ry + 1)];
}

function inTri(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * Find the world tile whose rendered surface contains world pixel (wx, wy) at tile width tw.
 * Walks candidate tiles on every height plane and returns the front-most hit.
 */
export function pickTile(world: World, rot: Rot, tw: number, wx: number, wy: number): [number, number] | null {
  const [RW, RH] = rotatedSize(rot, world.width, world.height);
  let best: [number, number] | null = null;
  let bestDepth = -Infinity;
  const seen = new Set<number>();
  for (let h = world.maxHeight; h >= 0; h--) {
    const [frx, fry] = unproject(wx, wy, h, tw);
    const brx = Math.floor(frx);
    const bry = Math.floor(fry);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const rx = brx + dx;
        const ry = bry + dy;
        if (rx < 0 || ry < 0 || rx >= RW || ry >= RH) continue;
        const key = ry * RW + rx;
        if (seen.has(key)) continue;
        seen.add(key);
        const depth = rx + ry;
        if (depth <= bestDepth) continue;
        const [hn, he, hs, hw] = viewCornerHeights(world, rot, rx, ry);
        const [nx, ny] = project(rx, ry, hn, tw);
        const [ex, ey] = project(rx + 1, ry, he, tw);
        const [sx, sy] = project(rx + 1, ry + 1, hs, tw);
        const [qx, qy] = project(rx, ry + 1, hw, tw);
        if (inTri(wx, wy, nx, ny, ex, ey, sx, sy) || inTri(wx, wy, nx, ny, sx, sy, qx, qy) ||
            inTri(wx, wy, nx, ny, ex, ey, qx, qy) || inTri(wx, wy, ex, ey, sx, sy, qx, qy)) {
          best = viewToTile(rx, ry, rot, world.width, world.height);
          bestDepth = depth;
        }
      }
    }
  }
  return best;
}
