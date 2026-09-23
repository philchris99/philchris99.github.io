// Verschickt Benachrichtigungen als Push über ntfy (App „ntfy“ für iPhone, Android,
// Mac/Windows über ntfy.sh im Browser). Tippen auf die Nachricht öffnet die App.
import { allUsers, findUser, topicFor, loginLink } from './auth.js';

// 5 = höchste Stufe (Alarm, durchdringend), 4 = hoch, 3 = normal, 2 = leise
const PRIORITY = { keys: 5, late: 5, reminder2: 5, reminder: 5, overdue: 5, new: 4, assigned: 4, rescheduled: 4, cancelled: 4, report: 4, note: 4, request: 4, period: 4, edited: 3, unassigned: 3, confirmed: 2, done: 2 };
const TAGS = { keys: ['key', 'rotating_light'], late: ['rotating_light'], reminder2: ['rotating_light'], reminder: ['alarm_clock'], overdue: ['rotating_light'], new: ['broom'], assigned: ['broom'],
  rescheduled: ['calendar'], request: ['calendar'], period: ['calendar'], cancelled: ['x'], report: ['memo'], note: ['memo'], confirmed: ['white_check_mark'], done: ['sparkles'] };
const GROUP_TITLES = { new: 'neue Reinigungen', late: 'Reinigungen nicht bestätigt', reminder: 'Reinigungen noch nicht gestartet',
  reminder2: 'Reinigungen noch nicht beendet', overdue: 'Reinigungen nicht erledigt', rescheduled: 'Reinigungen verschoben', cancelled: 'Reinigungen entfallen', assigned: 'neue Reinigungen für dich' };

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
export async function sendPush(env, user, { title, body, kind }, retries = 2) {
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
  for (let attempt = 0; attempt <= retries; attempt++) {
    res = await fetch(env.NTFY_URL || 'https://ntfy.sh', { method: 'POST', headers, body: payload });
    if (res.status !== 429 && res.status < 500) break;
    if (attempt < retries) await wait(1000 * (attempt + 1)); // kurz warten und erneut versuchen
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

/** Mehr als `budget` Nachrichten → je Person eine einzige Sammelnachricht. */
export function limit(messages, budget) {
  if (messages.length <= budget) return messages;
  const perUser = new Map();
  for (const m of messages) {
    if (!perUser.has(m.user.id)) perUser.set(m.user.id, []);
    perUser.get(m.user.id).push(m);
  }
  return [...perUser.values()].map((list) => list.length === 1 ? list[0] : {
    ...list[0],
    kind: list.some((m) => PRIORITY[m.kind] === 5) ? 'reminder2' : list[0].kind,
    title: `${list.length} Hinweise zu Reinigungen`,
    body: list.slice(0, 10).map((m) => `• ${m.title}: ${m.body.split('\n')[0]}`).join('\n'),
  });
}

/**
 * Alle Nachrichten verschicken; ein Fehler bei einer Person stoppt die anderen nicht.
 * Cloudflare erlaubt im kostenlosen Tarif max. 50 Anfragen nach außen pro Durchlauf –
 * deshalb werden Nachrichten gebündelt und Wiederholungen nur bei wenigen Nachrichten gemacht.
 */
export async function deliver(env, cfg, notifications, budget = 25) {
  const messages = [];
  for (const n of notifications) for (const user of expand(cfg, n.to)) messages.push({ ...n, user });
  const toSend = limit(group(messages), budget);
  const retries = toSend.length <= 8 ? 2 : 0;
  const results = await Promise.allSettled(toSend.map((m) => sendPush(env, m.user, m, retries)));
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') errors.push({ to: toSend[i].user.name, title: toSend[i].title, error: String(r.reason && r.reason.message || r.reason) });
  });
  if (errors.length) console.error(`${errors.length} Push-Nachricht(en) fehlgeschlagen:`, errors[0].error);
  return { sent: results.length - errors.length, failed: errors.length, errors };
}
