# Iron Baron

An 8-bit, browser-based railroad business simulation — an homage to the late-90s railroad
tycoon games, with original pixel art, an original pixel font and a modern, friction-free UI.

> Status: **Milestone 2 (track & stations)** — survey a procedurally generated world, lay
> auto-routed track with bridges and tunnels, and place stations with live catchment
> previews. Trains, economy and the stock market follow in later milestones (see `PLAN.md`).

## Running

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # Vitest unit tests (simulation + pure render math)
npm run build    # type-check + production build into dist/
```

Useful URL parameters: `?seed=1234&size=128` (sizes: 64, 128, 192, 256).

Dev helpers (no browser needed):

```bash
npx vite-node scripts/preview.ts -- <seed> <size> <rot 0-3> <tile width 8|16|32> out.png
npx vite-node scripts/mapstats.ts -- <seed> <size>
```

## Controls

| Input | Action |
|---|---|
| `T` | Lay track — drag from A to B; the route is planned automatically (cost, grades and elevation profile shown live) |
| `V` | Single / double track (track tool) |
| `B` | Build station — hover shows the catchment and what it covers; `B` again cycles depot/station/terminal, `R` rotates |
| `X` | Bulldoze track, bridges/tunnels (whole span) or stations |
| `Ctrl+Z` | Undo the last construction (full refund within 7 in-game days) |
| `I` / `Esc` | Back to Inspect (`Esc` also cancels a drag; right-click cancels too) |
| Right / middle drag (or left drag) | Pan |
| W A S D / arrow keys | Pan |
| Mouse wheel, `+` / `-` | Zoom (¼×, ½×, 1×, 2×) |
| `Q` / `E` | Rotate the view 90° |
| Hover / click | Inspect / pin a tile, town or industry (`Esc` unpins) |
| `Space` / `P` | Pause / resume (everything stays usable while paused) |
| `1` `2` `3` `4` | Speed 1× 2× 4× 8× |
| `G` | Tile grid |
| `L` | Town labels |
| `C` | Centre on pinned tile / largest town |
| `N` | New map (seed, size, water, terrain, forests, towns, start year) |
| `H` / `?` | Help |

The overview map in the lower right is clickable/draggable.

## How to play (M2)

You chair a new railroad with $1,000,000. Scout the map (hover anything for details), then
place stations where their catchment covers big towns or chains of industries (coal + iron
near a steel mill, grain + cattle near a food plant) and connect them with track. Watch the
grade profile: steep lines are cheap to build but will slow heavy trains once they run (M3).
Pause any time — building works while paused, and anything you build can be undone for a
full refund for a week of game time.

## Project layout

```
src/sim/     deterministic simulation (no DOM): rng, noise, world, mapgen, time, game
src/render/  palette, iso projection, camera, software rasterizer, chunk renderer
src/ui/      DOM HUD, inspector, minimap, dialogs, runtime-generated pixel font
src/data/    JSON data: cargo, industries, buildings, mapgen, names, time
src/assets/  glyph table for the pixel font
tests/       Vitest specs
```

See `PLAN.md` (milestones), `DECISIONS.md` (design choices) and `BALANCING.md` (formulas).

## Credits

All art, the 32-colour palette, the "BaronPixel" 5×7 font and all code are original to this
project. No third-party assets are used. Tooling: TypeScript, Vite, Vitest.

This game is not affiliated with, endorsed by or derived from the assets of any commercial
railroad game.
