/// <reference lib="webworker" />
import { generateWorld } from '../sim/mapgen';
import type { MapParams } from '../sim/world';
import { paintTiles } from './minimap';

/** Generates map previews off the main thread: {key, params} in, {key, w, h, rgba} out. */
self.onmessage = (e: MessageEvent<{ key: string; params: MapParams }>) => {
  const { key, params } = e.data;
  const world = generateWorld(params);
  const rgba = new Uint8ClampedArray(world.width * world.height * 4);
  paintTiles(world, [], rgba);
  (self as unknown as DedicatedWorkerGlobalScope).postMessage({ key, w: world.width, h: world.height, rgba }, [rgba.buffer]);
};
