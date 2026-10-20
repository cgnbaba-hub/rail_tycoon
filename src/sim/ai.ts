import { AI, ECONOMY, FINANCE, type PersonalityDef, type PersonalityId } from '../data';
import { idealDays, quoteRevenue } from './economy';
import type { Chairman } from './chairman';
import type { Company } from './company';
import { defaultTrackOptions } from './construction';
import { suggestConsist } from './estimate';
import type { Game, LineEnd } from './game';
import { mergerBlocker, proposeMerger } from './rivals';
import type { Rng } from './rng';
import type { Station } from './station';
import { enginesAvailable, stopTile, type RouteStop } from './train';
import type { City } from './world';

/** A line the AI runs: two of its stations with trains shuttling between them. */
interface AIRoute {
  a: number;
  b: number;
  /** Double track lets several trains pass; single track runs one. */
  double: boolean;
}

/**
 * A rival railroad baron. Once a month (on its own schedule) it looks after its company's
 * money, builds a new line between promising towns when it is due, adds trains where cargo
 * piles up and plays the stock market according to its personality.
 */
export class AIBaron {
  readonly routes: AIRoute[] = [];
  private months = 0;
  private nextBuild: number;
  /** Candidate key → day before which it is not retried. */
  private readonly tried = new Map<string, number>();

  constructor(
    readonly baron: Chairman,
    readonly companyId: number,
    readonly personality: PersonalityId,
    private readonly rng: Rng,
    readonly index: number,
  ) {
    this.nextBuild = 1 + index;
  }

  get def(): PersonalityDef {
    return AI.personalities[this.personality];
  }

  monthly(game: Game): void {
    this.months++;
    const c = game.companyById(this.companyId);
    const active = !!c && !c.defunct;
    const level = AI.levels[game.settings.aiLevel];
    if (active) {
      this.finances(game, c);
      if (this.months >= this.nextBuild) {
        this.build(game, c);
        this.nextBuild = this.months + Math.max(1, Math.round(this.def.buildEveryMonths / level.build));
      }
      this.addTrains(game, c);
    }
    this.trade(game, active ? c : null);
  }

  // -- company money -----------------------------------------------------------------------

  private finances(game: Game, c: Company): void {
    const P = this.def;
    // Each January: sell trains that lost money last year (but keep one per line).
    if (game.date.month === 0) {
      for (const t of game.trains.trains.filter((x) => x.owner === c.id && x.stats.lastCosts > 0 && x.stats.lastRevenue < x.stats.lastCosts)) {
        const mates = game.trains.trains.filter((x) => x.owner === c.id && x !== t && x.route.every((r, i) => r.station === t.route[i]?.station || t.route.some((q) => q.station === r.station)));
        if (mates.length > 0) game.sellTrain(t.id, c);
      }
    }
    if (game.date.month === 0 && P.dividendPayout > 0) {
      const perShare = (Math.max(0, c.profitTrend) * P.dividendPayout) / c.shares;
      game.setDividend(perShare, c);
    }
    if (c.cash < P.cashReserve * 0.5 && game.rating(c, FINANCE.bonds.block).index <= P.maxRatingIndex) game.issueBond(c);
    else if (c.cash > P.cashReserve * 4 && c.bonds.length) {
      const b = [...c.bonds].sort((x, y) => y.rate - x.rate)[0];
      game.repayBond(b.id, c);
    }
  }

  // -- building ------------------------------------------------------------------------------

  private myStations(game: Game): Station[] {
    return game.world.liveStations().filter((s) => s.owner === this.companyId);
  }

  private servedBy(game: Game, city: City, owner: number): boolean {
    return game.world.liveStations().some((s) => s.owner === owner && s.cityId === city.id);
  }

  /** Rival stations already in a town. */
  private rivalsIn(game: Game, city: City): number {
    return game.world.liveStations().filter((s) => s.owner !== this.companyId && s.cityId === city.id).length;
  }

  /** Pick the most promising unconnected pair (or a town to add to the network) and build it. */
  private build(game: Game, c: Company): void {
    const P = this.def;
    // Borrow for expansion as far as the personality's credit limit allows.
    for (let k = 0; k < 3 && c.cash - P.cashReserve < 350000; k++) {
      if (game.rating(c, FINANCE.bonds.block).index > P.maxRatingIndex || !game.issueBond(c).ok) break;
    }
    const budget = c.cash - P.cashReserve;
    if (budget < 150000) return;
    const towns = [...game.world.cities].sort((a, b) => b.population - a.population).slice(0, 24);
    const mine = this.myStations(game);
    const dMin = P.routeTiles[0];
    let dMax = P.routeTiles[1];
    type Cand = { key: string; score: number; a: City | Station; b: City };
    const cands: Cand[] = [];
    const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
    const weight = (d: number) => Math.min(d, 24) / 24;
    const comp = (city: City) => Math.pow(P.competition, this.rivalsIn(game, city));
    const day = game.day;
    const open = (key: string) => (this.tried.get(key) ?? -1) <= day;
    // Where towns lie far apart (hand-made maps), look further afield rather than not at all.
    for (const stretch of [1, 1.5, 2, 2.6]) {
      dMax = P.routeTiles[1] * stretch;
      // Grow the network from an existing station.
      for (const st of mine) {
        const home = game.world.cities[st.cityId];
        if (!home) continue;
        const [sx, sy] = [stopTile(st) % game.world.width, Math.floor(stopTile(st) / game.world.width)];
        for (const t of towns) {
          if (this.servedBy(game, t, this.companyId)) continue;
          const d = dist(sx, sy, t.x, t.y);
          if (d < dMin || d > dMax) continue;
          const key = `s${st.id}-${t.id}`;
          if (!open(key)) continue;
          cands.push({ key, a: st, b: t, score: Math.sqrt(home.population * t.population) * weight(d) * comp(t) * 1.1 });
        }
      }
      // Or start a new pair of towns.
      for (let i = 0; i < towns.length; i++) {
        for (let j = i + 1; j < towns.length; j++) {
          const A = towns[i];
          const B = towns[j];
          if (this.servedBy(game, A, this.companyId) && this.servedBy(game, B, this.companyId)) continue;
          const d = dist(A.x, A.y, B.x, B.y);
          if (d < dMin || d > dMax) continue;
          const key = `t${A.id}-${B.id}`;
          if (!open(key)) continue;
          cands.push({ key, a: A, b: B, score: Math.sqrt(A.population * B.population) * weight(d) * comp(A) * comp(B) });
        }
      }
      if (cands.length) break;
    }
    if (!cands.length) return;
    cands.sort((x, y) => y.score - x.score);
    // Try the best few; a little randomness keeps rivals from all picking the same line.
    const pool = cands.slice(0, 4);
    for (let attempt = 0; attempt < pool.length; attempt++) {
      const cand = pool.splice(this.rng.int(0, pool.length - 1), 1)[0];
      if (this.buildLine(game, c, cand.a, cand.b, budget)) return;
      this.tried.set(cand.key, day + 365);
    }
  }

  /**
   * Where to put a station in a town: the spot (and size) that covers the most people for
   * the money, preferring the side facing the far end of the line.
   */
  private placeStation(game: Game, c: Company, town: City, towards: [number, number]): LineEnd | null {
    const axis: 'x' | 'y' = Math.abs(towards[0] - town.x) >= Math.abs(towards[1] - town.y) ? 'x' : 'y';
    const kinds: Array<'station' | 'terminal'> = town.population > 6000 ? ['terminal', 'station'] : ['station'];
    let best: { e: LineEnd; score: number } | null = null;
    for (let r = 1; r <= 5; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = town.x + dx;
          const y = town.y + dy;
          for (const kind of kinds) {
            for (const ax of [axis, axis === 'x' ? 'y' : 'x'] as const) {
              const plan = game.planStation(x, y, kind, ax, c);
              if (!plan.ok) continue;
              const people = plan.coverage.cities.reduce((a, cc) => a + cc.population, 0);
              const facing = (towards[0] - town.x) * dx + (towards[1] - town.y) * dy;
              // A covered person is worth about $40 of construction (≈ a year of fares).
              const score = people * 40 - plan.cost + Math.max(0, facing) * 400 - (ax === axis ? 0 : 15000);
              if (!best || score > best.score) best = { e: { x, y, axis: ax, kind }, score };
            }
          }
        }
      }
    }
    return best?.e ?? null;
  }

  private buildLine(game: Game, c: Company, from: City | Station, to: City, budget: number): boolean {
    const W = game.world.width;
    const isStation = (v: City | Station): v is Station => 'tiles' in v;
    const fromXY: [number, number] = isStation(from) ? [stopTile(from) % W, Math.floor(stopTile(from) / W)] : [from.x, from.y];
    const endA: LineEnd | null = isStation(from) ? { station: from.id } : this.placeStation(game, c, from, [to.x, to.y]);
    const endB = this.placeStation(game, c, to, fromXY);
    if (!endA || !endB) return false;
    // The stations must end up far enough apart to pay.
    const ax = 'station' in endA ? fromXY[0] : endA.x;
    const ay = 'station' in endA ? fromXY[1] : endA.y;
    if ('x' in endB && Math.hypot(endB.x - ax, endB.y - ay) < this.def.routeTiles[0] * 0.8) return false;
    // Only build what should pay: fares from the people served (shared with rival stations)
    // against train and track running costs, with a decent return on the capital.
    const people = (e: LineEnd, town: City | undefined) => {
      if ('station' in e) return (game.economy.station(e.station)?.towns ?? []).reduce((a, t) => a + t.pop, 0);
      const plan = game.planStation(e.x, e.y, e.kind, e.axis, c);
      const covered = plan.coverage.cities.reduce((a, cc) => a + cc.population, 0);
      return covered / (1 + (town ? this.rivalsIn(game, town) : 0));
    };
    const pa = people(endA, isStation(from) ? undefined : from);
    const pb = people(endB, to);
    const bx = 'x' in endB ? endB.x : to.x;
    const by = 'y' in endB ? endB.y : to.y;
    const dist = Math.hypot(bx - ax, by - ay);
    const perPerson = Object.values(ECONOMY.townSupply).reduce((a, v) => a + v, 0);
    const loadsPerYear = 12 * perPerson * (pa + pb);
    const fare = quoteRevenue('passengers', 1, dist, idealDays(dist) + 1, true, game.economy.model).total;
    const expected = loadsPerYear * fare;
    const running = 11000 * this.def.trainsPerRoute + dist * 1.3 * ECONOMY.trackMaintenance.perTileYear * 1.6 + 6000;
    if (expected - running < 0.1 * (dist * 9000 + 120000)) return false;
    // Double track if the money allows (several trains can pass), else single track and one train.
    const opts = defaultTrackOptions(game.year, c.id);
    let double = this.def.trainsPerRoute > 1;
    let r = double ? game.buildLine(c, endA, endB, { ...opts, double: true }, budget - 40000 * this.def.trainsPerRoute) : null;
    if (!r?.ok) {
      double = false;
      r = game.buildLine(c, endA, endB, opts, budget - 40000);
    }
    if (!r.ok || !r.stations) return false;
    const [sa, sb] = r.stations;
    this.routes.push({ a: sa.id, b: sb.id, double });
    const n = double ? this.def.trainsPerRoute : 1;
    for (let k = 0; k < n; k++) this.buyTrain(game, c, k % 2 === 0 ? [sa.id, sb.id] : [sb.id, sa.id]);
    game.emit({
      type: 'rival',
      company: c.id,
      text: `${c.name} opened a line from ${sa.name} to ${sb.name}.`,
      tone: 0,
    });
    return true;
  }

  private buyTrain(game: Game, c: Company, stops: [number, number]): boolean {
    const engines = enginesAvailable(game.year)
      .filter((e) => e.price < c.cash - this.def.cashReserve * 0.25)
      .sort((a, b) => b.power * b.topSpeed - a.power * a.topSpeed);
    const engine = engines[0];
    if (!engine) return false;
    const route: RouteStop[] = stops.map((station) => ({ station, load: 'auto', waitFull: false }));
    const cargos = suggestConsist(game, engine.id, route).slice(0, Math.min(engine.maxCars, 5));
    return game.buyTrain(engine.id, cargos, route, c).ok;
  }

  /** More trains where cargo is piling up. */
  private addTrains(game: Game, c: Company): void {
    for (const r of this.routes) {
      const a = game.world.stations[r.a];
      const b = game.world.stations[r.b];
      if (!a || !b || a.owner !== c.id || b.owner !== c.id || !r.double) continue;
      const running = game.trains.trains.filter((t) => t.owner === c.id && t.route.some((s) => s.station === r.a) && t.route.some((s) => s.station === r.b)).length;
      if (running >= this.def.maxTrainsPerRoute) continue;
      const waiting = (id: number) => Object.values(game.economy.cargoAt(id).waiting).reduce((x, y) => x + y, 0);
      if (waiting(r.a) + waiting(r.b) < 14 || c.cash < this.def.cashReserve + 40000) continue;
      this.buyTrain(game, c, running % 2 === 0 ? [r.a, r.b] : [r.b, r.a]);
      return; // one per month
    }
  }

  // -- stock market ----------------------------------------------------------------------------

  private trade(game: Game, own: Company | null): void {
    const S = this.def.stock;
    const level = AI.levels[game.settings.aiLevel];
    const me = this.baron;
    const lot = FINANCE.shares.roundLot;
    const round = (n: number) => Math.floor(n / lot) * lot;
    const player = game.company;
    const playerStakeBefore = player.defunct ? 0 : player.holding(me.key) / player.shares;

    // Keep control of the own company.
    if (own) {
      const want = S.ownStake * own.shares - own.holding(me.key);
      if (want > lot && own.stock.price <= 1.25 * game.fair(own).perShare) {
        const n = round(Math.min(want, game.maxBuyShares(own.id, me), (me.cash * 0.6) / own.stock.price));
        if (n > 0) game.buyStock(own.id, n, me);
      }
    }

    for (const x of game.activeCompanies) {
      if (own && x.id === own.id) continue;
      const hostile = !(game.settings.friendlyAi && x.id === 0);
      const p = x.stock.price;
      const fair = game.fair(x).perShare;
      const long = x.holding(me.key);
      const stake = long / x.shares;
      const raiding = !!own && S.raid && hostile && p * x.shares < own.stock.price * own.shares;
      // Cover shorts once the price is back to fair value.
      const short = me.short(x.id);
      if (short > 0 && p <= fair) game.coverStock(x.id, short, me);
      // Take profits.
      if (long > 0 && p > S.sellAbove * fair && !raiding) game.sellStock(x.id, round(long / 2), me);
      // Buy cheap shares (and keep buying a raid target).
      const cheap = p < S.buyBelow * fair;
      if ((cheap || (raiding && stake < S.mergeAtStake)) && me.cash > 20000) {
        const budget = me.cash * (raiding ? 0.8 : 0.4) * level.trade;
        const cap = raiding ? x.shares * Math.min(0.06 * level.trade, S.mergeAtStake - stake + 0.02) : Infinity;
        const n = round(Math.min(game.maxBuyShares(x.id, me), budget / p, cap));
        if (n > 0) game.buyStock(x.id, n, me);
      }
      // Sell short what looks dear.
      if (S.short && hostile && p > S.shortAbove * fair && me.short(x.id) === 0) {
        const n = round(x.shares * 0.05 * level.trade);
        if (n > 0) game.shortStock(x.id, n, me);
      }
      // Call a merger vote once the stake is big enough.
      if (own && raiding && x.holding(me.key) / x.shares >= S.mergeAtStake && !mergerBlocker(game, own, x, me)) {
        proposeMerger(game, own, x, me);
      }
    }

    // Tell the player when a rival builds a position in their company.
    if (!player.defunct) {
      const after = player.holding(me.key) / player.shares;
      if (after - playerStakeBefore >= 0.05) {
        game.emit({
          type: 'rival',
          company: player.id,
          text: `${me.name} bought ${Math.round((after - playerStakeBefore) * 100)}% of ${player.name}; ${me.name.split(' ')[1] ?? me.name} now holds ${Math.round(after * 100)}%.`,
          tone: -1,
        });
      }
    }
  }
}
