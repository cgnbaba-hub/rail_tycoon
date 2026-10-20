import { EVENTS, type EventDef } from '../data';
import { combineMods, neutralMods, type Modifiers } from './modifiers';
import type { Rng } from './rng';

export interface ActiveEvent {
  id: string;
  startDay: number;
  /** Day it ends (Infinity for a permanent technology). */
  endDay: number;
}

/**
 * Random historical-flavoured events. Rolled once a month for every event whose era covers
 * the year and that is neither running nor cooling down; technologies happen once and last.
 */
export class EventSystem {
  readonly active: ActiveEvent[] = [];
  /** Technologies already adopted (permanent). */
  readonly adopted: string[] = [];
  /** Event id → day before which it can't happen again. */
  readonly cooldown = new Map<string, number>();
  /** Everything currently in effect, combined. */
  mods: Modifiers = neutralMods();

  constructor(private readonly rng: Rng) {}

  /** Monthly roll; returns events that started and ended this month. */
  monthly(day: number, year: number): { started: EventDef[]; ended: EventDef[] } {
    const started: EventDef[] = [];
    const ended: EventDef[] = [];
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].endDay <= day) {
        const def = EVENTS.events.find((e) => e.id === this.active[i].id);
        this.active.splice(i, 1);
        if (def) {
          ended.push(def);
          this.cooldown.set(def.id, day + EVENTS.cooldownMonths * 30);
        }
      }
    }
    for (const def of EVENTS.events) {
      const roll = this.rng.next();
      if (year < def.era[0] || year > def.era[1]) continue;
      if (this.adopted.includes(def.id) || this.active.some((a) => a.id === def.id)) continue;
      if ((this.cooldown.get(def.id) ?? -1) > day) continue;
      if (roll >= def.chancePerYear / 12) continue;
      if (def.months[1] === 0) this.adopted.push(def.id);
      else this.active.push({ id: def.id, startDay: day, endDay: day + this.rng.int(def.months[0], def.months[1]) * 30 });
      started.push(def);
    }
    if (started.length || ended.length) this.recompute();
    return { started, ended };
  }

  /** Start an event now (scenarios, tests). */
  force(id: string, day: number, months?: number): EventDef | undefined {
    const def = EVENTS.events.find((e) => e.id === id);
    if (!def) return undefined;
    if (def.months[1] === 0) {
      if (!this.adopted.includes(id)) this.adopted.push(id);
    } else if (!this.active.some((a) => a.id === id)) this.active.push({ id, startDay: day, endDay: day + (months ?? def.months[0]) * 30 });
    this.recompute();
    return def;
  }

  private recompute(): void {
    let m = neutralMods();
    for (const id of [...this.adopted, ...this.active.map((a) => a.id)]) {
      const def = EVENTS.events.find((e) => e.id === id);
      if (def) m = combineMods(m, def.effects);
    }
    this.mods = m;
  }
}
