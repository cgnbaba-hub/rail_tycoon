import { hash2 } from './rng';

/**
 * Seeded 2D value noise with quintic interpolation, plus fractal Brownian motion.
 * Output of `valueNoise` is in [0, 1]; `fbm` is normalised back to [0, 1].
 */
function lattice(ix: number, iy: number, seed: number): number {
  return hash2(ix, iy, seed) / 4294967295;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const a = lattice(x0, y0, seed);
  const b = lattice(x0 + 1, y0, seed);
  const c = lattice(x0, y0 + 1, seed);
  const d = lattice(x0 + 1, y0 + 1, seed);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}

export interface FbmOptions {
  octaves: number;
  /** Frequency multiplier per octave. */
  lacunarity: number;
  /** Amplitude multiplier per octave. */
  gain: number;
}

export function fbm(x: number, y: number, seed: number, opts: FbmOptions): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < opts.octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, (seed + o * 1013) >>> 0);
    norm += amp;
    amp *= opts.gain;
    freq *= opts.lacunarity;
  }
  return sum / norm;
}
