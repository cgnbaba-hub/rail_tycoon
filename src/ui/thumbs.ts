import type { MapParams } from '../sim/world';

/**
 * Map previews for the scenario list and the new-map dialog, generated in a worker and kept
 * for the session. Drawn as a diamond like the minimap (north-west corner at the top left).
 */

const cache = new Map<string, ImageData>();
const waiting = new Map<string, Array<(img: ImageData) => void>>();
let worker: Worker | null = null;

function getWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./thumbs.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ key: string; w: number; h: number; rgba: Uint8ClampedArray<ArrayBuffer> }>) => {
      const { key, w, h, rgba } = e.data;
      const img = new ImageData(rgba, w, h);
      cache.set(key, img);
      for (const fn of waiting.get(key) ?? []) fn(img);
      waiting.delete(key);
    };
  } catch {
    worker = null;
  }
  return worker;
}

export function thumbKey(p: MapParams): string {
  return JSON.stringify([p.seed, p.size, p.water, p.hills, p.forests, p.cities, p.startYear, p.layout ?? '']);
}

/** Draw the preview of `params` into `canvas` once it is ready. */
export function drawThumb(canvas: HTMLCanvasElement, params: MapParams): void {
  const key = thumbKey(params);
  const done = (img: ImageData) => paint(canvas, img);
  const hit = cache.get(key);
  if (hit) return done(hit);
  const list = waiting.get(key);
  if (list) {
    list.push(done);
    return;
  }
  const w = getWorker();
  if (!w) return;
  waiting.set(key, [done]);
  w.postMessage({ key, params });
}

function paint(canvas: HTMLCanvasElement, img: ImageData): void {
  if (!canvas.isConnected) return;
  const src = document.createElement('canvas');
  src.width = img.width;
  src.height = img.height;
  src.getContext('2d')!.putImageData(img, 0, 0);
  const ctx = canvas.getContext('2d')!;
  const W = img.width;
  const H = img.height;
  const k = (canvas.width - 2) / (W + H);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  // Same projection as the minimap at rotation 0.
  ctx.setTransform(k, k / 2, -k, k / 2, H * k + 1, 1);
  ctx.drawImage(src, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
