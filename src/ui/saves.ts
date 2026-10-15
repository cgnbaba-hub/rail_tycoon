import type { Game } from '../sim/game';
import { loadGame, saveGame, type SaveFile, type SaveMeta } from '../sim/save';
import { formatDate } from '../sim/time';
import { esc } from './dom';
import { fmtMoney } from './tools';
import { confirmModal, type TrainUiHost } from './trains';

/**
 * Save slots in IndexedDB (falls back to localStorage), plus export to / import from a
 * JSON file.
 */

const DB = 'iron-baron';
const STORE = 'saves';
const LS_PREFIX = 'ironBaron.save.';

interface Stored {
  name: string;
  meta: SaveMeta;
  json: string;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listSaves(): Promise<Array<{ name: string; meta: SaveMeta }>> {
  const db = await openDb();
  let all: Stored[] = [];
  if (db) all = await tx<Stored[]>(db, 'readonly', (s) => s.getAll() as IDBRequest<Stored[]>);
  else {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(LS_PREFIX)) all.push(JSON.parse(localStorage.getItem(k)!) as Stored);
    }
  }
  return all.map((x) => ({ name: x.name, meta: x.meta })).sort((a, b) => b.meta.savedAt - a.meta.savedAt);
}

export async function writeSave(name: string, game: Game): Promise<void> {
  const file = saveGame(game, formatDate(game.date));
  const rec: Stored = { name, meta: file.meta, json: JSON.stringify(file) };
  const db = await openDb();
  if (db) await tx(db, 'readwrite', (s) => s.put(rec));
  else localStorage.setItem(LS_PREFIX + name, JSON.stringify(rec));
}

export async function readSave(name: string): Promise<Game> {
  const db = await openDb();
  const rec = db ? await tx<Stored | undefined>(db, 'readonly', (s) => s.get(name) as IDBRequest<Stored | undefined>) : (JSON.parse(localStorage.getItem(LS_PREFIX + name) ?? 'null') as Stored | null);
  if (!rec) throw new Error('That save no longer exists.');
  return loadGame(JSON.parse(rec.json));
}

export async function deleteSave(name: string): Promise<void> {
  const db = await openDb();
  if (db) await tx(db, 'readwrite', (s) => s.delete(name));
  else localStorage.removeItem(LS_PREFIX + name);
}

/** Download the game as a JSON file. */
export function exportGame(game: Game): void {
  const file: SaveFile = saveGame(game, formatDate(game.date));
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  const a = document.createElement('a');
  const safe = game.company.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  a.href = URL.createObjectURL(blob);
  a.download = `iron-baron-${safe}-${game.date.year}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

/** Ask for a JSON file and load it. */
export function importGame(): Promise<Game> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) return reject(new Error('No file chosen.'));
      f.text()
        .then((t) => resolve(loadGame(JSON.parse(t))))
        .catch((e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
    });
    input.click();
  });
}

export interface SavesHost extends TrainUiHost {
  startGame(game: Game): void;
}

const fmtSaved = (t: number) => new Date(t).toLocaleString();

export async function openSaves(host: SavesHost): Promise<void> {
  const game = host.game;
  const saves = await listSaves().catch(() => []);
  const rows = saves
    .map(
      (s) => `<tr><td><b>${esc(s.name)}</b><br><small>${esc(fmtSaved(s.meta.savedAt))}</small></td><td>${esc(s.meta.company)}<br><small>${esc(s.meta.date)} · seed ${s.meta.seed} · ${s.meta.size}²</small></td><td>${fmtMoney(s.meta.netWorth)}</td>
        <td class="right"><button class="btn small primary" data-load="${esc(s.name)}">Load</button> <button class="btn small" data-del="${esc(s.name)}" aria-label="Delete ${esc(s.name)}">×</button></td></tr>`,
    )
    .join('');
  const m = host.openModal(
    `<h2>Save & load</h2>
    <div class="row"><label for="save-name">Save as</label><div class="seg"><input id="save-name" value="${esc(game.company.name)} ${game.date.year}" maxlength="40" autocomplete="off"><button class="btn primary" data-act="save">Save</button></div></div>
    <div class="section">Saved games</div>
    ${rows ? `<div class="scroll saves"><table class="table compact"><thead><tr><th>Name</th><th>Railroad</th><th>Your net worth</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="hint">No saved games yet.</p>'}
    <p class="hint">Saves stay in this browser. Export a game to keep it as a file or move it to another computer. Loading clears the undo history. <kbd>Ctrl+S</kbd> quick-saves.</p>
    <div class="actions"><button class="btn" data-act="export">Export to file</button><button class="btn" data-act="import">Import file…</button><button class="btn" data-act="close">Close</button></div>`,
    'wide',
  );
  const name = () => (m.querySelector<HTMLInputElement>('#save-name')!.value.trim() || 'Save').slice(0, 40);
  m.querySelector('[data-act="close"]')!.addEventListener('click', () => host.closeModal());
  m.querySelector('[data-act="save"]')!.addEventListener('click', () => {
    const n = name();
    const go = () =>
      writeSave(n, game)
        .then(() => host.toast(`Saved “${n}”`, 'info'))
        .catch((e: unknown) => host.toast(`Could not save: ${String(e)}`, 'error'))
        .finally(() => void openSaves(host));
    if (saves.some((s) => s.name === n)) void confirmModal(host, `Overwrite “${n}”?`, 'A saved game with this name already exists.', 'Overwrite').then((yes) => (yes ? go() : void openSaves(host)));
    else void go();
  });
  m.querySelectorAll<HTMLElement>('[data-load]').forEach((b) =>
    b.addEventListener('click', () => {
      readSave(b.dataset.load!)
        .then((g) => {
          host.closeModal();
          host.startGame(g);
          host.toast(`Loaded “${b.dataset.load}”`, 'info');
        })
        .catch((e: unknown) => host.toast(e instanceof Error ? e.message : String(e), 'error'));
    }),
  );
  m.querySelectorAll<HTMLElement>('[data-del]').forEach((b) =>
    b.addEventListener('click', () => {
      void confirmModal(host, `Delete “${b.dataset.del}”?`, 'This cannot be undone.', 'Delete').then((yes) => {
        if (yes) void deleteSave(b.dataset.del!).then(() => openSaves(host));
        else void openSaves(host);
      });
    }),
  );
  m.querySelector('[data-act="export"]')!.addEventListener('click', () => exportGame(game));
  m.querySelector('[data-act="import"]')!.addEventListener('click', () => {
    importGame()
      .then((g) => {
        host.closeModal();
        host.startGame(g);
        host.toast('Game imported', 'info');
      })
      .catch((e: unknown) => host.toast(e instanceof Error ? e.message : String(e), 'error'));
  });
}
