/** Player preferences (stored in the browser, not in save games). */

export type UiScale = 'small' | 'normal' | 'large';

export interface Prefs {
  uiScale: UiScale;
  /** Contextual hints (tutorial tips, first-time explanations). */
  hints: boolean;
  /** Autosave every N game months (0 = off). */
  autosaveMonths: number;
  music: number;
  sfx: number;
  muted: boolean;
  /** No steam puffs, smoke or floating money. */
  reducedMotion: boolean;
}

const KEY = 'ironBaron.prefs';

const DEFAULTS: Prefs = { uiScale: 'normal', hints: true, autosaveMonths: 3, music: 0.5, sfx: 0.7, muted: false, reducedMotion: false };

function read(): Prefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* storage blocked or corrupt: defaults */
  }
  return { ...DEFAULTS };
}

export const prefs: Prefs = read();

const listeners: Array<() => void> = [];

export function onPrefs(fn: () => void): void {
  listeners.push(fn);
}

export function setPrefs(patch: Partial<Prefs>): void {
  Object.assign(prefs, patch);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* private mode: keep in memory */
  }
  for (const l of listeners) l();
}

/** Target UI font size in CSS px for the chosen scale. */
export function uiFontTarget(narrow: boolean): number {
  const base = narrow ? 12 : 17;
  return prefs.uiScale === 'small' ? base * 0.62 : prefs.uiScale === 'large' ? base * 1.55 : base;
}
