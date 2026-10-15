import { describe, expect, it } from 'vitest';
import { Camera, ZOOMS } from '../src/render/camera';
import { fromView, project, rotatedSize, tileToView, toView, unproject, vecFromView, viewToTile, type Rot } from '../src/render/iso';
import { pickTile, viewCornerHeights } from '../src/render/pick';
import { defaultMapParams, generateWorld } from '../src/sim/mapgen';

const ROTS: Rot[] = [0, 1, 2, 3];

describe('view rotation', () => {
  it('round-trips points for all rotations on non-square maps', () => {
    for (const rot of ROTS) {
      for (const [x, y] of [[0, 0], [3.25, 7.5], [40, 10], [12, 30]]) {
        const [rx, ry] = toView(x, y, rot, 40, 30);
        const [bx, by] = fromView(rx, ry, rot, 40, 30);
        expect(bx).toBeCloseTo(x);
        expect(by).toBeCloseTo(y);
      }
    }
  });

  it('maps the world rectangle onto the rotated rectangle', () => {
    for (const rot of ROTS) {
      const [RW, RH] = rotatedSize(rot, 40, 30);
      for (const [x, y] of [[0, 0], [40, 0], [40, 30], [0, 30]]) {
        const [rx, ry] = toView(x, y, rot, 40, 30);
        expect(rx).toBeGreaterThanOrEqual(0);
        expect(ry).toBeGreaterThanOrEqual(0);
        expect(rx).toBeLessThanOrEqual(RW);
        expect(ry).toBeLessThanOrEqual(RH);
      }
    }
  });

  it('is a bijection on tiles', () => {
    for (const rot of ROTS) {
      const seen = new Set<string>();
      for (let y = 0; y < 6; y++) {
        for (let x = 0; x < 9; x++) {
          const [rx, ry] = tileToView(x, y, rot, 9, 6);
          seen.add(`${rx},${ry}`);
          expect(viewToTile(rx, ry, rot, 9, 6)).toEqual([x, y]);
        }
      }
      expect(seen.size).toBe(54);
    }
  });

  it('rotates direction vectors consistently with points', () => {
    for (const rot of ROTS) {
      const [ax, ay] = fromView(5, 5, rot, 20, 20);
      const [bx, by] = fromView(6, 7, rot, 20, 20);
      const [dx, dy] = vecFromView(1, 2, rot);
      expect(bx - ax).toBeCloseTo(dx);
      expect(by - ay).toBeCloseTo(dy);
    }
  });
});

describe('projection', () => {
  it('is 2:1 dimetric with tw/8 px per height level', () => {
    expect(project(1, 0, 0, 32)).toEqual([16, 8]);
    expect(project(0, 1, 0, 32)).toEqual([-16, 8]);
    expect(project(0, 0, 1, 32)).toEqual([0, -4]);
  });

  it('unproject inverts project on a height plane', () => {
    for (const tw of [8, 16, 32]) {
      const [sx, sy] = project(12.5, 3.25, 4, tw);
      const [rx, ry] = unproject(sx, sy, 4, tw);
      expect(rx).toBeCloseTo(12.5);
      expect(ry).toBeCloseTo(3.25);
    }
  });
});

describe('camera', () => {
  it('maps its centre to the middle of the view', () => {
    const cam = new Camera(64, 64);
    cam.viewW = 640;
    cam.viewH = 360;
    cam.centerOn(20, 30);
    const [sx, sy] = cam.worldToScreen(20, 30, 0);
    expect(Math.abs(sx - 320)).toBeLessThanOrEqual(1);
    expect(Math.abs(sy - 180)).toBeLessThanOrEqual(1);
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    for (const rot of ROTS) {
      const cam = new Camera(128, 128);
      cam.rot = rot;
      cam.viewW = 640;
      cam.viewH = 360;
      cam.centerOn(60, 60);
      const before = cam.screenToWorld(500, 100);
      cam.zoomAt(500, 100, 3);
      const after = cam.screenToWorld(500, 100);
      expect(after[0]).toBeCloseTo(before[0], 0);
      expect(after[1]).toBeCloseTo(before[1], 0);
      expect(cam.zoom).toBe(3);
      cam.zoomAt(500, 100, 99);
      expect(cam.zoom).toBe(ZOOMS.length - 1);
    }
  });

  it('pans so that content follows the pointer', () => {
    for (const rot of ROTS) {
      const cam = new Camera(128, 128);
      cam.rot = rot;
      cam.viewW = 640;
      cam.viewH = 360;
      const p = cam.screenToWorld(300, 200);
      cam.panByScreen(40, -20);
      const q = cam.screenToWorld(340, 180);
      expect(q[0]).toBeCloseTo(p[0], 1);
      expect(q[1]).toBeCloseTo(p[1], 1);
    }
  });

  it('rotates in 90° steps and wraps', () => {
    const cam = new Camera(10, 10);
    cam.rotate(-1);
    expect(cam.rot).toBe(3);
    cam.rotate(1);
    cam.rotate(1);
    expect(cam.rot).toBe(1);
  });
});

describe('picking', () => {
  const world = generateWorld({ ...defaultMapParams(9), size: 48 });

  it('returns the tile whose surface centre was clicked, for all rotations and zooms', () => {
    for (const rot of ROTS) {
      for (const tw of [16, 32]) {
        for (let y = 2; y < 46; y += 7) {
          for (let x = 2; x < 46; x += 5) {
            const [rx, ry] = toView(x + 0.5, y + 0.5, rot, 48, 48);
            const [sx, sy] = project(rx, ry, world.surfaceHeight(x + 0.5, y + 0.5), tw);
            expect(pickTile(world, rot, tw, sx, sy)).toEqual([x, y]);
          }
        }
      }
    }
  });

  it('view corner heights are a rotation of world corner heights', () => {
    const [a, b, c, d] = world.corners(10, 12);
    const all = [a, b, c, d].sort().join();
    for (const rot of ROTS) {
      const [rx, ry] = tileToView(10, 12, rot, 48, 48);
      expect([...viewCornerHeights(world, rot, rx, ry)].sort().join()).toBe(all);
    }
  });
});

describe('vector rotation', () => {
  it('vecToView inverts vecFromView', async () => {
    const { vecToView } = await import('../src/render/iso');
    for (const rot of ROTS) {
      const [vx, vy] = vecToView(0.3, -0.7, rot);
      const [x, y] = vecFromView(vx, vy, rot);
      expect(x).toBeCloseTo(0.3);
      expect(y).toBeCloseTo(-0.7);
    }
  });
});
