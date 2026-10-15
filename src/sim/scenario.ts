import { SCENARIOS, type ScenarioDef } from '../data';
import { Game } from './game';
import { findTrainPath } from './routing';
import { stopTile } from './train';

export const MEDALS = ['none', 'bronze', 'silver', 'gold'] as const;
export type Medal = (typeof MEDALS)[number];

/** A running scenario: which towns its goals refer to, and how it ended. */
export interface ScenarioState {
  id: string;
  deadlineYear: number;
  /** Town ids for the `connect` requirements, resolved at the start. */
  towns: number[];
  /** Best tier reached so far (0 = none … 3 = gold). */
  best: number;
  finished: boolean;
  medal: Medal | null;
}

export interface ScenarioProgress {
  def: ScenarioDef;
  metric: number;
  /** Tier the metric reaches right now (0–3), ignoring requirements. */
  tier: number;
  requirements: Array<{ label: string; met: boolean }>;
  /** Tier counting requirements (0 if any requirement is unmet). */
  medalTier: number;
  yearsLeft: number;
}

export function scenarioDef(id: string): ScenarioDef | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** Start a scenario game. */
export function startScenario(def: ScenarioDef): Game {
  const g = new Game({ ...def.map }, undefined, { rivals: 0, ...def.settings });
  const byPop = [...g.world.cities].sort((a, b) => b.population - a.population);
  // Requirement towns: by population rank, but the second one at least ~25 tiles away.
  const towns: number[] = [];
  for (const r of def.requires) {
    const a = byPop[r.a];
    const far = byPop.slice(r.b).find((c) => c !== a && Math.hypot(c.x - a.x, c.y - a.y) >= Math.min(25, g.world.width / 3)) ?? byPop[r.b];
    towns.push(a?.id ?? 0, far?.id ?? 0);
  }
  g.scenario = { id: def.id, deadlineYear: def.map.startYear + def.years, towns, best: 0, finished: false, medal: null };
  return g;
}

/** Your stations in a town, connected by your own track to one in another town? */
export function townsConnected(game: Game, a: number, b: number): boolean {
  const mine = game.world.liveStations().filter((s) => s.owner === game.company.id);
  const inA = mine.filter((s) => s.cityId === a);
  const goals = new Set(mine.filter((s) => s.cityId === b).map((s) => stopTile(s)));
  if (!inA.length || !goals.size) return false;
  return inA.some((s) => findTrainPath(game.world, stopTile(s), -1, goals) !== null);
}

function metricValue(game: Game, def: ScenarioDef): number {
  const c = game.company;
  switch (def.goal.metric) {
    case 'bookValue':
      return game.balance(c).bookValue;
    case 'netWorth':
      return game.netWorth();
    case 'bestYearRevenue': {
      let best = 0;
      for (let y = game.params.startYear; y <= game.year; y++) best = Math.max(best, c.revenueIn(y) + c.otherIncomeIn(y));
      return best;
    }
    case 'cargoLoads':
      return (def.goal.cargos ?? []).reduce((a, k) => a + (c.delivered.get(k) ?? 0), 0);
    case 'rank': {
      const mine = game.netWorth();
      return 1 + game.investors.filter((i) => i !== game.chairman && game.netWorth(i) > mine).length;
    }
  }
}

export function scenarioProgress(game: Game): ScenarioProgress | null {
  const st = game.scenario;
  const def = st && scenarioDef(st.id);
  if (!st || !def) return null;
  const metric = metricValue(game, def);
  const lower = def.goal.metric === 'rank';
  let tier = 0;
  def.goal.tiers.forEach((t, k) => {
    if (lower ? metric <= t : metric >= t) tier = k + 1;
  });
  if (def.goal.goldNetWorth && tier === 3 && game.netWorth() < def.goal.goldNetWorth) tier = 2;
  const requirements = def.requires.map((_, k) => {
    const a = game.world.cities[st.towns[2 * k]];
    const b = game.world.cities[st.towns[2 * k + 1]];
    return { label: `Connect ${a?.name ?? '?'} and ${b?.name ?? '?'} with your own track`, met: townsConnected(game, st.towns[2 * k], st.towns[2 * k + 1]) };
  });
  const medalTier = requirements.every((r) => r.met) ? tier : 0;
  return { def, metric, tier, requirements, medalTier, yearsLeft: Math.max(0, st.deadlineYear - game.year) };
}

/**
 * Monthly check: remember the best medal reached; finish at gold or at the deadline (the
 * January of the deadline year), or when you lose your railroad.
 */
export function checkScenario(game: Game): { finished: boolean; medal: Medal } | null {
  const st = game.scenario;
  if (!st || st.finished) return null;
  const p = scenarioProgress(game);
  if (!p) return null;
  st.best = Math.max(st.best, p.medalTier);
  const out = game.over !== null || p.medalTier === 3 || game.year >= st.deadlineYear;
  if (!out) return null;
  st.finished = true;
  st.medal = MEDALS[game.over ? 0 : st.best];
  return { finished: true, medal: st.medal };
}
