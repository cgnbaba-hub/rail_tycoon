import { PALETTE, PALETTE_NAMES } from '../render/palette';

/** Expose the palette to CSS as --c-<name> custom properties. */
export function applyTheme(root: HTMLElement = document.documentElement): void {
  for (const n of PALETTE_NAMES) root.style.setProperty(`--c-${n}`, PALETTE[n]);
}

/**
 * Choose a UI font size so one font pixel (1/10 em) maps to a whole number of device
 * pixels, as close as possible to `targetCss` CSS px.
 */
export function crispFontSize(dpr: number, targetCss: number): number {
  let best = 10 / dpr;
  for (let devicePx = 1; devicePx <= 8; devicePx++) {
    const css = (devicePx * 10) / dpr;
    if (Math.abs(css - targetCss) < Math.abs(best - targetCss)) best = css;
  }
  return best;
}
