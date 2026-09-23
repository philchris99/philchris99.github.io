// Persönliche Links: Das Token ist eine HMAC-Signatur aus APP_SECRET, Nutzer-ID
// und Version. Es wird nichts gespeichert; ein Link wird gesperrt, indem man in
// config.js die version der Person erhöht.
import config from './config.js';

const encoder = new TextEncoder();

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function allUsers() {
  return [
    ...config.owners.map((u) => ({ ...u, role: 'owner' })),
    ...config.cleaners.map((u) => ({ ...u, role: 'cleaner' })),
  ];
}

export function findUser(id) {
  return allUsers().find((u) => u.id === id) || null;
}

export async function tokenFor(env, user) {
  return (await hmac(env.APP_SECRET, `login:${user.id}:${user.version || 1}`)).slice(0, 32);
}

/** Privater ntfy-Kanal der Person (wer den Namen kennt, kann mitlesen → geheim halten). */
export async function topicFor(env, user) {
  const h = (await hmac(env.APP_SECRET, `ntfy:${user.id}:${user.version || 1}`)).replace(/[^A-Za-z0-9]/g, '');
  return `strauss-${user.id}-${h.slice(0, 16)}`;
}

export async function loginLink(env, user, origin = config.appUrl) {
  return `${origin}/?u=${encodeURIComponent(user.id)}&k=${await tokenFor(env, user)}`;
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Liest „Authorization: Bearer <nutzer>.<token>“ und liefert die Person oder null. */
export async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  // Fotos werden per <img src="…?a=nutzer.token"> geladen (dort gibt es keinen Header)
  const fromQuery = new URL(request.url).searchParams.get('a');
  const raw = header.startsWith('Bearer ') ? header.slice(7) : fromQuery || '';
  const match = raw.match(/^([^.\s]+)\.(\S+)$/);
  if (!match || !env.APP_SECRET) return null;
  const user = findUser(match[1]);
  if (!user) return null;
  return safeEqual(match[2], await tokenFor(env, user)) ? user : null;
}

/** Geheimer Pfad für den Smoobu-Webhook (optional, für sofortige Aktualisierung). */
export async function webhookToken(env) {
  return (await hmac(env.APP_SECRET, 'webhook:smoobu')).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}
