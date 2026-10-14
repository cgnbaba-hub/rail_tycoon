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

## Track & stations (M2)
- **Track graph on tile centres** with 8-direction connections (RT-style). Trains may turn at
  most 45° per tile; the planner and the junction rules enforce it. Two diagonals may not
  cross inside a 2×2 block; orthogonal crossings (diamonds) are allowed.
- **Heights:** ground track follows the terrain (node height = surface at the tile centre).
  Bridges and tunnels are straight spans whose interior nodes interpolate between the two
  ground ends; tunnels leave the terrain untouched. No terraforming.
- **Scale:** 1 tile = 1,320 ft (¼ mile), 1 height level = 60 ft ⇒ one level per tile is a 4.5 %
  grade. Real main lines rarely exceed 2 %, so anything over 3.5 % is flagged "steep".
- **Auto-routing** (A* over tile+heading) minimises *money + planning penalties* (grade² and
  turns). Penalties are not charged, they only make routes look like railways. The search is
  resumable so long previews are spread across frames and never stall the UI.
- Dragging onto a tile that can't take track (industry, water) snaps the end to its nearest
  buildable neighbour.
- **Stations** sit on straight track (E–W or N–S), 1/2/3 tiles long, and may demolish town
  buildings (priced in). Catchment = footprint grown by the radius (square). A town counts as
  covered in proportion to its buildings inside the catchment.
- **Bulldozing** a station removes the station but keeps its track; bulldozing a bridge or
  tunnel tile removes the whole span.
- **Undo rule:** the last 30 construction actions can be undone with a full refund as long as
  fewer than 7 in-game days have passed since each. Building while paused can therefore always
  be undone. (When trains exist, undo will also be blocked for track a train is standing on.)
- Company finances are minimal until M5: one cash balance ($1,000,000 to start) and a
  per-year construction ledger.

## Trains (M3)
- **Time scale:** like the classic games, trains run on compressed time — 1 mph moves
  0.0065 tiles per game hour, so a 40 mph train covers ~6 tiles (1.5 mi) per day and a
  typical intercity trip takes about a week. Displayed speeds are real mph.
- **Loads, not tons:** every car carries one *load* of one cargo; payments are per load.
  Cargo weight per load (data) drives physics and fuel.
- **Signalling:** trains reserve track ahead in atomic *blocks* that end at a station or at a
  stretch of plain double track at least one train long. Single-track nodes are exclusive;
  double-track nodes are shared only by trains using the same pair of edges in opposite
  directions. Trains can therefore only stop where they block nobody coming the other way,
  which prevents the gridlocks that naive per-tile reservation produces at junctions and
  small loops. Stations have no hard platform limit (a hard limit could gridlock two busy
  stations); platform counts are informational.
- Trains may **reverse only in stations**. Track changes under a train trigger a re-plan;
  bulldozing or undoing track a train stands on or has reserved is refused.
- **Auto-load** (default per stop) reassigns empty cars to the best-paying cargo waiting at
  the station, valued at the first later stop that demands it.
- **Undemanded cargo** is kept aboard while a later stop demands it, otherwise unloaded at a
  reduced rate (economic model factor). Cargo is never "delivered" back to its origin.
- Distance for revenue is the straight line between origin and destination stations (so
  direct lines pay best, as in the original).
- Economic model defaults to *Basic* in M3 and can be chosen in the new-map dialog; M4 adds
  the remaining model differences (saturation, price levels, industry ownership).
- Wrecks are on by default but rare (old engines, overweight trains on light bridges); they
  can be turned off in the new-map dialog.
