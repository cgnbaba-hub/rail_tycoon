import type { Camera } from '../render/camera';
import { rotatedSize, toView } from '../render/iso';
import { PALETTE, PALETTE_RGB, PAL, LIGHTER, DARKER } from '../render/palette';
import { NODE_TUNNEL } from '../sim/track';
import { F, OCC_BUILDING, OCC_INDUSTRY, T, occupantKind, type World } from '../sim/world';

type Affine = [number, number, number, number, number, number];

const TERRAIN_COLOR = [PAL.sea, PAL.sand, PAL.grass, PAL.pine, PAL.stone, PAL.snow];

/**
 * Diamond-shaped overview map that matches the main view's rotation. Click or drag to move
 * the camera; the white quad shows the visible area.
 */
export class Minimap {
  private image: HTMLCanvasElement | null = null;
  private world: World | null = null;
  private readonly ctx: CanvasRenderingContext2D;
  private dragging = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly onPick: (x: number, y: number) => void,
  ) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.pickAt(e);
    });
    canvas.addEventListener('pointermove', (e) => this.dragging && this.pickAt(e));
    canvas.addEventListener('pointerup', () => (this.dragging = false));
    canvas.addEventListener('pointercancel', () => (this.dragging = false));
  }

  private lastCamera: Camera | null = null;

  private pickAt(e: PointerEvent): void {
    if (!this.world || !this.lastCamera) return;
    const r = this.canvas.getBoundingClientRect();
    const px = ((e.clientX - r.left) * this.canvas.width) / r.width;
    const py = ((e.clientY - r.top) * this.canvas.height) / r.height;
    const m = this.transform(this.lastCamera);
    // Invert the 2×2 affine.
    const det = m[0] * m[3] - m[1] * m[2];
    const dx = px - m[4];
    const dy = py - m[5];
    const x = (m[3] * dx - m[2] * dy) / det;
    const y = (-m[1] * dx + m[0] * dy) / det;
    this.onPick(Math.max(0, Math.min(this.world.width, x)), Math.max(0, Math.min(this.world.height, y)));
  }

  setWorld(world: World): void {
    this.world = world;
    this.refresh();
  }

  /** Re-render the terrain image (call after construction). */
  refresh(): void {
    const world = this.world;
    if (!world) return;
    const W = world.width;
    const H = world.height;
    const img = document.createElement('canvas');
    img.width = W;
    img.height = H;
    const ictx = img.getContext('2d')!;
    const data = ictx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const ter = world.terrain[i];
        let c: number = TERRAIN_COLOR[ter];
        if (ter !== T.Water) {
          const hf = world.tileAvgH(x, y) / world.maxHeight;
          if (hf > 0.45) c = LIGHTER[c];
          else if (hf < 0.12 && ter === T.Grass) c = DARKER[c];
        }
        if (world.flags[i] & F.River) c = PAL.shallow;
        if (world.flags[i] & F.Road) c = PAL.soil;
        const occ = world.occupant[i];
        if (occupantKind(occ) === OCC_BUILDING) c = PAL.brick;
        if (occupantKind(occ) === OCC_INDUSTRY) c = PAL.gold;
        const node = world.track.getIdx(i);
        if (node && node.kind !== NODE_TUNNEL) c = node.station >= 0 ? PAL.snow : PAL.ink;
        const [r, g, b] = PALETTE_RGB[c];
        data.data[i * 4] = r;
        data.data[i * 4 + 1] = g;
        data.data[i * 4 + 2] = b;
        data.data[i * 4 + 3] = 255;
      }
    }
    ictx.putImageData(data, 0, 0);
    this.image = img;
  }

  /** Affine world(tile) → minimap pixel for the current rotation. */
  private transform(camera: Camera): Affine {
    const world = this.world!;
    const W = world.width;
    const H = world.height;
    const [RW, RH] = rotatedSize(camera.rot, W, H);
    const k = (this.canvas.width - 4) / (RW + RH);
    const f = (x: number, y: number): [number, number] => {
      const [rx, ry] = toView(x, y, camera.rot, W, H);
      return [(rx - ry + RH) * k + 2, ((rx + ry) * k) / 2 + 2];
    };
    const [ox, oy] = f(0, 0);
    const [ax, ay] = f(1, 0);
    const [bx, by] = f(0, 1);
    return [ax - ox, ay - oy, bx - ox, by - oy, ox, oy];
  }

  draw(camera: Camera): void {
    if (!this.world || !this.image) return;
    this.lastCamera = camera;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const m = this.transform(camera);
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(...m);
    ctx.drawImage(this.image, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // City dots.
    ctx.fillStyle = PALETTE.bone;
    for (const c of this.world.cities) {
      const px = m[0] * (c.x + 0.5) + m[2] * (c.y + 0.5) + m[4];
      const py = m[1] * (c.x + 0.5) + m[3] * (c.y + 0.5) + m[5];
      const s = c.classIndex >= 2 ? 3 : 2;
      ctx.fillRect(Math.round(px - s / 2), Math.round(py - s / 2), s, s);
    }

    // Viewport quad.
    const corners: Array<[number, number]> = [
      [0, 0],
      [camera.viewW, 0],
      [camera.viewW, camera.viewH],
      [0, camera.viewH],
    ];
    ctx.strokeStyle = PALETTE.snow;
    ctx.lineWidth = 1;
    ctx.beginPath();
    corners.forEach(([sx, sy], i) => {
      const [x, y] = camera.screenToWorld(sx, sy);
      const px = Math.round(m[0] * x + m[2] * y + m[4]) + 0.5;
      const py = Math.round(m[1] * x + m[3] * y + m[5]) + 0.5;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.stroke();
  }
}
