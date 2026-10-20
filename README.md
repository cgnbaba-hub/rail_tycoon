# Iron Baron

An 8-bit, browser-based railroad business simulation — an homage to the late-90s railroad
tycoon games, with original pixel art, an original pixel font and a modern, friction-free UI.

> Status: **Milestone 3 (trains & cargo)** — build a railroad on a procedurally generated
> world, buy steam engines, set routes and consists, and haul passengers, mail and freight
> for profit. Industry chains & city growth (M4), the stock market (M5) and AI rivals (M6)
> follow (see `PLAN.md`).

## Running

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # Vitest unit tests (simulation + pure render math)
npm run build    # type-check + production build into dist/
```

Useful URL parameters: `?seed=1234&size=128` (sizes: 64, 128, 192, 256), `?map=high_pass` (a
hand-made map, see below).

Dev helpers (no browser needed):

```bash
npx vite-node scripts/preview.ts -- <seed> <size> <rot 0-3> <tile width 8|16|32> out.png
npx vite-node scripts/mapstats.ts -- <seed> <size>
npx vite-node scripts/balance.ts -- <seed> [engine] [cars]   # one-year economics check
npx vite-node scripts/stress.ts                              # 120 trains, signalling + perf
npx vite-node scripts/rivals.ts -- <seed> <years> <level>    # watch AI rivals for a few years
npx vite-node scripts/mapview.ts -- <map id | seed> [size] [out.png] [year]  # top-down map picture
npx vite-node scripts/scenario-bot.ts -- <scenario id>       # a scripted player, for medal tiers
```

## Controls

| Input | Action |
|---|---|
| `T` | Lay track — drag from A to B; the route is planned automatically (cost, grades and elevation profile shown live) |
| `V` | Single / double track (track tool) |
| `B` | Build station — hover shows the catchment and what it covers; `B` again cycles depot/station/terminal, `R` rotates |
| `X` | Bulldoze track, bridges/tunnels (whole span) or stations |
| `F` | Trains: sortable table (profit/yr, age, reliability, load, breakdowns) with bulk upgrade/sell/re-route, route templates, new train dialog |
| `M` | Finance: books, bonds, stock chart & share actions, your portfolio (trade any railroad) |
| `O` | Railroads: rivals, chairmen, stakes, takeover votes, board confidence |
| `U` | Advisor: what needs attention, news log, every delivery with its revenue formula |
| `K` | Statistics: revenue by cargo, trains, stations, rivals' market value, net worth |
| `J` / `Shift+J` | Map overlays (supply, demand, growth, catchment, route profit, traffic, congestion, gradient) / off |
| `Y` | Supply-chain explorer — click a cargo to see where it is made and used |
| Click a top-bar chip | Economy report · stock window · your portfolio |
| Click a train | Select it: status, cargo, route, profit; edit, follow, duplicate, upgrade engine, sell |
| `Ctrl+Z` | Undo the last construction (full refund within 7 in-game days) |
| `I` / `Esc` | Back to Inspect (`Esc` also cancels a drag; right-click cancels too) |
| Right / middle drag (or left drag) | Pan |
| W A S D / arrow keys | Pan |
| Mouse wheel, `+` / `-` | Zoom (¼×, ½×, 1×, 2× with full detail, 4× chunky close-up) |
| `Q` / `E` | Rotate the view 90° |
| Hover / click | Inspect / pin a tile, town or industry (`Esc` unpins) |
| `Space` / `P` | Pause / resume (everything stays usable while paused) |
| `1` `2` `3` `4` | Speed 1× 2× 5× 15× (1×: a game day takes 1.5 s, a year about 9 minutes) |
| `G` | Tile grid |
| `L` | Town labels |
| `C` | Centre on pinned tile / largest town |
| `Ctrl+S` | Quick save (the disk button opens save & load, export and import) |
| Gear button | Settings: music / effects volume, mute, interface size, reduced motion, hints, autosave |
| `N` | New map (seed, size, water, terrain, forests, towns, start year, rivals, rival skill & attitude) |
| `H` / `?` | Help |

The overview map in the lower right is clickable/draggable.

## How to play

You chair a new railroad founded with $1,000,000 from its share issue; you hold 20 % of the shares.

1. **Scout** — hover towns and industries; stations show what they would supply and demand.
2. **Build stations** (`B`) whose catchment covers big towns or industry chains
   (coal + iron near a steel mill, grain + cattle near a food plant).
3. **Lay track** (`T`) from station to station; the preview shows cost, grades and — when
   both ends are stations — the expected revenue and payback.
4. **Buy a train** (`F` → New train, or *New train from here* in a station panel). The dialog
   estimates trip times, the slowest speed on the steepest grade and the yearly profit.
5. Watch the money roll in (`+$` pop-ups), keep an eye on breakdowns and old engines, and
   upgrade or duplicate your best trains.

**The economy.** Each delivery lowers what a station pays for that cargo for a few weeks —
spread your trains over several destinations. The chip in the top bar shows the economic
state (Boom … Panic) and *business confidence*: when it starts to move, the economy will
follow within months (click it for the economic report and news). Towns grow faster when you
carry their passengers and bring the goods they demand; growing towns demand more. Station
panels sell improvements (hotel, post office, water tower, maintenance shop, …); the train
dialog offers a caboose and dining car as extras. In the Expert economy you can buy
industries from their info panel.

**Money.** The company and you are separate: the company has cash, bonds and shares
(`M` opens the finance window — books, bonds, stock chart, your portfolio). You own 20 % of
it at the start and earn a salary plus dividends. Profits, book value, dividends and the
economy's mood drive the share price; the stock window explains every move. Bonds are
cheaper with a good credit rating; running out of cash forces expensive emergency bonds.
You can buy more shares (on margin), sell, or sell short — watch the margin gauge. Your
personal net worth is in the top bar.

**Information.** The advisor (`U`, with a badge when something needs you) lists waiting
cargo, stuck or empty trains, saturated stations, money and takeover risks; *Show* jumps to
the place. Map overlays (`J`) show where cargo is produced and wanted, which track pays and
where trains queue; the supply-chain explorer (`Y`) shows what feeds what on this map.
Statistics (`K`) graph your revenue by cargo, every train and station, and how you compare
with the rival barons. Hover numbers in the top bar and station panels for their formulas.
Save a good train as a template to buy copies (also running the other way).

**Game modes.** The title screen offers the tutorial, twelve scenarios with bronze, silver and
gold medals (marked easy, medium or hard, each with a map preview), and the sandbox: a random
land or one of the six hand-made maps, with your rules. The goal chip in the top bar shows how
your scenario is going. In the easy scenarios the shareholders never vote you out (the
sandbox has a switch for it). Games autosave every few months; you can also save, export to a
file and import it again.

| Scenario | Map | Years | Goal |
|---|---|---|---|
| Tutorial: First Spike (easy) | random 64² | 1850–1853 | best yearly revenue, two towns linked |
| The Iron Horse (easy) | random 128² | 1835–1845 | company book value |
| River Towns (easy) | Twin Rivers | 1840–1850 | company book value |
| Coal for the Mills (medium) | random 128² | 1870–1880 | coal, iron & steel loads |
| Over the Pass (medium) | High Pass | 1858–1870 | best yearly revenue, Wheatfield–Port Ashby linked |
| Black Gold (medium) | Black Gold Basin | 1895–1905 | oil & petroleum loads |
| Bridge the Divide (medium) | random 128² | 1880–1892 | best yearly revenue, two big towns linked |
| Lake Shore Line (medium) | Great Lake | 1872–1887 | personal net worth, Northshore–Southport linked |
| Streamliner Age (medium) | random 192² | 1936–1950 | personal net worth |
| Commuter Rush (medium) | Capital Region | 1948–1958 | passenger & mail loads |
| Robber Barons (hard) | random 192² | 1885–1900 | net-worth rank among the barons |
| Coast to Coast (hard) | Coast to Coast 256² | 1866–1886 | net-worth rank, Bayview–Eastport linked |

**Hand-made maps** live in `src/data/maps.json`: a gentle noise base shaped by features (seas
along an edge, lakes, mountain ridges along a path, hills, plains, river valleys with their
rivers, more or fewer forests, deserts), named towns of a given size and population, fixed
industries, plus some random villages and industries in between. Positions are fractions of
the map, so a layout works at any size. The seed only varies the small detail.

**Events, managers and territories.** Wars, gold rushes, strikes, harvests and new
technologies change prices and costs for a while (the economic report lists what is in
effect). Hire one manager at a time in the finance window's Manager tab. The map is divided
into regions with their own goodwill toward you: good service raises it and lowers your
building costs; some regions need a charter — earn enough goodwill or buy it from the
inspector. The Territories overlay shows them all.

**Sound.** Procedural chiptune blues and synthesized effects (cash register, whistle, chuffing
when you follow a steam train). Adjust or mute them in the settings.

**Rivals.** Up to three rival barons (two by default) build their own railways — their
stations have coloured roofs and labels — and play the stock market. A baron who buys 30 %
of your company can call a takeover vote; your own stake, a rising share price and profits
keep your shareholders loyal. From the third year the shareholders vote on you every
January: lose twice in a row and you are out. A company whose debts exceed its assets goes
bankrupt. You can raid rivals too: buy their shares and propose a merger in the Railroads
window (`O`). Choose *friendly* rivals in the new-map dialog for a gentler game.

**Transfers.** Tick *transfer* on a stop in the route editor and the train sets everything
down there; any other train that can take it on (to a station that wants it, or to its own
transfer stop) picks it up. A transferred load is paid only when it is delivered — from the
station where it was first loaded, for the whole time on the way — and the money is shared
between the trains by the distance each carried it. The station panel lists what waits to
transfer; lots left for half a year are lost.

**Passenger destinations** (new-map option *Passengers: destinations*, off by default). Every
passenger and mail bag then wants to reach one particular station: one the trains can take it
to with at most one change, bigger towns and nearer stations more likely. Travellers only
board trains that get them there and change trains on their own where a connecting train
calls (no transfer order needed). The station panel shows where its travellers are headed,
the train panel who is aboard for where. Without a train to anywhere, nobody starts a journey.

Single track carries one train per block between stations; double track lets trains pass
anywhere. Steep grades slow heavy trains to a crawl. Pause any time — building works while
paused, and construction can be undone for a full refund for a week of game time.

## Project layout

```
src/sim/     deterministic simulation (no DOM): rng, noise, world, mapgen, time, track,
             construction, trains, economy, cycle, growth, company, finance, chairman,
             ai (rival barons), rivals (mergers, bankruptcy, board vote), stats, advisor,
             overlays, fleet, events, modifiers, territories, layout (hand-made maps),
             cargoflow (transfers, destinations),
             scenario, save, game
src/audio/   chiptune composer and WebAudio engine (music + effects)
src/render/  palette, iso projection, camera, software rasterizer, chunk renderer
src/ui/      DOM HUD, inspector, minimap, dialogs, runtime-generated pixel font
src/data/    JSON data: cargo, industries, buildings, mapgen, maps, scenarios, names, time, …
src/assets/  glyph table for the pixel font
tests/       Vitest specs
```

See `PLAN.md` (milestones), `DECISIONS.md` (design choices) and `BALANCING.md` (formulas).

## Credits

All art, the 32-colour palette, the "BaronPixel" 5×7 font and all code are original to this
project. No third-party assets are used. Tooling: TypeScript, Vite, Vitest.

This game is not affiliated with, endorsed by or derived from the assets of any commercial
railroad game.
