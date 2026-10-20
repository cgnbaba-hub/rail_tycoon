import { describe, expect, it } from 'vitest';
import { TIME } from '../src/data';
import { defaultTrackOptions } from '../src/sim/construction';
import { Game } from '../src/sim/game';
import { defaultMapParams, generateWorld } from '../src/sim/mapgen';
import { loadGame, saveGame } from '../src/sim/save';

const DAY = TIME.ticksPerDay;

function run(g: Game, days: number): void {
  for (let i = 0; i < days * DAY; i++) g.step();
}

/** A generated map with two rivals and a player line with two trains. */
function busyGame(): Game {
  const params = { ...defaultMapParams(42), size: 96 };
  const g = new Game(params, generateWorld(params), { rivals: 2 });
  const towns = [...g.world.cities].sort((a, b) => b.population - a.population);
  const st = [];
  for (const town of towns.slice(0, 2)) {
    for (const [dx, dy] of [[0, 3], [0, -3], [3, 0], [-3, 0], [0, 4], [4, 0]]) {
      const r = g.buildStation(town.x + dx, town.y + dy, 'station', 'x');
      if (r.ok) {
        st.push(r.station!);
        break;
      }
    }
  }
  expect(st).toHaveLength(2);
  expect(g.buildTrack(st[0].tiles[1], st[1].tiles[0], defaultTrackOptions(1850)).ok).toBe(true);
  for (const [a, b] of [[0, 1], [1, 0]]) {
    g.buyTrain('columbia', ['passengers', 'mail'], [
      { station: st[a].id, load: 'auto', waitFull: false },
      { station: st[b].id, load: 'auto', waitFull: false },
    ]);
  }
  g.saveTemplate(g.trains.trains[0].id);
  return g;
}

/** Everything a save holds, as text (minus the wall-clock time stamp). */
function state(g: Game): string {
  return JSON.stringify(saveGame(g).data);
}

describe('save games', () => {
  it('round-trip through JSON and continue exactly like the original', () => {
    const a = busyGame();
    run(a, 200);
    const text = JSON.stringify(saveGame(a, 'test'));
    const b = loadGame(JSON.parse(text));
    expect(state(b)).toBe(state(a));
    run(a, 250);
    run(b, 250);
    expect(b.day).toBe(a.day);
    expect(b.company.cash).toBe(a.company.cash);
    expect(b.trains.trains.map((t) => [t.id, t.seg, t.offset, t.state])).toEqual(a.trains.trains.map((t) => [t.id, t.seg, t.offset, t.state]));
    expect(state(b)).toBe(state(a));
  });

  it('keep shared objects shared and re-link the game', () => {
    const a = busyGame();
    run(a, 40);
    const b = loadGame(JSON.parse(JSON.stringify(saveGame(a))));
    expect(b.ai[0].baron).toBe(b.investors[1]);
    expect(b.economy.cycle).toBeDefined();
    expect(b.trains.world).toBe(b.world);
    expect(b.templates).toHaveLength(1);
    expect(b.undoStack.length).toBe(a.undoStack.length);
    // Events reach new listeners, commands still work.
    let days = 0;
    b.on((e) => {
      if (e.type === 'day') days++;
    });
    run(b, 3);
    expect(days).toBe(3);
    const t = b.trains.trains.find((x) => x.owner === 0)!;
    expect(b.duplicateTrain(t.id).ok).toBe(true);
  });

  it('refuse files that are not Iron Baron saves', () => {
    expect(() => loadGame({ hello: 1 })).toThrow(/not an Iron Baron save/);
    const s = saveGame(busyGame());
    expect(() => loadGame({ ...s, version: 999 })).toThrow(/not supported/);
  });

  it('stay a reasonable size', () => {
    const a = busyGame();
    run(a, 365);
    const bytes = JSON.stringify(saveGame(a)).length;
    expect(bytes).toBeLessThan(3_000_000);
  });
});
