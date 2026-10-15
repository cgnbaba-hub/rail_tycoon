import { TIME } from '../data';

export const DAYS_PER_YEAR = TIME.monthDays.reduce((a, b) => a + b, 0);

export interface GameDate {
  year: number;
  /** 0-based month. */
  month: number;
  /** 1-based day of month. */
  day: number;
}

/** Convert a day count since Jan 1 of `startYear` into a calendar date (no leap years). */
export function dayToDate(dayIndex: number, startYear: number): GameDate {
  const year = startYear + Math.floor(dayIndex / DAYS_PER_YEAR);
  let rem = dayIndex % DAYS_PER_YEAR;
  let month = 0;
  while (rem >= TIME.monthDays[month]) {
    rem -= TIME.monthDays[month];
    month++;
  }
  return { year, month, day: rem + 1 };
}

export function formatDate(d: GameDate): string {
  return `${TIME.monthNames[d.month]} ${d.day}, ${d.year}`;
}

/**
 * Converts real elapsed time into a whole number of fixed simulation ticks.
 * Rendering runs at display rate; the simulation only ever advances in whole ticks.
 */
export class FixedStepper {
  private acc = 0;

  constructor(
    private readonly ticksPerDay = TIME.ticksPerDay,
    private readonly msPerDay = TIME.realMsPerDayAtSpeed1,
    private readonly maxTicks = TIME.maxTicksPerFrame,
  ) {}

  /** Returns the number of ticks to simulate for `dtMs` of real time at `speed` (0 = paused). */
  advance(dtMs: number, speed: number): number {
    if (speed <= 0 || dtMs <= 0) return 0;
    // Clamp huge gaps (tab in background) so we don't fast-forward unexpectedly.
    const dt = Math.min(dtMs, 250);
    this.acc += (dt * speed * this.ticksPerDay) / this.msPerDay;
    let n = Math.floor(this.acc + 1e-9);
    this.acc = Math.max(0, this.acc - n);
    if (n > this.maxTicks) n = this.maxTicks;
    return n;
  }

  /** Fraction (0..1) of the next tick already elapsed — for render interpolation. */
  get alpha(): number {
    return this.acc;
  }

  reset(): void {
    this.acc = 0;
  }
}
