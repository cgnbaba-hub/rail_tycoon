import { CARGO_BY_ID, type ModifierSpec } from '../data';

export type { ModifierSpec };

/**
 * Multipliers that events (for everyone) and managers (for one company) put on the game's
 * numbers. Revenue and supply are keyed by cargo id, cargo group (people, bulk, industrial,
 * farm, consumer) or 'all'; interest is added to bond rates.
 */
export interface Modifiers {
  revenue: Record<string, number>;
  supply: Record<string, number>;
  construction: number;
  fuel: number;
  maintenance: number;
  breakdowns: number;
  interest: number;
  growth: number;
  goodwill: number;
}

export function neutralMods(): Modifiers {
  return { revenue: {}, supply: {}, construction: 1, fuel: 1, maintenance: 1, breakdowns: 1, interest: 0, growth: 1, goodwill: 1 };
}

/** a ∘ b: multiply factors, add interest. */
export function combineMods(a: Modifiers, b: ModifierSpec): Modifiers {
  const out: Modifiers = { ...a, revenue: { ...a.revenue }, supply: { ...a.supply } };
  for (const [k, v] of Object.entries(b.revenue ?? {})) out.revenue[k] = (out.revenue[k] ?? 1) * v;
  for (const [k, v] of Object.entries(b.supply ?? {})) out.supply[k] = (out.supply[k] ?? 1) * v;
  out.construction *= b.construction ?? 1;
  out.fuel *= b.fuel ?? 1;
  out.maintenance *= b.maintenance ?? 1;
  out.breakdowns *= b.breakdowns ?? 1;
  out.growth *= b.growth ?? 1;
  out.goodwill *= b.goodwill ?? 1;
  out.interest += b.interest ?? 0;
  return out;
}

/** Factor for one cargo from a by-cargo/by-group/'all' table. */
export function cargoFactor(table: Record<string, number>, cargo: string): number {
  const group = CARGO_BY_ID.get(cargo)?.group;
  return (table[cargo] ?? 1) * (group ? table[group] ?? 1 : 1) * (table.all ?? 1);
}

/** Plain-language list of what a modifier spec does (for news and panels). */
export function describeMods(m: ModifierSpec): string[] {
  const pct = (f: number) => `${f >= 1 ? '+' : '−'}${Math.round(Math.abs(f - 1) * 100)}%`;
  const name = (k: string) => (k === 'all' ? 'all cargo' : k === 'people' ? 'passengers & mail' : CARGO_BY_ID.get(k)?.name.toLowerCase() ?? `${k} cargo`);
  const out: string[] = [];
  for (const [k, v] of Object.entries(m.revenue ?? {})) out.push(`${name(k)} pays ${pct(v)}`);
  for (const [k, v] of Object.entries(m.supply ?? {})) out.push(`${name(k)} supply ${pct(v)}`);
  if (m.construction && m.construction !== 1) out.push(`construction ${pct(m.construction)}`);
  if (m.fuel && m.fuel !== 1) out.push(`fuel ${pct(m.fuel)}`);
  if (m.maintenance && m.maintenance !== 1) out.push(`upkeep ${pct(m.maintenance)}`);
  if (m.breakdowns && m.breakdowns !== 1) out.push(`breakdowns ${pct(m.breakdowns)}`);
  if (m.growth && m.growth !== 1) out.push(`town growth ${pct(m.growth)}`);
  if (m.goodwill && m.goodwill !== 1) out.push(`goodwill gains ${pct(m.goodwill)}`);
  if (m.interest) out.push(`bond rates ${m.interest > 0 ? '+' : '−'}${(Math.abs(m.interest) * 100).toFixed(1)} points`);
  if (m.confidence) out.push(`business confidence ${m.confidence > 0 ? '+' : '−'}${Math.abs(m.confidence)}`);
  return out;
}
