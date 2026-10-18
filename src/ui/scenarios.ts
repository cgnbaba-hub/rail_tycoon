import { SCENARIOS, type ScenarioDef } from '../data';
import type { Game } from '../sim/game';
import { MEDALS, scenarioDef, scenarioProgress, startScenario, type Medal } from '../sim/scenario';
import { esc } from './dom';
import { icon } from './icons';
import { listSaves, openSaves, readSave } from './saves';
import { openSettings } from './settings';
import { fmtMoney } from './tools';
import type { TrainUiHost } from './trains';

export interface ScenarioHost extends TrainUiHost {
  startGame(game: Game): void;
  openNewGameDialog(): void;
  showTutorial(): void;
}

const MEDAL_KEY = 'ironBaron.medals';

function medals(): Record<string, Medal> {
  try {
    return JSON.parse(window.localStorage.getItem(MEDAL_KEY) ?? '{}') as Record<string, Medal>;
  } catch {
    return {};
  }
}

export function recordMedal(id: string, medal: Medal): void {
  const all = medals();
  if (MEDALS.indexOf(medal) > MEDALS.indexOf(all[id] ?? 'none')) all[id] = medal;
  try {
    window.localStorage.setItem(MEDAL_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked */
  }
}

export function medalIcon(m: Medal | null | undefined, cls = ''): string {
  if (!m || m === 'none') return `<span class="medal none ${cls}" aria-label="no medal">${icon('medal')}</span>`;
  return `<span class="medal ${m} ${cls}" aria-label="${m} medal">${icon('medal')}</span>`;
}

function fmtGoal(def: ScenarioDef, v: number): string {
  switch (def.goal.metric) {
    case 'cargoLoads':
      return `${Math.round(v).toLocaleString('en-US')} loads`;
    case 'rank':
      return v === 1 ? '1st' : v === 2 ? '2nd' : v === 3 ? '3rd' : `${v}th`;
    default:
      return fmtMoney(Math.round(v));
  }
}

function tierText(def: ScenarioDef): string {
  return def.goal.tiers
    .map((t, k) => {
      const extra = k === 2 && def.goal.goldNetWorth ? ` and ${fmtMoney(def.goal.goldNetWorth)} net worth` : '';
      return `${medalIcon(MEDALS[k + 1])} ${def.goal.metric === 'rank' ? `rank ${fmtGoal(def, t)}` : fmtGoal(def, t)}${extra}`;
    })
    .join(' · ');
}

// ---------------------------------------------------------------------------------------
// Title screen & scenario list
// ---------------------------------------------------------------------------------------

export async function openTitle(host: ScenarioHost): Promise<void> {
  const auto = (await listSaves().catch(() => [])).find((s) => s.name === 'Autosave');
  const m = host.openModal(
    `<div class="title-screen">
      <h1>IRON BARON</h1>
      <p class="hint">Build railroads, outwit rival barons and get rich — 1830 to 2000.</p>
      <div class="title-buttons">
        ${auto ? `<button class="btn primary" data-t="continue">Continue <small>${esc(auto.meta.company)} · ${esc(auto.meta.date)}</small></button>` : ''}
        <button class="btn ${auto ? '' : 'primary'}" data-t="tutorial">Tutorial <small>learn to play in a few minutes</small></button>
        <button class="btn" data-t="scenarios">Scenarios <small>goals and medals</small></button>
        <button class="btn" data-t="sandbox">Sandbox <small>a random map, your rules</small></button>
        <button class="btn" data-t="load">Load game <small>saves, import a file</small></button>
        <button class="btn" data-t="settings">Settings <small>sound, size, hints</small></button>
        <button class="btn" data-t="close">Back to the game <small>${esc(host.game.company.name)}</small></button>
      </div>
    </div>`,
    'title',
  );
  const on = (t: string, fn: () => void) => m.querySelector(`[data-t="${t}"]`)?.addEventListener('click', fn);
  on('continue', () => {
    readSave('Autosave')
      .then((g) => host.startGame(g))
      .catch((e: unknown) => host.toast(e instanceof Error ? e.message : String(e), 'error'));
  });
  on('tutorial', () => launch(host, SCENARIOS.find((s) => s.tutorial)!));
  on('scenarios', () => openScenarios(host));
  on('sandbox', () => host.openNewGameDialog());
  on('load', () => void openSaves(host));
  on('settings', () => openSettings(host));
  on('close', () => host.closeModal());
}

function launch(host: ScenarioHost, def: ScenarioDef): void {
  host.closeModal();
  const el = document.createElement('div');
  el.className = 'loading';
  el.textContent = `Preparing “${def.name}”…`;
  document.body.appendChild(el);
  requestAnimationFrame(() =>
    setTimeout(() => {
      try {
        host.startGame(startScenario(def));
      } finally {
        el.remove();
      }
    }, 0),
  );
}

export function openScenarios(host: ScenarioHost): void {
  const won = medals();
  const cards = SCENARIOS.map(
    (s) => `<div class="scn-card">
      <div class="scn-head"><b>${esc(s.name)}</b> <small>${s.map.startYear}–${s.map.startYear + s.years} · ${s.map.size}² · ${s.settings.rivals ?? 0} rival${s.settings.rivals === 1 ? '' : 's'}</small><span class="grow"></span>${medalIcon(won[s.id])}</div>
      <p>${esc(s.brief)}</p>
      <div class="scn-goal"><small>${esc(s.goal.label)}:</small> ${tierText(s)}</div>
      <div class="actions"><button class="btn small primary" data-start="${s.id}">Start</button></div>
    </div>`,
  ).join('');
  const m = host.openModal(
    `<h2>Scenarios</h2><div class="scn-list scroll">${cards}</div>
    <div class="actions"><button class="btn" data-a="back">Back</button></div>`,
    'wide',
  );
  m.querySelectorAll<HTMLElement>('[data-start]').forEach((b) => b.addEventListener('click', () => launch(host, SCENARIOS.find((s) => s.id === b.dataset.start)!)));
  m.querySelector('[data-a="back"]')!.addEventListener('click', () => void openTitle(host));
}

// ---------------------------------------------------------------------------------------
// Goal chip, goal window, result
// ---------------------------------------------------------------------------------------

export function goalChipHtml(game: Game): string {
  const p = scenarioProgress(game);
  if (!p) return '';
  const next = p.def.goal.tiers[Math.min(2, p.tier)];
  const reqOk = p.requirements.every((r) => r.met);
  const state = game.scenario!.finished ? (game.scenario!.medal ?? 'none') : `${p.yearsLeft}y`;
  return `${medalIcon(MEDALS[p.medalTier])}<span>${esc(fmtGoal(p.def, p.metric))}${p.tier < 3 ? ` <small>→ ${esc(fmtGoal(p.def, next))}</small>` : ''}${reqOk ? '' : ' <small class="bad">!</small>'} · ${esc(state)}</span>`;
}

export function openGoal(host: ScenarioHost): void {
  const game = host.game;
  const p = scenarioProgress(game);
  if (!p) return;
  const st = game.scenario!;
  const tiers = p.def.goal.tiers
    .map((t, k) => {
      const reached = p.tier > k;
      return `<li class="${reached ? 'good' : ''}">${medalIcon(MEDALS[k + 1])} ${esc(p.def.goal.metric === 'rank' ? `rank ${fmtGoal(p.def, t)}` : fmtGoal(p.def, t))}${k === 2 && p.def.goal.goldNetWorth ? ` and ${fmtMoney(p.def.goal.goldNetWorth)} net worth` : ''} ${reached ? '✓' : ''}</li>`;
    })
    .join('');
  const reqs = p.requirements.map((r) => `<li class="${r.met ? 'good' : 'bad'}">${r.met ? '✓' : '✗'} ${esc(r.label)}</li>`).join('');
  const m = host.openModal(
    `<h2>${esc(p.def.name)}</h2>
    <p>${esc(p.def.brief)}</p>
    <div class="kv"><span>${esc(p.def.goal.label)}</span><b>${esc(fmtGoal(p.def, p.metric))}</b></div>
    <div class="kv"><span>Time left</span><b>${st.finished ? 'finished' : `until January ${st.deadlineYear} (${p.yearsLeft} yr)`}</b></div>
    <div class="kv"><span>Medal so far</span><b>${medalIcon(MEDALS[st.best])} ${MEDALS[st.best]}</b></div>
    <div class="section">Medals</div><ul class="goal-list">${tiers}</ul>
    ${reqs ? `<div class="section">Needed for any medal</div><ul class="goal-list">${reqs}</ul>` : ''}
    <p class="hint">Reach gold and the scenario ends at once; otherwise your best medal counts when time runs out.</p>
    <div class="actions">${p.def.tutorial ? '<button class="btn" data-a="tut">Show the tutorial</button>' : ''}<button class="btn primary" data-a="ok">Close</button></div>`,
  );
  m.querySelector('[data-a="ok"]')!.addEventListener('click', () => host.closeModal());
  m.querySelector('[data-a="tut"]')?.addEventListener('click', () => host.showTutorial());
}

export function openScenarioEnd(host: ScenarioHost, medal: Medal): void {
  const game = host.game;
  const def = scenarioDef(game.scenario?.id ?? '');
  if (!def) return;
  recordMedal(def.id, medal);
  const won = medal !== 'none';
  const m = host.openModal(
    `<div class="scn-end">${medalIcon(medal, 'big')}
    <h2>${won ? `${medal[0].toUpperCase()}${medal.slice(1)} medal!` : 'No medal this time'}</h2>
    <p>${esc(def.name)} — ${won ? 'well run, Chairman.' : 'the goal was out of reach. Try again with a new plan.'}</p></div>
    <p class="hint">You can keep playing this map as a sandbox.</p>
    <div class="actions"><button class="btn" data-a="more">More scenarios</button><button class="btn primary" data-a="keep">Keep playing</button></div>`,
  );
  m.querySelector('[data-a="keep"]')!.addEventListener('click', () => host.closeModal());
  m.querySelector('[data-a="more"]')!.addEventListener('click', () => openScenarios(host));
}
