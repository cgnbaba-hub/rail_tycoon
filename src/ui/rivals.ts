import { AI } from '../data';
import { PALETTE, type PaletteName } from '../render/palette';
import type { Company } from '../sim/company';
import type { Game, GameOver } from '../sim/game';
import { boardVote, mergerBlocker, mergerVote, proposeMerger } from '../sim/rivals';
import { esc, fmtInt } from './dom';
import { fmtPrice, monthChange, openFinance, ownershipPie, priceChart } from './finance';
import { fmtMoney } from './tools';
import { confirmModal, type TrainUiHost } from './trains';

/** Company colour as CSS. */
export function companyColor(c: Company): string {
  return PALETTE[c.color as PaletteName] ?? PALETTE.gold;
}

/** Colour swatch + name, for tables and panels. */
export function companyTag(c: Company): string {
  return `<span class="co-tag"><i class="sw" style="background:${companyColor(c)}"></i>${esc(c.name)}</span>`;
}

/** Who holds shares: 'You', a baron's name, or 'Public'. */
export function holderName(game: Game, key: string): string {
  if (key === 'public') return 'Public';
  if (key === game.chairman.key) return 'You';
  return game.investorByKey(key)?.name ?? key;
}

/** Holder colour: you gold, barons their company colour, the public grey. */
export function holderColor(game: Game, key: string): string {
  if (key === 'public') return PALETTE.steel;
  if (key === game.chairman.key) return PALETTE.gold;
  const co = game.companies.find((c) => c.chairman === key);
  return co ? companyColor(co) : PALETTE.fog;
}

function row(label: string, value: string, cls = ''): string {
  return `<div class="kv ${cls}"><span>${esc(label)}</span><b>${value}</b></div>`;
}

function money(v: number): string {
  const s = fmtMoney(Math.round(v));
  return v < 0 ? `<span class="bad">${s}</span>` : s;
}

function chairmanLine(game: Game, c: Company): string {
  const ai = game.ai.find((a) => a.companyId === c.id);
  const name = holderName(game, c.chairman);
  return ai ? `${esc(name)}<br><small>${esc(ai.def.name)}</small>` : esc(name);
}

/** Largest holder other than the public and the chairman. */
function biggestOutsider(c: Company): { key: string; frac: number } | null {
  let best: { key: string; frac: number } | null = null;
  for (const [key, n] of c.holders) {
    if (key === 'public' || key === c.chairman || n <= 0) continue;
    const frac = n / c.shares;
    if (!best || frac > best.frac) best = { key, frac };
  }
  return best;
}

// ---------------------------------------------------------------------------------------
// Companies window
// ---------------------------------------------------------------------------------------

let selected = 0;

export function openCompanies(host: TrainUiHost, focus?: number): void {
  const game = host.game;
  if (focus !== undefined) selected = focus;
  if (!game.companyById(selected)) selected = 0;
  const me = game.company;
  const rows = game.companies
    .map((c) => {
      const ch = monthChange(c);
      const stake = c.holding(game.chairman.key) / Math.max(1, c.shares);
      const trains = game.trains.trains.filter((t) => t.owner === c.id).length;
      const stations = game.world.liveStations().filter((s) => s.owner === c.id).length;
      const status = c.defunct === 'merged' ? '<small>merged</small>' : c.defunct === 'bankrupt' ? '<small class="bad">bankrupt</small>' : '';
      const book = c.defunct ? '—' : money(game.balance(c).bookValue);
      return `<tr data-co="${c.id}" tabindex="0" class="${c.id === selected ? 'sel' : ''}${c.defunct ? ' defunct' : ''}">
        <td>${companyTag(c)}<br><small>${esc(c.ticker)}</small> ${status}</td>
        <td>${chairmanLine(game, c)}</td>
        <td>${c.defunct ? '—' : `${fmtPrice(c.stock.price)} <i class="${ch > 0.0005 ? 'good' : ch < -0.0005 ? 'bad' : ''}">${ch >= 0 ? '+' : '−'}${Math.abs(ch * 100).toFixed(0)}%</i>`}</td>
        <td>${c.defunct ? '—' : fmtMoney(Math.round(c.stock.price * c.shares))}</td>
        <td>${book}</td>
        <td>${c.defunct ? '—' : money(c.profitTrend)}</td>
        <td>${fmtInt(trains)} <small>· ${fmtInt(stations)} st.</small></td>
        <td>${stake > 0 ? `${(stake * 100).toFixed(1)}%` : '—'}</td>
      </tr>`;
    })
    .join('');
  const m = host.openModal(
    `<h2>Railroads</h2>
    <div class="scroll"><table class="table companies"><thead><tr><th>Company</th><th>Chairman</th><th>Share</th><th>Market value</th><th>Book value</th><th>Profit / yr</th><th>Trains</th><th>Your stake</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="co-detail">${detailHtml(game, game.companyById(selected)!)}</div>
    <div class="actions"><button class="btn primary" data-act="close">Close</button></div>`,
    'wide companies',
  );
  m.querySelector<HTMLElement>('[data-act="close"]')!.addEventListener('click', () => host.closeModal());
  m.querySelectorAll<HTMLElement>('[data-co]').forEach((r) => {
    const go = () => openCompanies(host, Number(r.dataset.co));
    r.addEventListener('click', go);
    r.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  });
  m.querySelector<HTMLElement>('[data-act="trade"]')?.addEventListener('click', () => openFinance(host, 'portfolio', selected));
  m.querySelector<HTMLElement>('[data-act="merge"]')?.addEventListener('click', () => {
    const target = game.companyById(selected)!;
    const vote = mergerVote(game, me, target, game.chairman);
    confirmModal(
      host,
      `Propose merging ${target.name} into ${me.name}?`,
      `${target.name}'s shareholders get ${vote.ratio.toFixed(2)} ${me.ticker} shares per share (a ${Math.round(AI.merger.premium * 100)}% premium). Expected vote: ${Math.round(vote.yes * 100)}% for. If it fails, you cannot try again for ${AI.merger.cooldownMonths} months.`,
      'Call the vote',
    ).then((yes) => {
      if (!yes) return openCompanies(host);
      const r = proposeMerger(game, me, target, game.chairman);
      if (!r.ok) host.toast(r.error ?? 'Cannot merge.', 'error');
      else if (r.vote?.passes) host.toast(`${target.name} is now part of ${me.name}!`, 'money');
      else host.toast(`The shareholders of ${target.name} voted no (${Math.round((r.vote?.yes ?? 0) * 100)}% for).`, 'error');
      host.invalidatePanel();
      openCompanies(host, r.vote?.passes ? me.id : target.id);
    });
  });
}

function detailHtml(game: Game, c: Company): string {
  const me = game.company;
  if (c.defunct) {
    return `<div class="section">${companyTag(c)}</div><p class="hint">${c.defunct === 'merged' ? 'This company was taken over; its railway now belongs to the acquirer.' : 'This company went bankrupt. Its shares became worthless and its railway was torn up.'}</p>`;
  }
  const holders = [...c.holders]
    .filter(([k, n]) => n > 0 && k !== 'public')
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => row(holderName(game, k) + (k === c.chairman ? ' (chairman)' : ''), `${((n / c.shares) * 100).toFixed(1)}% <small>${fmtInt(n)}</small>`))
    .join('');
  let right = '';
  if (c.id === me.id) {
    const v = boardVote(game, c);
    const out = biggestOutsider(c);
    right = `<div class="section">Board confidence</div>
      ${row('Support if the vote were today', `<span class="${v.support < 0.5 ? 'bad' : v.warn ? 'warn' : 'good'}">${Math.round(v.support * 100)}%</span>`)}
      ${row('Public mood', `${Math.round(v.publicSupport * 100)}% for you`)}
      ${row('Votes of no confidence', v.strikes ? `<span class="bad">${v.strikes} — one more and you are out</span>` : 'none')}
      <p class="hint">${v.held ? 'Every January the shareholders vote on you.' : `Votes start in ${game.params.startYear + AI.board.graceYears}.`} Your own shares count for you; the public follows the share price and profits${game.settings.friendlyAi ? '' : '; rival barons vote against you'}. Two failed votes in a row cost you the chair.</p>
      ${out && out.frac >= 0.1 ? `<p class="warnbox">${esc(holderName(game, out.key))} holds ${Math.round(out.frac * 100)}% of ${esc(c.name)}. At ${Math.round(AI.merger.minStake * 100)}% a rival can call a takeover vote.</p>` : ''}`;
  } else {
    const blocked = game.over ? 'You no longer run a railroad.' : mergerBlocker(game, me, c, game.chairman);
    const vote = mergerVote(game, me, c, game.chairman);
    right = `<div class="section">Take it over</div>
      ${row('Your stake', `${((c.holding(game.chairman.key) / c.shares) * 100).toFixed(1)}% (need ${Math.round(AI.merger.minStake * 100)}%)`)}
      ${row('Offer', `${vote.ratio.toFixed(2)} ${esc(me.ticker)} per ${esc(c.ticker)} share`)}
      ${row('Expected vote', `<span class="${vote.passes ? 'good' : 'bad'}">${Math.round(vote.yes * 100)}% for</span>`)}
      <ul class="why">${vote.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      <p class="hint">Buy at least ${Math.round(AI.merger.minStake * 100)}% of its shares, then call a vote. If more than half vote yes, its track, stations, trains, cash and debts become yours and its shareholders get your shares.</p>
      <div class="actions wrap">
        <button class="btn small" data-act="trade">Trade ${esc(c.ticker)} shares</button>
        <button class="btn small primary" data-act="merge" ${blocked ? `disabled data-tip="${esc(blocked)}"` : ''}>Propose merger</button>
      </div>`;
  }
  return `<div class="fin-grid">
    <div>
      <div class="section">${companyTag(c)} · ${esc(c.ticker)} ${fmtPrice(c.stock.price)}</div>
      ${priceChart(c.stock.daily, 320, 90)}
      ${ownershipPie(c, game)}
      ${holders}
      ${row('Cash · debt', `${money(c.cash)} · ${money(-c.debt)}`)}
    </div>
    <div>${right}</div>
  </div>`;
}

// ---------------------------------------------------------------------------------------
// Game over
// ---------------------------------------------------------------------------------------

const TITLES: Record<GameOver['reason'], string> = {
  takeover: 'Taken over!',
  bankrupt: 'Bankrupt!',
  board: 'Voted out!',
};

export function openGameOver(host: TrainUiHost & { openNewGameDialog(): void }, over: GameOver): void {
  const game = host.game;
  const worth = game.netWorth();
  const m = host.openModal(
    `<h2>${esc(TITLES[over.reason])}</h2>
    <p>${esc(over.text)}</p>
    ${row('Your net worth', money(worth), 'total')}
    ${row('Years as chairman', `${Math.max(0, (over.day / 365)).toFixed(1)}`)}
    <p class="hint">You can keep watching the rival railroads and trade shares with your personal fortune, or start a new map.</p>
    <div class="actions"><button class="btn" data-a="watch">Keep watching</button><button class="btn primary" data-a="new">New map</button></div>`,
  );
  m.querySelector<HTMLElement>('[data-a="watch"]')!.addEventListener('click', () => host.closeModal());
  m.querySelector<HTMLElement>('[data-a="new"]')!.addEventListener('click', () => host.openNewGameDialog());
}
