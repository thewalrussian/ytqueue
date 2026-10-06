import * as db from './db.js';
import * as yt from './yt.js';
import * as gdrive from './gdrive.js';
import { merge, canonical, emptyDeleted } from './merge.js';
import config from './config.js';

const DAY = 864e5;
const PAGE = 120;
const SYNCED = ['channels', 'videos', 'queues', 'deleted'];

const state = {
  settings: {
    apiKey: '',
    clientId: '',
    syncEnabled: false,
    initialDays: 14,
    openIn: 'player', // 'player' | 'youtube'
    markOnOpen: false,
    oldestFirst: true,
    lastRefresh: 0,
    lastSync: 0,
  },
  channels: {}, // id -> { id, title, handle, thumb, since, addedAt }
  videos: {},   // id -> { id, title, channelId, publishedAt, duration, kind, liveState, scheduledStart, actualStart, status, statusAt }
  queues: [],   // [{ id, name, channelIds, updatedAt }]
  deleted: emptyDeleted(), // tombstones for sync: kind -> { id: deletedAt }
};

const ui = { queueId: 'all', tab: 'video', filter: 'new', limit: PAGE, refreshing: false, progress: '', syncError: '' };

const $ = sel => document.querySelector(sel);
const view = $('#view');

// ---------- persistence ----------

async function load() {
  for (const key of ['settings', ...SYNCED]) {
    const value = await db.get(key);
    if (value !== undefined) state[key] = key === 'settings' ? { ...state.settings, ...value } : value;
  }
  state.settings.apiKey ||= config.apiKey;
  state.settings.clientId ||= config.clientId;
  try {
    Object.assign(ui, JSON.parse(localStorage.getItem('ytq-ui') || '{}'), { limit: PAGE, refreshing: false });
  } catch { /* storage unavailable */ }
}

function save(...keys) {
  if (keys.some(k => SYNCED.includes(k))) scheduleSync();
  return Promise.all(keys.map(k => db.set(k, state[k])));
}

function saveUi() {
  try {
    const { queueId, tab, filter } = ui;
    localStorage.setItem('ytq-ui', JSON.stringify({ queueId, tab, filter }));
  } catch { /* storage unavailable */ }
}

// ---------- helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => Math.random().toString(36).slice(2, 10);
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
function fmtRelative(iso) {
  if (!iso) return '';
  const diff = (new Date(iso) - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const units = [[60, 'second', 1], [3600, 'minute', 60], [86400, 'hour', 3600], [604800, 'day', 86400], [2629800, 'week', 604800], [31557600, 'month', 2629800], [Infinity, 'year', 31557600]];
  for (const [limit, unit, div] of units) {
    if (abs < limit) return rtf.format(Math.round(diff / div), unit);
  }
}

const dtf = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDateTime = iso => (iso ? dtf.format(new Date(iso)) : '');

function errMessage(e) {
  switch (e.reason) {
    case 'quotaExceeded': return 'исчерпана дневная квота YouTube API (сбросится в полночь по тихоокеанскому времени)';
    case 'keyInvalid': return 'неверный API-ключ';
    case 'accessNotConfigured': return 'YouTube Data API v3 не включён в проекте Google Cloud';
    case 'forbidden':
    case 'ipRefererBlocked': return 'ключ не разрешён для этого адреса: проверьте ограничения ключа';
  }
  if (/API key not valid/i.test(e.message)) return 'неверный API-ключ';
  if (e instanceof TypeError) return 'нет соединения с сетью';
  return e.message;
}

async function pool(items, size, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

let toastTimer;
function toast(message, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(message)}</span>${undo ? '<button class="btn small">Отменить</button>' : ''}`;
  el.hidden = false;
  if (undo) el.querySelector('button').onclick = () => { el.hidden = true; undo(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), undo ? 6000 : 3500);
}

// ---------- data operations ----------

function queueChannelSet() {
  const q = state.queues.find(q => q.id === ui.queueId);
  return q ? new Set(q.channelIds) : null;
}

function videosInQueue() {
  const set = queueChannelSet();
  return Object.values(state.videos).filter(v => !set || set.has(v.channelId));
}

function setStatus(ids, status) {
  const prev = ids.map(id => [id, state.videos[id].status, state.videos[id].statusAt]);
  const now = Date.now();
  for (const id of ids) Object.assign(state.videos[id], { status, statusAt: now });
  save('videos');
  render();
  const n = ids.length;
  const label = { watched: 'Просмотрено', ignored: 'Скрыто', new: 'Возвращено в очередь' }[status];
  toast(n > 1 ? `${label}: ${n}` : label, () => {
    for (const [id, s, at] of prev) if (state.videos[id]) Object.assign(state.videos[id], { status: s, statusAt: at });
    save('videos');
    render();
  });
}

function setProgress(text) {
  ui.progress = text;
  const el = $('#progress');
  if (el) el.textContent = text;
}

/** Fetches new uploads for the given channels (all by default) and refreshes the state of streams. */
async function refresh(channels = Object.values(state.channels)) {
  if (ui.refreshing) return;
  const key = state.settings.apiKey;
  if (!key) {
    toast('Сначала укажите API-ключ');
    location.hash = '#/settings';
    return;
  }
  if (!channels.length) return;
  const full = channels.length === Object.keys(state.channels).length;
  ui.refreshing = true;
  $('#refreshBtn').classList.add('spin');
  try {
    const found = new Map();
    let done = 0;
    setProgress(`Обновление: 0 / ${channels.length}`);
    await pool(channels, 6, async ch => {
      const base = ch.id.slice(2);
      const [videos, lives] = await Promise.all([
        yt.playlistItems(key, 'UULF' + base),
        yt.playlistItems(key, 'UULV' + base),
      ]);
      const known = id => state.videos[id] || state.deleted.videos[id];
      for (const it of videos) {
        if (!known(it.id) && it.publishedAt >= ch.since) found.set(it.id, { channelId: ch.id, kind: 'video' });
      }
      for (const it of lives) {
        if (!known(it.id)) found.set(it.id, { channelId: ch.id, kind: 'live', old: it.publishedAt < ch.since });
      }
      setProgress(`Обновление: ${++done} / ${channels.length}`);
    });

    // Streams that haven't ended yet need their state re-checked.
    const recheck = full ? Object.values(state.videos).filter(v => v.kind === 'live' && v.liveState !== 'ended').map(v => v.id) : [];
    setProgress('Загрузка подробностей…');
    const details = new Map((await yt.videoDetails(key, [...found.keys(), ...recheck])).map(d => [d.id, d]));

    let added = 0;
    for (const [id, f] of found) {
      const d = details.get(id);
      // Old stream records are skipped; old upcoming/ongoing streams are still relevant.
      if (!d || (f.old && d.liveState === 'ended')) continue;
      state.videos[id] = { ...d, channelId: f.channelId, kind: f.kind, status: 'new', statusAt: Date.now() };
      added++;
    }
    for (const id of recheck) {
      if (!state.videos[id]) continue; // removed by a sync meanwhile
      const d = details.get(id);
      if (d) {
        Object.assign(state.videos[id], d);
      } else { // cancelled or deleted
        delete state.videos[id];
        state.deleted.videos[id] = Date.now();
      }
    }
    if (full) state.settings.lastRefresh = Date.now();
    await save('videos', 'deleted', 'settings');
    toast(added ? `Новых: ${added}` : 'Ничего нового');
  } catch (e) {
    toast('Ошибка: ' + errMessage(e));
  } finally {
    ui.refreshing = false;
    ui.progress = '';
    $('#refreshBtn').classList.remove('spin');
    render();
  }
}

function addChannels(list) {
  const since = new Date(Date.now() - state.settings.initialDays * DAY).toISOString();
  const added = [];
  for (const ch of list) {
    if (state.channels[ch.id]) continue;
    state.channels[ch.id] = { ...ch, since, addedAt: Date.now() };
    added.push(state.channels[ch.id]);
  }
  save('channels');
  return added;
}

function removeChannel(id) {
  const now = Date.now();
  delete state.channels[id];
  state.deleted.channels[id] = now;
  for (const [vid, v] of Object.entries(state.videos)) if (v.channelId === id) delete state.videos[vid];
  for (const q of state.queues) {
    if (q.channelIds.includes(id)) Object.assign(q, { channelIds: q.channelIds.filter(c => c !== id), updatedAt: now });
  }
  save('channels', 'videos', 'queues', 'deleted');
  render();
}

// ---------- sync ----------

const syncData = () => ({
  channels: state.channels,
  videos: state.videos,
  queues: state.queues,
  deleted: state.deleted,
  apiKey: state.settings.apiKey,
});

const syncFields = d => ({
  channels: d.channels || {},
  videos: d.videos || {},
  queues: d.queues || [],
  deleted: { ...emptyDeleted(), ...d.deleted },
  apiKey: d.apiKey || '',
});

let syncRunning = null;
let syncAgain = false;
let syncTimer;

function scheduleSync() {
  if (!state.settings.syncEnabled) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(), 3000);
}

function syncStatus() {
  const s = state.settings;
  if (!s.syncEnabled) return '';
  if (syncRunning) return 'синхронизация…';
  if (ui.syncError) return 'синхронизация: ' + ui.syncError;
  if (!gdrive.hasToken()) return 'синхронизация: нажмите ⟳, чтобы войти в Google';
  return s.lastSync ? 'синхронизировано ' + fmtRelative(new Date(s.lastSync).toISOString()) : '';
}

function showSyncStatus() {
  const el = $('#syncStatus');
  if (el) el.textContent = syncStatus();
}

/**
 * Downloads the copy from Drive, merges it with local data and uploads the result.
 * With interactive=true it may open the Google sign-in popup, so it must be called
 * directly from a click handler (the popup is requested before the first await).
 */
function sync({ interactive = false } = {}) {
  const s = state.settings;
  if (!s.syncEnabled || !s.clientId) return Promise.resolve();
  if (syncRunning) {
    syncAgain = true;
    return syncRunning;
  }
  if (!gdrive.hasToken() && !interactive) {
    showSyncStatus();
    return Promise.resolve();
  }
  clearTimeout(syncTimer);
  syncRunning = (async () => {
    try {
      if (!gdrive.hasToken()) await gdrive.authorize(s.clientId);
      showSyncStatus();
      const text = await gdrive.pull();
      const remote = text ? JSON.parse(text) : null;
      // Merge synchronously right after download, so no local change can slip in between.
      const local = syncData();
      const merged = remote ? merge(local, remote) : local;
      const localChanged = canonical(merged) !== canonical(local);
      if (localChanged) {
        Object.assign(state, { channels: merged.channels, videos: merged.videos, queues: merged.queues, deleted: merged.deleted });
        s.apiKey = merged.apiKey;
        await Promise.all([...SYNCED, 'settings'].map(k => db.set(k, state[k])));
      }
      if (!remote || canonical(merged) !== canonical(syncFields(remote))) {
        await gdrive.push(JSON.stringify({ app: 'ytqueue', version: 2, ...merged }));
      }
      s.lastSync = Date.now();
      ui.syncError = '';
      await db.set('settings', s);
      // Don't wipe a form the user is filling in.
      if (localChanged && !location.hash.startsWith('#/queues/')) render();
    } catch (e) {
      ui.syncError = e instanceof gdrive.AuthError ? e.message : errMessage(e);
    } finally {
      syncRunning = null;
      showSyncStatus();
      if (syncAgain) {
        syncAgain = false;
        scheduleSync();
      }
    }
  })();
  showSyncStatus();
  return syncRunning;
}

function openVideo(id) {
  const v = state.videos[id];
  const url = `https://www.youtube.com/watch?v=${id}`;
  if (state.settings.markOnOpen && v.status === 'new') {
    Object.assign(v, { status: 'watched', statusAt: Date.now() });
    save('videos');
    render();
  }
  if (state.settings.openIn === 'youtube') {
    window.open(url, '_blank', 'noopener');
    return;
  }
  $('#playerFrame').src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
  $('#playerFrame').referrerPolicy = 'strict-origin-when-cross-origin';
  $('#playerTitle').textContent = v.title;
  $('#playerYt').href = url;
  $('#playerWatched').hidden = v.status !== 'new';
  $('#playerWatched').dataset.id = id;
  $('#player').hidden = false;
}

function closePlayer() {
  $('#player').hidden = true;
  $('#playerFrame').src = 'about:blank';
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- views ----------

function card(v) {
  const ch = state.channels[v.channelId] || {};
  let badge = '';
  if (v.kind === 'live' && v.liveState === 'live') badge = '<span class="badge live">● В ЭФИРЕ</span>';
  else if (v.kind === 'live' && v.liveState === 'upcoming') badge = `<span class="badge soon">${esc(fmtDateTime(v.scheduledStart))}</span>`;
  else if (v.duration) badge = `<span class="badge">${fmtDuration(v.duration)}</span>`;

  let when = fmtRelative(v.publishedAt);
  if (v.liveState === 'upcoming') when = 'начало ' + fmtRelative(v.scheduledStart);
  else if (v.liveState === 'live') when = 'начат ' + fmtRelative(v.actualStart);
  else if (v.kind === 'live' && v.actualStart) when = fmtRelative(v.actualStart);

  const actions = v.status === 'new'
    ? `<button class="btn small primary" data-act="watched" data-id="${v.id}">✓ Просмотрено</button>
       <button class="btn small" data-act="ignore" data-id="${v.id}">✕ Игнорировать</button>`
    : `<button class="btn small" data-act="restore" data-id="${v.id}">↺ Вернуть в очередь</button>`;

  return `<article class="card">
    <button class="thumb" data-act="open" data-id="${v.id}" aria-label="Смотреть">
      <img loading="lazy" src="https://i.ytimg.com/vi/${v.id}/mqdefault.jpg" alt="">${badge}
    </button>
    <div class="meta">
      ${ch.thumb ? `<img class="avatar" loading="lazy" src="${esc(ch.thumb)}" alt="">` : '<span class="avatar"></span>'}
      <div class="meta-text">
        <a class="title" href="https://www.youtube.com/watch?v=${v.id}" data-act="open" data-id="${v.id}">${esc(v.title)}</a>
        <div class="sub">${esc(ch.title || '')} · ${esc(when)}</div>
      </div>
    </div>
    <div class="actions">${actions}</div>
  </article>`;
}

function grid(list) {
  const shown = list.slice(0, ui.limit);
  return `<div class="grid">${shown.map(card).join('')}</div>` +
    (list.length > shown.length ? `<div class="center"><button class="btn" data-act="more">Показать ещё (${list.length - shown.length})</button></div>` : '');
}

function emptyState(text, link) {
  return `<div class="empty"><p>${text}</p>${link || ''}</div>`;
}

function renderQueue() {
  const s = state.settings;
  if (!s.apiKey) return emptyState('Чтобы начать, укажите ключ YouTube Data API.', '<a class="btn primary" href="#/settings">Открыть настройки</a>');
  if (!Object.keys(state.channels).length) return emptyState('Пока нет ни одного канала.', '<a class="btn primary" href="#/channels">Добавить каналы</a>');
  if (ui.queueId !== 'all' && !state.queues.some(q => q.id === ui.queueId)) ui.queueId = 'all';

  const all = videosInQueue();
  const count = kind => all.filter(v => v.kind === kind && v.status === 'new').length;
  const list = all.filter(v => v.kind === ui.tab && v.status === ui.filter);
  const t = v => new Date(v.kind === 'live' ? v.actualStart || v.scheduledStart || v.publishedAt : v.publishedAt).getTime();
  const dir = s.oldestFirst ? 1 : -1;
  if (ui.filter === 'new') list.sort((a, b) => (t(a) - t(b)) * dir);
  else list.sort((a, b) => b.statusAt - a.statusAt);

  const seg = (name, items) => `<div class="seg">${items.map(([val, label]) =>
    `<button class="${ui[name] === val ? 'on' : ''}" data-act="set" data-key="${name}" data-val="${val}">${label}</button>`).join('')}</div>`;

  let body;
  if (!list.length) {
    body = emptyState(ui.filter === 'new' ? 'Очередь пуста 🎉' : 'Здесь пока ничего нет.');
  } else if (ui.tab === 'live' && ui.filter === 'new') {
    const live = list.filter(v => v.liveState === 'live');
    const upcoming = list.filter(v => v.liveState === 'upcoming').sort((a, b) => new Date(a.scheduledStart) - new Date(b.scheduledStart));
    const ended = list.filter(v => v.liveState === 'ended');
    body = [
      live.length && `<h2 class="section">🔴 Сейчас в эфире</h2>${grid(live)}`,
      upcoming.length && `<h2 class="section">Запланированы</h2>${grid(upcoming)}`,
      ended.length && `<h2 class="section">Записи трансляций</h2>${grid(ended)}`,
    ].filter(Boolean).join('');
  } else {
    body = grid(list);
  }

  const lastRefresh = s.lastRefresh ? `обновлено ${fmtRelative(new Date(s.lastRefresh).toISOString())}` : 'ещё не обновлялось';
  return `
    <div class="toolbar">
      <select class="input" data-change="queue" aria-label="Очередь">
        <option value="all">Все подписки</option>
        ${state.queues.map(q => `<option value="${q.id}" ${q.id === ui.queueId ? 'selected' : ''}>${esc(q.name)}</option>`).join('')}
      </select>
      ${seg('tab', [['video', `Видео <b>${count('video')}</b>`], ['live', `Трансляции <b>${count('live')}</b>`]])}
      ${seg('filter', [['new', 'В очереди'], ['watched', 'Просмотренные'], ['ignored', 'Игнор']])}
      <div class="spacer"></div>
      ${ui.filter === 'new' ? `
        <button class="btn small" data-act="sort">${s.oldestFirst ? '↑ Сначала старые' : '↓ Сначала новые'}</button>
        ${list.length ? '<button class="btn small" data-act="markAll">✓ Всё просмотрено</button>' : ''}` : ''}
    </div>
    <div class="status"><span id="progress">${esc(ui.progress || lastRefresh)}</span>
      ${s.syncEnabled ? ` · <span id="syncStatus">${esc(syncStatus())}</span>` : ''}</div>
    ${body}`;
}

function renderChannels() {
  const channels = Object.values(state.channels).sort((a, b) => a.title.localeCompare(b.title));
  const newCount = id => Object.values(state.videos).filter(v => v.channelId === id && v.status === 'new').length;
  return `
    <h1>Каналы <span class="muted">${channels.length}</span></h1>
    <form class="row gap wrap" data-form="addChannel">
      <input class="input grow" name="q" placeholder="Ссылка на канал, @handle или ID канала" required>
      <button class="btn primary">Добавить</button>
    </form>
    <p class="hint">
      Импорт всех подписок: скачайте <a href="https://takeout.google.com/" target="_blank" rel="noopener">Google Takeout</a>
      → «YouTube и YouTube Music» → только «подписки». Затем выберите файл <code>subscriptions.csv</code>:
      <label class="btn small">Импорт CSV<input type="file" accept=".csv,text/csv" data-change="importCsv" hidden></label>
    </p>
    <div class="list">
      ${channels.map(ch => `
        <div class="list-row">
          ${ch.thumb ? `<img class="avatar" loading="lazy" src="${esc(ch.thumb)}" alt="">` : '<span class="avatar"></span>'}
          <div class="grow">
            <a href="https://www.youtube.com/channel/${ch.id}" target="_blank" rel="noopener">${esc(ch.title)}</a>
            <div class="sub">${esc(ch.handle)} · в очереди: ${newCount(ch.id)}</div>
          </div>
          <button class="btn small danger" data-act="removeChannel" data-id="${ch.id}">Удалить</button>
        </div>`).join('') || '<p class="muted">Каналов пока нет.</p>'}
    </div>`;
}

function renderQueues() {
  return `
    <div class="row between">
      <h1>Свои очереди</h1>
      <a class="btn primary" href="#/queues/new">+ Новая очередь</a>
    </div>
    <p class="hint">Очередь — это набор каналов. Выберите её на вкладке «Очередь», чтобы видеть видео только с этих каналов.</p>
    <div class="list">
      ${state.queues.map(q => `
        <div class="list-row">
          <div class="grow"><b>${esc(q.name)}</b>
            <div class="sub">${q.channelIds.length} ${plural(q.channelIds.length, 'канал', 'канала', 'каналов')}</div>
          </div>
          <button class="btn small" data-act="openQueue" data-id="${q.id}">Открыть</button>
          <a class="btn small" href="#/queues/${q.id}">Изменить</a>
        </div>`).join('') || '<p class="muted">Очередей пока нет.</p>'}
    </div>`;
}

function renderQueueEditor(id) {
  const q = state.queues.find(q => q.id === id) || { id: 'new', name: '', channelIds: [] };
  const selected = new Set(q.channelIds);
  const channels = Object.values(state.channels).sort((a, b) => a.title.localeCompare(b.title));
  return `
    <h1>${q.id === 'new' ? 'Новая очередь' : 'Изменить очередь'}</h1>
    <form data-form="saveQueue" data-id="${q.id}">
      <input class="input wide" name="name" placeholder="Название" value="${esc(q.name)}" required>
      <div class="row gap wrap" style="margin:12px 0">
        <input class="input grow" type="search" placeholder="Поиск канала" data-input="filterChannels">
        <button type="button" class="btn small" data-act="checkAll" data-val="1">Выбрать все</button>
        <button type="button" class="btn small" data-act="checkAll" data-val="">Снять все</button>
      </div>
      <div class="list checks">
        ${channels.map(ch => `
          <label class="list-row" data-title="${esc(ch.title.toLowerCase())}">
            <input type="checkbox" name="ch" value="${ch.id}" ${selected.has(ch.id) ? 'checked' : ''}>
            ${ch.thumb ? `<img class="avatar" loading="lazy" src="${esc(ch.thumb)}" alt="">` : '<span class="avatar"></span>'}
            <span class="grow">${esc(ch.title)}</span>
          </label>`).join('') || '<p class="muted">Сначала добавьте каналы.</p>'}
      </div>
      <div class="row gap sticky-bar">
        <button class="btn primary">Сохранить</button>
        <a class="btn" href="#/queues">Отмена</a>
        <div class="spacer"></div>
        ${q.id !== 'new' ? `<button type="button" class="btn danger" data-act="deleteQueue" data-id="${q.id}">Удалить</button>` : ''}
      </div>
    </form>`;
}

function renderSettings() {
  const s = state.settings;
  const total = Object.keys(state.videos).length;
  return `
    <h1>Настройки</h1>
    <section class="panel">
      <h2>Ключ YouTube Data API</h2>
      <input class="input wide" type="password" autocomplete="off" data-setting="apiKey" value="${esc(s.apiKey)}" placeholder="AIza…">
      <ol class="hint">
        <li>Откройте <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud Console</a> и создайте проект.</li>
        <li>Включите <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">YouTube Data API v3</a>.</li>
        <li>В разделе <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Credentials</a> создайте API key.
          Желательно ограничить его: API restrictions → YouTube Data API v3, Website restrictions → адрес, где открыто приложение.</li>
      </ol>
      <p class="hint">Бесплатная квота — 10 000 единиц в сутки. Одно обновление тратит примерно 2–3 единицы на канал.
        Ключ хранится на этом устройстве, а при включённой синхронизации ещё и в вашем Google Drive.</p>
    </section>
    <section class="panel">
      <h2>Синхронизация через Google Drive</h2>
      <p class="hint">Каналы, очереди и отметки хранятся в скрытой папке приложения в вашем Google Drive
        и объединяются между устройствами. Приложению доступна только эта папка, остальные файлы Drive ему не видны.</p>
      ${s.syncEnabled ? `
        <p><b>Включена.</b> <span class="muted" id="syncStatus">${esc(syncStatus())}</span></p>
        <div class="row gap wrap">
          <button class="btn primary" data-act="syncNow">Синхронизировать сейчас</button>
          <button class="btn" data-act="syncOff">Отключить</button>
        </div>` : `
        <input class="input wide" data-setting="clientId" value="${esc(s.clientId)}" placeholder="OAuth Client ID: …apps.googleusercontent.com">
        <ol class="hint">
          <li>В том же проекте Google Cloud включите <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">Google Drive API</a>.</li>
          <li>Настройте <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">экран согласия OAuth</a>:
            тип External, в разделе Audience добавьте свой Google-аккаунт в Test users.</li>
          <li>В <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Credentials</a> создайте
            OAuth client ID с типом «Web application». В Authorized JavaScript origins добавьте <code>${esc(location.origin)}</code>
            и адреса остальных устройств или сайта, где развёрнуто приложение.</li>
          <li>Вставьте Client ID выше и нажмите «Подключить».</li>
        </ol>
        <button class="btn primary" data-act="syncOn" ${s.clientId ? '' : 'disabled'}>Подключить Google Drive</button>`}
    </section>
    <section class="panel">
      <h2>Поведение</h2>
      <label class="field">При добавлении канала брать видео за последние
        <input class="input num" type="number" min="0" max="365" data-setting="initialDays" value="${s.initialDays}"> дн.</label>
      <label class="field">Открывать видео
        <select class="input" data-setting="openIn">
          <option value="player" ${s.openIn === 'player' ? 'selected' : ''}>во встроенном плеере</option>
          <option value="youtube" ${s.openIn === 'youtube' ? 'selected' : ''}>на YouTube (в приложении на телефоне)</option>
        </select></label>
      <label class="field"><input type="checkbox" data-setting="markOnOpen" ${s.markOnOpen ? 'checked' : ''}>
        Сразу отмечать видео просмотренным при открытии</label>
    </section>
    <section class="panel">
      <h2>Данные</h2>
      <p class="hint">Каналов: ${Object.keys(state.channels).length}, видео в базе: ${total}, очередей: ${state.queues.length}.
        Резервная копия переносит всё (каналы, очереди, отметки) на другое устройство.</p>
      <div class="row gap wrap">
        <button class="btn" data-act="export">Экспорт копии</button>
        <label class="btn">Импорт копии<input type="file" accept=".json,application/json" data-change="importBackup" hidden></label>
        <button class="btn danger" data-act="wipe">Удалить все данные</button>
      </div>
    </section>`;
}

function render() {
  const [, viewName = 'queue', arg] = location.hash.split('/');
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.view === viewName));
  const html = {
    queue: renderQueue,
    channels: renderChannels,
    queues: () => (arg ? renderQueueEditor(arg) : renderQueues()),
    settings: renderSettings,
  }[viewName] || renderQueue;
  view.innerHTML = html();
}

// ---------- events ----------

const actions = {
  open: (el, e) => { e.preventDefault(); openVideo(el.dataset.id); },
  watched: el => setStatus([el.dataset.id], 'watched'),
  ignore: el => setStatus([el.dataset.id], 'ignored'),
  restore: el => setStatus([el.dataset.id], 'new'),
  set: el => { ui[el.dataset.key] = el.dataset.val; ui.limit = PAGE; saveUi(); render(); },
  more: () => { ui.limit += PAGE; render(); },
  sort: () => { state.settings.oldestFirst = !state.settings.oldestFirst; save('settings'); render(); },
  markAll: () => {
    const set = queueChannelSet();
    const ids = Object.values(state.videos)
      .filter(v => v.kind === ui.tab && v.status === 'new' && (!set || set.has(v.channelId)))
      .map(v => v.id);
    if (ids.length && confirm(`Отметить просмотренными ${ids.length} шт.?`)) setStatus(ids, 'watched');
  },
  removeChannel: el => {
    const ch = state.channels[el.dataset.id];
    if (confirm(`Удалить канал «${ch.title}» вместе с его видео?`)) removeChannel(ch.id);
  },
  openQueue: el => { ui.queueId = el.dataset.id; saveUi(); location.hash = '#/queue'; },
  checkAll: el => {
    view.querySelectorAll('.checks .list-row:not([hidden]) input').forEach(i => (i.checked = !!el.dataset.val));
  },
  deleteQueue: el => {
    if (!confirm('Удалить очередь? Каналы и видео останутся.')) return;
    state.queues = state.queues.filter(q => q.id !== el.dataset.id);
    state.deleted.queues[el.dataset.id] = Date.now();
    save('queues', 'deleted');
    location.hash = '#/queues';
  },
  export: () => {
    const { settings, ...data } = state;
    const { apiKey, ...rest } = settings;
    download(`ytqueue-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'ytqueue', version: 1, settings: rest, ...data }));
  },
  wipe: async () => {
    if (!confirm('Удалить с этого устройства все каналы, очереди, отметки и ключ? Копия в Google Drive останется.')) return;
    gdrive.signOut();
    await db.clear();
    location.reload();
  },
  syncOn: () => {
    // Enabled synchronously so the sign-in popup opens within this click.
    state.settings.syncEnabled = true;
    ui.syncError = '';
    sync({ interactive: true }).then(() => {
      if (!state.settings.lastSync) state.settings.syncEnabled = false; // sign-in failed or cancelled
      else toast('Синхронизация включена');
      db.set('settings', state.settings);
      render();
      if (ui.syncError) toast('Ошибка: ' + ui.syncError);
    });
  },
  syncNow: () => sync({ interactive: true }).then(() => toast(ui.syncError ? 'Ошибка: ' + ui.syncError : 'Синхронизировано')),
  syncOff: () => {
    if (!confirm('Отключить синхронизацию на этом устройстве? Данные здесь и в Drive останутся.')) return;
    gdrive.signOut();
    Object.assign(state.settings, { syncEnabled: false, lastSync: 0 });
    save('settings');
    render();
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el, e);
});

document.addEventListener('submit', async e => {
  const form = e.target;
  e.preventDefault();
  if (form.dataset.form === 'addChannel') {
    if (!state.settings.apiKey) return toast('Сначала укажите API-ключ в настройках');
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const ch = await yt.resolveChannel(state.settings.apiKey, form.elements.q.value);
      if (state.channels[ch.id]) return toast(`«${ch.title}» уже добавлен`);
      const added = addChannels([ch]);
      form.reset();
      render();
      toast(`Добавлен «${ch.title}»`);
      refresh(added);
    } catch (err) {
      toast('Ошибка: ' + errMessage(err));
    } finally {
      btn.disabled = false;
    }
  }
  if (form.dataset.form === 'saveQueue') {
    const name = form.elements.name.value.trim();
    const channelIds = [...form.querySelectorAll('input[name=ch]:checked')].map(i => i.value);
    const existing = state.queues.find(q => q.id === form.dataset.id);
    const updatedAt = Date.now();
    if (existing) Object.assign(existing, { name, channelIds, updatedAt });
    else state.queues.push({ id: uid(), name, channelIds, updatedAt });
    await save('queues');
    location.hash = '#/queues';
  }
});

document.addEventListener('change', async e => {
  const el = e.target;
  if (el.dataset.setting) {
    const key = el.dataset.setting;
    state.settings[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Math.max(0, +el.value || 0) : el.value.trim();
    await save('settings');
    if (key === 'apiKey') toast('Ключ сохранён');
    if (key === 'clientId') {
      if (state.settings.clientId) gdrive.loadGis().catch(() => {});
      render();
    }
    return;
  }
  switch (el.dataset.change) {
    case 'queue':
      ui.queueId = el.value;
      ui.limit = PAGE;
      saveUi();
      render();
      break;
    case 'importCsv': {
      const file = el.files[0];
      if (!file) return;
      if (!state.settings.apiKey) return toast('Сначала укажите API-ключ в настройках');
      const ids = [...new Set((await file.text()).match(/UC[\w-]{22}/g) || [])].filter(id => !state.channels[id]);
      if (!ids.length) return toast('Новых каналов в файле не найдено');
      try {
        toast(`Загрузка ${ids.length} каналов…`);
        const added = addChannels(await yt.channelsByIds(state.settings.apiKey, ids));
        render();
        toast(`Добавлено каналов: ${added.length}`);
        refresh(added);
      } catch (err) {
        toast('Ошибка: ' + errMessage(err));
      }
      break;
    }
    case 'importBackup': {
      const file = el.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.app !== 'ytqueue') throw new Error('это не резервная копия YT Queue');
        if (!confirm('Заменить текущие данные данными из копии? API-ключ сохранится.')) return;
        Object.assign(state, {
          settings: { ...state.settings, ...data.settings, apiKey: state.settings.apiKey },
          channels: data.channels || {},
          videos: data.videos || {},
          queues: data.queues || [],
          deleted: { ...emptyDeleted(), ...data.deleted },
        });
        await save('settings', ...SYNCED);
        render();
        toast('Данные восстановлены');
      } catch (err) {
        toast('Ошибка импорта: ' + err.message);
      }
      break;
    }
  }
});

document.addEventListener('input', e => {
  if (e.target.dataset.input === 'filterChannels') {
    const q = e.target.value.trim().toLowerCase();
    view.querySelectorAll('.checks .list-row').forEach(row => (row.hidden = !row.dataset.title.includes(q)));
  }
});

// Sync first (may need the sign-in popup, which is only allowed inside a click), then fetch new videos.
$('#refreshBtn').onclick = () => sync({ interactive: true }).then(() => refresh());
$('#playerClose').onclick = closePlayer;
$('#player').onclick = e => { if (e.target.id === 'player') closePlayer(); };
$('#playerWatched').onclick = e => { closePlayer(); setStatus([e.target.dataset.id], 'watched'); };
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#player').hidden) closePlayer(); });
window.addEventListener('hashchange', () => { ui.limit = PAGE; render(); window.scrollTo(0, 0); });

// ---------- start ----------

// Pick up changes made on other devices when returning to the app.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - state.settings.lastSync > 60e3) sync();
});

await load();
render();
if (state.settings.syncEnabled && state.settings.clientId) {
  gdrive.loadGis().catch(() => {});
  await sync();
}
if (state.settings.apiKey && Date.now() - state.settings.lastRefresh > 60 * 60 * 1000) refresh();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
