/**
 * The one and only Iron Baron palette: 32 colours, original values.
 * Everything that is drawn into the world buffer must use these entries.
 * UI CSS mirrors them via CSS custom properties (see ui/theme.ts).
 */
export const PALETTE = {
  ink: '#120f1c',
  night: '#25203a',
  slate: '#3b3d5a',
  steel: '#6a6e88',
  fog: '#a5a9bf',
  bone: '#ece6d6',
  deepSea: '#1b356a',
  sea: '#2b5fa4',
  shallow: '#4a8ecb',
  foam: '#9ed1e6',
  sand: '#e2cc8c',
  dune: '#bf9f5f',
  meadow: '#93c958',
  grass: '#5fa53c',
  moss: '#3e7b32',
  pine: '#2a5a2d',
  fir: '#1a3c25',
  soil: '#8a6a3e',
  loam: '#5c4228',
  stone: '#8e8478',
  shale: '#605854',
  snow: '#f3f5fb',
  brick: '#a6463a',
  oxblood: '#6c2c2e',
  tile: '#cf5a39',
  ember: '#e88b2f',
  gold: '#f2c84a',
  wheat: '#d6b45c',
  teal: '#2f8a7c',
  rust: '#8b4a2a',
  cream: '#f4e2b6',
  sky: '#5a7ed6',
} as const;

export type PaletteName = keyof typeof PALETTE;

export const PALETTE_NAMES = Object.keys(PALETTE) as PaletteName[];

/** Palette index by name (stable ordering = declaration order). */
export const PAL: Record<PaletteName, number> = Object.fromEntries(
  PALETTE_NAMES.map((n, i) => [n, i]),
) as Record<PaletteName, number>;

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export const PALETTE_RGB: [number, number, number][] = PALETTE_NAMES.map((n) => hexToRgb(PALETTE[n]));

/**
 * Colours packed as little-endian ABGR uint32, ready to be written into a Uint32Array view of
 * ImageData (all browsers we target are little-endian).
 */
export const PALETTE_U32: Uint32Array = new Uint32Array(
  PALETTE_RGB.map(([r, g, b]) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0),
);

export function colorIndex(name: string): number {
  const idx = (PAL as Record<string, number>)[name];
  if (idx === undefined) throw new Error(`Unknown palette colour: ${name}`);
  return idx;
}

/** Hand-tuned "one step darker" for each palette entry (used for shaded faces). */
const DARKER_NAMES: Record<PaletteName, PaletteName> = {
  ink: 'ink', night: 'ink', slate: 'night', steel: 'slate', fog: 'steel', bone: 'fog',
  deepSea: 'night', sea: 'deepSea', shallow: 'sea', foam: 'shallow',
  sand: 'dune', dune: 'soil', meadow: 'grass', grass: 'moss', moss: 'pine', pine: 'fir', fir: 'ink',
  soil: 'loam', loam: 'night', stone: 'shale', shale: 'slate', snow: 'fog',
  brick: 'oxblood', oxblood: 'night', tile: 'brick', ember: 'rust', gold: 'wheat', wheat: 'dune',
  teal: 'pine', rust: 'loam', cream: 'wheat', sky: 'slate',
};

/** Hand-tuned "one step lighter" for each palette entry (used for lit faces/highlights). */
const LIGHTER_NAMES: Record<PaletteName, PaletteName> = {
  ink: 'night', night: 'slate', slate: 'steel', steel: 'fog', fog: 'bone', bone: 'snow',
  deepSea: 'sea', sea: 'shallow', shallow: 'foam', foam: 'snow',
  sand: 'cream', dune: 'sand', meadow: 'cream', grass: 'meadow', moss: 'grass', pine: 'moss', fir: 'pine',
  soil: 'dune', loam: 'soil', stone: 'fog', shale: 'stone', snow: 'snow',
  brick: 'tile', oxblood: 'brick', tile: 'ember', ember: 'gold', gold: 'cream', wheat: 'gold',
  teal: 'foam', rust: 'soil', cream: 'bone', sky: 'foam',
};

export const DARKER: number[] = PALETTE_NAMES.map((n) => PAL[DARKER_NAMES[n]]);
export const LIGHTER: number[] = PALETTE_NAMES.map((n) => PAL[LIGHTER_NAMES[n]]);
