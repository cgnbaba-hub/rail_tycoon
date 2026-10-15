import { describe, expect, it } from 'vitest';
import { SONGS, composeBar, midiToHz, swingBeat } from '../src/audio/music';

describe('chiptune composer', () => {
  it('converts MIDI notes to pitch', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
    expect(midiToHz(81)).toBeCloseTo(880, 6);
  });

  it('swings the off-beat eighths', () => {
    expect(swingBeat(0, 1 / 3)).toBe(0);
    expect(swingBeat(1, 1 / 3)).toBeCloseTo(2 / 3, 6);
    expect(swingBeat(1, 0)).toBe(0.5);
  });

  it('writes every voice inside the bar, in key, reproducibly', () => {
    for (const song of SONGS) {
      for (let bar = 0; bar < song.form.length * 2; bar++) {
        const notes = composeBar(song, bar, 7);
        expect(notes).toEqual(composeBar(song, bar, 7));
        for (const n of notes) {
          expect(n.beat).toBeGreaterThanOrEqual(0);
          expect(n.beat).toBeLessThan(4);
          expect(n.vel).toBeGreaterThan(0);
          expect(n.vel).toBeLessThanOrEqual(1);
        }
        const voices = new Set(notes.map((n) => n.voice));
        for (const v of ['bass', 'chord', 'kick', 'snare', 'hat']) expect(voices.has(v as never)).toBe(true);
        // Bass follows the chord of the bar.
        const root = song.root + song.form[bar % song.form.length];
        expect(notes.find((n) => n.voice === 'bass')!.midi).toBe(root);
      }
      // The lead improvises: different seeds give different tunes.
      const a = composeBar(song, 4, 1).filter((n) => n.voice === 'lead').map((n) => n.midi);
      const b = composeBar(song, 4, 2).filter((n) => n.voice === 'lead').map((n) => n.midi);
      const c = composeBar(song, 4, 3).filter((n) => n.voice === 'lead').map((n) => n.midi);
      expect(JSON.stringify(a) !== JSON.stringify(b) || JSON.stringify(b) !== JSON.stringify(c)).toBe(true);
    }
  });
});
