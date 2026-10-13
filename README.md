# Iron Baron

An 8-bit, browser-based railroad business simulation — an homage to the late-90s railroad
tycoon games, with original pixel art, an original pixel font and a modern, friction-free UI.

> Status: **Milestone 1 (engine & map)** — explore procedurally generated worlds. Track,
> stations, trains, economy and the stock market follow in later milestones (see `PLAN.md`).

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

## How to play (M1)

Start a new map, explore it and scout good routes: big towns, coal next to iron near a steel
mill, grain and cattle near a food plant. Every industry shows what it produces and what it
needs. Building and running a railroad arrives with M2/M3.

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
