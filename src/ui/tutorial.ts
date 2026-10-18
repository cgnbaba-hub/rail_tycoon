import type { Game } from '../sim/game';
import { townsConnected } from '../sim/scenario';
import { $, esc } from './dom';
import { prefs } from './prefs';

/**
 * The interactive tutorial: a short list of steps, each finished by doing it in the game.
 * A card at the bottom of the screen shows the current step and highlights the tool to use.
 */

interface Step {
  text: (g: Game) => string;
  /** Rail button to highlight. */
  tool?: string;
  done: (g: Game, seen: Set<string>) => boolean;
}

const town = (g: Game, k: number) => g.world.cities[g.scenario?.towns[k] ?? 0]?.name ?? 'the town';
const mine = (g: Game) => g.world.liveStations().filter((s) => s.owner === g.company.id);

const STEPS: Step[] = [
  {
    text: (g) => `Welcome, Chairman! You run <b>${esc(g.company.name)}</b>. Your goal: link <b>${esc(town(g, 0))}</b> and <b>${esc(town(g, 1))}</b> and make money. Pan with right-drag or WASD, zoom with the wheel. The game is paused — everything works while paused.`,
    done: (_g, seen) => seen.has('next'),
  },
  {
    text: (g) => `Press <kbd>B</kbd> (or the station button) and click near <b>${esc(town(g, 0))}</b>. The outline shows which houses the station serves — cover as many as you can.`,
    tool: 'station',
    done: (g) => mine(g).some((s) => s.cityId === g.scenario?.towns[0]),
  },
  {
    text: (g) => `Now build a station near <b>${esc(town(g, 1))}</b> the same way.`,
    tool: 'station',
    done: (g) => mine(g).some((s) => s.cityId === g.scenario?.towns[1]),
  },
  {
    text: () => 'Press <kbd>T</kbd> and drag from one station to the other. The route is planned for you; watch the cost and the grades in the panel, then release to build.',
    tool: 'track',
    done: (g) => !!g.scenario && townsConnected(g, g.scenario.towns[0], g.scenario.towns[1]),
  },
  {
    text: () => 'Press <kbd>F</kbd> and choose <b>New train</b>. Pick an engine, keep the suggested cars and buy it.',
    tool: 'trains',
    done: (g) => g.trains.trains.some((t) => t.owner === g.company.id),
  },
  {
    text: () => 'Press <kbd>Space</kbd> to let time run (<kbd>1</kbd>–<kbd>4</kbd> set the speed). Wait for your train to deliver its first load.',
    done: (g) => g.company.revenueIn(g.year) + g.company.revenueIn(g.year - 1) > 0,
  },
  {
    text: () => 'Money! Press <kbd>M</kbd> to see your books, bonds and share price.',
    tool: 'finance',
    done: (_g, seen) => seen.has('finance'),
  },
  {
    text: () => 'The advisor (<kbd>U</kbd>) tells you what needs attention, overlays (<kbd>J</kbd>) show where cargo is. Have a look at the advisor.',
    tool: 'advisor',
    done: (_g, seen) => seen.has('advisor'),
  },
  {
    text: () => 'That’s the basics! Add more trains and stations to raise your yearly revenue for a medal — the goal chip at the top shows your progress. <kbd>H</kbd> lists every key.',
    done: (_g, seen) => seen.has('next'),
  },
];

export class Tutorial {
  private step = 0;
  private readonly seen = new Set<string>();
  private el: HTMLElement;
  private lastHtml = '';
  /** The player pressed Skip (rather than finishing). */
  skipped = false;

  constructor() {
    this.el = document.getElementById('tutorial') ?? document.createElement('div');
    this.el.id = 'tutorial';
    this.el.setAttribute('role', 'status');
    if (!this.el.parentElement) $('#app').appendChild(this.el);
    this.el.hidden = false;
  }

  /** Something happened in the UI (window opened, Next pressed). */
  note(what: string): void {
    this.seen.add(what);
  }

  get finished(): boolean {
    return this.step >= STEPS.length;
  }

  /** Advance when the current step is done; redraw the card. Returns the tool to highlight. */
  update(game: Game): string | null {
    while (this.step < STEPS.length && STEPS[this.step].done(game, this.seen)) {
      this.step++;
      this.seen.delete('next');
    }
    if (this.finished) {
      this.close();
      return null;
    }
    const s = STEPS[this.step];
    const last = this.step === STEPS.length - 1;
    const needsNext = this.step === 0 || last;
    const html = `<div class="tut-head"><b>Tutorial</b> <small>step ${this.step + 1} of ${STEPS.length}</small><span class="grow"></span><button class="btn small" data-tut="skip">Skip</button></div>
      <p>${s.text(game)}</p>${needsNext ? `<div class="actions"><button class="btn small primary" data-tut="next">${last ? 'Finish' : 'Next'}</button></div>` : ''}`;
    if (html !== this.lastHtml) {
      this.lastHtml = html;
      this.el.innerHTML = html;
      this.el.querySelector('[data-tut="next"]')?.addEventListener('click', () => this.note('next'));
      this.el.querySelector('[data-tut="skip"]')?.addEventListener('click', () => {
        this.skipped = true;
        this.step = STEPS.length;
        this.close();
      });
    }
    return s.tool ?? null;
  }

  close(): void {
    this.el.hidden = true;
    this.el.innerHTML = '';
  }
}

// ---------------------------------------------------------------------------------------
// Contextual hints (shown once each, can be turned off in the settings)
// ---------------------------------------------------------------------------------------

const HINT_KEY = 'ironBaron.hintsSeen';

const HINTS: Record<string, string> = {
  station: 'Stations collect cargo from everything inside the dashed outline. B again cycles depot / station / terminal, R rotates.',
  track: 'Drag from A to B: the route avoids steep grades where it can. V switches to double track, which lets trains pass anywhere.',
  firstTrain: 'Trains load what waits at a station and deliver where it is wanted. Watch the +$ pop-ups; click a train to see its profit.',
  yearEnd: 'Each January the year-end report sums up your railroad. From the third year your shareholders vote on you.',
  rivals: 'Rival barons build their own railways and trade shares — O shows who owns what.',
};

function seenHints(): Set<string> {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(HINT_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** Show a one-time hint (returns its text, or null if already seen or hints are off). */
export function hint(id: keyof typeof HINTS): string | null {
  if (!prefs.hints) return null;
  const seen = seenHints();
  if (seen.has(id)) return null;
  seen.add(id);
  try {
    window.localStorage.setItem(HINT_KEY, JSON.stringify([...seen]));
  } catch {
    /* storage blocked */
  }
  return HINTS[id];
}

export function resetHints(): void {
  try {
    window.localStorage.removeItem(HINT_KEY);
  } catch {
    /* storage blocked */
  }
}
