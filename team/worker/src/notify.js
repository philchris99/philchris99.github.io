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

export async function sendPush(env, user, { title, body, kind }) {
  const res = await fetch(env.NTFY_URL || 'https://ntfy.sh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: await topicFor(env, user),
      title,
      message: body,
      priority: PRIORITY[kind] || 3,
      tags: TAGS[kind] || [],
      click: await loginLink(env, user),
    }),
  });
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
