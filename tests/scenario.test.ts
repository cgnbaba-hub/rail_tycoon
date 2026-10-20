import { describe, expect, it } from 'vitest';
import { SCENARIOS, TIME } from '../src/data';
import { defaultTrackOptions } from '../src/sim/construction';
import type { Game } from '../src/sim/game';
import { checkScenario, scenarioProgress, startScenario, townsConnected } from '../src/sim/scenario';
import { loadGame, saveGame } from '../src/sim/save';

const DAY = TIME.ticksPerDay;

function run(g: Game, days: number): void {
  for (let i = 0; i < days * DAY; i++) g.step();
}

/** Stations in the two requirement towns, joined by track. */
function connect(g: Game): boolean {
  const st = g.scenario!;
  const made = [];
  for (const id of st.towns.slice(0, 2)) {
    const town = g.world.cities[id];
    let done = false;
    for (let r = 2; r <= 6 && !done; r++) {
      for (const [dx, dy] of [[0, r], [0, -r], [r, 0], [-r, 0]]) {
        const res = g.buildStation(town.x + dx, town.y + dy, 'station', 'x');
        if (res.ok) {
          made.push(res.station!);
          done = true;
          break;
        }
      }
    }
  }
  if (made.length !== 2) return false;
  return g.buildTrack(made[0].tiles[made[0].tiles.length - 1], made[1].tiles[0], defaultTrackOptions(g.year)).ok;
}

describe('scenarios', () => {
  it('every scenario starts on its own map with goals that can be measured', () => {
    for (const def of SCENARIOS) {
      const g = startScenario(def);
      expect(g.params.startYear).toBe(def.map.startYear);
      expect(g.scenario!.deadlineYear).toBe(def.map.startYear + def.years);
      const p = scenarioProgress(g)!;
      expect(p.def.id).toBe(def.id);
      expect(Number.isFinite(p.metric)).toBe(true);
      expect(p.requirements).toHaveLength(def.requires.length);
      // Only a rank goal without requirements can count from day one.
      expect(p.medalTier).toBe(def.goal.metric === 'rank' && !def.requires.length ? p.tier : 0);
      expect(['easy', 'medium', 'hard']).toContain(def.difficulty);
    }
  });

  it('require the towns to be connected before any medal counts', () => {
    const g = startScenario(SCENARIOS.find((s) => s.id === 'tutorial')!);
    const [a, b] = g.scenario!.towns;
    expect(a).not.toBe(b);
    g.company.cash = 3_000_000;
    expect(townsConnected(g, a, b)).toBe(false);
    expect(connect(g)).toBe(true);
    expect(townsConnected(g, a, b)).toBe(true);
    expect(scenarioProgress(g)!.requirements.every((r) => r.met)).toBe(true);
  });

  it('award the best medal reached by the deadline, or end early with gold', () => {
    const def = SCENARIOS.find((s) => s.id === 'iron_horse')!;
    const g = startScenario(def);
    const medals: string[] = [];
    g.on((e) => e.type === 'scenarioEnd' && medals.push(e.medal));
    // Book value just above silver.
    g.company.cash += def.goal.tiers[1] - g.balance().bookValue + 60_000;
    run(g, 40);
    expect(g.scenario!.best).toBe(2);
    expect(g.scenario!.finished).toBe(false);
    g.company.cash += def.goal.tiers[2];
    run(g, 31);
    expect(g.scenario!.finished).toBe(true);
    expect(medals).toEqual(['gold']);
    expect(checkScenario(g)).toBeNull();
  });

  it('survive a save and load', () => {
    const g = startScenario(SCENARIOS.find((s) => s.id === 'divide')!);
    const b = loadGame(JSON.parse(JSON.stringify(saveGame(g))));
    expect(b.scenario).toEqual(g.scenario);
    expect(scenarioProgress(b)!.def.id).toBe('divide');
  });
});
