// Verschickt Benachrichtigungen als Push über ntfy (App „ntfy“ für iPhone/Android).
import { allUsers, findUser, topicFor, loginLink } from './auth.js';

const PRIORITY = { escalation: 5, reminder: 4, report: 4 };
const TAGS = { escalation: ['rotating_light'], reminder: ['alarm_clock'], confirmed: ['white_check_mark'], done: ['sparkles'], cancelled: ['x'], report: ['memo'] };

/** 'owner' steht in der Logik für „alle Auftraggeber“. */
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
      click: await loginLink(env, user), // Tippen auf die Nachricht öffnet die App
    }),
  });
  if (!res.ok) throw new Error(`ntfy antwortet mit ${res.status}`);
}

/** Alle Nachrichten verschicken; ein Fehler bei einer Person stoppt die anderen nicht. */
export async function deliver(env, cfg, notifications) {
  const jobs = [];
  for (const n of notifications) for (const user of expand(cfg, n.to)) jobs.push(sendPush(env, user, n));
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) console.error(`${failed.length} Push-Nachricht(en) fehlgeschlagen:`, failed[0].reason);
  return { sent: results.length - failed.length, failed: failed.length };
}
