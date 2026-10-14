import { describe, expect, it } from 'vitest';
import { AI, TIME } from '../src/data';
import { defaultTrackOptions } from '../src/sim/construction';
import { Game } from '../src/sim/game';
import { defaultMapParams, generateWorld } from '../src/sim/mapgen';
import { bankrupt, boardVote, mergerBlocker, mergerVote, proposeMerger } from '../src/sim/rivals';
import type { RouteStop } from '../src/sim/train';
import { addTown, flatWorld } from './helpers';

const DAY = TIME.ticksPerDay;
const opts = defaultTrackOptions(1850);

function run(g: Game, days: number): void {
  for (let i = 0; i < days * DAY; i++) g.step();
}

function route(a: number, b: number): RouteStop[] {
  return [
    { station: a, load: 'auto', waitFull: false },
    { station: b, load: 'auto', waitFull: false },
  ];
}

/**
 * Four towns; the player owns a line at y = 20, the rival (company 1) one at y = 36.
 * The AI is switched off so the tests drive the rival company by hand.
 */
function twoLines() {
  const w = flatWorld(48);
  addTown(w, 'Westford', 4, 16, 6000);
  addTown(w, 'Eastburg', 40, 16, 6000);
  addTown(w, 'Southby', 4, 32, 6000);
  addTown(w, 'Portmere', 40, 32, 6000);
  const g = new Game({ ...defaultMapParams(1), size: w.width }, w, { wrecks: false, rivals: 1 });
  g.ai.length = 0;
  const me = g.company;
  const rival = g.companies[1];
  me.cash = rival.cash = 5_000_000;
  const a = g.buildStation(6, 20, 'station', 'x').station!;
  const b = g.buildStation(42, 20, 'station', 'x').station!;
  expect(g.buildTrack(w.tileIndex(7, 20), w.tileIndex(42, 20), { ...opts, tunnels: false }).ok).toBe(true);
  const c = g.buildStation(6, 36, 'station', 'x', rival).station!;
  const d = g.buildStation(42, 36, 'station', 'x', rival).station!;
  expect(g.buildTrack(w.tileIndex(7, 36), w.tileIndex(42, 36), { ...opts, tunnels: false, owner: 1 }, undefined, rival).ok).toBe(true);
  return { w, g, me, rival, a, b, c, d };
}

describe('rival companies', () => {
  it('are founded with their own chairman, colour and stock', () => {
    const g = new Game({ ...defaultMapParams(1), size: 32 }, flatWorld(32), { rivals: 3 });
    expect(g.companies).toHaveLength(4);
    expect(g.investors).toHaveLength(4);
    for (let k = 1; k <= 3; k++) {
      const c = g.companies[k];
      expect(c.chairman).toBe(`ai:${k}`);
      expect(c.name).toBe(AI.barons[k - 1].company);
      expect(c.holding(`ai:${k}`)).toBeGreaterThan(0);
      expect(g.investorByKey(c.chairman)?.name).toBe(AI.barons[k - 1].name);
    }
    expect(new Set(g.companies.map((c) => c.ticker)).size).toBe(4);
  });
});

describe('ownership', () => {
  it('stamps track and stations with their owner', () => {
    const { w, a, c } = twoLines();
    expect(a.owner).toBe(0);
    expect(c.owner).toBe(1);
    expect(w.track.get(20, 20)?.owner).toBe(0);
    expect(w.track.get(20, 36)?.owner).toBe(1);
  });

  it('never lets one railroad build on, join or bulldoze another one\'s track', () => {
    const { w, g, me, rival } = twoLines();
    const mine = new Map([...w.track.nodes].filter(([, n]) => n.owner === 0).map(([i, n]) => [i, { ...n }]));
    // The rival tries to run north across the player's line.
    const cross = g.buildTrack(w.tileIndex(24, 34), w.tileIndex(24, 8), opts, undefined, rival);
    if (cross.ok) for (const s of cross.plan.steps) expect(mine.has(s.to) && mine.get(s.to)!.conn !== w.track.nodes.get(s.to)!.conn).toBe(false);
    for (const [i, n] of mine) expect(w.track.nodes.get(i)).toEqual(n);
    // Station on someone else's track.
    const st = g.planStation(20, 20, 'station', 'x', rival);
    expect(st.ok).toBe(false);
    // Bulldozing someone else's track.
    const bd = g.bulldoze([w.tileIndex(20, 36)], me);
    expect(bd.ok).toBe(false);
    expect(bd.error).toContain(rival.name);
    expect(w.track.get(20, 36)).toBeDefined();
  });

  it('only runs trains between the company\'s own stations and bills their owner', () => {
    const { g, me, rival, a, b, c, d } = twoLines();
    expect(g.buyTrain('columbia', ['passengers'], route(a.id, c.id)).ok).toBe(false);
    const t = g.buyTrain('columbia', ['passengers', 'passengers'], route(c.id, d.id), rival);
    expect(t.ok).toBe(true);
    expect(t.train!.owner).toBe(1);
    expect(g.sellTrain(t.train!.id, me).ok).toBe(false);
    expect(g.buyTrain('columbia', ['passengers', 'passengers'], route(a.id, b.id)).ok).toBe(true);
    run(g, 90);
    const yr = g.year;
    expect(rival.revenueIn(yr)).toBeGreaterThan(0);
    expect(rival.spentIn(yr, 'fuel')).toBeGreaterThan(0);
    expect(me.revenueIn(yr)).toBe(g.trains.trains.filter((x) => x.owner === 0).reduce((s, x) => s + x.stats.revenue, 0));
    expect(rival.revenueIn(yr)).toBe(g.trains.trains.filter((x) => x.owner === 1).reduce((s, x) => s + x.stats.revenue, 0));
  });

  it('keeps rival construction out of the player\'s undo history', () => {
    const { g, rival, w } = twoLines();
    const before = g.undoStack.length;
    g.buildStation(24, 44, 'station', 'x', rival);
    expect(g.undoStack.length).toBeLessThanOrEqual(before);
    expect(w.track.get(24, 44)?.owner ?? 1).toBe(1);
  });
});

describe('AI barons', () => {
  const size = 128;
  function aiGame(seed: number, settings = {}) {
    const params = { ...defaultMapParams(seed), size };
    return new Game(params, generateWorld(params), { wrecks: false, rivals: 2, ...settings });
  }

  it('build lines, buy trains and play the market — deterministically', () => {
    const snapshot = (g: Game) =>
      JSON.stringify({
        companies: g.companies.map((c) => [c.cash.toFixed(2), c.shares, c.stock.price.toFixed(4), [...c.holders]]),
        track: [...g.world.track.nodes.entries()].map(([i, n]) => [i, n.conn, n.owner]),
        trains: g.trains.trains.map((t) => [t.id, t.owner, t.engine]),
        investors: g.investors.map((i) => i.cash.toFixed(2)),
      });
    const runA = aiGame(42);
    const runB = aiGame(42);
    run(runA, 400);
    run(runB, 400);
    expect(snapshot(runA)).toBe(snapshot(runB));
    const rivalTrains = runA.trains.trains.filter((t) => t.owner !== 0);
    const rivalStations = runA.world.liveStations().filter((s) => s.owner !== 0);
    expect(rivalStations.length).toBeGreaterThanOrEqual(2);
    expect(rivalTrains.length).toBeGreaterThanOrEqual(1);
    expect(runA.companies.slice(1).some((c) => c.revenueIn(runA.year) + c.revenueIn(runA.year - 1) > 0)).toBe(true);
    // Barons hold stakes in their own companies.
    for (const ai of runA.ai) expect(runA.companies[ai.companyId].holding(ai.baron.key)).toBeGreaterThan(0);
  });

  it('leave the player alone in friendly mode', () => {
    const g = aiGame(7, { aiLevel: 'ruthless', friendlyAi: true });
    run(g, 730);
    for (const inv of g.investors.slice(1)) expect(inv.short(0)).toBe(0);
    expect(g.company.defunct).toBe(false);
    expect(g.over).toBeNull();
  });
});

describe('mergers', () => {
  it('need a big enough stake and the chairman of the acquirer', () => {
    const { g, me, rival } = twoLines();
    expect(mergerBlocker(g, me, rival, g.chairman)).toMatch(/at least/);
    expect(mergerBlocker(g, rival, me, g.chairman)).toMatch(/chairman/);
    expect(mergerBlocker(g, me, me, g.chairman)).toMatch(/itself/);
  });

  it('fold the target into the acquirer when the shareholders vote yes', () => {
    const { w, g, me, rival, c } = twoLines();
    const t = g.buyTrain('columbia', ['passengers'], route(c.id, g.world.stations.findIndex((s) => s && s.owner === 1 && s.id !== c.id)), rival).train!;
    // The player owns 45 % of the rival.
    const want = Math.round(rival.shares * 0.45);
    rival.transferShares('public', 'player', want - rival.holding('player'));
    const vote = mergerVote(g, me, rival, g.chairman);
    expect(vote.passes).toBe(true);
    const sharesBefore = me.shares;
    const cashBefore = me.cash + rival.cash;
    const r = proposeMerger(g, me, rival, g.chairman);
    expect(r.ok).toBe(true);
    expect(rival.defunct).toBe('merged');
    expect(me.shares).toBeGreaterThan(sharesBefore);
    expect(me.cash).toBeCloseTo(cashBefore, 2);
    expect(w.track.get(20, 36)?.owner).toBe(0);
    expect(c.owner).toBe(0);
    expect(t.owner).toBe(0);
    expect(g.activeCompanies).toEqual([me]);
    // The baron got shares in the player's company for his old stake.
    expect(me.holding('ai:1')).toBeGreaterThan(0);
  });

  it('fail without a majority and then wait out a cooldown', () => {
    const { g, me, rival } = twoLines();
    rival.transferShares('public', 'player', Math.round(rival.shares * AI.merger.minStake) - rival.holding('player'));
    // A chairman holding a big block votes no.
    rival.transferShares('public', rival.chairman, Math.round(rival.shares * 0.4) - rival.holding(rival.chairman));
    const r = proposeMerger(g, me, rival, g.chairman);
    expect(r.vote?.passes).toBe(false);
    expect(rival.defunct).toBe(false);
    expect(mergerBlocker(g, me, rival, g.chairman)).toMatch(/recently/);
  });

  it('end the game when a rival takes over the player\'s company', () => {
    const { g, me, rival } = twoLines();
    const baron = g.investors[1];
    me.transferShares('public', baron.key, Math.round(me.shares * 0.6));
    const r = proposeMerger(g, rival, me, baron);
    expect(r.vote?.passes).toBe(true);
    expect(me.defunct).toBe('merged');
    expect(g.over?.reason).toBe('takeover');
    expect(g.buildStation(20, 44, 'station', 'x').ok).toBe(false);
    // You keep your shares — now in the acquirer.
    expect(rival.holding('player')).toBeGreaterThan(0);
  });
});

describe('bankruptcy', () => {
  it('tears up the railway of a company whose debts exceed its assets', () => {
    const { w, g, rival, c, d } = twoLines();
    g.buyTrain('columbia', ['passengers'], route(c.id, d.id), rival);
    bankrupt(g, rival);
    expect(rival.defunct).toBe('bankrupt');
    expect([...w.track.nodes.values()].some((n) => n.owner === 1)).toBe(false);
    expect(w.liveStations().some((s) => s.owner === 1)).toBe(false);
    expect(g.trains.trains.some((t) => t.owner === 1)).toBe(false);
    expect(rival.holders.size).toBe(0);
    expect(g.activeCompanies).toHaveLength(1);
    expect(g.over).toBeNull();
  });

  it('follows months of insolvency with no lender willing to help', () => {
    const { g, rival } = twoLines();
    rival.cash = -2_000_000;
    rival.infrastructure = 0;
    run(g, 31);
    expect(rival.defunct).toBe(false);
    expect(rival.insolventMonths).toBe(1);
    run(g, 31);
    expect(rival.defunct).toBe('bankrupt');
  });

  it('ends the game when it is the player\'s company', () => {
    const { g, me } = twoLines();
    me.cash = -10_000_000;
    me.infrastructure = 0;
    run(g, 62);
    expect(me.defunct).toBe('bankrupt');
    expect(g.over?.reason).toBe('bankrupt');
  });
});

describe('board vote', () => {
  it('is not held in the first years, then counts your shares and the public mood', () => {
    const { g, me } = twoLines();
    expect(boardVote(g, me).held).toBe(false);
    const late = new Game({ ...defaultMapParams(1), startYear: 1830, size: 32 }, flatWorld(32));
    late.tick = AI.board.graceYears * 365 * DAY;
    const v = boardVote(late, late.company);
    expect(v.held).toBe(true);
    const own = late.company.holding('player') / late.company.shares;
    expect(v.support).toBeGreaterThanOrEqual(own);
  });

  it('removes you after two votes of no confidence in a row', () => {
    const g = new Game({ ...defaultMapParams(1), size: 32 }, flatWorld(32), { rivals: 1 });
    g.ai.length = 0;
    const me = g.company;
    // Hostile baron holds most of the company; the share price collapses every year.
    me.transferShares('public', 'ai:1', Math.round(me.shares * 0.6));
    const events: string[] = [];
    g.on((e) => {
      if (e.type === 'gameOver') events.push(e.over.reason);
    });
    for (let y = 0; y < AI.board.graceYears + 2 && !g.over; y++) {
      me.stock.yearOpen = me.stock.price * 3;
      run(g, 365);
    }
    expect(g.over?.reason).toBe('board');
    expect(events).toEqual(['board']);
    expect(me.boardStrikes).toBe(2);
  });
});
