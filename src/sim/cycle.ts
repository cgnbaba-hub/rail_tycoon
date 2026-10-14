import { ECONOMY, type CycleStateDef } from '../data';
import type { Rng } from './rng';

const C = ECONOMY.cycle;

export function cycleState(id: string): CycleStateDef {
  const s = C.states.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown economic state ${id}`);
  return s;
}

export interface Headline {
  day: number;
  text: string;
  /** Direction hinted at: +1 better, -1 worse, 0 neutral. */
  tone: number;
}

/**
 * The economic cycle (Boom … Panic). Unlike the original, swings are never a surprise: the
 * next state and its timing are decided when a state begins, and in the last few months
 * before the change the *business confidence* index drifts towards the coming state while
 * headlines hint at the direction.
 */
export class EconomicCycle {
  state: string;
  next: string;
  /** Months until `next` takes over. */
  monthsLeft: number;
  /** How many months before the change the warning signs start. */
  warning: number;
  /** Business confidence 0–100, the leading indicator. */
  confidence: number;
  /** Monthly confidence history (newest last). */
  readonly history: number[] = [];
  readonly news: Headline[] = [];

  constructor(private readonly rng: Rng) {
    this.state = C.start;
    this.confidence = cycleState(C.start).confidence;
    this.next = this.state;
    this.monthsLeft = 0;
    this.warning = 0;
    this.plan();
  }

  get current(): CycleStateDef {
    return cycleState(this.state);
  }

  get upcoming(): CycleStateDef {
    return cycleState(this.next);
  }

  /** Revenue multiplier of the current state. */
  get revenueFactor(): number {
    return this.current.revenue;
  }

  get growthFactor(): number {
    return this.current.growth;
  }

  /** Are the warning signs showing (i.e. within `warning` months of a change)? */
  get warningActive(): boolean {
    return this.next !== this.state && this.monthsLeft <= this.warning;
  }

  /** Pick the next state and when it arrives. */
  private plan(): void {
    const row = C.transitions[this.state] ?? {};
    const options = Object.keys(row);
    this.next = options.length ? this.rng.weighted(options, (k) => row[k]) : this.state;
    this.monthsLeft = this.rng.int(C.durationMonths[0], C.durationMonths[1]);
    this.warning = Math.min(this.monthsLeft - 1, this.rng.int(C.warningMonths[0], C.warningMonths[1]));
  }

  /** Advance one month. Returns true when the state changed. */
  monthly(day: number): boolean {
    let changed = false;
    this.monthsLeft--;
    if (this.monthsLeft <= 0) {
      this.state = this.next;
      changed = true;
      this.plan();
    }
    const cur = this.current.confidence;
    let target = cur;
    if (this.warningActive) {
      const progress = 1 - this.monthsLeft / (this.warning + 1);
      target = cur + (this.upcoming.confidence - cur) * progress;
    }
    const noise = (this.rng.next() * 2 - 1) * C.confidenceNoise;
    this.confidence = Math.max(0, Math.min(100, target + noise));
    this.history.push(Math.round(this.confidence));
    if (this.history.length > 36) this.history.shift();
    this.headline(day, changed);
    return changed;
  }

  private headline(day: number, changed: boolean): void {
    if (changed) {
      this.news.push({ day, text: `The economy enters ${this.current.name.toLowerCase() === 'normal' ? 'normal times' : `a ${this.current.name.toLowerCase()}`}.`, tone: 0 });
    } else if (this.warningActive && this.rng.chance(0.75)) {
      const better = this.upcoming.revenue > this.current.revenue;
      this.news.push({ day, text: this.rng.pick(better ? C.headlines.better : C.headlines.worse), tone: better ? 1 : -1 });
    } else if (this.rng.chance(0.2)) {
      this.news.push({ day, text: this.rng.pick(C.headlines.same), tone: 0 });
    }
    if (this.news.length > 40) this.news.shift();
  }
}
