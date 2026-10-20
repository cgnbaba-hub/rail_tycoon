import './styles.css';
import { MAPGEN, MAP_BY_ID, validateData } from './data';
import { defaultMapParams } from './sim/mapgen';
import { seedFromString } from './sim/rng';
import type { MapParams } from './sim/world';
import { App, withLoading } from './ui/app';
import { loadPixelFont } from './ui/pixelFont';
import { applyTheme } from './ui/theme';

function paramsFromUrl(): MapParams {
  const q = new URLSearchParams(window.location.search);
  const seedText = q.get('seed');
  const seed = seedText ? seedFromString(seedText) : Math.floor(Math.random() * 1_000_000);
  const p = defaultMapParams(seed);
  const size = Number(q.get('size'));
  const layout = MAP_BY_ID.get(q.get('map') ?? '');
  if (layout) {
    p.layout = layout.id;
    p.size = layout.size;
  }
  if (MAPGEN.sizes.includes(size)) p.size = size;
  return p;
}

async function boot(): Promise<void> {
  validateData();
  applyTheme();
  await loadPixelFont();
  const app = new App();
  // Handy for debugging and automated browser checks.
  (window as unknown as { ironBaron: App }).ironBaron = app;
  const q = new URLSearchParams(window.location.search);
  const showTitle = !q.has('seed') && !q.has('map');
  withLoading('Surveying the land…', () => {
    app.newGame(paramsFromUrl());
    app.start();
    if (showTitle) app.openTitle();
  });
}

void boot();
