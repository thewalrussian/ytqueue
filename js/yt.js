// YouTube Data API v3 client.
// Channel uploads are split by YouTube into service playlists:
//   UU<id>   — all uploads
//   UULF<id> — regular videos only (no shorts, no streams)
//   UULV<id> — live streams (upcoming, live, recorded)
//   UUSH<id> — shorts (never requested)
const API = 'https://www.googleapis.com/youtube/v3/';

export class ApiError extends Error {
  constructor(message, status, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

async function call(key, endpoint, params) {
  const url = new URL(API + endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', key);
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = json.error?.errors?.[0]?.reason;
    throw new ApiError(json.error?.message || res.statusText, res.status, reason);
  }
  return json;
}

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/** Parses a channel URL, @handle or channel ID into a channels.list query. */
export function parseChannelInput(raw) {
  let s = raw.trim();
  if (!s) return null;
  if (/^UC[\w-]{22}$/.test(s)) return { id: s };
  if (s.startsWith('@')) return { forHandle: s.split(/[/?#]/)[0] };
  if (/(^|[/.])youtube\.com\//i.test(s)) {
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try {
      const parts = new URL(s).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts[0] === 'channel' && parts[1]) return { id: parts[1] };
      if (parts[0]?.startsWith('@')) return { forHandle: parts[0] };
      if (parts[0] === 'user' && parts[1]) return { forUsername: parts[1] };
      // /c/<custom> has no direct lookup; the custom name usually matches the handle.
      if (parts[0] === 'c' && parts[1]) return { forHandle: '@' + parts[1] };
    } catch { /* fall through */ }
    return null;
  }
  return { forHandle: '@' + s };
}

function mapChannel(item) {
  const t = item.snippet.thumbnails;
  return {
    id: item.id,
    title: item.snippet.title,
    handle: item.snippet.customUrl || '',
    thumb: (t.medium || t.default)?.url || '',
  };
}

export async function resolveChannel(key, input) {
  const query = parseChannelInput(input);
  if (!query) throw new Error('Не удалось распознать канал');
  const json = await call(key, 'channels', { part: 'snippet', ...query });
  if (!json.items?.length) throw new Error('Канал не найден');
  return mapChannel(json.items[0]);
}

export async function channelsByIds(key, ids) {
  const out = [];
  for (const batch of chunks(ids, 50)) {
    const json = await call(key, 'channels', { part: 'snippet', id: batch.join(','), maxResults: 50 });
    out.push(...(json.items || []).map(mapChannel));
  }
  return out;
}

/** Latest items of a playlist: [{ id, publishedAt }]. Missing playlist → []. */
export async function playlistItems(key, playlistId, max = 50) {
  try {
    const json = await call(key, 'playlistItems', { part: 'contentDetails', playlistId, maxResults: max });
    return (json.items || [])
      .filter(i => i.contentDetails?.videoPublishedAt)
      .map(i => ({ id: i.contentDetails.videoId, publishedAt: i.contentDetails.videoPublishedAt }));
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

export function parseDuration(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return 0;
  const [, d, h, min, s] = m.map(x => +x || 0);
  return d * 86400 + h * 3600 + min * 60 + s;
}

function mapVideo(item) {
  const lsd = item.liveStreamingDetails || {};
  const lbc = item.snippet.liveBroadcastContent;
  return {
    id: item.id,
    title: item.snippet.title,
    channelId: item.snippet.channelId,
    publishedAt: item.snippet.publishedAt,
    duration: parseDuration(item.contentDetails?.duration),
    liveState: lbc === 'live' ? 'live' : lbc === 'upcoming' ? 'upcoming' : 'ended',
    scheduledStart: lsd.scheduledStartTime || null,
    actualStart: lsd.actualStartTime || null,
  };
}

export async function videoDetails(key, ids) {
  const out = [];
  for (const batch of chunks(ids, 50)) {
    const json = await call(key, 'videos', {
      part: 'snippet,contentDetails,liveStreamingDetails',
      id: batch.join(','),
      maxResults: 50,
    });
    out.push(...(json.items || []).map(mapVideo));
  }
  return out;
}
