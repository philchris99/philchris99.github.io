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
  for (const id of ids) {
    if (id.startsWith('v')) await deleteVideo(db, id);
    else await db.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
  }
}

export async function pruneOldPhotos(db, olderThan) {
  await ensurePhotos(db);
  await db.prepare('DELETE FROM photos WHERE created_at < ?').bind(olderThan).run();
  await ensureVideos(db);
  await db.prepare('DELETE FROM media_chunks WHERE id IN (SELECT id FROM media WHERE created_at < ?)').bind(olderThan).run();
  await db.prepare('DELETE FROM media WHERE created_at < ?').bind(olderThan).run();
}

// ---- Videos: in Stücken zu 1,9 MB (D1 erlaubt max. 2 MB je Feld) -------------
export const VIDEO_CHUNK = 1900000;
async function ensureVideos(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at INTEGER NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS media_chunks (id TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, idx))').run();
}

export async function saveVideo(db, { id, taskId, mime, data, now }) {
  await ensureVideos(db);
  const bytes = new Uint8Array(data);
  const chunks = Math.max(1, Math.ceil(bytes.length / VIDEO_CHUNK));
  try {
    for (let i = 0; i < chunks; i++) {
      const part = bytes.slice(i * VIDEO_CHUNK, (i + 1) * VIDEO_CHUNK).buffer;
      await db.prepare('INSERT INTO media_chunks (id, idx, data) VALUES (?, ?, ?)').bind(id, i, part).run();
    }
    await db.prepare('INSERT INTO media (id, task_id, created_at, mime, size, chunks) VALUES (?, ?, ?, ?, ?, ?)').bind(id, taskId, now, mime, bytes.length, chunks).run();
  } catch (e) {
    await deleteVideo(db, id).catch(() => {});
    throw e;
  }
}

export async function getVideoInfo(db, id) {
  await ensureVideos(db);
  return db.prepare('SELECT mime, size, chunks FROM media WHERE id = ?').bind(id).first();
}

export async function getVideoChunk(db, id, idx) {
  const row = await db.prepare('SELECT data FROM media_chunks WHERE id = ? AND idx = ?').bind(id, idx).first();
  if (!row) return new Uint8Array(0);
  return row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : ArrayBuffer.isView(row.data) ? new Uint8Array(row.data.buffer, row.data.byteOffset, row.data.byteLength) : new Uint8Array(row.data);
}

async function deleteVideo(db, id) {
  await ensureVideos(db);
  await db.prepare('DELETE FROM media_chunks WHERE id = ?').bind(id).run();
  await db.prepare('DELETE FROM media WHERE id = ?').bind(id).run();
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

// ---- Code-Anmeldung: stufenweise Sperre je IP-Adresse -------------------------
// 3 Versuche → 1 Min.; danach je 1 Versuch → 5 Min. → 30 Min. → 60 Min.; dann dauerhaft gesperrt (Admin schaltet frei).
export const CODE_STAGES = [
  { tries: 3, lockMs: 60 * 1000 },
  { tries: 1, lockMs: 5 * 60 * 1000 },
  { tries: 1, lockMs: 30 * 60 * 1000 },
  { tries: 1, lockMs: 60 * 60 * 1000 },
  { tries: 1, lockMs: null }, // danach: dauerhaft gesperrt
];
const RESET_AFTER = 24 * 3600 * 1000; // 24 Std. ohne Fehlversuch → wieder von vorn (außer dauerhaft gesperrt)

async function ensureLocks(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS login_locks (ip TEXT PRIMARY KEY, stage INTEGER NOT NULL, fails INTEGER NOT NULL, locked_until INTEGER NOT NULL, blocked INTEGER NOT NULL, last_at INTEGER NOT NULL)').run();
}

async function lockRow(db, ip, now) {
  await ensureLocks(db);
  const row = await db.prepare('SELECT stage, fails, locked_until, blocked, last_at FROM login_locks WHERE ip = ?').bind(ip).first();
  if (!row) return null;
  if (!row.blocked && now - row.last_at > RESET_AFTER) {
    await db.prepare('DELETE FROM login_locks WHERE ip = ?').bind(ip).run();
    return null;
  }
  return row;
}

/** Zustand für eine IP: { blocked, wait (Sekunden), left (Versuche) } */
export async function codeLockState(db, ip, now) {
  const row = await lockRow(db, ip, now);
  if (!row) return { blocked: false, wait: 0, left: CODE_STAGES[0].tries };
  if (row.blocked) return { blocked: true, wait: 0, left: 0 };
  if (row.locked_until > now) return { blocked: false, wait: Math.ceil((row.locked_until - now) / 1000), left: 0 };
  return { blocked: false, wait: 0, left: CODE_STAGES[row.stage].tries - row.fails };
}

/** Fehlversuch zählen; liefert den neuen Zustand (+ justBlocked beim Übergang zur dauerhaften Sperre) */
export async function codeFailure(db, ip, now) {
  const row = (await lockRow(db, ip, now)) || { stage: 0, fails: 0, locked_until: 0, blocked: 0 };
  let { stage, fails } = row;
  let lockedUntil = row.locked_until;
  let blocked = row.blocked;
  fails += 1;
  let justBlocked = false;
  if (fails >= CODE_STAGES[stage].tries) {
    if (CODE_STAGES[stage].lockMs == null) { blocked = 1; justBlocked = true; } else { lockedUntil = now + CODE_STAGES[stage].lockMs; stage += 1; }
    fails = 0;
  }
  await db.prepare('INSERT OR REPLACE INTO login_locks (ip, stage, fails, locked_until, blocked, last_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(ip, stage, fails, lockedUntil, blocked, now).run();
  return { ...(await codeLockState(db, ip, now)), justBlocked };
}

export async function codeSuccess(db, ip) {
  await ensureLocks(db);
  await db.prepare('DELETE FROM login_locks WHERE ip = ?').bind(ip).run();
}

/** Für den Admin: gesperrte / eingeschränkte IP-Adressen */
export async function listCodeLocks(db, now) {
  await ensureLocks(db);
  const { results } = await db.prepare('SELECT ip, stage, fails, locked_until, blocked, last_at FROM login_locks ORDER BY last_at DESC LIMIT 50').all();
  return (results || []).filter((r) => r.blocked || r.stage > 0 || r.fails > 0).map((r) => ({
    ip: r.ip, blocked: !!r.blocked, stage: r.stage, lockedUntil: r.locked_until > now ? new Date(r.locked_until).toISOString() : null,
    lastAt: new Date(r.last_at).toISOString(),
  }));
}

/** Admin schaltet frei → wieder 3 Versuche */
export async function releaseCodeLock(db, ip) {
  await codeSuccess(db, ip);
}

export async function clearAttempts(db, key) {
  await ensureAttempts(db);
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
}

/** Testphase: alles löschen (Reinigungen, Meldungen, Fotos, Protokoll). Team bleibt. */
export async function resetAll(db) {
  await ensureTable(db);
  await ensurePhotos(db);
  await ensureVideos(db);
  await db.prepare('DELETE FROM app_state').run();
  await db.prepare('DELETE FROM photos').run();
  await db.prepare('DELETE FROM media').run();
  await db.prepare('DELETE FROM media_chunks').run();
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
