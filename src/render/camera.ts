import { project, rotatedSize, toView, unproject, fromView, vecFromView, type Rot } from './iso';

export interface ZoomLevel {
  /** Tile width the terrain is rasterised at. */
  tw: number;
  /** Integer upscale applied when blitting. */
  scale: number;
  label: string;
}

export const ZOOMS: readonly ZoomLevel[] = [
  { tw: 8, scale: 1, label: '1/4' },
  { tw: 16, scale: 1, label: '1/2' },
  { tw: 32, scale: 1, label: '1x' },
  { tw: 64, scale: 1, label: '2x' },
  { tw: 64, scale: 2, label: '4x' },
];

/**
 * Camera over a W×H world. Position (x, y) is the world point (at sea level) shown at the
 * centre of the view buffer.
 */
export class Camera {
  x: number;
  y: number;
  zoom: number;
  rot: Rot = 0;
  viewW = 640;
  viewH = 360;

  constructor(
    readonly worldW: number,
    readonly worldH: number,
  ) {
    this.x = worldW / 2;
    this.y = worldH / 2;
    this.zoom = 2;
  }

  get level(): ZoomLevel {
    return ZOOMS[this.zoom];
  }

  get tw(): number {
    return this.level.tw;
  }

  get scale(): number {
    return this.level.scale;
  }

  /** World-pixel coordinates (at current tw) of the camera centre, snapped to whole pixels. */
  centerPx(): [number, number] {
    const [rx, ry] = toView(this.x, this.y, this.rot, this.worldW, this.worldH);
    const [sx, sy] = project(rx, ry, 0, this.tw);
    return [Math.round(sx), Math.round(sy)];
  }

  /** World pixel → buffer pixel. */
  toScreen(wx: number, wy: number): [number, number] {
    const [cx, cy] = this.centerPx();
    const s = this.scale;
    return [(wx - cx) * s + Math.floor(this.viewW / 2), (wy - cy) * s + Math.floor(this.viewH / 2)];
  }

  /** Buffer pixel → world pixel. */
  toWorldPx(sx: number, sy: number): [number, number] {
    const [cx, cy] = this.centerPx();
    const s = this.scale;
    return [(sx - Math.floor(this.viewW / 2)) / s + cx, (sy - Math.floor(this.viewH / 2)) / s + cy];
  }

  /** Project a world position (tiles, height levels) to buffer pixels. */
  worldToScreen(x: number, y: number, z: number): [number, number] {
    const [rx, ry] = toView(x, y, this.rot, this.worldW, this.worldH);
    const [wx, wy] = project(rx, ry, z, this.tw);
    return this.toScreen(wx, wy);
  }

  /** Buffer pixel → world position on the plane at height z. */
  screenToWorld(sx: number, sy: number, z = 0): [number, number] {
    const [wx, wy] = this.toWorldPx(sx, sy);
    const [rx, ry] = unproject(wx, wy, z, this.tw);
    return fromView(rx, ry, this.rot, this.worldW, this.worldH);
  }

  /** Move the view by a buffer-pixel delta (content follows the pointer). */
  panByScreen(dsx: number, dsy: number): void {
    const s = this.scale;
    const tw = this.tw;
    const a = -dsx / s / (tw / 2);
    const b = -dsy / s / (tw / 4);
    const [dx, dy] = vecFromView((a + b) / 2, (b - a) / 2, this.rot);
    this.x += dx;
    this.y += dy;
    this.clamp();
  }

  panByWorld(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
    this.clamp();
  }

  /** Change zoom keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, newZoom: number): void {
    const z = Math.max(0, Math.min(ZOOMS.length - 1, newZoom));
    if (z === this.zoom) return;
    const [bx, by] = this.screenToWorld(sx, sy);
    this.zoom = z;
    const [ax, ay] = this.screenToWorld(sx, sy);
    this.x += bx - ax;
    this.y += by - ay;
    this.clamp();
  }

  rotate(dir: 1 | -1): void {
    this.rot = (((this.rot + dir) % 4) + 4) % 4 as Rot;
  }

  centerOn(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.x = x;
    this.y = y;
    this.clamp();
  }

  clamp(): void {
    this.x = Math.max(0, Math.min(this.worldW, this.x));
    this.y = Math.max(0, Math.min(this.worldH, this.y));
  }

  rotatedSize(): [number, number] {
    return rotatedSize(this.rot, this.worldW, this.worldH);
  }
}
