# Prompt for Claude Code: 8-bit Railroad Tycoon-style game

> Paste everything below this line into Claude Code (ideally in an empty folder). Claude Code should save it as `SPEC.md` first and then work through it milestone by milestone.

---

## Role & goal

You are a senior game developer. Build a **browser-based railroad business simulation** inspired by the gameplay of *Railroad Tycoon II* (PopTop Software, 1998), rendered in a **deliberate 8-bit / pixel-art look**, with a **modern, friction-free UI**.

First save this prompt as `SPEC.md` in the repo root, then create a short `PLAN.md` with your milestone breakdown, and then implement milestone by milestone. After each milestone: run the game, run the tests, commit, and give me a short summary of what's playable now.

### Legal / originality constraints (important)
- This is an **homage, not a copy**. Use an **original name** (working title: **"Iron Baron"** – change if you have a better idea), original pixel art, original UI, original music/SFX (procedurally generated or chiptune-synthesized).
- Do **not** use the names "Railroad Tycoon", "Sid Meier", "PopTop" or any of their logos, assets, sprites, text or music. Historical real-world people (e.g. 19th-century rail barons) may be used as inspiration for fictional AI rivals, but give them fictional names.
- Game mechanics themselves (laying track, hauling cargo, stock market) are fair game.

---

## Tech stack

- **TypeScript + Vite**, rendering via **HTML5 Canvas 2D** (or PixiJS if you think it's clearly better – justify briefly in PLAN.md).
- No backend. Save games in `localStorage`/IndexedDB plus export/import as JSON file.
- **Deterministic simulation**: seeded RNG, fixed-timestep simulation tick decoupled from rendering. Simulation logic in pure TS modules with no DOM dependency → unit-testable with **Vitest**.
- Clean architecture: `sim/` (world, economy, trains, finance, AI), `render/` (iso renderer, sprites), `ui/` (panels, HUD), `data/` (JSON definitions for cargo, industries, engines, eras).
- All balancing values in data files, not hard-coded.

---

## Visual style: 8-bit

- **Low internal resolution** (e.g. 480×270 or 640×360), scaled up with integer scaling and `image-rendering: pixelated`. No anti-aliasing, no blur.
- **Fixed limited palette** (~32 colors, NES/PICO-8 spirit, but your own palette). Define it in one file.
- **Dimetric / isometric 2:1 tile view** (the original used a dimetric view, not top-down). Tile size e.g. 16×8 or 32×16.
- Terrain: water, coast, grass, forest, hills with **height levels** (height matters for gradients, see below), rivers, mountains.
- Sprites generated in code (pixel arrays / procedural) or as small PNG sprite sheets you create yourself. Steam locomotives with puffing smoke pixels, visible car types (coal, passengers, mail, etc.).
- Night/day tint optional; seasons optional.
- Chunky bitmap font (create your own or use an open-licensed pixel font, credit in README).
- Despite the retro look, **UI text must be readable** – UI may render at a higher scale than the world.

---

## Core gameplay (faithful to the original)

### 1. Setup & goal
- Player is the **chairman** of a newly founded railroad company. Starting capital comes from the company's initial share issue plus the player's own personal stake.
- Modes: **Sandbox** (random map, freely configurable) and **Scenarios** with goals and deadlines (e.g. "reach $X company book value by year Y", "connect city A to city B", "highest personal net worth among all players"). Bronze/Silver/Gold tiers per scenario.
- Start year selectable (e.g. 1830–1950); technology (engines) unlocks over time, older engines become obsolete.
- Difficulty settings that are separate dials: **economic model (Basic / Advanced / Expert)**, AI aggressiveness, stock-market realism, starting cash.

### 2. Map & world generation
- Procedural map generator: terrain heights, rivers, coastlines, forests, cities of varying size, resource sites (farms, mines, forests, oil wells …) and processing industries placed plausibly.
- Optional hand-made scenario maps defined in JSON.
- Cities **grow** when they are well supplied (passengers, mail, demanded goods), and new industries can appear in growing cities.

### 3. Track building
- Drag to lay track; auto-pathing along terrain with snapping to existing track.
- **Single and double track**, bridges (wood/stone/steel with different cost & weight limits), tunnels, bulldozing.
- **Gradients matter**: show the slope % while building; steep grades slow trains heavily and cost more to build. Cost depends on terrain, height difference, water, forest clearing and buildings in the way.
- Signals / passing sidings on single track so trains don't block each other.

### 4. Stations
- Three sizes with different **catchment radius**: small depot, medium station, large terminal. Show the catchment area overlay before placing and highlight which cities/industries fall inside it.
- Station improvements/buildings, e.g. water tower, sand house, engine/maintenance shop, roundhouse, hotel, restaurant, post office, warehouse, cold storage, livestock pens. Each gives concrete bonuses (faster turnaround, less breakdown risk, more passenger revenue, cargo keeps longer, etc.).
- Each station shows **supply** (what's waiting, how much) and **demand** (what it pays for and how much).

### 5. Cargo & industry chains
- Around 25–35 cargo types across eras, e.g. passengers, mail, troops, coal, iron, steel, lumber, paper, grain, livestock, food, milk, cotton, textiles, wool, goods, oil, petroleum, chemicals, cars, tires, rubber, bauxite, aluminum, cement, fertilizer, weapons …
- Raw resource sites produce; processing industries **convert inputs into outputs** (e.g. coal + iron → steel; steel → goods/cars; grain → food; logs → lumber/paper; cotton → textiles; oil → petroleum). The player is rewarded for building **production chains**.
- **Economic model difficulty** (from the original):
  - **Basic**: stations accept any cargo and pay only slightly less for non-demanded cargo; industries produce even when unsupplied.
  - **Advanced**: non-demanded cargo pays half; industries only produce when their inputs are supplied.
  - **Expert**: stations pay very little for cargo they don't demand; price levels affect payouts; the company may **buy industries** and earn their profit.
- **Demand saturation**: delivering lots of one cargo to a station drops its demand/price, which then recovers over time. Mass delivery works best over long distances. (UI must make this visible – see improvements.)
- Cargo has a **freshness / time value**: payout falls with transit time (passengers, mail and perishables decay fastest).

### 6. Trains
- Engine roster (~40–60 fictional engines across eras: early steam → heavy steam → diesel → electric → high-speed), each with: purchase price, top speed, power/acceleration (gradient-sensitive), fuel type (wood/coal/diesel/electric), reliability, maintenance cost, availability years, max cars.
- **Consist**: choose number and type of cars (up to e.g. 8), plus optional caboose/dining car with bonuses.
- **Routing**: list of stops; per stop choose what to load/unload or "auto-load whatever pays best". Wait-for-full-load option.
- Revenue per delivery depends on: **distance, transit time, demand, cargo type, economic state, station improvements, difficulty**.
- Costs: **fuel** (depends on cargo weight and distance run), **engine maintenance** (rises with age and type), **track maintenance** per tile.
- **Breakdowns**: probability increases with engine age (reduced by maintenance shops and certain managers). Breakdowns stall the train until repaired.
- **Wrecks**: rare collisions or overspeeding on bad track destroy the engine and cargo (can be disabled in settings).
- Engines age; old engines should be replaced → "upgrade engine" in one click.

### 7. Finance & stock market (the heart of the original)
- **Company finances**: cash, revenue/expense breakdown by category, income statement and balance sheet per year, **bonds** (issue/repay; interest rate depends on credit rating and economic climate), **dividends**, **issue new shares**, **share buyback**, **stock splits** at high prices.
- **Personal finances** of the chairman, separate from the company: cash, stock holdings in all companies, **buy on margin**, **short selling**, **margin calls**. Personal net worth is a key scoring metric.
- **Stock price** reacts to profits, book value, dividends, share supply (issuing lowers price, buyback raises it), and the overall economy.
- **Economic cycle** with 5 states: Boom, Prosperity, Normal, Recession, Panic. It affects cargo revenue, stock prices and interest rates, and shifts with some randomness (but with warning signs – see improvements).
- **Takeovers & mergers**: if a player controls enough shares of another company they can attempt a merger; shareholders vote. AI rivals can do this to the player too. Companies whose stock collapses can go **bankrupt** and disappear.
- **Board of directors**: if the player's company performs badly and he doesn't hold a majority, he can be voted out (game over in some scenarios).

### 8. Managers
- Hire one manager at a time from a pool; each has a salary and traits, e.g. lower construction cost, lower breakdown chance, higher passenger revenue, better public goodwill, cheaper fuel.

### 9. AI rivals
- 1–3 AI railroad barons with distinct personalities (cautious builder, aggressive expander, stock-market speculator who shorts and raids rival companies).
- AI builds track and stations, competes for cities, and plays the stock market. In "friendly" mode the AI does not attack via the stock market.
- AI cannot cross or use the player's track (track rights optional).

### 10. Events & territories
- Historical-flavored random events (wars, gold rush, oil boom, labor strikes, bad harvests, new technology) with concrete, clearly explained effects.
- Territories/regions with a **goodwill** value toward the player; some regions may restrict building until goodwill is high enough or a fee is paid.

### 11. Time & control
- Real-time with **pause** (all actions allowed while paused) and speed levels 1×/2×/4×/8×.
- Monthly and yearly accounting; year-end report screen.

### 12. Audio
- Chiptune soundtrack generated via WebAudio (a few bluesy/bluegrass-inspired loops in 8-bit style – the original was known for its railroad blues soundtrack).
- SFX: steam whistle, chuff, cash register on delivery, stock ticker, construction thuds. Volume sliders, mute.

---

## Improvements over the original (UI/UX & design)

The original is beloved for depth, but players widely criticize its 1998-era interface, opaque demand mechanics, and stock-market/economy swings that come without warning. Fix that:

1. **Modern layout**: slim top bar (date, company cash, personal cash, stock price, economy state icon, speed controls), left tool rail, context panel on the right that changes with the selected object. No modal walls of buttons.
2. **Tooltips everywhere** with exact numbers and formulas (e.g. hovering a delivery shows: base rate × distance × time factor × demand × economy = $).
3. **Profit preview before committing**: when laying track or creating a route, show estimated cost, estimated yearly revenue, payback period, and the gradient profile of the route.
4. **Supply-chain explorer**: an interactive diagram of all cargo chains on this map; click a cargo to highlight producing/consuming industries on the map.
5. **Map overlays / heat maps**: demand per cargo, supply per cargo, city growth, station catchment, route profitability (green→red), congestion, terrain gradient.
6. **Demand made visible**: per station a demand gauge with history graph and recovery time, so saturation is understandable instead of mysterious.
7. **Train list as a sortable table**: profit/year, age, reliability, load factor, last breakdown – with bulk actions ("replace all engines older than 25 years with best available").
8. **Route templates**: copy a train's route/consist to new trains; "duplicate train" button.
9. **Economic early-warning**: leading indicators and a news ticker that hint at upcoming recessions or booms a few months ahead, so swings feel fair, not random.
10. **Stock market UX**: clean chart per company (price, volume, ownership pie), clear margin indicator with liquidation price, confirmation dialogs for risky actions, explanation of *why* a price moved.
11. **Advisor / notifications feed** (dismissable, filterable): "Station X has 40 tons of coal waiting", "Train 7 runs at 20 % load", "AI rival bought 18 % of your shares".
12. **Undo** for the last construction actions (until money is spent / time passes, define sensible rules).
13. **Onboarding**: short interactive tutorial scenario instead of a manual; contextual hints that can be turned off.
14. **Keyboard shortcuts** for all tools (shown in tooltips) + full mouse-wheel zoom & right-drag pan; map rotation in 90° steps.
15. **Accessibility**: colorblind-safe overlay palettes, UI scale setting, no information conveyed by color alone.
16. **Statistics screen**: graphs over time for revenue by cargo, per train, per station, company value, personal net worth vs. rivals.
17. **Passenger/mail destinations (optional, toggle)**: in the original, passengers had no specific destination – offer an optional mode where passengers have destinations for a deeper sim.
18. **Transfers (optional)**: allow cargo to be dropped at one station and picked up by another train – the original removed this compared to its predecessor and players missed it.

---

## Milestones (suggested – refine in PLAN.md)

1. **M1 – Engine & map**: Vite/TS setup, palette, iso renderer, camera (pan/zoom/rotate), procedural terrain with heights, cities and industries rendered. Pause/speed controls.
2. **M2 – Track & stations**: track building with cost & gradient preview, bridges, stations with catchment overlay.
3. **M3 – Trains & cargo**: engines, consists, routing, movement along track with gradient physics, loading/unloading, revenue calculation, fuel & maintenance.
4. **M4 – Economy**: industry chains, supply/demand with saturation, three economic models, city growth, economic cycle.
5. **M5 – Finance**: company books, bonds, dividends, shares, personal portfolio, margin/short, stock price model, year-end report.
6. **M6 – AI rivals & takeovers**: AI construction + stock-market behavior, mergers, bankruptcies, board votes.
7. **M7 – Improved UI**: overlays, supply-chain explorer, train table, advisor feed, stats, tooltips with formulas, undo.
8. **M8 – Content & polish**: engine roster across eras, events, managers, 3–5 scenarios with medals, tutorial, chiptune audio, save/load, settings.

Each milestone must leave the game **playable** and must add **Vitest tests** for the new sim logic (revenue formula, demand recovery, stock price reactions, bond interest, breakdown probability, etc.).

---

## Working rules

- Ask me only when a decision is genuinely mine (e.g. game name, scope cuts). Otherwise make sensible choices and note them in `DECISIONS.md`.
- Keep a `BALANCING.md` explaining every formula and its constants.
- `npm run dev` must always work; `npm test` must always pass before you commit.
- Keep performance smooth with 100+ trains and a 256×256 tile map (dirty-rect or chunked rendering, spatial indexing).
- README with controls, how to play, and credits for any third-party open assets.

Start now: create `SPEC.md` and `PLAN.md`, then implement M1.
