import { ADVISOR, AI, CARGO_BY_ID, FINANCE, TIME } from '../data';
import { account } from './chairman';
import { daysToRecover } from './economy';
import type { Game } from './game';
import { boardVote } from './rivals';
import { annualProfit, engineAgeYears, engineDef, isSpecialCar, type Train } from './train';

/**
 * The advisor: a list of things worth your attention right now, derived from the game state
 * (nothing is stored, so advice disappears by itself once the problem is solved).
 */

export type AdviceKind = 'cargo' | 'trains' | 'money' | 'rivals' | 'economy';

export interface Advice {
  /** Stable id for dismissing (same problem → same key). */
  key: string;
  kind: AdviceKind;
  /** 0 = tip, 1 = worth a look, 2 = urgent. */
  severity: 0 | 1 | 2;
  text: string;
  /** What to show when the player clicks the item. */
  target?: { station?: number; train?: number; company?: number };
}

const cargoName = (id: string) => CARGO_BY_ID.get(id)?.name.toLowerCase() ?? id;
const pct = (v: number) => `${Math.round(v * 100)}%`;

export function advise(game: Game): Advice[] {
  const A = ADVISOR;
  const out: Advice[] = [];
  if (game.over) return out;
  const me = game.company;
  const mine = game.trains.trains.filter((t) => t.owner === me.id);
  const myStations = game.world.liveStations().filter((s) => s.owner === me.id);
  const servedBy = (station: number) => mine.filter((t) => t.route.some((r) => r.station === station));

  // -- cargo -------------------------------------------------------------------------------
  for (const st of myStations) {
    const sc = game.economy.cargoAt(st.id);
    const trains = servedBy(st.id);
    if (!trains.length) {
      out.push({ key: `idle:${st.id}`, kind: 'cargo', severity: 0, text: `${st.name} has no trains calling.`, target: { station: st.id } });
    }
    for (const [cargo, loads] of Object.entries(sc.waiting)) {
      if (loads < A.waitingLoads) continue;
      const carried = trains.some((t) => t.cars.some((c) => c.cargo === cargo));
      out.push({
        key: `wait:${st.id}:${cargo}`,
        kind: 'cargo',
        severity: loads >= A.waitingLoads * 2 ? 1 : 0,
        text: `${st.name} has ${Math.floor(loads)} loads of ${cargoName(cargo)} waiting — ${carried ? 'add a train or more cars' : 'no train carries it'}.`,
        target: { station: st.id },
      });
    }
    for (const [cargo, level] of Object.entries(sc.demand)) {
      if (level >= A.saturatedDemand) continue;
      out.push({
        key: `sat:${st.id}:${cargo}`,
        kind: 'cargo',
        severity: 0,
        text: `Deliveries of ${cargoName(cargo)} to ${st.name} pay only ${pct(level)} — demand needs ${Math.ceil(daysToRecover(level))} days to recover. Spread them over more stations.`,
        target: { station: st.id },
      });
    }
  }

  // -- trains ------------------------------------------------------------------------------
  for (const t of mine) out.push(...trainAdvice(game, t));

  // -- money -------------------------------------------------------------------------------
  if (me.cash < 0) out.push({ key: 'cash:neg', kind: 'money', severity: 2, text: `${me.name} is overdrawn: at month end the bank forces emergency bonds at a penalty rate.` });
  else if (me.cash < A.lowCash) out.push({ key: 'cash:low', kind: 'money', severity: 1, text: `Company cash is down to $${Math.round(me.cash).toLocaleString('en-US')}.` });
  const rating = game.rating(me);
  if (rating.index >= A.badRatingIndex) out.push({ key: 'rating', kind: 'money', severity: 1, text: `Credit rating ${rating.def.id}: new bonds are expensive. Repay debt or raise profits.` });
  const acc = account(game.chairman, game.activeCompanies);
  if (acc.marginLoan > 0 && acc.ratio < FINANCE.margin.initial) {
    out.push({
      key: 'margin',
      kind: 'money',
      severity: acc.ratio < FINANCE.margin.maintenance * 1.2 ? 2 : 1,
      text: `Your margin is at ${pct(acc.ratio)}; below ${pct(FINANCE.margin.maintenance)} your broker sells your shares.`,
    });
  }

  // -- rivals ------------------------------------------------------------------------------
  for (const [holder, n] of me.holders) {
    if (holder === 'public' || holder === game.chairman.key) continue;
    const stake = n / me.shares;
    if (stake < A.rivalStakeNotice) continue;
    const who = game.investorByKey(holder)?.name ?? holder;
    const company = game.companies.find((c) => c.chairman === holder);
    out.push({
      key: `stake:${holder}`,
      kind: 'rivals',
      severity: stake >= AI.merger.minStake ? 2 : 1,
      text:
        stake >= AI.merger.minStake
          ? `${who} holds ${pct(stake)} of ${me.name} and can call a takeover vote at any time.`
          : `${who} holds ${pct(stake)} of ${me.name}; at ${pct(AI.merger.minStake)} he can call a takeover vote.`,
      target: company ? { company: company.id } : undefined,
    });
  }
  const board = boardVote(game, me);
  if (board.strikes > 0 || (game.year + 1 - game.params.startYear >= AI.board.graceYears && board.warn)) {
    out.push({
      key: 'board',
      kind: 'rivals',
      severity: board.support < 0.5 ? 2 : 1,
      text: `Only ${pct(board.support)} of shareholders would back you in January${board.strikes ? ' — and you already lost one vote' : ''}.`,
      target: { company: me.id },
    });
  }

  // -- economy -----------------------------------------------------------------------------
  const h = game.economy.cycle.history;
  if (h.length >= 4) {
    const change = h[h.length - 1] - h[h.length - 4];
    if (change <= -A.confidenceDrop) out.push({ key: 'conf:down', kind: 'economy', severity: 1, text: `Business confidence fell ${-change} points in three months: a downturn may be coming. Keep some cash.` });
    else if (change >= A.confidenceDrop) out.push({ key: 'conf:up', kind: 'economy', severity: 0, text: `Business confidence rose ${change} points in three months: better times are likely ahead.` });
  }

  out.sort((a, b) => b.severity - a.severity);
  return out.slice(0, A.maxItems);
}

function trainAdvice(game: Game, t: Train): Advice[] {
  const A = ADVISOR;
  const out: Advice[] = [];
  const target = { train: t.id };
  if (t.state === 'noroute') out.push({ key: `noroute:${t.id}`, kind: 'trains', severity: 2, text: `${t.name} cannot reach its next stop — check the track.`, target });
  if (t.state === 'signal') {
    const days = (game.tick - t.waitSince) / TIME.ticksPerDay;
    if (days >= A.signalWaitDays) out.push({ key: `stuck:${t.id}`, kind: 'trains', severity: 1, text: `${t.name} has waited ${Math.floor(days)} days for the line ahead — add double track or passing stations.`, target });
  }
  if (t.stats.departures >= A.minDepartures && t.stats.loadFactor >= 0 && t.stats.loadFactor < A.lowLoadFactor && t.cars.some((c) => !isSpecialCar(c.cargo))) {
    out.push({ key: `load:${t.id}`, kind: 'trains', severity: 0, text: `${t.name} leaves its stations only ${pct(t.stats.loadFactor)} full — fewer cars or a busier route would pay better.`, target });
  }
  if (t.stats.months.length >= A.losingMonths && annualProfit(t) < 0) {
    out.push({ key: `loss:${t.id}`, kind: 'trains', severity: 1, text: `${t.name} is losing about $${Math.round(-annualProfit(t)).toLocaleString('en-US')} a year.`, target });
  }
  const e = engineDef(t);
  const age = engineAgeYears(t, game.tick);
  if (age > e.lifespan) out.push({ key: `old:${t.id}`, kind: 'trains', severity: 0, text: `${t.name}'s ${e.name} is ${Math.floor(age)} years old (lifespan ${e.lifespan}): breakdowns are getting likely.`, target });
  return out;
}
