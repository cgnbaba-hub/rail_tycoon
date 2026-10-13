import { TIME } from '../data';
import { generateWorld } from './mapgen';
import { Rng } from './rng';
import { dayToDate, type GameDate } from './time';
import type { MapParams, World } from './world';

export type GameEvent =
  | { type: 'day'; date: GameDate }
  | { type: 'month'; date: GameDate }
  | { type: 'year'; date: GameDate };

/**
 * Root simulation object. Advances only through `step()` (one fixed tick = one in-game
 * hour), never reads the wall clock, and owns the single seeded RNG → fully deterministic.
 */
export class Game {
  readonly params: MapParams;
  readonly world: World;
  readonly rng: Rng;
  /** Ticks since Jan 1 of the start year. */
  tick = 0;
  private listeners: Array<(e: GameEvent) => void> = [];

  constructor(params: MapParams, world?: World) {
    this.params = params;
    this.world = world ?? generateWorld(params);
    this.rng = new Rng((params.seed ^ 0xa5a5a5a5) >>> 0);
  }

  get day(): number {
    return Math.floor(this.tick / TIME.ticksPerDay);
  }

  get date(): GameDate {
    return dayToDate(this.day, this.params.startYear);
  }

  on(fn: (e: GameEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(e: GameEvent): void {
    for (const l of this.listeners) l(e);
  }

  step(): void {
    this.tick++;
    if (this.tick % TIME.ticksPerDay === 0) {
      const date = this.date;
      this.emit({ type: 'day', date });
      if (date.day === 1) {
        this.emit({ type: 'month', date });
        if (date.month === 0) this.emit({ type: 'year', date });
      }
    }
  }
}
