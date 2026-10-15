import { Rng } from '../sim/rng';

/**
 * Procedural 8-bit railroad blues. Pure note generation (no WebAudio here): a song is a
 * 12-bar form; every bar is turned into note events for bass, rhythm, lead and drums.
 */

export type Voice = 'bass' | 'chord' | 'lead' | 'kick' | 'snare' | 'hat';

export interface NoteEvent {
  voice: Voice;
  /** Start time in beats from the start of the bar. */
  beat: number;
  /** Length in beats. */
  len: number;
  /** MIDI note number (ignored for drums). */
  midi: number;
  vel: number;
}

export interface Song {
  id: string;
  name: string;
  /** Beats per minute. */
  bpm: number;
  /** Swing: 0 = straight eighths, 1/3 = full triplet shuffle. */
  swing: number;
  /** MIDI root of the key. */
  root: number;
  /** Chord per bar as semitones above the root (12-bar form). */
  form: number[];
  style: 'shuffle' | 'bluegrass' | 'slow';
}

export const SONGS: Song[] = [
  { id: 'blues', name: 'Iron Horse Blues', bpm: 104, swing: 1 / 3, root: 40, form: [0, 5, 0, 0, 5, 5, 0, 0, 7, 5, 0, 7], style: 'shuffle' },
  { id: 'bluegrass', name: 'Bluegrass Express', bpm: 148, swing: 0, root: 43, form: [0, 0, 5, 0, 0, 0, 7, 7, 0, 0, 5, 0, 0, 7, 0, 0], style: 'bluegrass' },
  { id: 'midnight', name: 'Midnight Freight', bpm: 78, swing: 1 / 3, root: 45, form: [0, 5, 0, 0, 5, 5, 0, 0, 7, 5, 0, 7], style: 'slow' },
];

/** Minor-pentatonic + blue note, relative to the root. */
const BLUES_SCALE = [0, 3, 5, 6, 7, 10, 12, 15, 17];
/** Major pentatonic (bluegrass). */
const MAJOR_PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19];
/** Boogie bass line over a chord (eighths). */
const BOOGIE = [0, 4, 7, 9, 10, 9, 7, 4];
/** Alternating root–fifth bass (bluegrass "boom-chick"). */
const ROOT_FIFTH = [0, 7, 0, 7];

/** Beat position of eighth note k with swing applied. */
export function swingBeat(k: number, swing: number): number {
  return Math.floor(k / 2) + (k % 2 === 1 ? 0.5 + swing / 2 : 0);
}

/**
 * Notes of one bar. `bar` counts from the start of the song (the form repeats); `seed`
 * varies the improvised lead so every chorus sounds a little different but stays
 * reproducible.
 */
export function composeBar(song: Song, bar: number, seed: number): NoteEvent[] {
  const out: NoteEvent[] = [];
  const pos = bar % song.form.length;
  const chord = song.form[pos];
  const root = song.root + chord;
  const rng = new Rng((seed * 7919 + bar * 104729 + song.bpm) >>> 0);
  const last = pos === song.form.length - 1;

  // Bass.
  if (song.style === 'bluegrass') {
    ROOT_FIFTH.forEach((iv, k) => out.push({ voice: 'bass', beat: k, len: 0.8, midi: root + iv, vel: 0.9 }));
  } else {
    BOOGIE.forEach((iv, k) => out.push({ voice: 'bass', beat: swingBeat(k, song.swing), len: 0.45, midi: root + iv, vel: k % 2 ? 0.7 : 0.9 }));
  }

  // Rhythm: dominant-seventh stabs on the off-beats ("chick").
  const triad = [0, 4, 7, 10].map((iv) => root + 12 + iv);
  for (const beat of song.style === 'bluegrass' ? [0.5, 1.5, 2.5, 3.5] : [1, 3]) {
    for (const m of triad) out.push({ voice: 'chord', beat: song.style === 'bluegrass' ? beat : beat + 0.02, len: song.style === 'slow' ? 0.9 : 0.3, midi: m, vel: 0.35 });
  }

  // Lead: phrases of 2 bars, call (odd) and response (even), rests in between.
  const scale = song.style === 'bluegrass' ? MAJOR_PENTA : BLUES_SCALE;
  const base = song.root + 24;
  const phrase = Math.floor(bar / 2) % 4;
  const density = song.style === 'slow' ? 0.35 : song.style === 'bluegrass' ? 0.8 : 0.55;
  if (!(phrase === 3 && bar % 2 === 1)) {
    let idx = rng.int(2, 5);
    const steps = song.style === 'bluegrass' ? 8 : 8;
    for (let k = 0; k < steps; k++) {
      if (rng.next() > density) continue;
      idx = Math.max(0, Math.min(scale.length - 1, idx + rng.int(-2, 2)));
      const beat = song.style === 'bluegrass' ? k * 0.5 : swingBeat(k, song.swing);
      const held = rng.next() < 0.25 ? 1 : 0.45;
      out.push({ voice: 'lead', beat, len: held, midi: base + scale[idx], vel: 0.55 + rng.next() * 0.3 });
    }
  }
  // Turnaround: land on the root at the end of the form.
  if (last) out.push({ voice: 'lead', beat: 3, len: 1, midi: base, vel: 0.8 });

  // Drums: a train beat — kick on 1 and 3, brushes on 2 and 4, hats chugging on the eighths.
  for (const b of [0, 2]) out.push({ voice: 'kick', beat: b, len: 0.2, midi: 0, vel: 0.9 });
  for (const b of [1, 3]) out.push({ voice: 'snare', beat: b, len: 0.15, midi: 0, vel: song.style === 'slow' ? 0.4 : 0.6 });
  for (let k = 0; k < 8; k++) out.push({ voice: 'hat', beat: song.style === 'bluegrass' ? k * 0.5 : swingBeat(k, song.swing), len: 0.05, midi: 0, vel: k % 2 ? 0.35 : 0.2 });
  return out;
}

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}
