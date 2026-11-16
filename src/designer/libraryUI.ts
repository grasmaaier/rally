/** Dialog for the personal design library (save, load, rename, delete). */
import type { Params } from '../core/types';
import { escapeHtml } from './controls';
import { icon } from './icons';
import type { Design, Library } from './library';

export interface LibraryHost {
  lib: Library;
  toolId: string;
  toolName: string;
  params(): Params;
  /** Small JPEG of the current view (may fail: then no thumbnail). */
  thumb(): Promise<string | undefined>;
  load(d: Design): void;
}

const date = (t: number) => {
  try {
    return new Date(t).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
};

export function openLibrary(h: LibraryHost) {
  document.querySelector('.lib-dialog')?.remove();
  const dlg = document.createElement('dialog');
  dlg.className = 'lib-dialog';
  dlg.setAttribute('aria-label', 'Bibliotheek');
  dlg.innerHTML = `
    <div class="lib-head">
      <div><h2>Bibliotheek</h2><small>Je eigen ontwerpen voor ${escapeHtml(h.toolName)}, bewaard in deze browser</small></div>
      <button type="button" class="icon-sm" data-lib="close" aria-label="Sluiten">${icon('close')}</button>
    </div>
    <form class="lib-save" method="dialog">
      <input type="text" name="name" maxlength="80" aria-label="Naam van het ontwerp" placeholder="Naam van dit ontwerp" />
      <button type="submit" class="primary small-primary">${icon('save')}<span>Bewaar</span></button>
    </form>
    <p class="lib-msg" role="status"></p>
    <div class="lib-grid"></div>`;
  document.body.append(dlg);
  const input = dlg.querySelector<HTMLInputElement>('input[name="name"]')!;
  const msg = dlg.querySelector<HTMLElement>('.lib-msg')!;
  const grid = dlg.querySelector<HTMLElement>('.lib-grid')!;
  input.value = `${h.toolName} ${date(Date.now())}`;
  let confirmDel: string | null = null;

  const say = (text: string, bad = false) => {
    msg.textContent = text;
    msg.classList.toggle('bad', bad);
  };

  const render = () => {
    const list = h.lib.list(h.toolId);
    if (!list.length) {
      grid.innerHTML = '<p class="lib-empty">Nog niets bewaard. Geef je ontwerp een naam en klik op Bewaar.</p>';
      return;
    }
    grid.innerHTML = list
      .map(
        (d) => `<article class="lib-card" data-id="${escapeHtml(d.id)}">
          <button type="button" class="lib-thumb" data-lib="load" title="Laden">${d.thumb ? `<img alt="" src="${escapeHtml(d.thumb)}"/>` : icon('lamp')}</button>
          <div class="lib-meta"><b class="lib-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</b><small>${escapeHtml(date(d.updated))}</small></div>
          <div class="lib-actions">
            <button type="button" class="ghost small" data-lib="load">Laden</button>
            <button type="button" class="icon-sm" data-lib="rename" title="Hernoemen" aria-label="Hernoemen">${icon('edit')}</button>
            <button type="button" class="icon-sm${confirmDel === d.id ? ' danger' : ''}" data-lib="delete" title="${confirmDel === d.id ? 'Klik nogmaals om te verwijderen' : 'Verwijderen'}" aria-label="Verwijderen">${icon('trash')}</button>
          </div>
        </article>`,
      )
      .join('');
  };

  dlg.querySelector('form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    say('Bewaren…');
    let thumb: string | undefined;
    try {
      thumb = await h.thumb();
    } catch {
      thumb = undefined;
    }
    const r = h.lib.save({ name: input.value, tool: h.toolId, params: h.params(), thumb });
    if (r.ok) say(r.withoutThumb ? `“${r.design.name}” bewaard (zonder plaatje: de opslag is bijna vol).` : `“${r.design.name}” bewaard.`);
    else say(r.error, true);
    render();
  });

  dlg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-lib]');
    if (!b) {
      if (e.target === dlg) dlg.close();
      return;
    }
    const a = b.dataset.lib;
    if (a === 'close') {
      dlg.close();
      return;
    }
    const id = b.closest<HTMLElement>('.lib-card')?.dataset.id;
    if (!id) return;
    const d = h.lib.get(id);
    if (!d) {
      render();
      return;
    }
    if (a === 'load') {
      h.load(d);
      dlg.close();
    } else if (a === 'delete') {
      if (confirmDel !== id) {
        confirmDel = id;
        render();
        return;
      }
      confirmDel = null;
      say(h.lib.remove(id) ? `“${d.name}” verwijderd.` : 'Verwijderen lukte niet.', false);
      render();
    } else if (a === 'rename') {
      const nameEl = b.closest('.lib-card')!.querySelector<HTMLElement>('.lib-name')!;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'lib-rename';
      inp.maxLength = 80;
      inp.value = d.name;
      inp.setAttribute('aria-label', 'Nieuwe naam');
      nameEl.replaceWith(inp);
      inp.focus();
      inp.select();
      let done = false;
      const commit = (save: boolean) => {
        if (done) return;
        done = true;
        if (save && inp.value.trim() && inp.value !== d.name) say(h.lib.rename(id, inp.value) ? 'Hernoemd.' : 'Hernoemen lukte niet.');
        render();
      };
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          commit(true);
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          commit(false);
        }
      });
      inp.addEventListener('blur', () => commit(true));
    }
  });
  dlg.addEventListener('close', () => dlg.remove());
  render();
  try {
    dlg.showModal();
  } catch {
    dlg.setAttribute('open', '');
  }
}
