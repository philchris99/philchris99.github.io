// Speichert den gesamten Zustand als ein JSON-Dokument in Cloudflare D1.
// Die Versionsnummer verhindert, dass sich gleichzeitige Änderungen
// (z. B. Abgleich mit Smoobu und Klick auf „Bestätigen“) gegenseitig überschreiben.
import L from '../../logic/logic.js';

const MAX_LOG = 100;

async function ensureTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL)').run();
}

// ---- Fotos (eigene Tabelle, damit der Zustand klein bleibt) --------------------
async function ensurePhotos(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at INTEGER NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL)').run();
}

export async function savePhoto(db, { id, taskId, mime, data, now }) {
  await ensurePhotos(db);
  await db.prepare('INSERT INTO photos (id, task_id, created_at, mime, data) VALUES (?, ?, ?, ?, ?)').bind(id, taskId, now, mime, data).run();
}

export async function getPhoto(db, id) {
  await ensurePhotos(db);
  const row = await db.prepare('SELECT mime, data FROM photos WHERE id = ?').bind(id).first();
  if (!row) return null;
  // D1 liefert BLOBs je nach Version als ArrayBuffer oder als Zahlen-Array
  const data = row.data instanceof ArrayBuffer ? row.data : ArrayBuffer.isView(row.data) ? row.data : new Uint8Array(row.data);
  return { mime: row.mime, data };
}

export async function deletePhotos(db, ids) {
  for (const id of ids) await db.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
}

export async function pruneOldPhotos(db, olderThan) {
  await ensurePhotos(db);
  await db.prepare('DELETE FROM photos WHERE created_at < ?').bind(olderThan).run();
}

// ---- Einstellungen (Team) – bleiben beim Zurücksetzen erhalten ---------------
async function ensureSettings(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL)').run();
}

export async function loadSettings(db) {
  await ensureSettings(db);
  const row = await db.prepare('SELECT data FROM settings WHERE id = 1').first();
  return row ? JSON.parse(row.data) : { cleaners: [] };
}

export async function saveSettings(db, settings) {
  await ensureSettings(db);
  await db.prepare('INSERT OR REPLACE INTO settings (id, data) VALUES (1, ?)').bind(JSON.stringify(settings)).run();
}

// ---- Schutz gegen Durchprobieren von Codes/Passwort ----------------------------
async function ensureAttempts(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, since INTEGER NOT NULL)').run();
}

/** Gesperrt? Liefert die verbleibenden Sekunden (0 = frei). */
export async function lockedFor(db, key, now, { max, windowMs }) {
  await ensureAttempts(db);
  const row = await db.prepare('SELECT count, since FROM login_attempts WHERE key = ?').bind(key).first();
  if (!row || row.count < max || now - row.since >= windowMs) return 0;
  return Math.ceil((row.since + windowMs - now) / 1000);
}

/** Fehlversuch zählen; ab dem max. Versuch beginnt die Sperrzeit neu. */
export async function recordFailure(db, key, now, { max, windowMs }) {
  await ensureAttempts(db);
  const row = await db.prepare('SELECT count, since FROM login_attempts WHERE key = ?').bind(key).first();
  if (!row || now - row.since >= windowMs) {
    await db.prepare('INSERT OR REPLACE INTO login_attempts (key, count, since) VALUES (?, 1, ?)').bind(key, now).run();
    return 1;
  }
  const count = row.count + 1;
  // Sperre gilt ab dem letzten Fehlversuch
  await db.prepare('UPDATE login_attempts SET count = ?, since = ? WHERE key = ?').bind(count, count >= max ? now : row.since, key).run();
  return count;
}

export async function clearAttempts(db, key) {
  await ensureAttempts(db);
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
}

/** Testphase: alles löschen (Reinigungen, Meldungen, Fotos, Protokoll). Team bleibt. */
export async function resetAll(db) {
  await ensureTable(db);
  await ensurePhotos(db);
  await db.prepare('DELETE FROM app_state').run();
  await db.prepare('DELETE FROM photos').run();
}

export async function loadState(db) {
  await ensureTable(db);
  const row = await db.prepare('SELECT version, data FROM app_state WHERE id = 1').first();
  if (!row) return { state: Object.assign(L.createState(), { log: [] }), version: 0 };
  return { state: JSON.parse(row.data), version: row.version };
}

/**
 * Lädt den Zustand, wendet fn an ((state) => { state, notifications }) und speichert.
 * Bei gleichzeitiger Änderung wird neu geladen und fn erneut ausgeführt.
 * Verschickte Nachrichten werden im Protokoll (state.log) festgehalten.
 */
export async function mutate(db, fn, now) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { state, version } = await loadState(db);
    const result = fn(state);
    const next = result.state;
    const at = new Date(now || Date.now()).toISOString();
    next.log = [...result.notifications.map((n) => ({ ...n, at })).reverse(), ...(state.log || [])].slice(0, MAX_LOG);
    const data = JSON.stringify(next);
    const res = version === 0
      ? await db.prepare('INSERT OR IGNORE INTO app_state (id, version, data) VALUES (1, 1, ?)').bind(data).run()
      : await db.prepare('UPDATE app_state SET data = ?, version = version + 1 WHERE id = 1 AND version = ?').bind(data, version).run();
    if (res.meta && res.meta.changes === 1) return { state: next, notifications: result.notifications };
  }
  throw new Error('Speichern fehlgeschlagen, bitte erneut versuchen');
}
