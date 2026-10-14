# Balancing & formulas

Every tunable constant lives in `src/data/*.json`. This file explains how they are used.
Later milestones append their formulas (revenue, demand, stock price, …) here.

## Time (`time.json`)

| Constant | Value | Meaning |
|---|---|---|
| `ticksPerDay` | 24 | One tick = one in-game hour |
| `realMsPerDayAtSpeed1` | 450 | 1× speed: a month ≈ 14 s, a year ≈ 2.7 min; at 8× a year ≈ 20 s |
| `speeds` | 1, 2, 4, 8 | Speed multipliers |
| `maxTicksPerFrame` | 1200 | Safety cap per rendered frame |

`ticks(frame) = floor(acc)`, `acc += min(dt, 250 ms) · speed · ticksPerDay / realMsPerDay`.
Frames longer than 250 ms (background tab) are clamped so the game never fast-forwards.

## Map generation (`mapgen.json`)

**Heights.** For every vertex:
`v = fbm(x·s, y·s) · (1 − 0.35·range) + ridge² · 0.35·range`, with `s = noise.baseScale`,
`ridge = 1 − |2·fbm₂ − 1|` (mountain chains) and `range`/`exponent` from the hills setting.
Near the border (`edgeFalloff.width` as fraction of the map) `v −= strength · k²` to favour coasts.
Sea level `t` is the `water[setting]` quantile of all `v`. Land vertices become
`level = 1 + floor(((v − t)/(max − t))^exponent · range · (maxHeight − 1))`.
Finally an L1 distance transform lowers vertices so neighbours differ by ≤ 1 level.

**Rivers.** `round(perTenThousandTiles · area / 10 000)` attempts-worth of sources at tiles with
average height ≥ `minSourceHeight · maxHeight`; each walks 4-connected to the lowest neighbour
(downhill or level, small random tie-break) until it reaches water or another river. Kept if
`minLength ≤ length ≤ maxLength`.

**Biomes** (per land tile, `h` = average corner height):
beach if it touches sea level next to water and `max ≤ beachMaxHeight`; snow if
`h ≥ snowHeight · maxHeight`; rocky hills if `h ≥ rockHeight · maxHeight` (forested instead when
very moist); forest if moisture-fBm `> forests[setting]`; otherwise grassland with a
`scatteredTreeChance` lone tree.

**Towns.** Target count `max(2, round(perTenThousandTiles[setting] · area / 10 000))`.
Candidate sites (buildable, ≥14 buildable tiles in the 5×5 around, ≤ `maxHeightFraction`)
score `1 + 1.5·coastal + 1.5·river + flat/25`; sites are drawn by weighted random order with
`minSpacing`. Class by `classes[].weight`; at most `area / areaPerMetropolis` metropolises; at
least one "city" if there are ≥3 towns. Population uniform in `[popMin, popMax]`;
building tiles `= ceil(population / peoplePerBuilding)`, chosen by a Gaussian around the centre
(`σ = 0.55·√n + 0.8`) on a street grid every 4th row/column. Building styles
(`buildings.json`) are picked by weight among those allowed for the town class and ring
(normalised distance from the centre). Office/tower heights × `(1 + 0.15·class)`.

**Industries.** For each type available in the start year:
`expected = density · landTiles / 10 000 · industries.densityScale`, rounded stochastically
(raw industries get at least one if `expected > 0.3`). Up to `80 · target` random attempts; a
spot is valid when the footprint is buildable, on allowed terrain, within the height band, has
≤ 1 level of relief, keeps `minGap` tiles from other occupants, keeps `spacing` from the same
type, and (processors) lies `nearCity[0..1]` tiles beyond a town's built-up radius (resource
sites stay ≥ 3 tiles outside towns).

## Construction (`construction.json`, `stations.json`, `company.json`)

Scale: `feetPerTile = 1320`, `feetPerLevel = 60` →
`grade % = Δlevels · 60 / (tiles · 1320) · 100` (one level per tile ≈ 4.5 %).

**Track step** from tile A to neighbour B (length `L` = 1 or √2):
`cost = single · L · max(terrain[A], terrain[B]) + perLevelClimb · |zB − zA| (+ doubleExtra · L if double)`
plus, once per newly occupied tile: `clearForest` (forest or lone tree), `levelCrossing`
(town street), `demolish[building type]`. Terrain factors: grass 1.0, sand 1.15, forest 1.3,
rough 1.7, snow 2.1. Reusing existing track is free (upgrading to double costs `doubleExtra · L`).

**Bridges** (straight span of k interior tiles): `perTile · (k + 1) · L + perLevel · Σ deck height above ground`.
Wooden trestle (k ≤ 3, 35 mph, 400 t), stone arch (k ≤ 5, 80 mph, 3,000 t), steel truss
(k ≤ 10, from 1870, 120 mph, 9,000 t). "Auto" picks the cheapest type that spans the gap.
Deck clearance ≥ 0.5 level over dry ground; deck slope ≤ 1 level per tile.

**Tunnels**: `perTile · (k + 1) · L`, 2 ≤ k ≤ `maxLength` (8), every interior tile's centre must
be ≥ `minCover` (0.75 level) above the tunnel line, grade ≤ `maxGradeLevelsPerTile` (0.5).

**Planner** (A*, not charged): step penalty `gradeAvoidance · grade%² · L + turnPenalty` (per 45°
turn); reused track costs `reusePerTile · L`; heuristic = octile distance · single ·
`heuristicWeight` (1.1, slightly greedy for speed). Search stops after `maxExpansions`.

**Stations**: depot $25k (1 tile, radius 2), station $60k (2 tiles, radius 3), terminal $120k
(3 tiles, radius 4), plus track and demolition for new tiles. Covered town population =
`population · buildings inside / live buildings`.

**Bulldozing**: `bulldozePerTile` ($500) per removed track tile (station tiles count too).
**Undo**: full refund; `undo.maxActions` = 30, `undo.windowDays` = 7.

**Company**: `startingCash` $1,000,000 (until shares/bonds arrive in M5).

## Trains, cargo & revenue (`engines.json`, `cars.json`, `cargo.json`, `economy.json`)

**Physics** (per tick = one game hour; `physics`):
- tractive effort `F = min(power · 375 / max(v, 3), adhesion_tons · 2000 · 0.25)` lbf
- resistance `R = tons · (2 + 0.02 v + 0.0006 v²) + tons · 20 · grade%` lbf
- `Δv = (F − R) · 0.010968 / tons · physicsSecondsPerTick(40)` mph per tick, capped at the
  engine's top speed and bridge limits (overweight on a bridge: 8 mph); never below a 3 mph
  crawl on grades. Braking `brakeMphPerTick` (6); stopping distance `k·v²/(2b) + k·v`.
- movement: `tilesPerTickPerMph` = 0.0065 (40 mph ≈ 6.2 tiles/day).
- train weight = engine + Σ car tare + loads · cargo tons.

**Supply** (loads/month at a station): towns `population_covered × townSupply`
(passengers 0.0026, mail 0.0009 per person); raw industries `rate` loads/month. Shared equally
when several stations cover the same building or industry. Stock is capped at
`maxWaitingMonths` (3) of supply. Processing industries turn delivered input loads into the
same number of output loads next month (up to `rate`); in the Basic model they also make
`processorWithoutInputs` (2) loads/month unsupplied.

**Demand**: towns by size class (`townDemand`), industries their inputs.

**Revenue per load** = `(base + perMile · miles) · timeFactor · demandFactor · economyFactor`
- miles = straight-line tiles between origin and destination station × 0.25
- `timeFactor = max(minFactor, 0.5^(late / halfLife))`, `late = max(0, days − idealDays − graceDays)`,
  `idealDays` = time a 40 mph train needs; half-lives: fast 8 d (passengers, mail, milk),
  medium 18 d, slow 45 d, none for bulk; floor 0.25; grace 2 days.
- `demandFactor` = 1 when the station demands the cargo, else the model factor
  (Basic 0.75, Advanced 0.5, Expert 0.1). `economyFactor` = 1 until M4's economic cycle.

**Loading**: dwell `minDwellHours (4) + hoursPerLoad (3) × loads moved`; "wait for full load"
re-checks for cargo up to `maxWaitDays` (60).

**Costs**:
- fuel per tile = `0.25 mi × fuelPrice[fuel] × (fuelBase + fuelPerTon · tons)`
  (wood 0.9, coal 1.0, diesel 1.3, electric 0.8)
- engine maintenance per month = `maintenance / 12 × (1 + 0.05 · age_years)`
- track upkeep per month = `perTileYear (90) / 12` per tile × 1.6 double × 2.5 bridge × 3.0 tunnel;
  stations $1,500 / $3,000 / $6,000 per year
- breakdowns: daily chance `0.0022 × (1 − reliability)/(1 − 0.85) × (1 + (age/lifespan)²)`;
  repair 2–5 days costing 4 % of the engine price
- wrecks (if enabled): chance per tile `4·10⁻⁶ × (age/lifespan)³` (× 50 when overweight on a bridge)
- resale: engine `price × max(0.15, 0.75 − 0.04 · age)` + cars at half price; upgrades trade the
  old engine in at that value.

Reference check (`npx vite-node scripts/balance.ts -- 7`): two cities ~10 miles apart, one
4-car Columbia: ≈ $180–240k revenue/year, ≈ $10k running costs, payback of track + train
in ≈ 1.5–2.5 years.

## Rendering constants (code, visual only)
- Light direction (view space) `(-0.6, 0.25, 0.76)`, height-to-tile ratio `Z_UNIT = 0.9`,
  `SHADE_GAIN = 2.2`: `t = 1 + (n·L − L_z) · gain` picks a position on a 3-colour ramp.
- Display elevation: 1 height level = 60 ft (`feetPerLevel`).
