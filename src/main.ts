import './styles.css';
import { MAPGEN, validateData } from './data';
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
  if (MAPGEN.sizes.includes(size)) p.size = size;
  return p;
}

async function boot(): Promise<void> {
  validateData();
  applyTheme();
  await loadPixelFont();
  const app = new App();
  withLoading('Surveying the land…', () => {
    app.newGame(paramsFromUrl());
    app.start();
  });
}

void boot();
