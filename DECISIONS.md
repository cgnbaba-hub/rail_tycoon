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
- Economic model defaults to *Basic* and can be chosen in the new-map dialog.
- Wrecks are on by default but rare (old engines, overweight trains on light bridges); they
  can be turned off in the new-map dialog.

## Economy (M4)
- **Saturation is per station and cargo**, not per town: flooding one station drops its
  price, so spreading deliveries over several stations (or towns) pays — the classic
  "feed many destinations" strategy. It recovers with a 45-day half-life and the station panel
  shows level, a 12-month history and the days needed to recover to 90 %.
- **The economic cycle is never a surprise**: the next state and its timing are fixed when a
  state begins; for the last 3–6 months business confidence drifts towards the coming level
  and headlines hint at the direction. Hidden state stays hidden (we never print "recession in
  4 months"), but a watchful player always gets warning.
- **Models:** Basic = forgiving (undemanded 75 %, gentle saturation, plants run without
  inputs); Advanced = plants need inputs, undemanded 50 %; Expert = harsh saturation,
  undemanded 10 %, moving cargo prices and industry ownership. Model is fixed per game.
- **Industry ownership** (Expert) is a simple income stream (output × margin); price looks at
  potential capacity so idle plants are not free money, but feeding a bought plant is the
  intended profitable play.
- **City growth only adds buildings on free flat lots** off the street grid and never touches
  track or tiles an undo could restore; new industries only appear on flat land (runtime never
  reshapes terrain). Undo of a demolition gives back the removed population as a *delta*, so
  growth in the meantime is kept.
- **Station improvements** are per station, built from the station panel, have yearly upkeep
  and are not undoable; building one clears the undo stack (an undo that removed the station
  would otherwise lose the improvement silently). They appear as small outbuildings across the
  track from the station building.
- **Caboose & dining car** are bought as extra cars (`@caboose`, `@dining` in a consist);
  they never load cargo and count once per train.
- Service buffs (maintenance shop, roundhouse) last 60 days after a stop; the sand house only
  helps on the next leg.

## Finance (M5)
- **Capital structure:** the company is founded with 100,000 shares at $10 ($1M cash); the
  chairman buys 20 % from a $300,000 personal fortune, leaving $100,000 of personal cash. The
  rest is held by "the public" (M6 adds rival barons as holders).
- **Book value** = cash + trains at resale value + infrastructure at cost (2 %/yr
  depreciation) + industries at cost − bonds − overdraft. Building track therefore moves cash
  into infrastructure without changing book value; bulldozing writes the track off at its
  replacement value (written back on undo). Write-offs are reported but not extrapolated by
  investors.
- **Share price** is fully explainable: it drifts (5 % a day) towards a fair value made of
  book value, smoothed profit × P/E (by economic state) and a dividend premium, scaled by
  market mood from *business confidence* — so the market turns before the economy does, in
  line with the M4 leading indicator. The stock window spells out every component.
- **Interest rates** follow the economy (panic = credit crunch, highest base rate) plus a
  rating spread. Ratings are leverage bands with notches off for weak interest cover. A new
  bond is refused when it would push the rating to D. Negative cash at month end forces
  emergency bonds at a penalty instead of bankruptcy — bankruptcy and takeovers are M6.
- **Dividends** are set as an annual amount per share and paid quarterly from company cash
  before any emergency borrowing; if the cash isn't there the dividend is passed (and noted).
- **Share issues** sell 10 % blocks at a 5 % discount, at most every 6 months; buybacks pay a
  3 % premium. Every trade (company or personal) moves the price by 0.6 × the share of the
  company traded, so big trades are visibly expensive.
- **Personal account:** one combined margin account. Trades must leave equity ≥ 50 % of gross
  positions; below 30 % a margin call closes positions (shorts first, biggest first). The
  liquidation price shown is exact for the selected stock with other prices unchanged. The
  chairman earns a salary ($24k/yr, a company expense) plus dividends.
- **Year-end report** opens on Jan 1 and pauses the game; it can be switched off from the
  report itself (stored in the browser).

## Graphics polish: trains & track
- **Zoom 2× renders natively** at 64-px tiles instead of doubling the 1× image, so close up
  there is real detail (sleepers, windows, wheels) while staying palette-locked and hard-edged.
  The old chunky doubled look is kept as an extra 4× level. Fixed pixel sprites (trees, rocks)
  are drawn at 2× there.
- **Rolling stock** is built from boxes and octagonal cylinders per vehicle type (boiler,
  stack, dome, cab, cow-catcher; coach windows, boxcar doors, slatted stock cars, tank cars,
  caboose cupola, …), drawn bottom-up in height bands and outlined in ink so trains read on
  any ground. Proportions are long and low.
- **Steam engines pull a tender** (0.32 tiles, `physics.tenderLength`); diesels don't. It is
  drawn, but signalling keeps using engine + cars: counting it made long trains find fewer
  safe stopping places and doubled waits in the 120-train stress test, and it fits inside the
  0.5-tile margin every block keeps anyway.
- Vehicles sit on the **chord between their front and rear points** on the track, so trains
  bend smoothly through curves instead of snapping.
- **Track** is drawn as a path: shaded ballast bed, wooden sleepers at even spacing,
  two-tone rails at 2×, and smooth curves at 45° bends (quadratic arcs that meet tangentially).
- **Bridges:** timber trestles with braced bents and railings, stone viaducts with a solid
  near wall, arch openings where there is clearance and a parapet, steel trusses drawn far side
  first and near side last. Tunnel portals have stone arches with voussoirs and a cornice;
  buffer stops are a beam on posts with a lamp.
- Known limitations: trains are drawn above the scenery, so they can show in front of a tall
  building that should hide them; a train reversing out of a terminus briefly overhangs the
  buffer stop (true reversal of the whole train would need a simulation change).

## Rivals & takeovers (M6)
- **Ownership is a number on every track node, station and train** (company id, 0 = you).
  Construction and train commands take the acting company; the route planner simply refuses
  nodes owned by anyone else, so rival networks never join (no shared track or running
  rights — a later option). Stations of different railroads may serve the same town and
  split its passengers through the normal catchment/saturation rules.
- **AI barons use exactly the player's commands** (`buildStation`, `buildTrack`, `buyTrain`,
  `issueBond`, `buyStock`, …) and pay the same prices, so they can't cheat. A whole line is
  built in one atomic `Game.buildLine` that rolls back if any part fails or it costs too much.
  Rival construction is not undoable and clears your pending undos only if it touched the
  same tiles.
- **The AI is deliberately simple and readable**: once a month per baron, on its own
  schedule, with its own forked RNG (deterministic). It scores lines by
  √(pop A · pop B) · distance weight · competition penalty, tries the top few, and only builds
  what its revenue estimate says will pay. It is not a pathfinding optimiser; it builds point-
  to-point lines and extends from its own stations.
- **Personalities** are data (`ai.json`): build interval, cash reserve, credit limit, trains
  per route, distance range, competition tolerance, dividend payout and stock behaviour.
  Skill levels scale building frequency and trading size. *Friendly* rivals never short,
  raid or vote against you (they still compete for passengers).
- **Takeovers need a shareholder vote** rather than happening at 50 %: the bidder must hold
  30 %, offers its own shares worth the target price + 15 %, the target's chairman votes no,
  other barons take the premium, and the public splits by a published formula (more likely
  yes after a bad year). This makes defence possible: hold a big stake, keep the price up.
  The player can do the same to rivals from the Railroads window.
- **Bankruptcy replaces endless emergency bonds** only when debts exceed assets (negative
  book value): a merely cash-poor company still gets emergency bonds as in M5. The torn-up
  railway is removed outright (no auction yet).
- **Board vote:** from the third January on. Your shares support you; the public's support
  follows the year's share-price change and profit; hostile barons vote against. One failed
  vote is a warning; two in a row end the game. It rewards keeping a stake and a rising price
  rather than just staying solvent.
- **Game over is soft:** the simulation keeps running, you keep your shares and can trade, but
  construction, train and company-finance commands are refused.
- **Colours:** you are gold; rivals are sky, tile-red and teal. Rival stations get roofs and
  label rules in their colour, the minimap draws rival track in their colour; track itself is
  not recoloured on the main map to keep the strict palette readable.

## Insight tools (M7)
- **Statistics are sampled, not reconstructed:** at each month end the game stores one small
  sample (per company, per investor, per train, per station). Revenue uses "since last
  sample" accumulators, so the yearly resets of the books can never double-count or drop a
  month. 240 samples (20 years) are kept.
- **Overlays are fields, not special renderers:** the sim computes one number per tile
  (`computeOverlay`) and the renderer only knows "heat map with thresholds". Supply and demand
  are summed over a station-size window (summed-area table), so the value reads as "what a
  station here would collect / absorb". Fields refresh monthly or when you change them.
- **Heat maps stay inside the palette:** they are rasterised into a transparent layer with an
  ordered-dither mask (¼, ½, ¾ of the pixels), never alpha-blended, and cached until the view
  or the data changes. Magnitude is carried by both colour and dither density; the ramps
  avoid red/green pairs.
- **Traffic, route profit and congestion** are per-tile counters fed by the trains themselves
  (every node entered, every tick blocked at a signal, every breakdown) and multiplied by 0.7
  each month, so they show recent conditions without storing histories.
- **Advice is derived, never stored:** `advise(game)` re-reads the state, so an item vanishes
  once its cause is fixed. Dismissals are by stable key (e.g. `wait:<station>:<cargo>`) and
  last for the session. Rivals' trains and stations are ignored.
- **Bulk actions reuse the single-train commands** (upgrade, sell, set route), so their rules
  (cash, ownership, game over) stay in one place; failures are counted and reported.
- **Templates** copy engine, cars and route; if the engine is no longer on sale the best
  engine that can pull the cars is used.
- **Tooltips** are the game's own pixel tooltips (multi-line, formulas spelled out) instead of
  browser `title`s, which are slow, unstyled and invisible to touch users.

## Content & polish (M8)
- **Saves are a snapshot of the object graph**, not a replay or a hand-written schema: every
  object reachable from the Game is written once (shared references and cycles preserved),
  with Maps, Sets and typed arrays encoded and the sim's classes restored by prototype. New
  fields are saved automatically. Event listeners, the train system's host and the undo
  history are left out and rebuilt (loading clears undo). A test runs a game, saves, loads,
  runs both on and checks the two states are byte-identical. To make that hold, station
  supply is now recomputed every month instead of only on visible population steps.
- **Storage:** IndexedDB (falls back to localStorage); files export as plain JSON. Saves carry
  a version number and are refused when it doesn't match.
- **Events and managers share one modifier system** (revenue/supply by cargo, group or all;
  construction, fuel, upkeep, breakdowns, interest, growth, goodwill). Events apply to every
  railroad, a manager only to its company. Event revenue appears in the economy factor of the
  delivery formula, a manager's in the bonus factor, so the formula stays explainable.
  Technologies are events that happen once and last.
- **Territories are Voronoi regions** around spread-out towns. Only the player has goodwill
  (rivals simply stay out of restricted regions). Goodwill moves slowly and visibly: it is in
  the inspector, the overlay and the construction cost. Hand-made worlds (tests, future
  scenario maps from tests) start with charters off; generated and hand-made maps with charters
  on (new-map option).
- **Scenarios are data** (map parameters, settings, one metric with three tiers, optional
  "connect these towns" requirements). The medal is the best tier reached; gold ends the
  scenario early, otherwise it ends at the deadline. Medals are stored in the browser.
- **Hand-made maps are layouts, not tile dumps** (`maps.json`): features in map fractions on a
  gentle noise base, so a map stays small, editable by hand, works at every size and still
  looks natural; the seed only changes detail. Named towns are placed first (so their ids are
  stable and scenarios can name them), get flattened ground, and keep their size and
  population; extra random towns stay village/town-sized so the named ones remain the
  landmarks. Fixed industries fall back to any flat free spot nearby if the usual placement
  rules (terrain, height, distance to a town) say no — the author asked for it there.
- **Rivals look further on sparse maps:** when no town pair lies within a baron's usual route
  length, the AI widens the range step by step (up to 2.6×) instead of building nothing.
- **Board votes can be switched off** (`boardVotes`): off in the easy scenarios and optional in
  the sandbox, since the spec makes being voted out a game-over only "in some scenarios".
- **Medal tiers are checked with a scripted player** (`scripts/scenario-bot.ts`): it builds a
  fixed list of sensible lines per scenario, adds trains where cargo waits and plays to the
  deadline. It plays plainly, so its result is about bronze to silver; gold needs a better
  plan.
- **Transfers are an order on a stop**, not a station type: the train sets everything down
  there as lots that remember their first station, loading time, destination and the trains
  that carried them. Payment waits for the final delivery and uses the whole distance and
  time, so feeding a trunk line never loses money against a through train; the train
  statistics split it by distance. A lot never goes straight back onto the train that set it
  down, and only onto trains that can place it (a later stop wants it or transfers it again).
- **Destinations are destinations, not paths:** new passengers and mail pick a station among
  those reachable with at most one change (gravity: people served / (1 + distance/60)). The
  station keeps them in buckets per destination; a train boards only those it can take there
  (it calls there, or calls where a connecting train does). Changing trains reuses the
  transfer lots. One change keeps it understandable and cheap to compute; the link graph is
  rebuilt only when a route changes. Off by default (a toggle, as the spec asks), so
  balancing and scenarios are unchanged.
- **The tutorial is a scenario plus a step list** whose conditions read the game state
  (stations in the two towns, connected, a train, revenue, windows opened), so it can't get
  out of sync with what the player actually did.
- **Audio is synthesized at run time** with WebAudio: pulse/triangle/square oscillators and
  LFSR-style noise; the songs are generated bar by bar from a 12-bar (or 16-bar) form with a
  seeded improvised lead, so they vary between choruses. The note generator is pure and
  unit-tested; an offline render produced the previews. Sound starts on the first click or
  key press (browser autoplay rules).

