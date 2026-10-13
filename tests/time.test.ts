import { describe, expect, it } from 'vitest';
import { TIME } from '../src/data';
import { Game } from '../src/sim/game';
import { defaultMapParams, generateWorld } from '../src/sim/mapgen';
import { DAYS_PER_YEAR, FixedStepper, dayToDate, formatDate } from '../src/sim/time';

describe('calendar', () => {
  it('converts day indices to dates', () => {
    expect(dayToDate(0, 1850)).toEqual({ year: 1850, month: 0, day: 1 });
    expect(dayToDate(31, 1850)).toEqual({ year: 1850, month: 1, day: 1 });
    expect(dayToDate(DAYS_PER_YEAR - 1, 1850)).toEqual({ year: 1850, month: 11, day: 31 });
    expect(dayToDate(DAYS_PER_YEAR, 1850)).toEqual({ year: 1851, month: 0, day: 1 });
    expect(formatDate({ year: 1899, month: 6, day: 4 })).toBe('Jul 4, 1899');
    expect(DAYS_PER_YEAR).toBe(365);
  });
});

describe('FixedStepper', () => {
  it('converts real time into whole ticks at the configured rate', () => {
    const s = new FixedStepper(24, 500, 10000);
    let ticks = 0;
    for (let i = 0; i < 100; i++) ticks += s.advance(10, 1); // 1 s real
    expect(ticks).toBe(48); // 2 days × 24 ticks
    expect(s.alpha).toBeGreaterThanOrEqual(0);
    expect(s.alpha).toBeLessThan(1);
  });

  it('scales with speed and stops when paused', () => {
    const s = new FixedStepper(24, 500, 10000);
    let fast = 0;
    for (let i = 0; i < 100; i++) fast += s.advance(10, 8);
    expect(fast).toBe(384);
    expect(s.advance(1000, 0)).toBe(0);
  });

  it('clamps long frames and caps ticks per frame', () => {
    const s = new FixedStepper(24, 1, 50);
    expect(s.advance(10_000, 8)).toBe(50);
    const t = new FixedStepper(24, 500, 10000);
    // A 10 s hiccup is treated as 250 ms.
    expect(t.advance(10_000, 1)).toBe(12);
  });
});

describe('Game clock', () => {
  const world = generateWorld({ ...defaultMapParams(1), size: 64 });

  it('emits day, month and year events at the right ticks', () => {
    const g = new Game({ ...defaultMapParams(1), size: 64 }, world);
    const counts = { day: 0, month: 0, year: 0 };
    g.on((e) => counts[e.type]++);
    for (let i = 0; i < DAYS_PER_YEAR * TIME.ticksPerDay; i++) g.step();
    expect(counts.day).toBe(DAYS_PER_YEAR);
    expect(counts.month).toBe(12);
    expect(counts.year).toBe(1);
    expect(g.date).toEqual({ year: g.params.startYear + 1, month: 0, day: 1 });
  });

  it('allows unsubscribing listeners', () => {
    const g = new Game({ ...defaultMapParams(1), size: 64 }, world);
    let n = 0;
    const off = g.on(() => n++);
    for (let i = 0; i < TIME.ticksPerDay; i++) g.step();
    off();
    for (let i = 0; i < TIME.ticksPerDay; i++) g.step();
    expect(n).toBe(1);
  });
});
