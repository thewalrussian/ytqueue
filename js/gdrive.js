// Google Drive transport: one JSON file in the hidden per-app folder (appDataFolder).
// Auth uses the Google Identity Services token model: short-lived (1 h) access tokens, no backend.
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FILE_NAME = 'ytqueue.json';
const TOKEN_KEY = 'ytq-token';

export class AuthError extends Error {}

let token = null;
let fileId = null;
let gisPromise = null;
let client = null;
let clientIdUsed = null;
let pending = null;

try {
  token = JSON.parse(localStorage.getItem(TOKEN_KEY));
} catch { /* storage unavailable */ }

function setToken(value) {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, JSON.stringify(value));
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable */ }
}

export const hasToken = () => !!token && token.exp > Date.now() + 60e3;

export function loadGis() {
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => {
        gisPromise = null;
        reject(new Error('не удалось загрузить вход Google'));
      };
      document.head.append(s);
    });
  }
  return gisPromise;
}

/** Opens the Google consent popup. Must be called synchronously from a user gesture. */
export function authorize(clientId) {
  if (!window.google?.accounts?.oauth2) {
    loadGis();
    return Promise.reject(new Error('вход Google ещё загружается, попробуйте через пару секунд'));
  }
  if (!client || clientIdUsed !== clientId) {
    client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: r => {
        if (r.error) return pending?.reject(new AuthError(r.error_description || r.error));
        setToken({ value: r.access_token, exp: Date.now() + r.expires_in * 1000 });
        pending?.resolve();
      },
      error_callback: e => pending?.reject(new AuthError(e.type === 'popup_closed' ? 'окно входа закрыто' : e.message || e.type)),
    });
    clientIdUsed = clientId;
  }
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    client.requestAccessToken({ prompt: '' });
  });
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token.value, () => {});
  setToken(null);
  fileId = null;
}

async function api(url, options = {}) {
  if (!hasToken()) throw new AuthError('нужен вход в Google');
  const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token.value}`, ...options.headers } });
  if (res.status === 401) {
    setToken(null);
    throw new AuthError('сессия Google истекла');
  }
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    const err = new Error(json.error?.message || res.statusText);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function findFile() {
  if (fileId) return fileId;
  const q = encodeURIComponent(`name='${FILE_NAME}'`);
  const res = await api(`${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id)&orderBy=modifiedTime desc`);
  fileId = (await res.json()).files?.[0]?.id || null;
  return fileId;
}

/** Remote file contents as text, or null when nothing has been synced yet. */
export async function pull() {
  const id = await findFile();
  if (!id) return null;
  try {
    return await (await api(`${DRIVE}/files/${id}?alt=media`)).text();
  } catch (e) {
    if (e.status === 404) { fileId = null; return null; }
    throw e;
  }
}

export async function push(text) {
  const id = await findFile();
  if (id) {
    try {
      await api(`${UPLOAD}/files/${id}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      return;
    } catch (e) {
      if (e.status !== 404) throw e;
      fileId = null;
    }
  }
  const boundary = 'ytq' + Date.now();
  const body = [
    `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '',
    JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] }),
    `--${boundary}`, 'Content-Type: application/json', '',
    text,
    `--${boundary}--`,
  ].join('\r\n');
  const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  fileId = (await res.json()).id;
}
