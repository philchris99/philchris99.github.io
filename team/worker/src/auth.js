// Anmeldung
//  - alle: persönlicher 6-stelliger Code (nur als Hash gespeichert)
//  - Admin-Notzugang: /admin mit ADMIN_PASSWORD
// Nach der Anmeldung gibt es ein Token (HMAC aus APP_SECRET, Nutzer-ID, Version).
// Es wird im Browser gespeichert; Version erhöhen = auf allen Geräten abmelden.
import config from './config.js';

const encoder = new TextEncoder();

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** cfg = config mit Reinigungsleitung (leads) und Mitarbeiterinnen (staff) aus der Datenbank */
export function allUsers(cfg) {
  return [
    ...cfg.owners.map((u) => ({ ...u, role: 'owner' })),
    ...cfg.leads.map((u) => ({ ...u, role: 'lead' })),
    ...cfg.staff.map((u) => ({ ...u, role: 'staff' })),
  ];
}

export function findUser(cfg, id) {
  return allUsers(cfg).find((u) => u.id === id) || null;
}

export async function tokenFor(env, user) {
  return (await hmac(env.APP_SECRET, `login:${user.id}:${user.version || 1}`)).slice(0, 32);
}

export async function sessionFor(env, user) {
  return `${user.id}.${await tokenFor(env, user)}`;
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

/** Liest „Authorization: Bearer <nutzer>.<token>“ (oder ?a= bei Fotos) und liefert die Person oder null. */
export async function authenticate(request, env, cfg) {
  const header = request.headers.get('Authorization') || '';
  const fromQuery = new URL(request.url).searchParams.get('a');
  const raw = header.startsWith('Bearer ') ? header.slice(7) : fromQuery || '';
  const match = raw.match(/^([^.\s]+)\.(\S+)$/);
  if (!match || !env.APP_SECRET) return null;
  const user = findUser(cfg, match[1]);
  if (!user) return null;
  return safeEqual(match[2], await tokenFor(env, user)) ? user : null;
}

/** Geheimer Pfad für den Smoobu-Webhook (optional, für sofortige Aktualisierung). */
export async function webhookToken(env) {
  return (await hmac(env.APP_SECRET, 'webhook:smoobu')).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}

// ---- Codes der Reinigungskräfte ------------------------------------------------
export function newCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}

export function randomId(prefix, length = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return prefix + [...bytes].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}

export async function hashCode(code, salt) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${salt}:${code}`)));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Codes zusätzlich verschlüsselt speichern (AES-GCM, Schlüssel aus APP_SECRET),
// damit Admin/Leitung sie jederzeit wieder anzeigen können.
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
async function codeKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', encoder.encode(`${env.APP_SECRET}:codes`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptCode(env, code) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await codeKey(env), encoder.encode(code)));
  return `${b64(iv)}.${b64(data)}`;
}
export async function decryptCode(env, enc) {
  if (!enc) return null;
  try {
    const [iv, data] = enc.split('.').map(unb64);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await codeKey(env), data));
  } catch (e) {
    return null;
  }
}

/** Sucht die Person zu einem Code (Codes sind eindeutig). */
export async function findByCode(cleaners, code) {
  for (const c of cleaners) {
    if (c.codeHash && safeEqual(await hashCode(code, c.codeSalt), c.codeHash)) return c;
  }
  return null;
}
