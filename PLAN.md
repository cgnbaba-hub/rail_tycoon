# Iron Baron — Implementation Plan

## Tech choice: Canvas 2D + software rasterizer (not PixiJS)

The 8-bit brief demands *no anti-aliasing anywhere*. Canvas 2D path fills are always
anti-aliased and WebGL/PixiJS needs custom shaders to get the same guarantee. Instead the
terrain is **software-rasterized into `ImageData` chunks** (16×16 tiles each) with our own
scanline polygon filler, palette lookups and 4×4 Bayer dithering. That gives:

- pixel-exact, palette-locked output (no blur, no AA, ever);
- rasterizer code that runs in Node, so it is unit-testable;
- cheap frames: a frame is just `drawImage` of a handful of cached chunk canvases + dynamic
  sprites, which scales to a 256×256 map and 100+ trains;
- an LRU chunk cache keyed by (chunk, zoom, rotation), invalidated per chunk when the world
  changes (track, stations, city growth) — this is our "dirty rect" strategy.

The UI is plain DOM/CSS on top of the canvas (accessibility, text selection, UI scaling,
tables), using a pixel font that is **generated at runtime as a TrueType font** from our own
5×7 glyph table, so the UI is chunky but crisp at integer scales.

## Architecture

```
src/
  sim/      pure TS, no DOM: rng, noise, world, mapgen, time/clock, game state (+ later
            track, trains, economy, finance, ai)
  render/   palette, iso projection, camera, rasterizer, sprites, chunk cache, renderer
  ui/       DOM HUD: top bar, tool rail, context panel, minimap, dialogs, pixel font
  data/     JSON: cargo, industries, mapgen, time, names (all balancing lives here)
  assets/   glyph table (font), pixel-art sprite strings
tests/      Vitest specs for sim + pure render math
```

## Milestones

| # | Name | Playable result |
|---|------|-----------------|
| M1 | Engine & map ✅ | New-game dialog (seed, size, water, hills, forests, cities, start year). Procedural 64–256² map with corner heightmap, coasts, rivers, forests, mountains, named cities and ~20 industry types rendered in pixel-art iso. Pan (right/middle drag, WASD), wheel zoom (4 levels), Q/E rotate, minimap, hover/inspect panel, date + pause + 1/2/4/8× speed. |
| M2 | Track & stations ✅ | Track tool with A* auto-pathing, slope % + cost preview, single/double track, bridges (3 types), tunnels, bulldoze, undo stack. Stations (3 sizes) with catchment overlay + highlighted industries. Company cash. |
| M3 | Trains & cargo ✅ | Engine data (early eras), consists, route editor, movement with gradient physics, block signalling / passing sidings on the track graph, load/unload, revenue formula (+ revenue estimate & payback in the track preview), fuel/maintenance, track maintenance, breakdowns, bridge speed/weight limits. |
| M4 | Economy ✅ | Industry production chains, station supply/demand with saturation + recovery, 3 economic models, city growth, 5-state economic cycle with leading indicators, station improvements (water tower, hotel, …). |
| M5 | Finance ✅ | Books (income statement, balance sheet), bonds, dividends, share issue/buyback/split, personal portfolio, margin/short, stock price model, year-end report. |
| M6 | AI & takeovers ✅ | 1–3 AI barons with personalities (builders + speculators), mergers, bankruptcy, board votes. |
| M7 | Improved UI ✅ | Overlays/heat maps, supply-chain explorer, sortable train table w/ bulk actions, advisor feed, stats graphs, formula tooltips, route templates. |
| M8 | Content & polish ✅ | Full engine roster across eras, events, managers, territories/goodwill, 3–5 scenarios with medals, tutorial, WebAudio chiptune + SFX, save/load (+JSON export), settings, accessibility options. |

Every milestone: `npm test` green, `npm run build` green, commit, short summary.

## M1 detailed checklist

- [x] Vite + TS (strict) + Vitest scaffolding
- [x] 32-colour palette in one file
- [x] Seeded RNG (serializable state) + stateless hash + value-noise fBm
- [x] World model: corner heightmap (|Δh| ≤ 1 per edge), tile terrain, river flags, occupancy
- [x] Map generator: heights, sea, rivers, biomes, cities (named, sized, buildings), industries
- [x] Iso projection with 4 rotations + height-aware picking
- [x] Software rasterizer: polygons, dithered shading, iso boxes w/ gable roofs & windows, sprites
- [x] Chunked terrain renderer with LRU cache and 4 zoom levels
- [x] Camera: right/middle-drag pan, keys, wheel zoom at cursor, rotation
- [x] Fixed-timestep clock decoupled from rendering, pause, 1/2/4/8×
- [x] HUD: top bar, tool rail, context panel (hover/inspect), minimap, new-game dialog
- [x] Runtime-generated pixel TTF font
- [x] Tests: rng, noise, mapgen invariants/determinism, iso round-trips, clock, rasterizer, font

## M2 detailed checklist

- [x] Track graph: one node per tile centre, 8 directions, ≤45° turns, diagonal-crossing guard
- [x] Bridges (wooden trestle / stone arch / steel truss from 1870) with span, speed and weight limits
- [x] Tunnels (straight, max 8 tiles, need cover, gentle grade)
- [x] A* auto-router over (tile, heading): real money + grade/turn penalties, reuses and joins existing track, time-sliced for live preview
- [x] Cost model: terrain, earthworks per level climbed, forest clearing, level crossings, demolition, double track
- [x] Track tool: drag to route, live cost breakdown, length in miles, steepest grade, elevation profile, grade legend
- [x] Stations: depot / station / terminal (1/2/3 tiles, radius 2/3/4), snap to straight track, R rotates; catchment overlay with covered town buildings and industries highlighted; auto naming
- [x] Bulldoze (track, whole spans, stations) and Undo (Ctrl+Z, full refund, last 30 actions within 7 in-game days)
- [x] Company cash + construction ledger; cash in the top bar; toasts
- [x] Renderer: rails/ballast/ties, double track, bridge decks + pillars + trusses, tunnel portals, buffer stops, station platforms & buildings, station labels; partial chunk invalidation
- [x] Tests: geometry, planner (bridges, tunnels, hills, demolition, reuse, joins), costs, undo, bulldoze, stations & coverage, rendering

Deferred on purpose: signals/passing sidings need trains (M3); station improvements and
supply/demand gauges need the economy (M4); route revenue/payback estimates need the
revenue formula (M3).

## M3 detailed checklist

- [x] Data: 14 fictional engines (1830–1936, steam → first diesel), 9 car types, cargo rates/weights, economy constants
- [x] Physics: tractive effort (power, adhesion), rolling + grade resistance, braking; heavy trains crawl up grades; bridge speed/weight limits
- [x] Train routing on the track graph (≤45° turns, reversing in stations)
- [x] Block signalling: atomic reservations up to the next station or a train-length stretch of plain double track; single track = one train per block, double track = passing; no gridlock (regression-tested under load)
- [x] Supply (towns: passengers/mail by covered population; raw industries) and demand (town class, industry inputs) per station; processing industries convert deliveries into outputs
- [x] Loading/unloading, auto-load best-paying cargo, wait for full load; revenue = (base + per mile × miles) × time factor × demand factor
- [x] Running costs: fuel (weight × distance), engine maintenance rising with age, track & station upkeep; breakdowns (reliability × age) with repair costs; optional wrecks
- [x] Commands: buy, sell, edit route/consist, upgrade engine (trade-in), duplicate
- [x] UI: new-train dialog with live estimate (legs, grades, slowest speed, revenue, profit, payback), train panel, sortable fleet table, station supply/demand gauges, follow camera, revenue pop-ups, batched breakdown notices; track preview shows revenue/payback when joining two stations
- [x] Rendering: procedural 8-direction engine & car sprites (open/flat cars show their load), steam puffs, tunnels hide trains
- [x] Tests: physics, revenue, breakdowns, routing, signalling (single & double track, junction networks), commands, estimates, determinism

Deferred: caboose/dining-car bonuses and station improvements (M4), demand saturation and
economic cycle factors in the revenue formula (M4), transfers between trains (M7 option).

## M4 detailed checklist

- [x] Demand saturation per station & cargo with recovery (half-life), steady-state aware estimates
- [x] Three economic models: undemanded factor, saturation strength, processors need inputs, Expert price levels & industry ownership
- [x] 5-state economic cycle with transition table, durations, business-confidence leading indicator and news headlines
- [x] Revenue formula: × demand level × economy (cycle × price level) × bonuses
- [x] Town growth from natural rate, passenger service and delivered goods; new buildings on free lots; size classes unlock demands; new industries on class-up
- [x] Raw industries grow with good service and shrink when neglected; processing chains
- [x] Station improvements (water tower, sand house, maintenance shop, roundhouse, hotel, restaurant, post office, warehouse, cold storage, livestock pens) with upkeep and visuals
- [x] Caboose and dining car bonuses
- [x] UI: economy chip + news ticker + economic report, station demand gauges with history and recovery time, improvements panel, industry business panel (buy/sell in Expert), town growth panel, last-delivery revenue breakdown in the train panel
- [x] Tests: saturation & recovery, steady state, cycle determinism / warnings / leading indicator, models, price bounds, ownership, town growth (served vs. unserved), building placement, class-up, undo keeps growth, improvements, consist bonuses

## M5 detailed checklist

- [x] Founding share issue (100,000 shares at $10) with the chairman's 20 % stake bought from a personal fortune
- [x] Books: income statement (revenue, operating costs, depreciation, interest, write-offs, net profit), investment & financing flows, balance sheet (cash, rolling stock, infrastructure, industries, bonds, book value), yearly history
- [x] Bonds with fixed rates from the economy's base rate plus a credit-rating spread; rating from leverage and interest cover; early repayment, maturity, forced emergency bonds when cash runs out
- [x] Dividends (quarterly, skipped when unaffordable), share issues (dilution, price dip, 6-month gap), buybacks, 2-for-1 splits
- [x] Stock price model: fair value from book value, smoothed profit × P/E by economic state and dividends, scaled by market mood (business confidence — the market leads the economy); daily mean reversion with noise; trade impact; volume; notes explaining moves
- [x] Chairman's personal account: salary, dividends, buy/sell, margin buying, short selling, margin calls with liquidation price, margin-loan interest; net worth history
- [x] UI: top-bar share price and net-worth chips, finance window (Books, Bonds, Stock chart with volume + ownership pie + "why the price is where it is", Portfolio with margin gauge), confirmations for risky actions, year-end report (pauses the game, can be turned off)
- [x] Tests: founding, valuation reactions (profit, book, dividends, losses, economy, confidence), convergence & impact, determinism, issue/buyback/split, dividends incl. skipped ones, credit rating, bond interest & rising rates, emergency bonds, book-value identity, bulldoze write-off & undo, depreciation & year-end report, margin limits, margin call at the liquidation price, short selling

## Graphics polish (between M5 and M6)

- [x] Native 64-px rendering at 2× zoom (extra chunky 4× level)
- [x] New procedural train sprites with ink outline; tenders for steam engines; smooth placement through curves
- [x] Track: ballast with shoulders, sleepers, two-tone rails, smooth curves
- [x] Bridges (trestle, stone viaduct, steel truss), tunnel portals, buffer stops, round steam puffs
- [x] `scripts/showcase.ts`: renders a railway test scene in all rotations plus a sprite sheet to PNG

## M6 detailed checklist

- [x] Ownership of track, stations and trains; the planner treats other railroads' track as an obstacle; no stations, bulldozing or train routes on rival property; each train bills its owner
- [x] Up to three AI barons (fictional) with personalities — cautious builder, aggressive expander, stock speculator — and three skill levels (relaxed / normal / ruthless) plus a friendly mode
- [x] AI building: candidate town pairs and extensions scored by population, distance and competition; station placement by coverage; profitability gate; double track when it can afford several trains; borrows within its credit limit; adds trains where cargo piles up; sells loss-makers each January; dividends by payout ratio
- [x] AI trading: keeps a stake in its own company, buys cheap shares, takes profits, sells short what looks dear (speculator), raids smaller railroads and calls merger votes
- [x] Mergers with a shareholder vote (stake ≥ 30 % to call it, 15 % premium, cooldown after a failed vote): shares exchanged, shorts covered at the offer, assets, debts and the whole railway transferred
- [x] Bankruptcy: a company whose debts exceed its assets gets no emergency bonds; still in the red after two month-ends, its shares become worthless and its railway is torn up
- [x] Board vote on the player every January from the third year; two votes of no confidence in a row end the game
- [x] Game over (taken over, bankrupt, voted out) with "keep watching" as an investor
- [x] UI: new-game options (rivals 0–3, skill, attitude), Railroads window (`O`: companies, chairmen, prices, book value, profit, stakes, ownership pies, takeover vote preview, board confidence), trade any company from the portfolio, rival colours (station roofs and labels, minimap track), owner in the inspector, read-only rival trains, rival news and warnings, board vote in the year-end report, game-over dialog
- [x] Tests: founding of rivals, ownership rules, billing, undo isolation, AI determinism and building, friendly mode, merger rules/vote/execution/cooldown, takeover of the player, bankruptcy (direct and after insolvency, player game over), board vote and removal after two strikes

## M7 detailed checklist

- [x] Monthly statistics (revenue by cargo, net profit, share price, market and book value per company; everyone's net worth; profit per train and revenue per station), 20 years kept
- [x] Per-train load factor (moving average at departure), 12-month profit history, per-tile traffic, route profit and congestion counters that fade monthly
- [x] Map overlays (`J`): supply and demand per cargo (station-size catchment), town growth, station catchment, route profit, traffic, congestion, gradient — pixel-exact ordered-dither heat maps with a legend; colour-blind-safe ramps (light blue → red, orange ↔ blue) and dither density that grows with the value
- [x] Supply-chain explorer (`Y`): the cargo chains of this map as a diagram; clicking a cargo shows its supply overlay and outlines producers (solid) and users (dashed)
- [x] Advisor (`U`, badge on the rail): waiting cargo, idle stations, saturated demand, stuck/unrouted/low-load/loss-making/worn-out trains, low cash, bad rating, margin, rival stakes, board support, confidence swings; dismissable and filterable; news log; delivery list with the full revenue formula; "Show" jumps to the train/station/company
- [x] Train table: sortable by profit/yr, age, reliability, load, last year, last breakdown; checkboxes and quick selections (worn out, > 25 years, losing, low load); bulk upgrade, sell and re-route
- [x] Route templates: save a train's engine, cars and route; buy copies (also reversed) from the train table or start the new-train dialog from one; apply a template's route to many trains
- [x] Statistics screen (`K`): revenue by cargo (stacked), profit, per-train and per-station sparklines, market value of all railroads, net worth of you vs. the barons (dash patterns + colours)
- [x] Formula tooltips: share price (fair-value formula), net worth, company cash (revenue − costs), demand gauges (saturation and recovery), multi-line pixel tooltips everywhere instead of browser titles
- [x] Tests: statistics add up to the books, monthly train profit and load factor, window sums, supply/demand/traffic/profit/congestion/gradient/catchment fields, advisor rules and ordering, templates (incl. reversed), fleet selection and bulk upgrade/sell

## M8 detailed checklist

- [x] Save games: snapshot of the whole game graph (a loaded game continues exactly like the saved one), slots in IndexedDB with a localStorage fallback, quick save (Ctrl+S), autosave every N months, export / import as JSON
- [x] Settings: music / effects volume, mute, interface size, reduced motion, contextual hints, year-end report, autosave interval
- [x] Engine roster: 26 fictional engines from 1830 to 2000 (early steam, heavy freight, articulateds, fast passenger steam, diesel switchers, road diesels, gas turbine, high-speed diesel)
- [x] Historical-flavoured events with spelled-out effects (war, gold rush, oil boom, strikes, harvests, building boom, epidemic) and one-off technologies (air brakes, steel rails, standard time, refrigerated cars)
- [x] Managers: a few candidates each year, one at a time, salary and signing fee, effects on construction, breakdowns, upkeep, fuel, interest, revenue or goodwill
- [x] Territories: named regions, goodwill per region (service, revenue, demolition, wrecks), construction cost scaled by goodwill, charters (by goodwill or fee) for restricted regions, rivals kept out; territories overlay and inspector
- [x] Scenarios with bronze/silver/gold medals (6 incl. the tutorial), title screen, goal chip and window, result screen, medals remembered
- [x] Interactive tutorial (9 steps completed by doing them, tool highlighted) and one-time contextual hints
- [x] WebAudio chiptune: three procedural blues/bluegrass songs (bass, rhythm, improvised lead, drums) and synthesized effects (cash register, steam whistle, chuff, stock ticker, construction thud, bulldozer, alarm)
- [x] Tests: save round-trip determinism, events, managers, roster, territories, scenarios, music composer

