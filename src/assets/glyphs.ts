/**
 * "Baron 5x7" — an original proportional pixel font. Each glyph is a list of rows separated
 * by '|': 7 rows above the baseline, optionally 2 more for descenders. 'X' = ink.
 * Used both for the in-world canvas labels and (converted to TrueType at runtime) for the UI.
 */
export const GLYPH_ROWS_ABOVE = 7;
export const GLYPH_ROWS_BELOW = 2;

export const GLYPHS: Record<string, string> = {
  ' ': '...|...|...|...|...|...|...',
  '!': 'X|X|X|X|X|.|X',
  '"': 'X.X|X.X|...|...|...|...|...',
  '#': '.X.X.|.X.X.|XXXXX|.X.X.|XXXXX|.X.X.|.X.X.',
  $: '..X..|.XXXX|X.X..|.XXX.|..X.X|XXXX.|..X..',
  '%': 'XX...|XX..X|...X.|..X..|.X...|X..XX|...XX',
  '&': '.XX..|X..X.|X.X..|.X...|X.X.X|X..X.|.XX.X',
  "'": 'X|X|.|.|.|.|.',
  '(': '..X|.X.|X..|X..|X..|.X.|..X',
  ')': 'X..|.X.|..X|..X|..X|.X.|X..',
  '*': '.....|..X..|X.X.X|.XXX.|X.X.X|..X..|.....',
  '+': '.....|..X..|..X..|XXXXX|..X..|..X..|.....',
  ',': '..|..|..|..|..|.X|.X|X.',
  '-': '....|....|....|XXXX|....|....|....',
  '.': '.|.|.|.|.|.|X',
  '/': '....X|....X|...X.|..X..|.X...|X....|X....',
  '0': '.XXX.|X...X|X..XX|X.X.X|XX..X|X...X|.XXX.',
  '1': '.X.|XX.|.X.|.X.|.X.|.X.|XXX',
  '2': '.XXX.|X...X|....X|...X.|..X..|.X...|XXXXX',
  '3': 'XXXXX|...X.|..X..|...X.|....X|X...X|.XXX.',
  '4': '...X.|..XX.|.X.X.|X..X.|XXXXX|...X.|...X.',
  '5': 'XXXXX|X....|XXXX.|....X|....X|X...X|.XXX.',
  '6': '..XX.|.X...|X....|XXXX.|X...X|X...X|.XXX.',
  '7': 'XXXXX|....X|...X.|..X..|.X...|.X...|.X...',
  '8': '.XXX.|X...X|X...X|.XXX.|X...X|X...X|.XXX.',
  '9': '.XXX.|X...X|X...X|.XXXX|....X|...X.|.XX..',
  ':': '.|.|X|.|.|X|.',
  ';': '..|..|.X|..|..|.X|.X|X.',
  '<': '...X|..X.|.X..|X...|.X..|..X.|...X',
  '=': '....|....|XXXX|....|XXXX|....|....',
  '>': 'X...|.X..|..X.|...X|..X.|.X..|X...',
  '?': '.XXX.|X...X|....X|...X.|..X..|.....|..X..',
  '@': '.XXX.|X...X|X.XXX|X.X.X|X.XXX|X....|.XXXX',
  A: '.XXX.|X...X|X...X|XXXXX|X...X|X...X|X...X',
  B: 'XXXX.|X...X|X...X|XXXX.|X...X|X...X|XXXX.',
  C: '.XXX.|X...X|X....|X....|X....|X...X|.XXX.',
  D: 'XXXX.|X...X|X...X|X...X|X...X|X...X|XXXX.',
  E: 'XXXXX|X....|X....|XXXX.|X....|X....|XXXXX',
  F: 'XXXXX|X....|X....|XXXX.|X....|X....|X....',
  G: '.XXX.|X...X|X....|X.XXX|X...X|X...X|.XXXX',
  H: 'X...X|X...X|X...X|XXXXX|X...X|X...X|X...X',
  I: 'XXX|.X.|.X.|.X.|.X.|.X.|XXX',
  J: '..XXX|...X.|...X.|...X.|...X.|X..X.|.XX..',
  K: 'X...X|X..X.|X.X..|XX...|X.X..|X..X.|X...X',
  L: 'X....|X....|X....|X....|X....|X....|XXXXX',
  M: 'X...X|XX.XX|X.X.X|X.X.X|X...X|X...X|X...X',
  N: 'X...X|X...X|XX..X|X.X.X|X..XX|X...X|X...X',
  O: '.XXX.|X...X|X...X|X...X|X...X|X...X|.XXX.',
  P: 'XXXX.|X...X|X...X|XXXX.|X....|X....|X....',
  Q: '.XXX.|X...X|X...X|X...X|X.X.X|X..X.|.XX.X',
  R: 'XXXX.|X...X|X...X|XXXX.|X.X..|X..X.|X...X',
  S: '.XXXX|X....|X....|.XXX.|....X|....X|XXXX.',
  T: 'XXXXX|..X..|..X..|..X..|..X..|..X..|..X..',
  U: 'X...X|X...X|X...X|X...X|X...X|X...X|.XXX.',
  V: 'X...X|X...X|X...X|X...X|X...X|.X.X.|..X..',
  W: 'X...X|X...X|X...X|X.X.X|X.X.X|X.X.X|.X.X.',
  X: 'X...X|X...X|.X.X.|..X..|.X.X.|X...X|X...X',
  Y: 'X...X|X...X|.X.X.|..X..|..X..|..X..|..X..',
  Z: 'XXXXX|....X|...X.|..X..|.X...|X....|XXXXX',
  '[': 'XXX|X..|X..|X..|X..|X..|XXX',
  '\\': 'X....|X....|.X...|..X..|...X.|....X|....X',
  ']': 'XXX|..X|..X|..X|..X|..X|XXX',
  '^': '..X..|.X.X.|X...X|.....|.....|.....|.....',
  _: '.....|.....|.....|.....|.....|.....|.....|XXXXX',
  '`': 'X.|.X|..|..|..|..|..',
  a: '.....|.....|.XXX.|....X|.XXXX|X...X|.XXXX',
  b: 'X....|X....|X.XX.|XX..X|X...X|X...X|XXXX.',
  c: '.....|.....|.XXX.|X....|X....|X...X|.XXX.',
  d: '....X|....X|.XX.X|X..XX|X...X|X...X|.XXXX',
  e: '.....|.....|.XXX.|X...X|XXXXX|X....|.XXX.',
  f: '..XX|.X..|.X..|XXX.|.X..|.X..|.X..',
  g: '.....|.....|.XXXX|X...X|X...X|X...X|.XXXX|....X|.XXX.',
  h: 'X....|X....|X.XX.|XX..X|X...X|X...X|X...X',
  i: '.X.|...|XX.|.X.|.X.|.X.|XXX',
  j: '...X|....|..XX|...X|...X|...X|...X|X..X|.XX.',
  k: 'X...|X...|X..X|X.X.|XX..|X.X.|X..X',
  l: 'XX.|.X.|.X.|.X.|.X.|.X.|XXX',
  m: '.....|.....|XX.X.|X.X.X|X.X.X|X...X|X...X',
  n: '.....|.....|X.XX.|XX..X|X...X|X...X|X...X',
  o: '.....|.....|.XXX.|X...X|X...X|X...X|.XXX.',
  p: '.....|.....|XXXX.|X...X|X...X|X...X|XXXX.|X....|X....',
  q: '.....|.....|.XXXX|X...X|X...X|X...X|.XXXX|....X|....X',
  r: '.....|.....|X.XX.|XX..X|X....|X....|X....',
  s: '.....|.....|.XXXX|X....|.XXX.|....X|XXXX.',
  t: '.X..|.X..|XXX.|.X..|.X..|.X.X|..X.',
  u: '.....|.....|X...X|X...X|X...X|X..XX|.XX.X',
  v: '.....|.....|X...X|X...X|X...X|.X.X.|..X..',
  w: '.....|.....|X...X|X...X|X.X.X|X.X.X|.X.X.',
  x: '.....|.....|X...X|.X.X.|..X..|.X.X.|X...X',
  y: '.....|.....|X...X|X...X|X...X|X...X|.XXXX|....X|.XXX.',
  z: '.....|.....|XXXXX|...X.|..X..|.X...|XXXXX',
  '{': '..X|.X.|.X.|X..|.X.|.X.|..X',
  '|': 'X|X|X|X|X|X|X|X',
  '}': 'X..|.X.|.X.|..X|.X.|.X.|X..',
  '~': '.....|.....|.X...|X.X.X|...X.|.....|.....',
  '°': '.X.|X.X|.X.|...|...|...|...',
  '×': '.....|.....|X...X|.X.X.|..X..|.X.X.|X...X',
  '·': '.|.|.|X|.|.|.',
  '–': '.....|.....|.....|XXXXX|.....|.....|.....',
  '—': '.......|.......|.......|XXXXXXX|.......|.......|.......',
  '…': '.....|.....|.....|.....|.....|.....|X.X.X',
  '▲': '.....|.....|..X..|.XXX.|XXXXX|.....|.....',
  '▼': '.....|.....|XXXXX|.XXX.|..X..|.....|.....',
  '►': 'X...|XX..|XXX.|XXXX|XXX.|XX..|X...',
  '◄': '...X|..XX|.XXX|XXXX|.XXX|..XX|...X',
  '•': '...|...|.X.|XXX|.X.|...|...',
  '✓': '.....|....X|...X.|X.X..|.X...|.....|.....',
};

export interface GlyphBitmap {
  ch: string;
  width: number;
  /** rows[0] is the top row (7 above baseline), rows.length is 7 or 9. */
  rows: boolean[][];
}

let cache: Map<string, GlyphBitmap> | null = null;

export function glyphBitmaps(): Map<string, GlyphBitmap> {
  if (cache) return cache;
  cache = new Map();
  for (const [ch, spec] of Object.entries(GLYPHS)) {
    const rowStrs = spec.split('|');
    if (rowStrs.length !== GLYPH_ROWS_ABOVE && rowStrs.length !== GLYPH_ROWS_ABOVE + GLYPH_ROWS_BELOW && rowStrs.length !== 8) {
      throw new Error(`Glyph '${ch}' has ${rowStrs.length} rows`);
    }
    const width = Math.max(...rowStrs.map((r) => r.length));
    cache.set(ch, { ch, width, rows: rowStrs.map((r) => Array.from({ length: width }, (_, i) => r[i] === 'X')) });
  }
  return cache;
}
