# Design decisions

Decisions made without asking (per the working rules). Revisit any of them on request.

## Naming & originality
- **Name: "Iron Baron"** (the suggested working title). Window/brand text "IRON BARON".
- Town names are generated from original syllable lists (`src/data/names.json`).

## Rendering
- **Canvas 2D + own software rasterizer** instead of PixiJS (see `PLAN.md`): guarantees zero
  anti-aliasing and palette-only output, and keeps the rasterizer unit-testable in Node.
- **Tile 32×16 px at 1× zoom**, one height level = 4 px (tw/8). Zoom levels ¼×, ½×, 1× are
  rasterised natively at tile widths 8/16/32 (with level-of-detail: no trees/windows at ¼×);
  2× is a nearest-neighbour upscale of 1×.
- **Internal resolution** ≈ 560–640 px wide: the world canvas uses an integer pixel scale
  `floor(deviceWidth / 560)` and CSS `image-rendering: pixelated`.
- **Chunks** of 16×16 view-space tiles, cached per (chunk, rotation, zoom, grid) in an LRU of
  ~192 MB; missing chunks are built nearest-first within a 12 ms per-frame budget.
- **Painter's order**: chunks by (cx+cy), tiles by (rx+ry) inside a chunk, objects right after
  their tile; multi-tile industries draw at their front-most tile. Sprites never exceed their
  footprint width, which makes this order correct across chunk boundaries.
- **Terrain triangulation** follows a world-space rule (fold along the level diagonal) so the
  surface is identical in all four rotations; `World.surfaceHeight` uses the same rule.
- **Lighting** is fixed in view space (from the upper left), so rotating the map keeps the
  familiar shading. Shades between ramp colours use 4×4 Bayer dithering anchored to world
  pixels (seamless across chunks).
- Dynamic effects (chimney smoke) are drawn on top of the cached terrain and animate with
  *simulation* time, so they freeze while paused — a visual pause cue.

## World model
- Heights live on tile **corners** (vertex grid), max 16 levels, and adjacent corners differ
  by at most one level (enforced by an L1 distance transform). This gives clean slopes and a
  well-defined gradient for track in M2.
- Sea level is height 0; a tile is water iff all four corners are 0. Rivers are tile flags.
- Building and industry footprints are **flattened pads** (lowered to their minimum corner,
  then the slope invariant is restored).
- Calendar: 365-day years, no leap years. One simulation tick = one in-game hour.

## UI
- DOM/CSS UI over the canvas (accessible, scalable, selectable). Its font **BaronPixel** is
  generated at runtime as a TrueType font from the same 5×7 glyph table that the canvas uses.
  The UI font size is chosen so one font pixel is a whole number of device pixels (≈17 CSS
  px on desktop) — "UI may render at a higher scale than the world".
- Left-drag also pans in the Inspect tool (trackpads); in later build tools left-drag will be
  reserved for construction and pan stays on right/middle drag.
- The overview map is an isometric diamond that rotates with the main view.
