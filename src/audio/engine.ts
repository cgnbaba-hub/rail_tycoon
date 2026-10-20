import { prefs } from '../ui/prefs';
import { SONGS, composeBar, midiToHz, type NoteEvent, type Song } from './music';

/**
 * WebAudio chiptune player and sound effects. Everything is synthesised: square/triangle
 * oscillators for the music, filtered noise for drums, steam and construction sounds.
 * The audio context starts on the first user gesture (browser autoplay rules).
 */

export type Sfx = 'cash' | 'whistle' | 'chuff' | 'ticker' | 'build' | 'bulldoze' | 'alarm' | 'click';

const CHORUSES_PER_SONG = 3;
const LOOKAHEAD = 0.15;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicGain!: GainNode;
  private sfxGain!: GainNode;
  private noise!: AudioBuffer;
  private pulse!: PeriodicWave;
  private timer: number | null = null;
  private song = 0;
  private bar = 0;
  private barStart = 0;
  private seed = 1;
  private lastSfx = new Map<Sfx, number>();

  /** Call from a user gesture; safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.setup(new AC());
    this.seed = Math.floor(Math.random() * 1e6);
    this.song = Math.floor(Math.random() * SONGS.length);
    this.applyVolumes();
    this.barStart = this.ctx!.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 50);
  }

  private setup(ctx: BaseAudioContext): void {
    this.ctx = ctx as AudioContext;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.musicGain = ctx.createGain();
    this.musicGain.connect(this.master);
    this.sfxGain = ctx.createGain();
    this.sfxGain.connect(this.master);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let x = 1;
    for (let i = 0; i < len; i++) {
      // LFSR-style noise like old sound chips.
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (x / 0x3fffffff - 1) * 0.8;
    }
    // 25 % pulse wave (the classic NES lead).
    const n = 32;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let k = 1; k < n; k++) im[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * 0.25);
    this.pulse = ctx.createPeriodicWave(re, im);
  }

  /**
   * Render music (song index, a few bars) followed by every sound effect into an offline
   * buffer — used to preview the audio without a speaker.
   */
  async renderPreview(songIndex: number, bars: number): Promise<AudioBuffer> {
    const song = SONGS[songIndex];
    const barLen = (60 / song.bpm) * 4;
    const sfx: Sfx[] = ['cash', 'whistle', 'chuff', 'chuff', 'chuff', 'ticker', 'build', 'bulldoze', 'alarm'];
    const seconds = bars * barLen + sfx.length * 1.3 + 1;
    const off = new OfflineAudioContext(1, Math.ceil(seconds * 44100), 44100);
    this.setup(off);
    this.master.gain.value = 0.6;
    this.musicGain.gain.value = 0.35 * 0.8;
    this.sfxGain.gain.value = 0.8;
    for (let bar = 0; bar < bars; bar++) for (const ev of composeBar(song, bar, 3)) this.play(ev, bar * barLen + ev.beat * (60 / song.bpm), 60 / song.bpm);
    sfx.forEach((k, i) => this.sfxAt(k, bars * barLen + 0.5 + i * 1.3));
    const buf = await off.startRendering();
    this.ctx = null;
    return buf;
  }

  applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(prefs.muted ? 0 : 0.6, t, 0.05);
    this.musicGain.gain.setTargetAtTime(prefs.music * 0.35, t, 0.05);
    this.sfxGain.gain.setTargetAtTime(prefs.sfx * 0.8, t, 0.05);
  }

  get currentSong(): Song {
    return SONGS[this.song];
  }

  // -- music -----------------------------------------------------------------------------

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const song = SONGS[this.song];
    const beat = 60 / song.bpm;
    const barLen = beat * 4;
    while (this.barStart < ctx.currentTime + LOOKAHEAD) {
      if (prefs.music > 0 && !prefs.muted) for (const ev of composeBar(song, this.bar, this.seed)) this.play(ev, this.barStart + ev.beat * beat, beat);
      this.barStart += barLen;
      this.bar++;
      if (this.bar >= song.form.length * CHORUSES_PER_SONG) {
        this.bar = 0;
        this.song = (this.song + 1) % SONGS.length;
        this.seed++;
        this.barStart += barLen; // a bar of rest between songs
        return;
      }
    }
  }

  private play(ev: NoteEvent, when: number, beat: number): void {
    const ctx = this.ctx!;
    const dur = ev.len * beat;
    switch (ev.voice) {
      case 'bass':
        this.tone('triangle', midiToHz(ev.midi), when, dur, ev.vel * 0.8, this.musicGain);
        break;
      case 'chord':
        this.tone('square', midiToHz(ev.midi), when, dur, ev.vel * 0.12, this.musicGain, 2200);
        break;
      case 'lead': {
        const o = this.tone(this.pulse, midiToHz(ev.midi), when, dur, ev.vel * 0.3, this.musicGain, 3000);
        // A little harmonica vibrato on held notes.
        if (dur > beat * 0.8) {
          const lfo = ctx.createOscillator();
          const depth = ctx.createGain();
          lfo.frequency.value = 5.5;
          depth.gain.value = midiToHz(ev.midi) * 0.01;
          lfo.connect(depth).connect(o.frequency);
          lfo.start(when + dur * 0.3);
          lfo.stop(when + dur);
        }
        break;
      }
      case 'kick': {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.setValueAtTime(110, when);
        o.frequency.exponentialRampToValueAtTime(40, when + 0.12);
        g.gain.setValueAtTime(ev.vel * 0.9, when);
        g.gain.exponentialRampToValueAtTime(0.001, when + 0.18);
        o.connect(g).connect(this.musicGain);
        o.start(when);
        o.stop(when + 0.2);
        break;
      }
      case 'snare':
        this.noiseBurst(when, 0.12, ev.vel * 0.35, 1800, this.musicGain, 'bandpass');
        break;
      case 'hat':
        this.noiseBurst(when, 0.04, ev.vel * 0.18, 7000, this.musicGain, 'highpass');
        break;
    }
  }

  private tone(type: OscillatorType | PeriodicWave, hz: number, when: number, dur: number, vel: number, out: AudioNode, cutoff?: number): OscillatorNode {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    if (typeof type === 'string') o.type = type as OscillatorType;
    else o.setPeriodicWave(type);
    o.frequency.setValueAtTime(hz, when);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vel, when + 0.005);
    g.gain.setValueAtTime(vel, when + Math.max(0.01, dur - 0.04));
    g.gain.linearRampToValueAtTime(0, when + dur);
    let node: AudioNode = o;
    if (cutoff) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = cutoff;
      node = o.connect(f);
    }
    node.connect(g).connect(out);
    o.start(when);
    o.stop(when + dur + 0.02);
    return o;
  }

  private noiseBurst(when: number, dur: number, vel: number, freq: number, out: AudioNode, type: BiquadFilterType = 'lowpass', q = 0.8): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    src.connect(f).connect(g).connect(out);
    src.start(when, Math.random() * 0.5);
    src.stop(when + dur + 0.02);
  }

  // -- sound effects -----------------------------------------------------------------------

  /** Play a sound effect (rate-limited per kind). */
  sfx(kind: Sfx, volume = 1): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || prefs.muted || prefs.sfx <= 0) return;
    const now = ctx.currentTime;
    const gap = kind === 'chuff' ? 0.05 : kind === 'cash' ? 0.35 : 0.15;
    if (now - (this.lastSfx.get(kind) ?? -1) < gap) return;
    this.lastSfx.set(kind, now);
    this.sfxAt(kind, now + 0.01, volume);
  }

  private sfxAt(kind: Sfx, t: number, volume = 1): void {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = volume;
    out.connect(this.sfxGain);
    switch (kind) {
      case 'cash':
        // "Ka-ching": a drawer thunk, two bright blips and a ringing bell.
        this.noiseBurst(t, 0.05, 0.4, 900, out);
        this.tone('square', 1318, t + 0.04, 0.05, 0.18, out, 5000);
        this.tone('square', 2637, t + 0.09, 0.06, 0.15, out, 6000);
        this.tone('sine', 2093, t + 0.12, 0.5, 0.2, out);
        break;
      case 'whistle': {
        // Steam whistle: a detuned chord with a breathy attack and a sag at the end.
        for (const hz of [466, 587, 698]) {
          const o = this.tone('triangle', hz, t, 1.1, 0.12, out);
          o.frequency.setValueAtTime(hz * 0.97, t);
          o.frequency.linearRampToValueAtTime(hz, t + 0.1);
          o.frequency.setValueAtTime(hz, t + 0.9);
          o.frequency.linearRampToValueAtTime(hz * 0.95, t + 1.1);
        }
        this.noiseBurst(t, 1.0, 0.05, 2500, out, 'bandpass', 2);
        break;
      }
      case 'chuff':
        this.noiseBurst(t, 0.16, 0.35, 500, out, 'lowpass');
        break;
      case 'ticker':
        for (let k = 0; k < 7; k++) this.noiseBurst(t + k * 0.045, 0.015, 0.3, 4000, out, 'highpass');
        break;
      case 'build': {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.setValueAtTime(90, t);
        o.frequency.exponentialRampToValueAtTime(35, t + 0.18);
        g.gain.setValueAtTime(0.6, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + 0.26);
        this.noiseBurst(t, 0.12, 0.3, 300, out);
        this.noiseBurst(t + 0.16, 0.08, 0.2, 400, out);
        break;
      }
      case 'bulldoze':
        this.noiseBurst(t, 0.35, 0.45, 250, out);
        this.noiseBurst(t + 0.1, 0.25, 0.3, 120, out);
        break;
      case 'alarm':
        for (let k = 0; k < 3; k++) this.tone('square', k % 2 ? 660 : 880, t + k * 0.14, 0.12, 0.15, out, 4000);
        break;
      case 'click':
        this.tone('square', 1200, t, 0.02, 0.08, out, 4000);
        break;
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    void this.ctx?.close();
    this.ctx = null;
  }
}

export const audio = new AudioEngine();
