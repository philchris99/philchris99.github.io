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

// ---- Statistik: Auslastung je Tag (ein JSON-Eintrag, bleibt beim Zurücksetzen erhalten) ----
async function ensureStats(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS stats (id INTEGER PRIMARY KEY, data TEXT NOT NULL)').run();
}
export async function loadStats(db) {
  await ensureStats(db);
  const row = await db.prepare('SELECT data FROM stats WHERE id = 1').first();
  return row ? JSON.parse(row.data) : { days: {} };
}
export async function saveStats(db, stats) {
  await ensureStats(db);
  const dates = Object.keys(stats.days).sort();
  for (const d of dates.slice(0, Math.max(0, dates.length - 1150))) delete stats.days[d]; // höchstens ~3 Jahre
  await db.prepare('INSERT OR REPLACE INTO stats (id, data) VALUES (1, ?)').bind(JSON.stringify(stats)).run();
}

// ---- Buchungstempo (Pace): alle Buchungen kompakt (Eintragungs-/Stornodatum, Preis) ----
async function ensurePace(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS pace (id TEXT PRIMARY KEY, apt TEXT NOT NULL, arrival TEXT NOT NULL, departure TEXT NOT NULL, created TEXT, blocked INTEGER NOT NULL, cancelled TEXT, price REAL)').run();
}
/** Einträge speichern/aktualisieren (in Paketen – D1 mag keine riesigen Batches) */
export async function upsertPace(db, entries) {
  await ensurePace(db);
  const sql = 'INSERT OR REPLACE INTO pace (id, apt, arrival, departure, created, blocked, cancelled, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
  for (let i = 0; i < entries.length; i += 50) {
    await db.batch(entries.slice(i, i + 50).map((e) => db.prepare(sql)
      .bind(e.id, e.apartmentId, e.arrival, e.departure, e.created, e.blocked ? 1 : 0, e.cancelled, e.price)));
  }
  return entries.length;
}
export async function loadPace(db) {
  await ensurePace(db);
  const { results } = await db.prepare('SELECT id, apt, arrival, departure, created, blocked, cancelled, price FROM pace').all();
  return (results || []).map((r) => ({ id: r.id, apartmentId: r.apt, arrival: r.arrival, departure: r.departure, created: r.created,
    blocked: !!r.blocked, cancelled: r.cancelled, price: r.price }));
}

/** Zustellstatus im Protokoll vermerken: statuses = { nid: { status: 'versendet'|'wartet'|'fehlgeschlagen', error? } } */
export async function recordDelivery(db, statuses, now) {
  if (!statuses || !Object.keys(statuses).length) return;
  const at = new Date(now || Date.now()).toISOString();
  await mutate(db, (state) => {
    for (const e of state.log || []) {
      const s = e.nid && statuses[e.nid];
      if (s) { e.status = s.status; e.statusAt = at; if (s.error) e.statusError = s.error; else delete e.statusError; }
    }
    return { state, notifications: [] };
  }, now);
}

// ---- Push-Warteschlange: von ntfy abgelehnte Nachrichten (429) werden später nachgesendet ----
async function ensurePushQueue(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS push_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0)').run();
}
export async function enqueuePush(db, messages) {
  await ensurePushQueue(db);
  const now = Date.now();
  await db.prepare('DELETE FROM push_queue WHERE created < ? OR tries > 30').bind(now - 2 * 86400000).run(); // alte aufgeben
  for (const m of messages) {
    const payload = JSON.stringify({ title: m.title, body: m.body, kind: m.kind, nids: m.nids || [] });
    const dup = await db.prepare('SELECT id FROM push_queue WHERE user_id = ? AND payload = ?').bind(m.user.id, payload).first();
    if (!dup) await db.prepare('INSERT INTO push_queue (user_id, payload, created) VALUES (?, ?, ?)').bind(m.user.id, payload, now).run();
  }
}
export async function takePushQueue(db, max) {
  await ensurePushQueue(db);
  const { results } = await db.prepare('SELECT id, user_id, payload FROM push_queue ORDER BY id LIMIT ?').bind(max).all();
  return (results || []).map((r) => ({ id: r.id, userId: r.user_id, payload: JSON.parse(r.payload) }));
}
export async function dropPush(db, id) { await db.prepare('DELETE FROM push_queue WHERE id = ?').bind(id).run(); }
export async function retryPush(db, id) { await db.prepare('UPDATE push_queue SET tries = tries + 1 WHERE id = ?').bind(id).run(); }
export async function countPushQueue(db) {
  await ensurePushQueue(db);
  const row = await db.prepare('SELECT COUNT(*) AS n FROM push_queue').first();
  return row ? Number(row.n) : 0;
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
    // jede Nachricht bekommt eine Kennung, damit der Zustellstatus später im Protokoll vermerkt werden kann
    for (const n of result.notifications) if (!n.nid) n.nid = Math.random().toString(36).slice(2, 12);
    next.log = [...result.notifications.map((n) => ({ ...n, at })).reverse(), ...(state.log || [])].slice(0, MAX_LOG);
    const data = JSON.stringify(next);
    const res = version === 0
      ? await db.prepare('INSERT OR IGNORE INTO app_state (id, version, data) VALUES (1, 1, ?)').bind(data).run()
      : await db.prepare('UPDATE app_state SET data = ?, version = version + 1 WHERE id = 1 AND version = ?').bind(data, version).run();
    if (res.meta && res.meta.changes === 1) return { state: next, notifications: result.notifications };
  }
  throw new Error('Speichern fehlgeschlagen, bitte erneut versuchen');
}

// ---- Gästeanfragen: Nachrichten aus Smoobu für die Themen-Auswertung ----
async function ensureInquiries(db) {
  await ensurePace(db);
  await db.prepare('CREATE TABLE IF NOT EXISTS inq_done (booking TEXT PRIMARY KEY, at INTEGER NOT NULL, n INTEGER NOT NULL)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS inq_msgs (id TEXT PRIMARY KEY, booking TEXT NOT NULL, apt TEXT, created TEXT, inbound INTEGER, phase TEXT, text TEXT NOT NULL)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS inq_cats (msg TEXT NOT NULL, cat TEXT NOT NULL, booking TEXT NOT NULL, phase TEXT, created TEXT, snippet TEXT, PRIMARY KEY (msg, cat))').run();
}
/** Nächste Buchungen (keine Blockierungen) im Zeitraum, deren Nachrichten noch nicht gelesen wurden */
export async function inquiryTodo(db, from, to, limit) {
  await ensureInquiries(db);
  const where = 'FROM pace WHERE blocked = 0 AND arrival >= ? AND arrival <= ? AND id NOT IN (SELECT booking FROM inq_done)';
  const { results } = await db.prepare(`SELECT id, apt, arrival, departure ${where} ORDER BY arrival DESC LIMIT ?`).bind(from, to, limit).all();
  const left = await db.prepare(`SELECT COUNT(*) AS n ${where}`).bind(from, to).first();
  return { list: results || [], remaining: Number(left ? left.n : 0) };
}
/** Nachrichten einer Buchung speichern: msgs = [{ id, created, inbound, phase, text, cats: [{ cat, snippet }] }] */
export async function saveInquiries(db, booking, apt, msgs, now) {
  await ensureInquiries(db);
  const st = [db.prepare('INSERT OR REPLACE INTO inq_done (booking, at, n) VALUES (?, ?, ?)').bind(booking, now || Date.now(), msgs.length)];
  for (const m of msgs) {
    st.push(db.prepare('INSERT OR REPLACE INTO inq_msgs (id, booking, apt, created, inbound, phase, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(m.id, booking, apt, m.created, m.inbound == null ? null : m.inbound ? 1 : 0, m.phase, m.text));
    for (const c of m.cats || []) {
      st.push(db.prepare('INSERT OR REPLACE INTO inq_cats (msg, cat, booking, phase, created, snippet) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(m.id, c.cat, booking, m.phase, m.created, c.snippet));
    }
  }
  for (let i = 0; i < st.length; i += 50) await db.batch(st.slice(i, i + 50));
}
/** Auswertung: Themen mit Anzahl Nachrichten/Buchungen, Zeitpunkt und bis zu 3 Beispielen */
export async function inquiryReport(db) {
  await ensureInquiries(db);
  const q = (sql) => db.prepare(sql).all().then((r) => r.results || []);
  const [totals, dirs, cats, phases, examples] = await Promise.all([
    db.prepare('SELECT (SELECT COUNT(*) FROM inq_done) AS bookings, (SELECT COUNT(*) FROM inq_done WHERE n > 0) AS withMsgs, (SELECT COUNT(DISTINCT booking) FROM inq_msgs WHERE inbound = 1) AS asking, (SELECT MIN(created) FROM inq_msgs) AS oldest, (SELECT MAX(at) FROM inq_done) AS updated').first(),
    q('SELECT inbound, COUNT(*) AS n FROM inq_msgs GROUP BY inbound'),
    q('SELECT cat, COUNT(*) AS msgs, COUNT(DISTINCT booking) AS bookings FROM inq_cats GROUP BY cat'),
    q('SELECT cat, phase, COUNT(*) AS n FROM inq_cats GROUP BY cat, phase'),
    q('SELECT cat, snippet FROM (SELECT cat, snippet, ROW_NUMBER() OVER (PARTITION BY cat ORDER BY created DESC) AS rn FROM inq_cats) WHERE rn <= 3'),
  ]);
  return { totals: totals || {}, dirs, cats, phases, examples };
}
/** Zufällige Beispiele je Thema samt unserer ersten Antwort danach (für den Export) */
export async function inquiryExamples(db, perTopic, other) {
  await ensureInquiries(db);
  const { results } = await db.prepare(`SELECT c.cat, c.phase, c.snippet,
      (SELECT o.text FROM inq_msgs o WHERE o.booking = c.booking AND o.inbound = 0 AND o.created > c.created ORDER BY o.created LIMIT 1) AS reply
    FROM (SELECT cat, phase, snippet, booking, created, ROW_NUMBER() OVER (PARTITION BY cat ORDER BY RANDOM()) AS rn FROM inq_cats WHERE cat != 'thanks') c
    WHERE c.rn <= CASE WHEN c.cat = 'other' THEN ? ELSE ? END`).bind(other, perTopic).all();
  return results || [];
}
/** Stichprobe von Gastnachrichten (für die KI-Zusammenfassung) */
export async function inquirySample(db, limit) {
  await ensureInquiries(db);
  const { results } = await db.prepare('SELECT text FROM inq_msgs WHERE inbound = 1 AND length(text) > 15 ORDER BY RANDOM() LIMIT ?').bind(limit).all();
  return (results || []).map((r) => r.text);
}
export async function resetInquiries(db) {
  await ensureInquiries(db);
  await db.batch(['inq_done', 'inq_msgs', 'inq_cats'].map((t) => db.prepare(`DELETE FROM ${t}`)));
}
