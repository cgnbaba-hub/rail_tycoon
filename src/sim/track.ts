/**
 * Track network: one optional node per tile (at the tile centre) with up to eight
 * connections to neighbouring tiles. Bridges and tunnels are straight runs of "interior"
 * nodes whose height is interpolated between the two ground ends.
 *
 * Directions (world space, clockwise from east):
 *   0 E (+1,0)  1 SE (+1,+1)  2 S (0,+1)  3 SW (-1,+1)  4 W (-1,0)  5 NW (-1,-1)  6 N (0,-1)  7 NE (+1,-1)
 */
export const DX = [1, 1, 0, -1, -1, -1, 0, 1] as const;
export const DY = [0, 1, 1, 1, 0, -1, -1, -1] as const;
export const DIR_NAMES = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];

export function opposite(d: number): number {
  return (d + 4) & 7;
}

export function isDiagonal(d: number): boolean {
  return (d & 1) === 1;
}

/** Length of a step in direction d, in tiles. */
export function stepLength(d: number): number {
  return isDiagonal(d) ? Math.SQRT2 : 1;
}

/** Can a train travelling in direction `din` continue in direction `dout`? (≤ 45° turn) */
export function canTurn(din: number, dout: number): boolean {
  const diff = (dout - din + 8) & 7;
  return diff === 0 || diff === 1 || diff === 7;
}

export const NODE_GROUND = 0;
export const NODE_BRIDGE = 1;
export const NODE_TUNNEL = 2;

export interface TrackNode {
  /** Track height at the tile centre, in height levels. */
  z: number;
  /** Bit d set = connected to the neighbour in direction d. */
  conn: number;
  /** Bit d set = that connection is double track. */
  double: number;
  /** NODE_GROUND, NODE_BRIDGE (span interior) or NODE_TUNNEL (span interior). */
  kind: number;
  /** Bridge type index (CONSTRUCTION.bridges) for bridge interiors, else -1. */
  span: number;
  /** Station id or -1. */
  station: number;
}

export function cloneNode(n: TrackNode): TrackNode {
  return { ...n };
}

export function bitCount(v: number): number {
  let c = 0;
  for (let x = v; x; x &= x - 1) c++;
  return c;
}

export class TrackNetwork {
  readonly nodes = new Map<number, TrackNode>();

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  idx(x: number, y: number): number {
    return y * this.width + x;
  }

  get(x: number, y: number): TrackNode | undefined {
    return this.nodes.get(y * this.width + x);
  }

  getIdx(i: number): TrackNode | undefined {
    return this.nodes.get(i);
  }

  has(x: number, y: number): boolean {
    return this.nodes.has(y * this.width + x);
  }

  /** Index of the neighbour tile in direction d, or -1 off-map. */
  neighbor(i: number, d: number): number {
    const x = (i % this.width) + DX[d];
    const y = Math.floor(i / this.width) + DY[d];
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return y * this.width + x;
  }

  /** Direction from tile a to adjacent tile b, or -1. */
  dirBetween(a: number, b: number): number {
    const dx = (b % this.width) - (a % this.width);
    const dy = Math.floor(b / this.width) - Math.floor(a / this.width);
    for (let d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) return d;
    return -1;
  }

  connected(a: number, b: number): boolean {
    const d = this.dirBetween(a, b);
    if (d < 0) return false;
    const n = this.nodes.get(a);
    return !!n && (n.conn & (1 << d)) !== 0;
  }

  /** Connect two existing adjacent nodes (symmetric). */
  connect(a: number, b: number, double: boolean): void {
    const d = this.dirBetween(a, b);
    if (d < 0) throw new Error('connect: tiles not adjacent');
    const na = this.nodes.get(a);
    const nb = this.nodes.get(b);
    if (!na || !nb) throw new Error('connect: missing node');
    na.conn |= 1 << d;
    nb.conn |= 1 << opposite(d);
    if (double) {
      na.double |= 1 << d;
      nb.double |= 1 << opposite(d);
    }
  }

  disconnect(a: number, b: number): void {
    const d = this.dirBetween(a, b);
    if (d < 0) return;
    const na = this.nodes.get(a);
    const nb = this.nodes.get(b);
    if (na) {
      na.conn &= ~(1 << d);
      na.double &= ~(1 << d);
    }
    if (nb) {
      nb.conn &= ~(1 << opposite(d));
      nb.double &= ~(1 << opposite(d));
    }
  }

  isDouble(a: number, b: number): boolean {
    const d = this.dirBetween(a, b);
    const n = this.nodes.get(a);
    return d >= 0 && !!n && (n.double & (1 << d)) !== 0;
  }

  /**
   * Would a diagonal edge between a and b (adjacent diagonally) cross an existing
   * diagonal edge between the other two tiles of the 2×2 block?
   */
  crossesDiagonal(a: number, b: number): boolean {
    const d = this.dirBetween(a, b);
    if (d < 0 || !isDiagonal(d)) return false;
    const ax = a % this.width;
    const ay = Math.floor(a / this.width);
    const c1 = this.idx(ax + DX[d], ay);
    const c2 = this.idx(ax, ay + DY[d]);
    return this.connected(c1, c2);
  }

  /** Can a train arriving at node i travelling in direction din continue somewhere? */
  hasExitFor(i: number, din: number): boolean {
    const n = this.nodes.get(i);
    if (!n) return false;
    for (let d = 0; d < 8; d++) if (n.conn & (1 << d) && canTurn(din, d)) return true;
    return false;
  }

  /**
   * Starting from interior node i, collect the whole straight span (interior nodes only)
   * plus its two ground ends.
   */
  spanOf(i: number): { interior: number[]; ends: number[] } {
    const n = this.nodes.get(i);
    if (!n || n.kind === NODE_GROUND) return { interior: [], ends: [] };
    const interior = [i];
    const ends: number[] = [];
    for (let d = 0; d < 8; d++) {
      if (!(n.conn & (1 << d))) continue;
      let cur = this.neighbor(i, d);
      while (cur >= 0) {
        const c = this.nodes.get(cur);
        if (!c) break;
        if (c.kind === NODE_GROUND) {
          ends.push(cur);
          break;
        }
        interior.push(cur);
        cur = this.neighbor(cur, d);
      }
    }
    return { interior, ends };
  }

  /** Number of tiles that carry visible track (ground + bridge). */
  get size(): number {
    return this.nodes.size;
  }
}
