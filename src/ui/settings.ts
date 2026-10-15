import { esc } from './dom';
import { yearEndEnabled, setYearEnd } from './finance';
import { prefs, setPrefs, type UiScale } from './prefs';
import type { TrainUiHost } from './trains';

export function openSettings(host: TrainUiHost): void {
  const opt = (v: string, label: string, cur: string) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const pct = (v: number) => Math.round(v * 100);
  const m = host.openModal(`
    <h2>Settings</h2>
    <div class="section">Sound</div>
    <div class="row"><label for="st-music">Music</label><input id="st-music" type="range" min="0" max="100" step="5" value="${pct(prefs.music)}"></div>
    <div class="row"><label for="st-sfx">Sound effects</label><input id="st-sfx" type="range" min="0" max="100" step="5" value="${pct(prefs.sfx)}"></div>
    <label class="check"><input type="checkbox" id="st-mute" ${prefs.muted ? 'checked' : ''}> Mute everything</label>
    <div class="section">Display</div>
    <div class="row"><label for="st-scale">Interface size</label><select id="st-scale">${opt('small', 'Small', prefs.uiScale)}${opt('normal', 'Normal', prefs.uiScale)}${opt('large', 'Large', prefs.uiScale)}</select></div>
    <label class="check"><input type="checkbox" id="st-motion" ${prefs.reducedMotion ? 'checked' : ''}> Reduce motion (no smoke, puffs or floating money)</label>
    <div class="section">Game</div>
    <label class="check"><input type="checkbox" id="st-hints" ${prefs.hints ? 'checked' : ''}> Contextual hints</label>
    <label class="check"><input type="checkbox" id="st-ye" ${yearEndEnabled() ? 'checked' : ''}> Year-end report every January</label>
    <div class="row"><label for="st-auto">Autosave</label><select id="st-auto">${opt('0', 'Off', String(prefs.autosaveMonths))}${opt('1', 'Every month', String(prefs.autosaveMonths))}${opt('3', 'Every 3 months', String(prefs.autosaveMonths))}${opt('12', 'Every year', String(prefs.autosaveMonths))}</select></div>
    <div class="actions"><button class="btn primary" data-act="close">Done</button></div>`);
  const $i = (id: string) => m.querySelector<HTMLInputElement>(id)!;
  $i('#st-music').addEventListener('input', (e) => setPrefs({ music: Number((e.target as HTMLInputElement).value) / 100 }));
  $i('#st-sfx').addEventListener('input', (e) => setPrefs({ sfx: Number((e.target as HTMLInputElement).value) / 100 }));
  $i('#st-mute').addEventListener('change', (e) => setPrefs({ muted: (e.target as HTMLInputElement).checked }));
  m.querySelector<HTMLSelectElement>('#st-scale')!.addEventListener('change', (e) => setPrefs({ uiScale: (e.target as HTMLSelectElement).value as UiScale }));
  $i('#st-motion').addEventListener('change', (e) => setPrefs({ reducedMotion: (e.target as HTMLInputElement).checked }));
  $i('#st-hints').addEventListener('change', (e) => setPrefs({ hints: (e.target as HTMLInputElement).checked }));
  $i('#st-ye').addEventListener('change', (e) => setYearEnd((e.target as HTMLInputElement).checked));
  m.querySelector<HTMLSelectElement>('#st-auto')!.addEventListener('change', (e) => setPrefs({ autosaveMonths: Number((e.target as HTMLSelectElement).value) }));
  m.querySelector('[data-act="close"]')!.addEventListener('click', () => host.closeModal());
}
