/**
 * Dimetric 2:1 projection with four 90° view rotations.
 *
 * World coordinates (x, y) are continuous tile units; vertices sit on integers. A view
 * rotation maps world → view coordinates (rx, ry); projection then maps view coordinates and
 * a height (in levels) to world pixels:
 *   sx = (rx - ry) · tw/2
 *   sy = (rx + ry) · tw/4 - z · tw/8
 * so a tile is tw×tw/2 pixels and one height level is tw/8 pixels.
 */
export type Rot = 0 | 1 | 2 | 3;

export function rotatedSize(rot: Rot, W: number, H: number): [number, number] {
  return rot % 2 === 0 ? [W, H] : [H, W];
}

export function toView(x: number, y: number, rot: Rot, W: number, H: number): [number, number] {
  switch (rot) {
    case 0:
      return [x, y];
    case 1:
      return [H - y, x];
    case 2:
      return [W - x, H - y];
    case 3:
      return [y, W - x];
  }
}

export function fromView(rx: number, ry: number, rot: Rot, W: number, H: number): [number, number] {
  switch (rot) {
    case 0:
      return [rx, ry];
    case 1:
      return [ry, H - rx];
    case 2:
      return [W - rx, H - ry];
    case 3:
      return [W - ry, rx];
  }
}

/** Rotate a direction vector (no translation) from view space to world space. */
export function vecFromView(dx: number, dy: number, rot: Rot): [number, number] {
  switch (rot) {
    case 0:
      return [dx, dy];
    case 1:
      return [dy, -dx];
    case 2:
      return [-dx, -dy];
    case 3:
      return [-dy, dx];
  }
}

/** World tile → view tile. */
export function tileToView(tx: number, ty: number, rot: Rot, W: number, H: number): [number, number] {
  const [rx, ry] = toView(tx + 0.5, ty + 0.5, rot, W, H);
  return [Math.floor(rx), Math.floor(ry)];
}

/** View tile → world tile. */
export function viewToTile(rtx: number, rty: number, rot: Rot, W: number, H: number): [number, number] {
  const [x, y] = fromView(rtx + 0.5, rty + 0.5, rot, W, H);
  return [Math.floor(x), Math.floor(y)];
}

export function heightStep(tw: number): number {
  return tw / 8;
}

export function project(rx: number, ry: number, z: number, tw: number): [number, number] {
  return [((rx - ry) * tw) / 2, ((rx + ry) * tw) / 4 - (z * tw) / 8];
}

/** Inverse of `project` on the plane at height z. */
export function unproject(sx: number, sy: number, z: number, tw: number): [number, number] {
  const a = sx / (tw / 2);
  const b = (sy + (z * tw) / 8) / (tw / 4);
  return [(a + b) / 2, (b - a) / 2];
}
