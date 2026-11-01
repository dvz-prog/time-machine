'use strict';

/* =====================================================================
   Constantes
   ===================================================================== */
const WB = 'https://web.archive.org';
const CDX = WB + '/cdx/search/cdx';
const FROM = '20250101000000';   // limite inferior fixo
const TO = '20261231235959';     // limite superior fixo
const YEARS = [2025, 2026];
const CAP_LIMIT = 30000;
const PAGE_LIMIT = 300;
const MEDIA_LIMIT = 48;
const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const WEEK = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const PRIVATE = !!(chrome.extension && chrome.extension.inIncognitoContext); // janela anônima
const KIND_LABEL = { page: 'Página', saved: 'Arquivado agora', image: 'Foto', video: 'Vídeo' };

/* =====================================================================
   Utilitários
   ===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k in n && typeof v !== 'object') {
      try { n[k] = v; } catch { n.setAttribute(k, String(v)); }
    } else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

const fmtD = (ts) => `${ts.slice(6, 8)}/${ts.slice(4, 6)}/${ts.slice(0, 4)}`;
const fmtT = (ts) => `${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}`;
const inRange = (ts) => typeof ts === 'string' && ts.length === 14 && ts >= FROM && ts <= TO;
const replay = (ts, url, mod = '') => `${WB}/web/${ts}${mod}/${url}`;
const shortUrl = (u) => u.replace(/^https?:\/\//i, '').replace(/\/$/, '');

function slug(url) {
  return shortUrl(url).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'site';
}

function baseName(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return last || u.hostname;
  } catch { return slug(url); }
}

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'video/mp4': 'mp4', 'video/webm': 'webm',
  'video/ogg': 'ogv', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv'
};

function fileNameFor(item, mime) {
  let name = baseName(item.original).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'arquivo';
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += '.' + (EXT_BY_MIME[mime] || (mime && mime.startsWith('video') ? 'mp4' : 'jpg'));
  return `${item.ts}_${name}`;
}

/* ---------- entrada do usuário ---------- */
function normalizeInput(raw) {
  let s = (raw || '').trim();
  if (!s) throw new Error('Digite um site, por exemplo: youtube.com');
  if (/\s/.test(s)) throw new Error('O endereço não pode ter espaços.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error('Endereço inválido. Exemplo: youtube.com'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Use um endereço http ou https.');
  if (!u.hostname.includes('.')) throw new Error('Endereço inválido. Exemplo: youtube.com');
  u.hash = '';
  return { href: u.href, host: u.hostname.replace(/^www\./, '') };
}

/* =====================================================================
   Rede: Wayback Machine (CDX)
   ===================================================================== */
function buildQuery(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.append(k, v);
  }
  return p.toString();
}

const cdxCache = new Map();   // consultas repetidas voltam na hora

async function fetchText(url, signal, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const sig = (AbortSignal.any && AbortSignal.timeout) ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : signal;
      const res = await fetch(url, { signal: sig });
      if (res.status === 429) last = new Error('O Wayback Machine está limitando as consultas. Aguarde um instante e tente de novo.');
      else if (res.status >= 500) last = new Error(`O Wayback Machine está instável no momento (erro ${res.status}).`);
      else if (!res.ok) throw new Error(`O Wayback Machine respondeu com erro ${res.status}.`);
      else return await res.text();
    } catch (e) {
      if (signal.aborted) throw e;
      if (e.name === 'TimeoutError') last = new Error('O Wayback Machine demorou demais para responder.');
      else if (e instanceof TypeError) last = new Error('Não foi possível falar com o Wayback Machine. Verifique sua conexão.');
      else throw e;
    }
    if (i < tries - 1) await sleep(700);
  }
  throw last;
}

async function cdxOnce(params, signal) {
  const url = CDX + '?' + buildQuery({ output: 'json', from: FROM, to: TO, ...params });
  const cacheable = params.limit !== -1;
  if (cacheable && cdxCache.has(url)) return cdxCache.get(url);
  const text = await fetchText(url, signal);
  let out = [];
  if (text.trim()) {
    let rows;
    try { rows = JSON.parse(text); } catch { throw new Error('Resposta inesperada do Wayback Machine. Tente novamente.'); }
    if (Array.isArray(rows) && rows.length >= 2) {
      const head = rows[0];
      out = rows.slice(1)
        .filter((r) => Array.isArray(r) && r.length === head.length)
        .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
    }
  }
  if (cacheable) {
    if (cdxCache.size > 60) cdxCache.delete(cdxCache.keys().next().value);
    cdxCache.set(url, out);
  }
  return out;
}

// Consulta simples. Com "split" busca 2025 e 2026 ao mesmo tempo (metade do tempo de espera).
async function cdx(params, signal = new AbortController().signal, split = false) {
  if (!split) return cdxOnce(params, signal);
  const parts = await Promise.all([
    cdxOnce({ ...params, from: FROM, to: '20251231235959' }, signal),
    cdxOnce({ ...params, from: '20260101000000', to: TO }, signal)
  ]);
  return parts.flat();
}

function normCaps(rows, includeRedirects) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!inRange(r.timestamp) || !r.original) continue;
    const status = r.statuscode || '';
    if (includeRedirects && !/^[23]\d\d$/.test(status)) continue;
    const key = r.timestamp + '|' + r.original;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ts: r.timestamp, original: r.original, status });
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}

/* =====================================================================
   Estado
   ===================================================================== */
const state = {
  tab: 'captures', query: null, scope: 'page', inc: false,
  capKey: null, captures: [], byDay: new Map(), year: 'all', view: 'calendar', selDay: null,
  listRows: [], listShown: 0, pages: [], pagesOffset: 0, pagesDone: false, pagesLoading: false
};
const media = {};
const ctls = {};
let LIB = [];
let libKind = 'all';

function newCtl(name) {
  if (ctls[name]) ctls[name].abort();
  ctls[name] = new AbortController();
  return ctls[name];
}

/* =====================================================================
   Interface comum
   ===================================================================== */
function showStatus(box, type, msg, retry) {
  box.hidden = false;
  box.className = 'status ' + type;
  box.replaceChildren();
  if (type === 'loading') box.append(el('div', { class: 'spinner' }));
  box.append(el('span', { text: msg }));
  if (retry) box.append(el('button', { class: 'btn small', type: 'button', text: 'Tentar novamente', onclick: retry }));
}
function hideStatus(box) { box.hidden = true; box.replaceChildren(); }

function toast(msg, { type = 'info', sticky = false, action = null, ms = 5500 } = {}) {
  const t = el('div', { class: 'toast ' + type });
  const close = () => t.remove();
  t.append(el('span', { text: msg }));
  if (action) t.append(el('button', { class: 'link', type: 'button', text: action.label, onclick: () => { action.fn(); close(); } }));
  t.append(el('button', { class: 'x', type: 'button', text: '✕', 'aria-label': 'Fechar', onclick: close }));
  $('#toasts').append(t);
  if (!sticky) setTimeout(close, action ? ms * 2 : ms);
  return { close };
}

function downloadBlob(blob, name) {
  const href = URL.createObjectURL(blob);
  const a = el('a', { href, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 15000);
}

async function downloadOriginal(url, filename) {
  const clean = filename.replace(/[^\w.-]+/g, '_').slice(0, 120);
  try {
    await chrome.downloads.download({ url, filename: clean });
  } catch (e) {
    toast('Não foi possível iniciar o download: ' + (e && e.message ? e.message : e), { type: 'error' });
  }
}

async function fetchBlob(url, signal) {
  const res = await fetch(url, { signal, cache: 'force-cache' });
  if (!res.ok) throw new Error(`O Wayback Machine respondeu com erro ${res.status}.`);
  return res.blob();
}

/* =====================================================================
   Biblioteca (chrome.storage.local)
   ===================================================================== */
async function libLoad() {
  if (PRIVATE) { LIB = []; updateLibBadge(); return; }   // anônimo: não lê nem grava o perfil normal
  const r = await chrome.storage.local.get('library');
  LIB = Array.isArray(r.library) ? r.library : [];
  updateLibBadge();
}
async function libSave() {
  if (!PRIVATE) await chrome.storage.local.set({ library: LIB });
  updateLibBadge();
}
function updateLibBadge() {
  const b = $('#libCount');
  b.hidden = LIB.length === 0;
  b.textContent = String(LIB.length);
}
const libId = (kind, ts, original) => `${kind}:${ts}:${original}`;
const libHas = (id) => LIB.some((x) => x.id === id);

async function libToggle(entry) {
  const i = LIB.findIndex((x) => x.id === entry.id);
  if (i >= 0) { LIB.splice(i, 1); toast('Removido da biblioteca.'); }
  else { LIB.unshift({ ...entry, addedAt: Date.now() }); toast('Salvo na biblioteca.'); }
  await libSave();
  if (state.tab === 'library') renderLibrary();
}
function paintStar(btn, id) {
  const on = libHas(id);
  btn.textContent = on ? '★ Salvo' : '☆ Salvar';
  btn.classList.toggle('on', on);
}

function renderLibrary() {
  const grid = $('#libGrid');
  const st = $('#libStatus');
  grid.replaceChildren();
  const term = $('#libFilter').value.trim().toLowerCase();
  const list = LIB.filter((x) => {
    const kindOk = libKind === 'all' || (libKind === 'page' ? (x.kind === 'page' || x.kind === 'saved') : x.kind === libKind);
    return kindOk && (!term || x.original.toLowerCase().includes(term));
  });
  if (!LIB.length) {
    showStatus(st, 'empty', 'Sua biblioteca está vazia. Use “Salvar” em qualquer captura, foto ou vídeo para guardar aqui.');
    return;
  }
  if (!list.length) { showStatus(st, 'empty', 'Nada encontrado com esse filtro.'); return; }
  hideStatus(st);

  for (const it of list) {
    const thumb = el('div', { class: 'lib-thumb' });
    if (it.kind === 'image') {
      const img = el('img', { loading: 'lazy', alt: '', src: replay(it.ts, it.original, 'id_') });
      img.addEventListener('error', () => { img.remove(); thumb.textContent = '▣'; });
      thumb.append(img);
    } else if (it.kind === 'video') thumb.textContent = '▶';
    else {
      let host = '';
      try { host = new URL(it.original).hostname.replace(/^www\./, ''); } catch { /* ignora */ }
      thumb.textContent = (host[0] || '?').toUpperCase();
    }
    const open = () => {
      if (it.kind === 'image') openImage(it);
      else if (it.kind === 'video') openVideo(it);
      else openViewer(it, [it]);
    };
    grid.append(el('div', { class: 'lib-card' },
      thumb,
      el('div', { class: 'lib-body' },
        el('div', { class: 't', title: it.original, text: shortUrl(it.original) }),
        el('div', { class: 'm' }, el('span', { class: 'kind', text: KIND_LABEL[it.kind] || 'Item' }), `${fmtD(it.ts)} ${fmtT(it.ts)} UTC`)),
      el('div', { class: 'lib-act' },
        el('button', { class: 'btn small primary', type: 'button', text: 'Abrir', onclick: open }),
        el('a', { class: 'btn small', target: '_blank', rel: 'noopener', href: replay(it.ts, it.original), text: 'Wayback' }),
        el('button', { class: 'btn small ghost', type: 'button', text: 'Remover', onclick: () => libToggle(it) }))));
  }
}

/* =====================================================================
   Abas
   ===================================================================== */
function setTab(name) {
  state.tab = name;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  for (const t of ['captures', 'photos', 'videos', 'library']) $('#tab-' + t).hidden = t !== name;
  refreshActive();
}
function refreshActive() {
  if (state.tab === 'captures') ensureCaptures();
  else if (state.tab === 'photos') ensureMedia('image');
  else if (state.tab === 'videos') ensureMedia('video');
  else renderLibrary();
}

/* =====================================================================
   Busca
   ===================================================================== */
function doSearch() {
  let q;
  try { q = normalizeInput($('#q').value); } catch (e) { toast(e.message, { type: 'error' }); return; }
  state.query = q;
  state.scope = $('#scope').value;
  state.inc = $('#inc').checked;
  state.capKey = null;
  resetMedia();
  if (!PRIVATE) chrome.storage.local.set({ lastQuery: q.href });
  refreshActive();
  schedulePrefetch();
}

/* =====================================================================
   Capturas
   ===================================================================== */
async function ensureCaptures(force = false) {
  const q = state.query;
  const box = $('#capStatus');
  if (!q) {
    $('#capContent').hidden = true; $('#pagesView').hidden = true;
    showStatus(box, 'hint', 'Digite um site acima para ver as capturas.');
    return;
  }
  const key = `${q.href}|${state.scope}|${state.inc}`;
  if (!force && state.capKey === key) return;
  state.capKey = key;

  const ctl = newCtl('cap');
  $('#capContent').hidden = true; $('#pagesView').hidden = true;
  showStatus(box, 'loading', 'Buscando capturas de 2025–2026…');

  try {
    if (state.scope === 'site') {
      state.pages = []; state.pagesOffset = 0; state.pagesDone = false; state.pagesLoading = false;
      $('#pagesBody').replaceChildren();
      await loadPages(ctl);
      if (ctl.signal.aborted) return;
      if (!state.pages.length) {
        showStatus(box, 'empty', `Nenhuma página de ${q.host} tem captura em 2025–2026.`);
        return;
      }
      hideStatus(box);
      $('#pagesView').hidden = false;
    } else {
      const rows = await cdx({
        url: q.href,
        fl: 'timestamp,original,statuscode',
        filter: state.inc ? [] : ['statuscode:200'],
        limit: Math.ceil(CAP_LIMIT / 2)
      }, ctl.signal, true);
      if (ctl.signal.aborted) return;
      state.captures = normCaps(rows, state.inc);
      state.rawCount = rows.length;
      state.capped = rows.length >= CAP_LIMIT - 1;
      state.byDay = new Map();
      for (const c of state.captures) {
        const k = c.ts.slice(0, 8);
        if (!state.byDay.has(k)) state.byDay.set(k, []);
        state.byDay.get(k).push(c);
      }
      state.selDay = null;
      if (!state.captures.length) {
        showStatus(box, 'empty', `Nenhuma captura de ${shortUrl(q.href)} em 2025–2026. Tente “Todas as páginas do site” ou marque “Incluir redirecionamentos”.`);
        return;
      }
      hideStatus(box);
      $('#capContent').hidden = false;
      renderCaptures();
    }
  } catch (e) {
    if (e.name === 'AbortError' || ctl.signal.aborted) return;
    state.capKey = null;
    showStatus(box, 'error', e.message || 'Erro inesperado ao buscar capturas.', () => ensureCaptures(true));
  }
}

const filteredCaps = () => (state.year === 'all' ? state.captures : state.captures.filter((c) => c.ts.startsWith(state.year)));

function renderCaptures() {
  renderSummary();
  const note = state.capped ? `Mostrando as primeiras ${CAP_LIMIT.toLocaleString('pt-BR')} capturas.` : '';
  $('#capNote').textContent = note;
  $('#calView').hidden = state.view !== 'calendar';
  $('#listView').hidden = state.view !== 'list';
  if (state.view === 'calendar') renderCalendar(); else renderList();
}

function renderSummary() {
  const caps = state.captures;
  const n = (y) => caps.filter((c) => c.ts.startsWith(String(y))).length;
  const stat = (label, value) => el('div', { class: 'stat' }, el('b', { text: String(value) }), el('span', { text: label }));
  const first = caps[0], last = caps[caps.length - 1];
  $('#summary').replaceChildren(
    stat('capturas no total', caps.length.toLocaleString('pt-BR')),
    stat('em 2025', n(2025).toLocaleString('pt-BR')),
    stat('em 2026', n(2026).toLocaleString('pt-BR')),
    stat('primeira captura', fmtD(first.ts)),
    stat('última captura', `${fmtD(last.ts)} ${fmtT(last.ts).slice(0, 5)}`));
}

function renderCalendar() {
  const wrap = $('#calendar');
  wrap.replaceChildren();
  const caps = filteredCaps();
  const years = state.year === 'all' ? YEARS : [Number(state.year)];
  const now = new Date();
  const curY = now.getUTCFullYear(), curM = now.getUTCMonth();

  for (const y of years) {
    const yCount = caps.filter((c) => c.ts.startsWith(String(y))).length;
    const months = el('div', { class: 'months' });
    for (let m = 0; m < 12; m++) {
      if (y === curY && m > curM) continue;
      const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
      const total = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const days = el('div', { class: 'days' }, WEEK.map((w) => el('div', { class: 'wd', text: w })));
      for (let i = 0; i < first; i++) days.append(el('div'));
      let mCount = 0;
      for (let d = 1; d <= total; d++) {
        const key = `${y}${pad(m + 1)}${pad(d)}`;
        const list = state.byDay.get(key);
        if (!list) { days.append(el('div', { class: 'd', text: String(d) })); continue; }
        mCount += list.length;
        const lvl = list.length === 1 ? 1 : list.length <= 3 ? 2 : list.length <= 10 ? 3 : 4;
        days.append(el('button', {
          class: `d l${lvl}`, type: 'button', text: String(d), dataset: { day: key },
          title: `${list.length} ${list.length === 1 ? 'captura' : 'capturas'}`,
          onclick: () => selectDay(key)
        }));
      }
      months.append(el('div', { class: 'month' },
        el('h3', {}, MONTHS[m], el('small', { text: mCount ? `${mCount.toLocaleString('pt-BR')}` : 'sem capturas' })),
        days));
    }
    wrap.append(el('div', { class: 'year-block' },
      el('div', { class: 'year-head' }, el('h2', { text: String(y) }), el('span', { text: `${yCount.toLocaleString('pt-BR')} capturas` })),
      months));
  }

  const keys = [...new Set(caps.map((c) => c.ts.slice(0, 8)))];
  if (!state.selDay || !keys.includes(state.selDay)) state.selDay = keys[keys.length - 1] || null;
  selectDay(state.selDay);
}

function selectDay(key) {
  state.selDay = key;
  $$('#calendar .d.sel').forEach((b) => b.classList.remove('sel'));
  const btn = key && $(`#calendar button[data-day="${key}"]`);
  if (btn) btn.classList.add('sel');

  const panel = $('#dayPanel');
  panel.replaceChildren();
  if (!key) { panel.append(el('div', { class: 'sub', text: 'Nenhuma captura neste ano.' })); return; }

  const list = (state.byDay.get(key) || []).filter((c) => state.year === 'all' || c.ts.startsWith(state.year));
  const viewList = filteredCaps();
  const MAX = 500;
  panel.append(
    el('h3', { text: `${key.slice(6, 8)}/${key.slice(4, 6)}/${key.slice(0, 4)}` }),
    el('div', { class: 'sub', text: `${list.length} ${list.length === 1 ? 'captura' : 'capturas'} neste dia (UTC)` }));
  const box = el('div', { class: 'shots' });
  for (const c of list.slice(0, MAX)) {
    box.append(el('button', { class: 'shot', type: 'button', onclick: () => openViewer(c, viewList) },
      el('span', { class: 'time', text: fmtT(c.ts) }),
      c.status && c.status !== '200' ? el('span', { class: 'badge', text: c.status }) : null,
      el('span', { class: 'path', text: shortUrl(c.original) })));
  }
  panel.append(box);
  if (list.length > MAX) panel.append(el('div', { class: 'sub', text: `Mostrando as primeiras ${MAX} deste dia.` }));
}

function renderList() {
  state.listRows = [...filteredCaps()].reverse();
  state.listShown = 0;
  $('#listBody').replaceChildren();
  moreList();
}
function moreList() {
  const body = $('#listBody');
  const viewList = filteredCaps();
  const slice = state.listRows.slice(state.listShown, state.listShown + 150);
  for (const c of slice) {
    body.append(el('tr', {},
      el('td', { text: fmtD(c.ts) }),
      el('td', { text: fmtT(c.ts) }),
      el('td', {}, c.status === '200' || !c.status ? 'OK' : el('span', { class: 'badge', text: c.status })),
      el('td', { class: 'url', title: c.original, text: shortUrl(c.original) }),
      el('td', { class: 'act' }, el('button', { class: 'btn small primary', type: 'button', text: 'Ver captura', onclick: () => openViewer(c, viewList) }))));
  }
  state.listShown += slice.length;
  $('#listMore').hidden = state.listShown >= state.listRows.length;
}

/* ---------- modo "todas as páginas do site" ---------- */
async function loadPages(ctl) {
  if (state.pagesLoading || state.pagesDone) return;
  state.pagesLoading = true;
  try {
    const rows = await cdx({
      url: state.query.host, matchType: 'domain',
      fl: 'timestamp,original,mimetype,statuscode',
      filter: ['statuscode:200', 'mimetype:text/html'],
      collapse: 'urlkey', limit: PAGE_LIMIT, offset: state.pagesOffset
    }, ctl.signal);
    if (ctl.signal.aborted) return;
    state.pagesOffset += rows.length;
    if (rows.length < PAGE_LIMIT) state.pagesDone = true;
    const known = new Set(state.pages.map((p) => p.original));
    const fresh = normCaps(rows, false).filter((p) => !known.has(p.original));
    state.pages.push(...fresh);
    const body = $('#pagesBody');
    for (const p of fresh) {
      body.append(el('tr', {},
        el('td', { class: 'url', title: p.original, text: shortUrl(p.original) }),
        el('td', { text: `${fmtD(p.ts)} ${fmtT(p.ts)}` }),
        el('td', { class: 'act' },
          el('button', { class: 'btn small primary', type: 'button', text: 'Ver capturas', onclick: () => { $('#q').value = p.original; $('#scope').value = 'page'; doSearch(); } }),
          ' ',
          el('button', { class: 'btn small', type: 'button', text: 'Abrir', onclick: () => openViewer(p, [p]) }))));
    }
    $('#pagesMore').hidden = state.pagesDone;
  } finally {
    state.pagesLoading = false;
  }
}

/* =====================================================================
   Fotos e vídeos
   ===================================================================== */
const mediaUI = {
  image: { grid: '#photoGrid', status: '#photoStatus', more: '#photoMore', noun: 'foto', mime: 'image/.*' },
  video: { grid: '#videoGrid', status: '#videoStatus', more: '#videoMore', noun: 'vídeo', mime: 'video/.*' }
};

function resetMedia() {
  for (const k of ['image', 'video']) {
    media[k] = { items: [], offset: 0, done: false, loading: false, key: null, seen: new Set() };
    $(mediaUI[k].grid).replaceChildren();
    $(mediaUI[k].more).hidden = true;
    if (ctls[k]) ctls[k].abort();
  }
}

function ensureMedia(kind) {
  const ui = mediaUI[kind], q = state.query, S = media[kind];
  if (!q) { showStatus($(ui.status), 'hint', `Digite um site acima para ver ${kind === 'image' ? 'as fotos' : 'os vídeos'} arquivados.`); return; }
  if (S.key === q.host) return Promise.resolve();
  S.key = q.host;
  return loadMedia(kind);
}

// Depois que as capturas aparecem, já deixa fotos e vídeos carregando em segundo plano
let prefetchTimer = 0;
function schedulePrefetch() {
  clearTimeout(prefetchTimer);
  const q = state.query;
  prefetchTimer = setTimeout(async () => {
    for (const k of ['image', 'video']) {
      if (state.query !== q) return;
      try { await ensureMedia(k); } catch { /* ignora */ }
    }
  }, 1500);
}

async function loadMedia(kind) {
  const S = media[kind], ui = mediaUI[kind];
  if (S.loading || S.done) return;
  S.loading = true;
  const st = $(ui.status), grid = $(ui.grid), more = $(ui.more);
  const first = S.items.length === 0;
  const ctl = newCtl(kind);
  if (first) showStatus(st, 'loading', `Buscando ${kind === 'image' ? 'fotos' : 'vídeos'} arquivados em 2025–2026…`);
  more.disabled = true;
  try {
    const rows = await cdx({
      url: state.query.host, matchType: 'domain',
      fl: 'timestamp,original,mimetype,statuscode',
      filter: ['statuscode:200', 'mimetype:' + ui.mime],
      collapse: 'urlkey', limit: MEDIA_LIMIT, offset: S.offset
    }, ctl.signal);
    if (media[kind] !== S || ctl.signal.aborted) return;
    S.offset += rows.length;
    if (rows.length < MEDIA_LIMIT) S.done = true;
    const fresh = [];
    for (const r of rows) {
      if (!inRange(r.timestamp) || !r.original || S.seen.has(r.original)) continue;
      S.seen.add(r.original);
      fresh.push({ ts: r.timestamp, original: r.original, mime: r.mimetype || '' });
    }
    S.items.push(...fresh);
    hideStatus(st);
    for (const it of fresh) grid.append(kind === 'image' ? imageTile(it) : videoTile(it));
    if (!S.items.length) {
      showStatus(st, 'empty', `Nenhum${kind === 'image' ? 'a foto' : ' vídeo'} de ${state.query.host} foi arquivado em 2025–2026. Só aparecem arquivos hospedados no próprio domínio do site.`);
    }
    more.hidden = S.done;
  } catch (e) {
    if (media[kind] !== S || e.name === 'AbortError') return;
    if (first) {
      S.key = null;
      showStatus(st, 'error', e.message || 'Erro ao buscar.', () => { S.key = null; ensureMedia(kind); });
    } else toast(e.message || 'Erro ao carregar mais.', { type: 'error' });
  } finally {
    if (media[kind] === S) S.loading = false;
    more.disabled = false;
  }
}

function imageTile(it) {
  const btn = el('button', { class: 'tile', type: 'button', title: it.original, onclick: () => openImage(it) });
  const img = el('img', { loading: 'lazy', decoding: 'async', fetchpriority: 'low', alt: '', src: replay(it.ts, it.original, 'id_') });
  img.addEventListener('error', () => btn.remove());
  img.addEventListener('load', () => { if (img.naturalWidth < 32 && img.naturalHeight < 32) btn.remove(); });
  btn.append(img, el('span', { class: 'cap', text: `${fmtD(it.ts)}` }));
  return btn;
}
function videoTile(it) {
  return el('button', { class: 'tile vtile', type: 'button', title: it.original, onclick: () => openVideo(it) },
    el('div', { class: 'play', text: '▶' }),
    el('div', { class: 'name', text: baseName(it.original) }),
    el('div', { class: 'meta', text: `${fmtD(it.ts)} ${fmtT(it.ts)} UTC` }));
}

/* =====================================================================
   Painel de exportação (qualquer qualidade)
   ===================================================================== */
function createExportPanel({ allowOriginal = false, onOriginal = null, nameBase = () => 'captura', hint = 'Aguardando…' } = {}) {
  let src = null, timer = 0, token = 0, last = null;

  const fmt = el('select', {},
    allowOriginal ? el('option', { value: 'orig', text: 'Original (sem recompressão)' }) : null,
    el('option', { value: 'png', text: 'PNG (sem perdas)' }),
    el('option', { value: 'jpeg', text: 'JPEG' }),
    el('option', { value: 'webp', text: 'WebP' }));
  fmt.value = allowOriginal ? 'orig' : 'png';

  const qual = el('input', { type: 'range', min: '1', max: '100', value: '92' });
  const qout = el('output', { text: '92' });
  const scale = el('select', {}, [25, 50, 75, 100, 150, 200, 300].map((v) => el('option', { value: String(v), text: v + '%' })));
  scale.value = '100';
  const info = el('div', { class: 'est', text: hint });
  const dl = el('button', { class: 'btn primary', type: 'button', text: 'Baixar', disabled: true });

  const syncControls = () => {
    const f = fmt.value;
    qual.disabled = !(f === 'jpeg' || f === 'webp');
    scale.disabled = f === 'orig';
  };

  function render(w, h, f, quality) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (f === 'jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(src.source, 0, 0, w, h);
    const mime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[f];
    return new Promise((res, rej) => c.toBlob(
      (b) => (b ? res(b) : rej(new Error('O navegador não conseguiu gerar essa imagem.'))), mime, f === 'png' ? undefined : quality));
  }

  async function compute() {
    last = null;
    if (!src) { dl.disabled = true; return; }
    const f = fmt.value;
    if (f === 'orig') {
      info.className = 'est';
      info.textContent = 'Arquivo original, exatamente como o Wayback Machine guardou. É a maior qualidade disponível.';
      dl.disabled = false;
      return;
    }
    const s = Number(scale.value) / 100;
    const w = Math.max(1, Math.round(src.w * s)), h = Math.max(1, Math.round(src.h * s));
    if (w > 16000 || h > 16000 || w * h > 150e6) {
      info.className = 'est bad';
      info.textContent = `${w}×${h} é grande demais para o navegador. Escolha uma escala menor.`;
      dl.disabled = true;
      return;
    }
    const my = ++token;
    info.className = 'est';
    info.textContent = 'Calculando tamanho…';
    dl.disabled = true;
    try {
      const blob = await render(w, h, f, Number(qual.value) / 100);
      if (my !== token) return;
      const ext = f === 'jpeg' ? 'jpg' : f;
      last = { blob, w, h, ext };
      info.textContent = `${w}×${h} px, aproximadamente ${(blob.size / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} KB.`;
      dl.disabled = false;
    } catch (e) {
      if (my !== token) return;
      info.className = 'est bad';
      info.textContent = e.message || 'Não foi possível gerar a imagem.';
    }
  }

  const schedule = () => { clearTimeout(timer); timer = setTimeout(compute, 250); };

  fmt.addEventListener('change', () => { syncControls(); schedule(); });
  qual.addEventListener('input', () => { qout.textContent = qual.value; schedule(); });
  scale.addEventListener('change', schedule);
  dl.addEventListener('click', async () => {
    if (fmt.value === 'orig') { if (onOriginal) onOriginal(); return; }
    clearTimeout(timer);
    if (!last) await compute();
    if (last) downloadBlob(last.blob, `${nameBase()}_${last.w}x${last.h}.${last.ext}`);
  });

  syncControls();
  const root = el('div', { class: 'exp' },
    el('label', {}, 'Formato', fmt),
    el('label', {}, 'Qualidade da compressão', el('div', { class: 'qrow' }, qual, qout)),
    el('label', {}, 'Tamanho', scale),
    info, dl);

  return {
    el: root,
    setSource(s) { src = s; clearTimeout(timer); compute(); },
    setHint(msg, bad = false) { src = null; last = null; dl.disabled = true; info.className = 'est' + (bad ? ' bad' : ''); info.textContent = msg; }
  };
}

/* =====================================================================
   Visualizador de páginas
   ===================================================================== */
let diagGot = false;
function showDiag(text) {
  const box = el('div', { style: 'position:fixed;inset:8% 10%;z-index:99999;background:#fff;color:#111;border:2px solid #c00;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;box-shadow:0 10px 40px rgba(0,0,0,.5)' });
  const ta = el('textarea', { readonly: true, style: 'flex:1;font:12px monospace;width:100%' });
  ta.value = text;
  box.append(el('strong', { text: 'Diagnóstico da captura. Copie tudo e cole no chat.' }), ta,
    el('div', {}, el('button', { class: 'btn primary', type: 'button', text: 'Copiar', onclick: async () => { ta.select(); try { await navigator.clipboard.writeText(text); toast('Copiado.'); } catch { document.execCommand('copy'); } } }),
      ' ', el('button', { class: 'btn', type: 'button', text: 'Fechar', onclick: () => box.remove() })));
  document.body.append(box);
  ta.select();
}

const V = { list: [], idx: 0, item: null, loaderTimer: 0, js: true };
let shotPanel = null;

function openViewer(item, list) {
  V.list = list && list.length ? list : [item];
  let i = V.list.indexOf(item);
  if (i < 0) i = V.list.findIndex((x) => x.ts === item.ts && x.original === item.original);
  V.idx = i < 0 ? 0 : i;
  $('#viewer').hidden = false;
  document.body.classList.add('noscroll');
  showViewerItem();
}

function showViewerItem() {
  const it = V.list[V.idx];
  V.item = it;
  // o JavaScript desligado automaticamente volta ao normal ao mudar de captura
  if (V.autoOff && V.autoOff !== it.ts + '|' + it.original) { V.js = true; V.autoOff = null; }
  $('#vUrl').textContent = shortUrl(it.original);
  $('#vUrl').title = it.original;
  $('#vDate').textContent = `${fmtD(it.ts)} às ${fmtT(it.ts)} UTC`;
  $('#vPos').textContent = V.list.length > 1 ? `${V.idx + 1} de ${V.list.length}` : '';
  $('#vPrev').disabled = V.idx <= 0;
  $('#vNext').disabled = V.idx >= V.list.length - 1;
  $('#vOpen').href = replay(it.ts, it.original);
  paintStar($('#vStar'), libId('page', it.ts, it.original));
  $('#shotPop').hidden = true;

  const loader = $('#vLoader');
  loader.hidden = false;
  clearTimeout(V.loaderTimer);
  V.loaderTimer = setTimeout(() => { loader.hidden = true; }, 30000);
  const frame = $('#vFrame');
  frame.setAttribute('sandbox', V.js
    ? 'allow-scripts allow-same-origin allow-forms allow-popups'
    : 'allow-same-origin allow-forms allow-popups');
  $('#vJs').textContent = V.js ? 'JavaScript: ligado' : 'JavaScript: desligado';
  frame.src = replay(it.ts, it.original, 'if_');
}

function closeViewer() {
  $('#viewer').hidden = true;
  $('#shotPop').hidden = true;
  clearTimeout(V.loaderTimer);
  $('#vFrame').src = 'about:blank';
  if ($('#lightbox').hidden) document.body.classList.remove('noscroll');
}

function viewerStep(d) {
  const n = V.idx + d;
  if (n < 0 || n >= V.list.length) return;
  V.idx = n;
  showViewerItem();
}

const nextFrames = (n) => new Promise((res) => { const f = () => (--n <= 0 ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });

async function takeScreenshot() {
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: ['<all_urls>'] }); } catch { granted = false; }
  if (!granted) {
    toast('Para tirar o print, permita o acesso quando o navegador perguntar. Ele é usado só para capturar a tela desta aba.', { type: 'error' });
    return;
  }
  const pop = $('#shotPop');
  const frame = $('#vFrame');
  pop.hidden = true;
  await nextFrames(3);
  await sleep(150);
  try {
    let dataUrl;
    try { dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' }); }
    catch { dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' }); }
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const r = frame.getBoundingClientRect();
    const sx = img.naturalWidth / window.innerWidth;
    const sy = img.naturalHeight / window.innerHeight;
    const w = Math.max(1, Math.round(r.width * sx)), h = Math.max(1, Math.round(r.height * sy));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, r.left * sx, r.top * sy, r.width * sx, r.height * sy, 0, 0, w, h);
    shotPanel.setSource({ source: c, w, h });
    pop.hidden = false;
  } catch (e) {
    pop.hidden = false;
    shotPanel.setHint('Não foi possível capturar: ' + (e && e.message ? e.message : e), true);
  }
}

/* =====================================================================
   Visualizador de foto / vídeo
   ===================================================================== */
const LB = { item: null, kind: null, objUrl: null, ctl: null };

function lbPrepare(item, kind) {
  closeLightboxContent();
  LB.item = item; LB.kind = kind;
  $('#lbName').textContent = baseName(item.original);
  $('#lbName').title = item.original;
  $('#lbDate').textContent = `${fmtD(item.ts)} às ${fmtT(item.ts)} UTC`;
  $('#lbOpen').href = replay(item.ts, item.original);
  paintStar($('#lbStar'), libId(kind, item.ts, item.original));
  $('#lightbox').hidden = false;
  document.body.classList.add('noscroll');
  $('#lbStage').replaceChildren(el('div', { class: 'status loading' }, el('div', { class: 'spinner' }), el('span', { text: 'Carregando…' })));
  $('#lbSide').replaceChildren();
}
function closeLightboxContent() {
  if (LB.ctl) LB.ctl.abort();
  LB.ctl = null;
  const v = $('#lbStage video');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  if (LB.objUrl) { URL.revokeObjectURL(LB.objUrl); LB.objUrl = null; }
}
function closeLightbox() {
  closeLightboxContent();
  $('#lightbox').hidden = true;
  $('#lbStage').replaceChildren();
  $('#lbSide').replaceChildren();
  if ($('#viewer').hidden) document.body.classList.remove('noscroll');
}

async function openImage(item) {
  lbPrepare(item, 'image');
  const url = replay(item.ts, item.original, 'id_');
  const panel = createExportPanel({
    allowOriginal: true,
    onOriginal: () => downloadOriginal(url, fileNameFor(item, item.mime || 'image/jpeg')),
    nameBase: () => fileNameFor(item, 'image/png').replace(/\.[a-z0-9]+$/i, ''),
    hint: 'Carregando imagem…'
  });
  $('#lbSide').append(
    el('h4', { text: 'Salvar foto' }),
    el('div', { class: 'kv', text: item.original }),
    panel.el);
  panel.setHint('Carregando imagem…');

  const ctl = new AbortController();
  LB.ctl = ctl;
  try {
    const blob = await fetchBlob(url, ctl.signal);
    if (LB.item !== item) return;
    const objUrl = URL.createObjectURL(blob);
    LB.objUrl = objUrl;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('O arquivo não é uma imagem válida.')); img.src = objUrl; });
    if (LB.item !== item) return;
    $('#lbStage').replaceChildren(el('img', { src: objUrl, alt: baseName(item.original) }));
    panel.setSource({ source: img, w: img.naturalWidth || 1024, h: img.naturalHeight || 1024 });
  } catch (e) {
    if (e.name === 'AbortError' || LB.item !== item) return;
    $('#lbStage').replaceChildren(el('div', { class: 'status error' }, el('span', { text: 'Não foi possível carregar essa foto. O Wayback Machine pode não ter guardado o arquivo.' })));
    panel.setHint(e.message || 'Falha ao carregar.', true);
  }
}

function openVideo(item) {
  lbPrepare(item, 'video');
  const url = replay(item.ts, item.original, 'id_');
  const video = el('video', { controls: true, autoplay: true, playsInline: true, preload: 'metadata', src: url });
  video.addEventListener('error', () => {
    $('#lbStage').replaceChildren(el('div', { class: 'status error' }, el('span', { text: 'Este vídeo não pôde ser reproduzido. Pode estar incompleto no arquivo ou em um formato que o navegador não abre. Tente baixar o original.' })));
  });

  const panel = createExportPanel({
    nameBase: () => fileNameFor(item, 'image/png').replace(/\.[a-z0-9]+$/i, '') + '_quadro',
    hint: 'Pause no ponto desejado e clique em “Capturar quadro atual”.'
  });
  panel.setHint('Pause no ponto desejado e clique em “Capturar quadro atual”.');

  const grab = el('button', { class: 'btn', type: 'button', text: 'Capturar quadro atual', onclick: () => grabFrame(video, url, panel) });
  $('#lbStage').replaceChildren(video);
  $('#lbSide').append(
    el('h4', { text: 'Salvar vídeo' }),
    el('div', { class: 'kv', text: item.original }),
    el('button', { class: 'btn primary', type: 'button', text: 'Baixar vídeo original', onclick: () => downloadOriginal(url, fileNameFor(item, item.mime || 'video/mp4')) }),
    el('div', { class: 'kv', text: 'O Wayback Machine guarda uma única versão de cada vídeo, então o original é a maior qualidade possível. Para imagens estáticas, capture um quadro e escolha o formato e a qualidade.' }),
    grab,
    panel.el);
}

async function grabFrame(video, url, panel) {
  if (!video.videoWidth) { toast('O vídeo ainda não carregou. Aguarde o primeiro quadro aparecer.', { type: 'error' }); return; }
  const draw = (v) => {
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0);
    ctx.getImageData(0, 0, 1, 1); // lança SecurityError se o canvas estiver contaminado
    return c;
  };
  try {
    const c = draw(video);
    panel.setSource({ source: c, w: c.width, h: c.height });
    return;
  } catch (e) {
    if (e.name !== 'SecurityError') { toast('Não foi possível capturar o quadro.', { type: 'error' }); return; }
  }
  // Plano B: baixar o vídeo para a memória e capturar de uma cópia local
  const note = toast('Preparando captura: baixando o vídeo para a memória…', { sticky: true });
  const t = video.currentTime;
  let objUrl = null;
  try {
    const blob = await fetchBlob(url, new AbortController().signal);
    objUrl = URL.createObjectURL(blob);
    const copy = el('video', { muted: true, preload: 'auto', src: objUrl });
    await new Promise((res, rej) => {
      copy.onloadeddata = res;
      copy.onerror = () => rej(new Error('Não foi possível ler o vídeo.'));
    });
    if (Math.abs(copy.currentTime - t) > 0.01) await new Promise((res) => { copy.onseeked = res; copy.currentTime = t; });
    const c = draw(copy);
    panel.setSource({ source: c, w: c.width, h: c.height });
  } catch (e) {
    toast(e.message || 'Não foi possível capturar o quadro.', { type: 'error' });
  } finally {
    note.close();
    if (objUrl) URL.revokeObjectURL(objUrl);
  }
}

/* =====================================================================
   Arquivar agora (Save Page Now)
   ===================================================================== */
async function saveNow() {
  let q;
  try { q = normalizeInput($('#q').value); } catch (e) { toast(e.message, { type: 'error' }); return; }
  const btn = $('#btnSave');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Arquivando…';
  const wait = toast('Enviando ao Wayback Machine. Isso pode levar de 20 segundos a 2 minutos.', { sticky: true });
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(new DOMException('Tempo esgotado', 'TimeoutError')), 150000);
  try {
    const res = await fetch(`${WB}/save/${q.href}`, { signal: ac.signal, credentials: 'include', cache: 'no-store' });
    if (res.status === 429) throw new Error('Limite de arquivamentos atingido. Aguarde alguns minutos e tente de novo.');
    const match = (s) => (s || '').match(/\/web\/(\d{14})/);
    let ts = (match(res.url) || match(res.headers.get('content-location')) || [])[1];
    if (!ts) {
      if (!res.ok) throw new Error(`O Wayback Machine não conseguiu arquivar este endereço (erro ${res.status}). Alguns sites bloqueiam o arquivamento.`);
      const rows = await cdx({ url: q.href, fl: 'timestamp,original', filter: ['statuscode:200'], limit: -1 });
      if (rows.length) ts = rows[rows.length - 1].timestamp;
    }
    if (!ts) throw new Error('O arquivamento foi enviado, mas a captura ainda não apareceu. Tente buscar de novo em alguns minutos.');
    const item = { ts, original: q.href };
    if (!libHas(libId('saved', ts, q.href))) {
      LIB.unshift({ id: libId('saved', ts, q.href), kind: 'saved', ts, original: q.href, addedAt: Date.now() });
      await libSave();
    }
    state.capKey = null;
    wait.close();
    toast(inRange(ts)
      ? 'Site arquivado e salvo na sua biblioteca. Pode levar algumas horas para aparecer no calendário.'
      : 'Site arquivado, mas fora do período 2025–2026.', { action: { label: 'Ver captura', fn: () => openViewer(item, [item]) } });
  } catch (e) {
    wait.close();
    const msg = (e && e.name === 'TimeoutError') ? 'O arquivamento demorou demais. Tente de novo em alguns minutos.'
      : (e instanceof TypeError ? 'Não foi possível falar com o Wayback Machine. Verifique sua conexão.' : (e.message || 'Erro ao arquivar.'));
    toast(msg, { type: 'error' });
  } finally {
    clearTimeout(timeout);
    btn.disabled = false;
    btn.textContent = 'Arquivar agora';
  }
}

/* =====================================================================
   Inicialização
   ===================================================================== */
function bind() {
  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); doSearch(); });
  $('#scope').addEventListener('change', () => { if (state.query) doSearch(); });
  $('#inc').addEventListener('change', () => { if (state.query) doSearch(); });
  $('#btnSave').addEventListener('click', saveNow);
  $$('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  $('#yearSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.year = b.dataset.year;
    $$('#yearSeg button').forEach((x) => x.classList.toggle('on', x === b));
    if (state.captures.length) renderCaptures();
  });
  $('#viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.view = b.dataset.view;
    $$('#viewSeg button').forEach((x) => x.classList.toggle('on', x === b));
    if (state.captures.length) renderCaptures();
  });
  $('#listMore').addEventListener('click', moreList);
  $('#pagesMore').addEventListener('click', async () => {
    const b = $('#pagesMore'); b.disabled = true;
    try { await loadPages(newCtl('cap')); } catch (e) { if (e.name !== 'AbortError') toast(e.message, { type: 'error' }); }
    b.disabled = false;
  });
  for (const k of ['image', 'video']) $(mediaUI[k].more).addEventListener('click', () => loadMedia(k));

  $('#libSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    libKind = b.dataset.kind;
    $$('#libSeg button').forEach((x) => x.classList.toggle('on', x === b));
    renderLibrary();
  });
  $('#libFilter').addEventListener('input', renderLibrary);

  // visualizador de páginas
  $('#vClose').addEventListener('click', closeViewer);
  $('#vPrev').addEventListener('click', () => viewerStep(-1));
  $('#vNext').addEventListener('click', () => viewerStep(1));
  $('#vStar').addEventListener('click', async () => {
    const it = V.item; if (!it) return;
    await libToggle({ id: libId('page', it.ts, it.original), kind: 'page', ts: it.ts, original: it.original });
    paintStar($('#vStar'), libId('page', it.ts, it.original));
  });
  $('#vHtml').addEventListener('click', () => {
    const it = V.item; if (!it) return;
    downloadOriginal(replay(it.ts, it.original, 'id_'), `${slug(it.original)}_${it.ts}.html`);
  });
  $('#vDiag').addEventListener('click', () => {
    const w = $('#vFrame').contentWindow;
    if (!w) return;
    toast('Coletando informações da captura…');
    w.postMessage({ tmDiag: 1 }, WB);
    setTimeout(() => { if (!diagGot) toast('A captura não respondeu. Espere ela carregar e tente de novo.', { type: 'error' }); }, 4000);
    diagGot = false;
  });
  window.addEventListener('message', (e) => {
    if (e.origin === WB && e.data && e.data.tmHome) {
      const it = V.item;
      if (!it) return;
      let isRoot = false;
      try { const u = new URL(it.original); isRoot = u.pathname === '/' || u.pathname === ''; } catch { /* ignora */ }
      if (isRoot) return;                                   // a página pedida é mesmo a inicial
      const key = it.ts + '|' + it.original;
      if (V.js && V.retried !== key) {
        // muitas vezes é o JavaScript da própria página mandando para a tela de login
        V.retried = key;
        V.js = false;
        V.autoOff = key;
        toast('Esta página foi redirecionada para a tela de login. Tentando abrir sem JavaScript…');
        showViewerItem();
      } else if (!V.js) {
        toast('O erome guardou esta captura já como tela de login. Tente outra data com as setas ◀ ▶.', { type: 'error', ms: 9000 });
      }
      return;
    }
    if (e.origin !== WB || !e.data || !e.data.tmDiagResult) return;
    diagGot = true;
    showDiag(JSON.stringify(e.data.tmDiagResult, null, 1));
  });
  $('#vJs').addEventListener('click', () => { V.js = !V.js; if (V.item) showViewerItem(); });
  $('#vFrame').addEventListener('load', () => { clearTimeout(V.loaderTimer); $('#vLoader').hidden = true; });

  shotPanel = createExportPanel({
    nameBase: () => `${slug(V.item.original)}_${V.item.ts}_print`,
    hint: 'Clique em “Capturar agora”. O print mostra exatamente o que está visível no quadro.'
  });
  shotPanel.setHint('Clique em “Capturar agora”. O print mostra exatamente o que está visível no quadro.');
  $('#shotPop').append(
    el('h4', { text: 'Tirar print da captura' }),
    el('button', { class: 'btn', type: 'button', text: 'Capturar agora', onclick: takeScreenshot }),
    shotPanel.el);
  $('#vShot').addEventListener('click', () => { $('#shotPop').hidden = !$('#shotPop').hidden; });

  // visualizador de foto/vídeo
  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lbStar').addEventListener('click', async () => {
    const it = LB.item; if (!it) return;
    await libToggle({ id: libId(LB.kind, it.ts, it.original), kind: LB.kind, ts: it.ts, original: it.original });
    paintStar($('#lbStar'), libId(LB.kind, it.ts, it.original));
  });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
    if (e.key === 'Escape') {
      if (!$('#lightbox').hidden) closeLightbox();
      else if (!$('#shotPop').hidden) $('#shotPop').hidden = true;
      else if (!$('#viewer').hidden) closeViewer();
    } else if (!typing && !$('#viewer').hidden && $('#lightbox').hidden) {
      if (e.key === 'ArrowLeft') viewerStep(-1);
      else if (e.key === 'ArrowRight') viewerStep(1);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (!PRIVATE && area === 'local' && changes.library) {
      LIB = Array.isArray(changes.library.newValue) ? changes.library.newValue : [];
      updateLibBadge();
      if (state.tab === 'library') renderLibrary();
    }
  });
}

async function boot() {
  resetMedia();
  bind();
  const libReady = libLoad();
  const param = new URLSearchParams(location.search).get('url');
  if (param) {
    $('#q').value = param;
    doSearch();
  } else {
    const r = PRIVATE ? {} : await chrome.storage.local.get('lastQuery');
    if (r.lastQuery) $('#q').value = r.lastQuery.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }
  if (PRIVATE) toast('Modo anônimo: seu histórico de busca e sua biblioteca não são gravados. Itens salvos valem só até fechar esta aba.', { ms: 9000 });
  if (!matchMedia('(pointer: coarse)').matches) $('#q').focus();
  await libReady;
}

boot();
