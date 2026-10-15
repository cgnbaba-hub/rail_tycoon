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
- train length for signalling = engine 0.52 + 0.42 per car (tiles); steam engines also draw a
  0.32-tile tender, which fits inside the 0.5-tile margin every block keeps.

**Supply** (loads/month at a station): towns `population_covered × townSupply`
(passengers 0.0026, mail 0.0009 per person); raw industries `rate` loads/month. Shared equally
when several stations cover the same building or industry. Stock is capped at
`maxWaitingMonths` (3) of supply. Processing industries turn delivered input loads into the
same number of output loads next month (up to `rate`); in the Basic model they also make
`processorWithoutInputs` (2) loads/month unsupplied.

**Demand**: towns by size class (`townDemand`), industries their inputs.

**Revenue per load** = `(base + perMile · miles) · timeFactor · demandFactor · economyFactor · bonusFactor`
- miles = straight-line tiles between origin and destination station × 0.25
- `timeFactor = max(minFactor, 0.5^(late / halfLife))`, `late = max(0, days − idealDays − graceDays)`,
  `idealDays` = time a 40 mph train needs; half-lives: fast 8 d (passengers, mail, milk),
  medium 18 d, slow 45 d, none for bulk; floor 0.25; grace 2 days.
- `demandFactor` = (1 when the station demands the cargo, else the model factor: Basic 0.75,
  Advanced 0.5, Expert 0.1) × the station's current **demand level** for that cargo.
- `economyFactor` = economic-cycle revenue factor × cargo price level (Expert only).
- `bonusFactor` = destination station improvements (hotel, post office, …) × consist extras
  (dining car: passengers × 1.15; caboose: freight × 1.08 — one of each counts).

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

Reference check (`npx vite-node scripts/balance.ts -- 7`, also seeds 3, 11): two cities
~10 miles apart, one 4-car Columbia: ≈ $150–240k revenue/year, ≈ $10k running costs, payback
of track + train in ≈ 1.8–3 years (with M4 saturation and a random economic cycle; a single
train leaves demand at 85–99 %).

## Economy (`economy.json`, M4)

**Demand saturation** (`saturation`): every station keeps a demand level per accepted cargo
(1 = full price). A delivery of `n` loads lowers it by
`dropPerCapacity (0.12) × model.saturation × n / capacity`, floor 0.15. It recovers towards 1
with a half-life of `recoveryHalfLifeDays` (45 d). `capacity` (loads/month the catchment
absorbs) = covered population / 1000 × `townCapacityPerThousand` (passengers 6, mail 2.5,
food 1.6, goods 1.4, milk 1.2, other 1) + Σ consuming industries `rate × 1.5`, at least 3.
Model saturation strength: Basic 0.6, Advanced 1.0, Expert 1.3.
Steady state for a constant flow `d` loads/month: `L = 1 − drop(d) / (1 − 0.5^(30.4/45))`;
the train estimate uses `min(current level, L)` so a planned train already accounts for the
prices it will push down. A town of 6,000 receiving its partner town's passengers settles
around 85–90 %.

**Economic cycle** (`cycle`): Boom / Prosperity / Normal / Recession / Panic with revenue
×1.15 / 1.07 / 1.00 / 0.88 / 0.75 and town growth ×1.6 / 1.25 / 1 / 0.5 / 0. Each state lasts
8–30 months; the next state is drawn from the `transitions` weights when a state begins.
**Leading indicator:** business confidence (0–100) sits at the state's level (88 / 70 / 55 /
35 / 15, ±3 noise) and, 3–6 months before a change, moves linearly towards the coming state's
level while headlines hint at the direction. The top bar shows state, confidence and its
3-month trend.

**Cargo prices** (Expert only, `priceLevels`): each cargo's index random-walks monthly
(`p ← p·(1 + U(−0.05, 0.05)) + (1 − p)·0.12`), clamped to [0.65, 1.45].

**Town growth** (`cityGrowth`, monthly): annual rate =
`(0.004 + 0.05 · service + 0.04 · supplied) × cycle growth factor`, where
`service = min(1, passengers & mail picked up / town supply / 0.6)` and
`supplied = min(1, demanded freight delivered / (2 loads per 1,000 people per year))`.
Towns add up to 3 buildings a month on free flat lots off the street grid (never on track),
move up a size class at the class's `popMin` (unlocking new demands) and then attract a new
processing industry with 80 % chance.

**Raw industry growth** (`industryGrowth`, yearly): picking up ≥ 60 % of the output grows the
production level by 12 % (max 250 %); < 20 % shrinks it by 6 % (min 50 %); sites without a
station drift back to 100 %.

**Industry ownership** (Expert, `ownership`): owner's profit/month = output × cargo base × 0.6
× economy factor − $1,500/12. Price = 5 × yearly profit valued at no less than 40 % of
full-capacity profit, at least $25,000; sold back for 80 %. A fed processing plant (12 loads
of goods) earns ≈ $30k/year, roughly a 2-year payback; raw sites ≈ 5 years.

**Station improvements** (`improvements`, effects stack multiplicatively):

| Improvement | Cost | Upkeep/yr | Effect |
|---|---|---|---|
| Water tower | $15,000 | $500 | dwell × 0.7 |
| Sand house | $12,000 | $400 | adhesion × 1.2 for the next leg |
| Maintenance shop | $40,000 | $2,000 | breakdown chance × 0.5 for 60 days after a stop |
| Roundhouse (needs shop) | $60,000 | $3,000 | maintenance × 0.7, breakdowns × 0.8 for 60 days |
| Hotel | $50,000 | $1,500 | passenger revenue × 1.2, passenger supply × 1.15 |
| Restaurant | $25,000 | $800 | passenger revenue × 1.1 |
| Post office | $25,000 | $800 | mail revenue and supply × 1.25 |
| Warehouse | $35,000 | $1,200 | waiting-cargo cap × 2 |
| Cold storage | $40,000 | $1,500 | +4 grace days for perishables loaded here; food & milk revenue × 1.15 |
| Livestock pens | $20,000 | $600 | livestock supply × 1.25, revenue × 1.1 |

Revenue boosts apply at the *destination* station. Caboose: freight × 1.08, breakdowns × 0.85;
dining car: passengers × 1.15 (cars that carry nothing).

## Rendering constants (code, visual only)
- Light direction (view space) `(-0.6, 0.25, 0.76)`, height-to-tile ratio `Z_UNIT = 0.9`,
  `SHADE_GAIN = 2.2`: `t = 1 + (n·L − L_z) · gain` picks a position on a 3-colour ramp.
- Display elevation: 1 height level = 60 ft (`feetPerLevel`).

## Finance (`finance.json`, M5)

**Founding:** 100,000 shares × $10 = $1,000,000 company cash; chairman 20,000 shares
(cost $200,000 of a $300,000 fortune). Salary $24,000/yr.

**Fair value (whole company)** = `(book + P/E · profit⁺ + 0.5 · P/E · profit⁻ + 4 · dividends/yr) × mood`
- book = book value (balance sheet); profit = smoothed annualised net profit:
  `trend += 0.15 · (monthNet · 12 − trend)` each month.
- P/E by economic state: Boom 11, Prosperity 9.5, Normal 8, Recession 6.5, Panic 5.
- mood = `1 + (confidence − 55) · 0.0067` (confidence 15 → 0.73, 88 → 1.22).
- Daily: `price += (fair/share − price) · 0.05 + price · N(0, 0.012)`; floor $0.25.
- Trades move the price by `0.6 × shares / shares outstanding` (half that is the average
  execution price). Commission 0.5 % on personal trades.

**Bonds:** $100,000 blocks, 20-year term, rate fixed at issue = base + spread.
Base: Boom 6 %, Prosperity 5 %, Normal 4.5 %, Recession 4 %, Panic 7 %.
Rating by debt/assets: AAA ≤ 10 %, AA ≤ 20 %, A ≤ 30 %, BBB ≤ 40 %, BB ≤ 50 %, B ≤ 60 %,
CCC ≤ 75 %, else D; spreads 0 / 0.5 / 1 / 1.5 / 2.5 / 4 / 6 / 9 %. Interest cover
`(profit + interest) / interest` below 4 / 2 / 1 costs 1 / 2 / 3 notches. Emergency bonds
+2 %.

**Dividends:** annual $/share in $0.10 steps, paid in Jan/Apr/Jul/Oct.
**Shares:** issue 10 % blocks at −5 % (max every 6 months); buyback 10 % at +3 %; 2:1 split
from $60.
**Margin:** initial 50 %, maintenance 30 %, loan rate = base + 2 %.
**Depreciation:** infrastructure 2 %/yr (monthly).

Reference (`npx vite-node scripts/finance.ts -- 42`): two trains between two cities,
$100k bond, $0.50 dividend: share price $10 → ≈ $19 after the first year, ≈ −20 % in the
following recession; the chairman's net worth $300k → ≈ $500k.

## Rivals, mergers, board (`ai.json`, M6)

**Barons:** Vandermere Central (cautious builder), Hartwell Pacific (aggressive expander),
Fenwick & Erie (stock speculator); each founded like your company (100,000 shares, the baron
holds 20 %, $100k personal cash).

| Personality | Build every | Reserve | Credit limit | Trains/route (max) | Line length | Competition | Payout | Own stake | Buy < fair | Sell > fair | Short | Raid | Merge at |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Builder | 4 mo | $150k | A | 2 (4) | 10–28 tiles | ×0.5 per rival station | 35 % | 30 % | 0.8 | 1.35 | no | no | 60 % |
| Expander | 2 mo | $60k | B | 3 (5) | 8–36 | ×1.0 | 0 | 35 % | 0.85 | 1.5 | no | yes | 42 % |
| Speculator | 6 mo | $100k | BBB | 2 (3) | 10–24 | ×0.8 | 15 % | 22 % | 0.9 | 1.15 | > 1.3 × fair | yes | 45 % |

Skill levels multiply build frequency / trade size: relaxed 0.6 / 0.5, normal 1 / 1,
ruthless 1.4 / 1.6.

**Line choice:** score = √(popA · popB) · min(d, 24)/24 · competition^(rival stations in
town); extensions from own stations × 1.1. A line is built only if
`12 · Σ townSupply · (people A + people B) · fare(d)` exceeds running costs
(`$11k · trains + 1.3 · d · track upkeep · 1.6 + $6k`) by 10 % of the capital
(`d · $9k + $120k`). Stations go where they cover the most people per dollar
(≈ $40 per covered person), terminals in towns > 6,000.

**Raids:** a raider buys up to 6 % (× skill) of a smaller railroad a month until it reaches
its merge stake, then calls a vote.

**Merger vote:** offer = target price × 1.15 in acquirer shares. Public yes share =
0.10 + 0.15 · 1.5 = 32.5 % (+25 % if the target's price fell this year, capped at 90 %).
Needs > 50 % of all target shares. Failed vote → 12-month cooldown for that bidder.

**Board vote** (from year 3): support = your stake + public stake · mood (+ friendly barons
· mood), mood = `0.55 + 0.8 · price change over the year + 0.1 (profit) / − 0.2 (loss)`,
clamped 5–95 %. < 50 % is a strike; two in a row = removed. Warning below 60 %.

**Bankruptcy:** book value < 0 and cash < 0 at month end → no emergency bonds; after
2 such month-ends the company is bankrupt.

Reference (`npx vite-node scripts/rivals.ts -- 42 4 normal`, 128 map, 3 rivals, the
player runs one line): after 4 years the expander leads (≈ $120k/yr profit, 7 trains), the
builder breaks even on 5 stations, the speculator loses money on its railway; rivals
hold 5–6 % of the player's company. Simulating 4 years takes < 2 s.

## Advisor and overlays (`advisor.json`, M7)

| Advice | Trigger |
|---|---|
| Cargo waiting | ≥ 12 loads of one cargo at your station (worth a look at ≥ 24) |
| Idle station | no train of yours calls there |
| Saturated demand | demand level < 50 %, with days to recover to 90 % |
| Stuck train | waiting ≥ 10 days at a signal |
| Low load | load factor < 30 % after ≥ 4 departures |
| Losing train | negative 12-month profit after ≥ 6 months |
| Worn-out engine | older than its design life |
| Cash | negative (urgent) or < $50,000 |
| Credit | rating index ≥ 5 (B or worse) |
| Margin | margin loan and equity ratio < 50 % (urgent below 36 %) |
| Rival stake | a baron holds ≥ 10 % of your company (urgent at the 30 % merger threshold) |
| Board | strike already, or support below 60 % once votes are due |
| Confidence | ±8 points or more over three months |

**Load factor:** share of cargo cars (caboose/dining car excluded) loaded at departure;
moving average `lf += 0.25 · (share − lf)`.
**Train profit/yr:** sum of the last 12 monthly profits × 12 / months recorded.

**Overlay fields** (per tile):
- Supply: Σ loads/month produced within ±3 tiles (industries at current output; towns
  `population per building × townSupply`).
- Demand: Σ loads/month absorbed within ±3 tiles (industries `rate × industryCapacityFactor`,
  towns `pop/1000 × townCapacityPerThousand` for demanded cargo).
- Traffic: trains per month ≈ counter × 0.3 (counter fades × 0.7 monthly).
- Route profit: mean 12-month profit/yr of the trains passing.
- Congestion: days per month spent blocked at signals or broken down.
- Gradient: track grade (max over its connections); land: fall over three tiles.
- Buckets: amounts at 10/25/45/70 % of the maximum; ±(20 %, 100 %) of half the largest
  magnitude around zero; gradient 1 / 2 / 3.5 / 5 %; catchment 2–5 stations.

