import { PAL } from './palette';
import { parseSprite, type Sprite } from './raster';

/** Original pixel art, defined inline. Light comes from the upper left. */

const conifer = { l: PAL.moss, m: PAL.pine, d: PAL.fir, t: PAL.loam };
const leafy = { l: PAL.meadow, m: PAL.grass, d: PAL.moss, t: PAL.loam };
const rock = { l: PAL.fog, m: PAL.stone, d: PAL.shale };
const snowRock = { l: PAL.snow, m: PAL.fog, d: PAL.steel };

export const SPRITES = {
  coniferL: parseSprite(
    [
      '...l...',
      '..lm...',
      '..lmd..',
      '.llmd..',
      '..lmd..',
      '.lmmdd.',
      'llmmmdd',
      '.lmmdd.',
      'llmmmdd',
      'lmmmmdd',
      '...t...',
      '...t...',
    ],
    conifer,
  ),
  leafyL: parseSprite(
    [
      '...lll...',
      '.llllmm..',
      '.lllmmmd.',
      'llllmmmdd',
      'lllmmmmdd',
      '.lmmmmdd.',
      '..mmddd..',
      '....t....',
      '....t....',
    ],
    leafy,
  ),
  coniferS: parseSprite(['.l.', 'lmd', '.m.', 'lmd', '.t.'], conifer),
  leafyS: parseSprite(['.lm.', 'lmmd', '.md.', '..t.'], leafy),
  rockL: parseSprite(['..lm..', '.llmd.', 'llmmdd'], rock),
  rockS: parseSprite(['lm', 'md'], rock),
  snowRockL: parseSprite(['..lm..', '.llmd.', 'llmmdd'], snowRock),
} satisfies Record<string, Sprite>;
