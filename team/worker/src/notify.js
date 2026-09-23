// Verschickt Benachrichtigungen als Push über ntfy (App „ntfy“ für iPhone, Android,
// Mac/Windows über ntfy.sh im Browser). Tippen auf die Nachricht öffnet die App.
import { allUsers, findUser, topicFor, loginLink } from './auth.js';

// 5 = höchste Stufe (Alarm, durchdringend), 4 = hoch, 3 = normal, 2 = leise
const PRIORITY = { late: 5, reminder2: 5, reminder: 4, new: 4, assigned: 4, rescheduled: 4, cancelled: 4, report: 4, note: 4, edited: 3, unassigned: 3, confirmed: 2, done: 2 };
const TAGS = { late: ['rotating_light'], reminder2: ['rotating_light'], reminder: ['alarm_clock'], new: ['broom'], assigned: ['broom'],
  rescheduled: ['calendar'], cancelled: ['x'], report: ['memo'], note: ['memo'], confirmed: ['white_check_mark'], done: ['sparkles'] };
const GROUP_TITLES = { new: 'neue Reinigungen', late: 'Reinigungen nicht bestätigt', reminder: 'Reinigungen heute noch offen',
  reminder2: 'Reinigungen immer noch offen', rescheduled: 'Reinigungen verschoben', cancelled: 'Reinigungen entfallen', assigned: 'neue Reinigungen für dich' };

/** 'owner' steht in der Logik für „alle Admins“. */
function expand(cfg, to) {
  if (to === cfg.owner.id) return allUsers(cfg).filter((u) => u.role === 'owner');
  const user = findUser(cfg, to);
  return user ? [user] : [];
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Eine Nachricht an ntfy schicken. Mit NTFY_TOKEN (kostenloses ntfy.sh-Konto) zählt
 * ntfy pro Konto statt pro Server-Adresse – Cloudflare teilt sich Adressen mit vielen
 * anderen, daher sonst häufig „429 Too Many Requests“.
 */
export async function sendPush(env, user, { title, body, kind }) {
  const headers = { 'Content-Type': 'application/json' };
  const token = (env.NTFY_TOKEN || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const payload = JSON.stringify({
    topic: await topicFor(env, user),
    title,
    message: body,
    priority: PRIORITY[kind] || 3,
    tags: TAGS[kind] || [],
    click: await loginLink(env, user),
  });
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(env.NTFY_URL || 'https://ntfy.sh', { method: 'POST', headers, body: payload });
    if (res.status !== 429 && res.status < 500) break;
    await wait(1000 * (attempt + 1)); // kurz warten und erneut versuchen
  }
  if (res.status === 429) {
    throw new Error(token
      ? 'ntfy.sh meldet „zu viele Nachrichten“ (429) – Tageslimit des ntfy-Kontos erreicht'
      : 'ntfy.sh meldet „zu viele Nachrichten“ (429) – bitte NTFY_TOKEN in Cloudflare eintragen (siehe Anleitung)');
  }
  if (res.status === 401 || res.status === 403) throw new Error(`ntfy lehnt den Zugang ab (${res.status}) – NTFY_TOKEN prüfen`);
  if (!res.ok) throw new Error(`ntfy antwortet mit ${res.status}`);
}

/**
 * Mehr als 3 gleichartige Nachrichten an dieselbe Person → eine Sammelnachricht
 * (z. B. nach dem Einrichten: „12 Reinigungen nicht bestätigt“ statt 12 Pushes).
 */
export function group(messages) {
  const buckets = new Map();
  for (const m of messages) {
    const key = `${m.user.id}|${m.kind}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(m);
  }
  const out = [];
  for (const list of buckets.values()) {
    if (list.length <= 3 || !GROUP_TITLES[list[0].kind]) { out.push(...list); continue; }
    const lines = list.slice(0, 8).map((m) => '• ' + m.body);
    if (list.length > 8) lines.push(`… und ${list.length - 8} weitere`);
    out.push({ ...list[0], title: `${list.length} ${GROUP_TITLES[list[0].kind]}`, body: lines.join('\n') });
  }
  return out;
}

/** Alle Nachrichten verschicken; ein Fehler bei einer Person stoppt die anderen nicht. */
export async function deliver(env, cfg, notifications) {
  const messages = [];
  for (const n of notifications) for (const user of expand(cfg, n.to)) messages.push({ ...n, user });
  const results = await Promise.allSettled(group(messages).map((m) => sendPush(env, m.user, m)));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) console.error(`${failed.length} Push-Nachricht(en) fehlgeschlagen:`, failed[0].reason);
  return { sent: results.length - failed.length, failed: failed.length };
}
