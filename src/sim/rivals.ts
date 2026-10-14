import { AI } from '../data';
import type { Chairman } from './chairman';
import type { Company } from './company';
import type { Game } from './game';

/**
 * Corporate control: takeovers by merger (with a shareholder vote), bankruptcy of companies
 * whose debts exceed their assets, and the yearly board vote on the player's chairmanship.
 */

// ---------------------------------------------------------------------------------------
// Mergers
// ---------------------------------------------------------------------------------------

export interface MergerVote {
  /** Fractions of the target's shares. */
  yes: number;
  no: number;
  passes: boolean;
  /** Acquirer shares issued per target share. */
  ratio: number;
  /** Who voted how (for the report). */
  lines: string[];
}

/** Why `by` can't propose merging `target` into `acquirer` (null = allowed). */
export function mergerBlocker(game: Game, acquirer: Company, target: Company, by: Chairman): string | null {
  if (acquirer === target) return 'A company cannot merge with itself.';
  if (acquirer.defunct || target.defunct) return 'That company no longer exists.';
  if (acquirer.chairman !== by.key) return `Only the chairman of ${acquirer.name} can propose a merger.`;
  const stake = target.holding(by.key) / target.shares;
  if (stake < AI.merger.minStake) return `You need at least ${Math.round(AI.merger.minStake * 100)}% of ${target.name} to call a vote (you hold ${(stake * 100).toFixed(1)}%).`;
  const until = target.mergerCooldown.get(acquirer.id) ?? -Infinity;
  if (game.day < until) return `${target.name}'s shareholders rejected a merger recently; try again in ${Math.ceil((until - game.day) / 30)} months.`;
  return null;
}

/** How the target's shareholders would vote right now. */
export function mergerVote(game: Game, acquirer: Company, target: Company, by: Chairman): MergerVote {
  const M = AI.merger;
  const shares = target.shares;
  let yes = 0;
  let no = 0;
  const lines: string[] = [];
  const pct = (n: number) => `${((n / shares) * 100).toFixed(1)}%`;
  for (const [holder, n] of target.holders) {
    if (n <= 0 || holder === 'public') continue;
    const inv = game.investorByKey(holder);
    const name = inv?.name ?? holder;
    if (holder === by.key) {
      yes += n;
      lines.push(`${name}: ${pct(n)} for`);
    } else if (holder === target.chairman) {
      no += n;
      lines.push(`${name} (chairman of ${target.name}): ${pct(n)} against`);
    } else {
      // Other barons take the premium.
      yes += n;
      lines.push(`${name}: ${pct(n)} for (premium)`);
    }
  }
  const pub = target.holding('public');
  const badYear = target.stock.price < target.stock.yearOpen;
  const pubYes = Math.min(0.9, Math.max(0, M.publicBase + M.premium * M.publicPerPremium + (badYear ? M.badYearBonus : 0)));
  yes += pub * pubYes;
  no += pub * (1 - pubYes);
  lines.push(`Public: ${pct(pub)}, ${Math.round(pubYes * 100)}% of it for${badYear ? ' (a bad year for the share price)' : ''}`);
  const ratio = (target.stock.price * (1 + M.premium)) / Math.max(0.01, acquirer.stock.price);
  return { yes: yes / shares, no: no / shares, passes: yes / shares > 0.5, ratio, lines };
}

export interface MergerResult {
  ok: boolean;
  error?: string;
  vote?: MergerVote;
}

/** Hold the vote; if it carries, `target` is folded into `acquirer`. */
export function proposeMerger(game: Game, acquirer: Company, target: Company, by: Chairman): MergerResult {
  const blocked = mergerBlocker(game, acquirer, target, by);
  if (blocked) return { ok: false, error: blocked };
  const vote = mergerVote(game, acquirer, target, by);
  if (!vote.passes) {
    target.mergerCooldown.set(acquirer.id, game.day + AI.merger.cooldownMonths * 30);
    game.emit({ type: 'rival', company: target.id, text: `${target.name}'s shareholders rejected ${acquirer.name}'s merger offer (${Math.round(vote.yes * 100)}% for).`, tone: target.id === 0 ? 1 : 0 });
    return { ok: true, vote };
  }
  executeMerger(game, acquirer, target, vote.ratio);
  return { ok: true, vote };
}

function executeMerger(game: Game, acquirer: Company, target: Company, ratio: number): void {
  // Every target share becomes `ratio` new acquirer shares.
  let issued = 0;
  for (const [holder, n] of target.holders) {
    if (n <= 0) continue;
    const m = Math.round(n * ratio);
    acquirer.holders.set(holder, acquirer.holding(holder) + m);
    issued += m;
  }
  acquirer.shares += issued;
  // Short sellers of the target must buy back at the offer price.
  const offer = target.stock.price * (1 + AI.merger.premium);
  for (const inv of game.investors) {
    const s = inv.short(target.id);
    if (s > 0) {
      inv.cash -= s * offer;
      inv.shorts.delete(target.id);
    }
  }
  // Assets and debts.
  acquirer.cash += target.cash;
  acquirer.infrastructure += target.infrastructure;
  for (const [id, cost] of target.industryCost) acquirer.industryCost.set(id, cost);
  target.industryCost.clear();
  for (const b of target.bonds) acquirer.bonds.push({ ...b, id: acquirer.bonds.length + 1000 + b.id });
  transferProperty(game, target.id, acquirer.id);
  target.cash = 0;
  target.bonds.length = 0;
  target.holders.clear();
  target.defunct = 'merged';
  acquirer.note(game.day, `Merged with ${target.name}`);
  game.emit({ type: 'rival', company: acquirer.id, text: `${acquirer.name} has taken over ${target.name}! Its shareholders got ${ratio.toFixed(2)} ${acquirer.ticker} shares per share.`, tone: acquirer.id === 0 ? 1 : target.id === 0 ? -1 : 0 });
  if (target.id === 0) game.endGame('takeover', `${acquirer.name} took over ${target.name}. You keep your shares, but you no longer run a railroad.`);
}

/** Hand all track, stations and trains of one company to another. */
function transferProperty(game: Game, from: number, to: number): void {
  const w = game.world;
  for (const [i, n] of w.track.nodes) {
    if (n.owner === from) {
      n.owner = to;
      w.markDirty(i);
    }
  }
  for (const st of w.liveStations()) if (st.owner === from) st.owner = to;
  for (const t of game.trains.trains) if (t.owner === from) t.owner = to;
  game.economy.invalidate();
}

// ---------------------------------------------------------------------------------------
// Bankruptcy
// ---------------------------------------------------------------------------------------

/**
 * Called at month end when a company's cash is negative. Returns true if lenders will
 * still help (emergency bonds); otherwise counts the month and, after
 * `bankruptcy.monthsInsolvent`, declares the company bankrupt.
 */
export function checkSolvency(game: Game, c: Company): boolean {
  if (game.balance(c).bookValue >= 0) {
    c.insolventMonths = 0;
    return true;
  }
  c.insolventMonths++;
  if (c.insolventMonths >= AI.bankruptcy.monthsInsolvent) {
    bankrupt(game, c);
  } else {
    game.emit({ type: 'rival', company: c.id, text: `${c.name} owes more than it owns and no bank will lend to it. Raise cash or it goes bankrupt next month!`, tone: -1 });
  }
  return false;
}

export function bankrupt(game: Game, c: Company): void {
  const w = game.world;
  // Shares become worthless; short sellers keep their gains.
  c.holders.clear();
  for (const inv of game.investors) inv.shorts.delete(c.id);
  // The railway is torn up.
  const doomed: number[] = [];
  for (const [i, n] of w.track.nodes) if (n.owner === c.id) doomed.push(i);
  for (const i of doomed) {
    w.track.nodes.delete(i);
    w.markDirty(i);
  }
  w.stations.forEach((st, id) => {
    if (st && st.owner === c.id) {
      for (const t of st.tiles) w.markDirty(t);
      w.stations[id] = null;
    }
  });
  for (const t of [...game.trains.trains]) if (t.owner === c.id) game.trains.remove(t);
  w.editVersion++;
  game.undoStack.length = 0;
  game.economy.invalidate();
  for (const id of c.industryCost.keys()) game.economy.owned.delete(id);
  c.industryCost.clear();
  c.cash = 0;
  c.bonds.length = 0;
  c.defunct = 'bankrupt';
  game.emit({ type: 'rival', company: c.id, text: `${c.name} has gone bankrupt. Its shares are worthless and its railway is being torn up.`, tone: c.id === 0 ? -1 : 1 });
  if (c.id === 0) game.endGame('bankrupt', `${c.name} went bankrupt: its debts exceeded everything it owned.`);
}

// ---------------------------------------------------------------------------------------
// Board vote
// ---------------------------------------------------------------------------------------

export interface BoardVote {
  /** False in the first years (no vote held). */
  held: boolean;
  /** Share of votes for the chairman. */
  support: number;
  /** The public's mood (fraction of public shares for you). */
  publicSupport: number;
  warn: boolean;
  /** Failed votes in a row so far (a second one in a row removes you). */
  strikes: number;
}

/** The shareholders' yearly vote on the player as chairman of company c. */
export function boardVote(game: Game, c: Company): BoardVote {
  const B = AI.board;
  const priceChange = c.stock.price / Math.max(0.01, c.stock.yearOpen) - 1;
  const profit = c.netProfitIn(game.year - 1);
  const publicSupport = Math.min(0.95, Math.max(0.05, B.publicBase + B.perPriceChange * priceChange + (profit > 0 ? B.profitBonus : -B.lossPenalty)));
  let support = 0;
  for (const [holder, n] of c.holders) {
    const f = n / c.shares;
    if (holder === c.chairman) support += f;
    else if (holder === 'public') support += f * publicSupport;
    else if (game.settings.friendlyAi) support += f * publicSupport;
    // Hostile rival barons vote against.
  }
  const held = game.year - game.params.startYear >= B.graceYears;
  return { held, support, publicSupport, warn: support < B.warnBelow, strikes: c.boardStrikes };
}
