import { MinHeap } from './heap';
import { canTurn, stepLength } from './track';
import type { World } from './world';

export interface TrainPath {
  /** Node (tile) indices from the start node to the goal node inclusive. */
  nodes: number[];
  /** Length in tiles. */
  length: number;
}

/**
 * Shortest path for a train over existing track, honouring the ≤45° turn rule.
 * `heading` is the train's current direction of travel (0–7) or -1 when it may leave in
 * any direction (e.g. after reversing in a station).
 */
export function findTrainPath(world: World, start: number, heading: number, goals: ReadonlySet<number>): TrainPath | null {
  const track = world.track;
  if (!track.getIdx(start)) return null;
  if (goals.has(start)) return { nodes: [start], length: 0 };
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const heap = new MinHeap();
  const startState = start * 9 + (heading < 0 ? 8 : heading);
  dist.set(startState, 0);
  heap.push(0, startState);
  let found = -1;
  let expansions = 0;
  while (heap.size > 0) {
    const s = heap.pop();
    const t = Math.floor(s / 9);
    const din = s % 9;
    const g = dist.get(s)!;
    if (goals.has(t) && t !== start) {
      found = s;
      break;
    }
    if (++expansions > 400000) break;
    const node = track.getIdx(t);
    if (!node) continue;
    for (let d = 0; d < 8; d++) {
      if (!(node.conn & (1 << d))) continue;
      if (din < 8 && !canTurn(din, d)) continue;
      const n = track.neighbor(t, d);
      if (n < 0) continue;
      const ns = n * 9 + d;
      const ng = g + stepLength(d);
      if (ng < (dist.get(ns) ?? Infinity)) {
        dist.set(ns, ng);
        prev.set(ns, s);
        heap.push(ng, ns);
      }
    }
  }
  if (found < 0) return null;
  const nodes: number[] = [];
  for (let s: number | undefined = found; s !== undefined; s = prev.get(s)) nodes.push(Math.floor(s / 9));
  nodes.reverse();
  return { nodes, length: dist.get(found)! };
}

/** Straight-line distance between two tiles, in tiles. */
export function tileDistance(world: World, a: number, b: number): number {
  const W = world.width;
  return Math.hypot((a % W) - (b % W), Math.floor(a / W) - Math.floor(b / W));
}
