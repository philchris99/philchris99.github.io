// Verschickt Benachrichtigungen als Push über ntfy (App „ntfy“ für iPhone/Android).
import config from './config.js';
import { allUsers, findUser, topicFor, loginLink } from './auth.js';

const PRIORITY = { escalation: 5, reminder: 4 };
const TAGS = { escalation: ['rotating_light'], reminder: ['alarm_clock'], confirmed: ['white_check_mark'], done: ['sparkles'], cancelled: ['x'] };

/** 'owner' steht in der Logik für „alle Auftraggeber“. */
function expand(to) {
  if (to === config.owner.id) return allUsers().filter((u) => u.role === 'owner');
  const user = findUser(to);
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
export async function deliver(env, notifications) {
  const jobs = [];
  for (const n of notifications) for (const user of expand(n.to)) jobs.push(sendPush(env, user, n));
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) console.error(`${failed.length} Push-Nachricht(en) fehlgeschlagen:`, failed[0].reason);
  return { sent: results.length - failed.length, failed: failed.length };
}
