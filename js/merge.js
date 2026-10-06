// Conflict-free merge of two copies of the synced data.
// data = { channels, videos, queues, deleted: { channels, queues, videos }, apiKey }
// - channels: kept unless a deletion is newer than addedAt
// - queues: latest updatedAt wins, unless a deletion is newer
// - videos: the latest status change (statusAt) wins; stream state only moves forward
const LIVE_RANK = { upcoming: 0, live: 1, ended: 2 };
const LIVE_FIELDS = ['liveState', 'actualStart', 'scheduledStart', 'duration', 'title'];

export const emptyDeleted = () => ({ channels: {}, queues: {}, videos: {} });

function mergeTombstones(a = {}, b = {}) {
  const out = { ...a };
  for (const [id, t] of Object.entries(b)) out[id] = Math.max(out[id] || 0, t);
  return out;
}

function mergeVideo(a, b) {
  if (!a || !b) return a || b;
  const [older, newer] = (a.statusAt || 0) > (b.statusAt || 0) ? [b, a] : [a, b];
  const out = { ...newer };
  if ((LIVE_RANK[older.liveState] ?? 2) > (LIVE_RANK[newer.liveState] ?? 2)) {
    for (const f of LIVE_FIELDS) out[f] = older[f];
  }
  return out;
}

export function merge(local, remote) {
  const ld = { ...emptyDeleted(), ...local.deleted };
  const rd = { ...emptyDeleted(), ...remote.deleted };
  const deleted = {
    channels: mergeTombstones(rd.channels, ld.channels),
    queues: mergeTombstones(rd.queues, ld.queues),
    videos: mergeTombstones(rd.videos, ld.videos),
  };

  const channels = {};
  for (const ch of [...Object.values(remote.channels || {}), ...Object.values(local.channels || {})]) {
    const cur = channels[ch.id];
    if (!cur || (ch.addedAt || 0) >= (cur.addedAt || 0)) channels[ch.id] = ch;
  }
  for (const [id, ch] of Object.entries(channels)) {
    if ((deleted.channels[id] || 0) >= (ch.addedAt || 0)) delete channels[id];
    else delete deleted.channels[id]; // re-added after deletion
  }

  const queues = new Map();
  for (const q of [...(remote.queues || []), ...(local.queues || [])]) {
    const cur = queues.get(q.id);
    if (!cur || (q.updatedAt || 0) >= (cur.updatedAt || 0)) queues.set(q.id, q);
  }
  for (const [id, q] of queues) {
    if ((deleted.queues[id] || 0) >= (q.updatedAt || 0)) queues.delete(id);
  }

  const videos = {};
  const lv = local.videos || {}, rv = remote.videos || {};
  for (const id of new Set([...Object.keys(rv), ...Object.keys(lv)])) {
    const v = mergeVideo(lv[id], rv[id]);
    if (channels[v.channelId] && !deleted.videos[id]) videos[id] = v;
  }

  return {
    channels,
    videos,
    queues: [...queues.values()].map(q => ({ ...q, channelIds: q.channelIds.filter(id => channels[id]) })),
    deleted,
    apiKey: local.apiKey || remote.apiKey || '',
  };
}

/** JSON with sorted object keys, to compare data regardless of key order. */
export const canonical = value => JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v);
