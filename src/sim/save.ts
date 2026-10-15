import { AIBaron } from './ai';
import { Chairman } from './chairman';
import { Company } from './company';
import { EconomicCycle } from './cycle';
import { Economy } from './economy';
import { EventSystem } from './events';
import { Game } from './game';
import { Rng } from './rng';
import { Statistics } from './stats';
import { TrackNetwork } from './track';
import { Signals, TrainSystem } from './train';
import { World } from './world';

/**
 * Save games: a snapshot of the whole object graph of a Game (shared references, cycles,
 * Maps, Sets and typed arrays preserved), so a loaded game continues exactly as the saved
 * one would have. Only links back to the outside world (event listeners, the train system's
 * host) are left out and rebuilt on load.
 */

export const SAVE_VERSION = 1;

const CLASSES: Record<string, { prototype: object }> = {
  Game,
  World,
  TrackNetwork,
  Rng,
  Economy,
  EconomicCycle,
  TrainSystem,
  Signals,
  Company,
  Chairman,
  AIBaron,
  Statistics,
  EventSystem,
};

/** Fields never saved (re-created on load). */
const SKIP: Record<string, Set<string>> = {
  Game: new Set(['listeners', 'undoStack']),
  TrainSystem: new Set(['host']),
  Economy: new Set(['cache']),
};

const TYPED: Record<string, new (b: ArrayBuffer) => ArrayBufferView> = {
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
};

type Enc = unknown;

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function className(o: object): string | null {
  const proto = Object.getPrototypeOf(o);
  for (const [name, cls] of Object.entries(CLASSES)) if (cls.prototype === proto) return name;
  return null;
}

/** Encode any value reachable from the game into JSON-safe data. */
function encodeGraph(root: unknown): Enc {
  const ids = new Map<object, number>();
  const enc = (v: unknown): Enc => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) return v;
      return { $n: Number.isNaN(v) ? 'NaN' : v > 0 ? 'Inf' : '-Inf' };
    }
    if (typeof v === 'undefined' || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return undefined;
    const o = v as object;
    const seen = ids.get(o);
    if (seen !== undefined) return { $r: seen };
    const id = ids.size;
    ids.set(o, id);
    if (Array.isArray(o)) return { $i: id, a: o.map((x) => enc(x) ?? null) };
    if (o instanceof Map) return { $i: id, m: [...o].map(([k, x]) => [enc(k), enc(x) ?? null]) };
    if (o instanceof Set) return { $i: id, s: [...o].map((x) => enc(x)) };
    if (ArrayBuffer.isView(o)) {
      const name = o.constructor.name;
      if (!TYPED[name]) throw new Error(`Cannot save ${name}`);
      return { $i: id, t: name, b: b64(new Uint8Array(o.buffer, o.byteOffset, o.byteLength)) };
    }
    const proto = Object.getPrototypeOf(o);
    const cls = proto === Object.prototype || proto === null ? null : className(o);
    if (proto !== Object.prototype && proto !== null && !cls) throw new Error(`Cannot save an instance of ${proto?.constructor?.name ?? 'unknown'}`);
    const skip = cls ? SKIP[cls] : undefined;
    const f: Record<string, Enc> = {};
    for (const [k, x] of Object.entries(o)) {
      if (skip?.has(k)) continue;
      const e = enc(x);
      if (e !== undefined) f[k] = e;
    }
    return cls ? { $i: id, c: cls, f } : { $i: id, o: f };
  };
  return enc(root);
}

function decodeGraph(data: Enc): unknown {
  const objs = new Map<number, unknown>();
  const dec = (v: Enc): unknown => {
    if (v === null || typeof v !== 'object') return v;
    const e = v as Record<string, unknown>;
    if ('$n' in e) return e.$n === 'NaN' ? NaN : e.$n === 'Inf' ? Infinity : -Infinity;
    if ('$r' in e) {
      if (!objs.has(e.$r as number)) throw new Error('Broken save: dangling reference');
      return objs.get(e.$r as number);
    }
    const id = e.$i as number;
    if ('a' in e) {
      const out: unknown[] = [];
      objs.set(id, out);
      for (const x of e.a as Enc[]) out.push(dec(x));
      return out;
    }
    if ('m' in e) {
      const out = new Map();
      objs.set(id, out);
      for (const [k, x] of e.m as Array<[Enc, Enc]>) out.set(dec(k), dec(x));
      return out;
    }
    if ('s' in e) {
      const out = new Set();
      objs.set(id, out);
      for (const x of e.s as Enc[]) out.add(dec(x));
      return out;
    }
    if ('t' in e) {
      const bytes = unb64(e.b as string);
      const Ctor = TYPED[e.t as string];
      if (!Ctor) throw new Error(`Broken save: unknown array type ${String(e.t)}`);
      const out = new Ctor(bytes.buffer as ArrayBuffer);
      objs.set(id, out);
      return out;
    }
    const cls = e.c as string | undefined;
    if (cls && !CLASSES[cls]) throw new Error(`Broken save: unknown class ${cls}`);
    const out: Record<string, unknown> = cls ? Object.create(CLASSES[cls].prototype) : {};
    objs.set(id, out);
    for (const [k, x] of Object.entries((cls ? e.f : e.o) as Record<string, Enc>)) out[k] = dec(x);
    return out;
  };
  return dec(data);
}

export interface SaveMeta {
  company: string;
  date: string;
  day: number;
  seed: number;
  size: number;
  netWorth: number;
  savedAt: number;
}

export interface SaveFile {
  game: 'iron-baron';
  version: number;
  meta: SaveMeta;
  data: Enc;
}

export function saveGame(game: Game, dateText = ''): SaveFile {
  return {
    game: 'iron-baron',
    version: SAVE_VERSION,
    meta: {
      company: game.company.name,
      date: dateText,
      day: game.day,
      seed: game.params.seed,
      size: game.params.size,
      netWorth: Math.round(game.netWorth()),
      savedAt: Date.now(),
    },
    data: encodeGraph(game),
  };
}

export function loadGame(file: unknown): Game {
  const f = file as Partial<SaveFile>;
  if (!f || f.game !== 'iron-baron') throw new Error('This is not an Iron Baron save.');
  if (f.version !== SAVE_VERSION) throw new Error(`Save version ${String(f.version)} is not supported (expected ${SAVE_VERSION}).`);
  const game = decodeGraph(f.data) as Game;
  if (!(game instanceof Game)) throw new Error('Broken save: no game inside.');
  game.restored();
  return game;
}
