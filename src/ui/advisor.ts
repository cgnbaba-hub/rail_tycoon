import { CARGO_BY_ID } from '../data';
import { advise, type Advice, type AdviceKind } from '../sim/advisor';
import type { RevenueQuote } from '../sim/economy';
import type { Game } from '../sim/game';
import { formatDate } from '../sim/time';
import { esc } from './dom';
import { fmtMoney } from './tools';
import type { TrainUiHost } from './trains';

/** Everything that happened, newest last; plus the advisor's current list. */

export type LogKind = 'news' | 'rivals' | 'money' | 'trains' | 'towns';

export interface LogEntry {
  day: number;
  kind: LogKind;
  text: string;
  tone: number;
  target?: Advice['target'];
}

export interface DeliveryEntry {
  day: number;
  train: number;
  trainName: string;
  station: number;
  stationName: string;
  revenue: number;
  quotes: RevenueQuote[];
}

const KIND_LABEL: Record<AdviceKind | LogKind, string> = {
  cargo: 'Cargo',
  trains: 'Trains',
  money: 'Money',
  rivals: 'Rivals',
  economy: 'Economy',
  news: 'News',
  towns: 'Towns',
};

export const feed = {
  log: [] as LogEntry[],
  deliveries: [] as DeliveryEntry[],
  advice: [] as Advice[],
  dismissed: new Set<string>(),
  hidden: new Set<string>(),
  tab: 'advice' as 'advice' | 'log' | 'deliveries',
  showDismissed: false,
};

export function resetFeed(): void {
  feed.log.length = 0;
  feed.deliveries.length = 0;
  feed.advice = [];
  feed.dismissed.clear();
}

export function logEvent(game: Game, kind: LogKind, text: string, tone = 0, target?: Advice['target']): void {
  feed.log.push({ day: game.day, kind, text, tone, target });
  if (feed.log.length > 300) feed.log.shift();
}

export function logDelivery(game: Game, train: number, station: number, revenue: number, quotes: RevenueQuote[]): void {
  feed.deliveries.push({
    day: game.day,
    train,
    trainName: game.trains.byId(train)?.name ?? `Train ${train}`,
    station,
    stationName: game.world.stations[station]?.name ?? '?',
    revenue,
    quotes,
  });
  if (feed.deliveries.length > 80) feed.deliveries.shift();
}

export function refreshAdvice(game: Game): void {
  feed.advice = advise(game);
}

/** Open, not-dismissed advice that deserves a look (for the rail badge). */
export function adviceCount(): number {
  return feed.advice.filter((a) => a.severity >= 1 && !feed.dismissed.has(a.key)).length;
}

/** Formula of one delivered cargo, e.g. "$410 × 0.95 time × 0.80 demand × 1.10 econ × 1.00 bonus × 3 loads = $1,029". */
export function quoteFormula(q: RevenueQuote): string {
  const f = (v: number) => v.toFixed(2);
  return `${fmtMoney(Math.round(q.distancePay))}/load (base + ${q.miles.toFixed(0)} mi) × ${f(q.timeFactor)} time × ${f(q.demandFactor)} demand × ${f(q.economyFactor)} economy × ${f(q.bonusFactor)} bonus × ${q.loads} load${q.loads === 1 ? '' : 's'} = ${fmtMoney(Math.round(q.total))}${q.transferred ? ` (${q.transferred} via transfer, paid from their first station)` : ''}`;
}

export interface AdvisorHost extends TrainUiHost {
  focusTarget(target: NonNullable<Advice['target']>): void;
}

export function openAdvisor(host: AdvisorHost): void {
  const game = host.game;
  refreshAdvice(game);
  const date = (day: number) => formatDate(game.dateOf(day));
  const kinds: Array<AdviceKind | LogKind> =
    feed.tab === 'advice' ? ['cargo', 'trains', 'money', 'rivals', 'economy'] : feed.tab === 'log' ? ['news', 'rivals', 'money', 'trains', 'towns'] : [];
  const filters = kinds
    .map((k) => `<label class="check"><input type="checkbox" data-kind="${k}" ${feed.hidden.has(k) ? '' : 'checked'}> ${KIND_LABEL[k]}</label>`)
    .join('');
  let body = '';
  if (feed.tab === 'advice') {
    const items = feed.advice.filter((a) => !feed.hidden.has(a.kind) && (feed.showDismissed || !feed.dismissed.has(a.key)));
    body = items.length
      ? `<ul class="feed">${items
          .map(
            (a) => `<li class="sev${a.severity}${feed.dismissed.has(a.key) ? ' dismissed' : ''}">
              <span class="tag">${a.severity === 2 ? '!!' : a.severity === 1 ? '!' : 'i'} ${KIND_LABEL[a.kind]}</span>
              <span class="grow">${esc(a.text)}</span>
              ${a.target ? `<button class="btn small" data-go="${esc(JSON.stringify(a.target))}">Show</button>` : ''}
              <button class="btn small" data-dismiss="${esc(a.key)}" aria-label="${feed.dismissed.has(a.key) ? 'Restore' : 'Dismiss'}">${feed.dismissed.has(a.key) ? '↺' : '×'}</button></li>`,
          )
          .join('')}</ul>`
      : '<p class="hint">Nothing needs your attention right now.</p>';
    body += `<label class="check"><input type="checkbox" id="adv-dis" ${feed.showDismissed ? 'checked' : ''}> Show dismissed (${feed.dismissed.size})</label>`;
  } else if (feed.tab === 'log') {
    const items = [...feed.log].reverse().filter((e) => !feed.hidden.has(e.kind));
    body = items.length
      ? `<ul class="feed">${items
          .slice(0, 150)
          .map(
            (e) => `<li class="${e.tone > 0 ? 'good' : e.tone < 0 ? 'bad' : ''}"><small>${esc(date(e.day))}</small><span class="tag">${KIND_LABEL[e.kind]}</span><span class="grow">${esc(e.text)}</span>
              ${e.target ? `<button class="btn small" data-go="${esc(JSON.stringify(e.target))}">Show</button>` : ''}</li>`,
          )
          .join('')}</ul>`
      : '<p class="hint">No news yet.</p>';
  } else {
    const items = [...feed.deliveries].reverse();
    body = items.length
      ? `<ul class="feed deliveries">${items
          .slice(0, 60)
          .map(
            (d) => `<li><small>${esc(date(d.day))}</small><span class="grow"><b>${esc(d.trainName)}</b> → ${esc(d.stationName)}
              ${d.quotes.map((q) => `<div class="formula"><span>${esc(CARGO_BY_ID.get(q.cargo)?.name ?? q.cargo)}:</span> ${esc(quoteFormula(q))}</div>`).join('')}</span>
              <b class="money">${fmtMoney(Math.round(d.revenue))}</b>
              <button class="btn small" data-go="${esc(JSON.stringify({ train: d.train }))}">Show</button></li>`,
          )
          .join('')}</ul>`
      : '<p class="hint">Deliveries with their revenue formula appear here.</p>';
  }
  const tab = (id: typeof feed.tab, label: string) => `<button class="btn small" role="tab" data-tab="${id}" aria-selected="${feed.tab === id}">${label}</button>`;
  const m = host.openModal(
    `<div class="fin-head"><h2>Advisor</h2><div class="tabs" role="tablist">${tab('advice', `Advice (${feed.advice.filter((a) => !feed.dismissed.has(a.key)).length})`)}${tab('log', 'News log')}${tab('deliveries', 'Deliveries')}</div></div>
    ${filters ? `<div class="filters">${filters}</div>` : ''}
    <div class="fin-body">${body}</div>
    <div class="actions"><button class="btn primary" data-act="close">Close</button></div>`,
    'wide advisor',
  );
  m.querySelector('[data-act="close"]')!.addEventListener('click', () => host.closeModal());
  m.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      feed.tab = b.dataset.tab as typeof feed.tab;
      openAdvisor(host);
    }),
  );
  m.querySelectorAll<HTMLInputElement>('[data-kind]').forEach((c) =>
    c.addEventListener('change', () => {
      if (c.checked) feed.hidden.delete(c.dataset.kind!);
      else feed.hidden.add(c.dataset.kind!);
      openAdvisor(host);
    }),
  );
  m.querySelector<HTMLInputElement>('#adv-dis')?.addEventListener('change', (e) => {
    feed.showDismissed = (e.target as HTMLInputElement).checked;
    openAdvisor(host);
  });
  m.querySelectorAll<HTMLElement>('[data-dismiss]').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.dismiss!;
      if (feed.dismissed.has(k)) feed.dismissed.delete(k);
      else feed.dismissed.add(k);
      host.invalidatePanel();
      openAdvisor(host);
    }),
  );
  m.querySelectorAll<HTMLElement>('[data-go]').forEach((b) =>
    b.addEventListener('click', () => {
      host.closeModal();
      host.focusTarget(JSON.parse(b.dataset.go!));
    }),
  );
}
