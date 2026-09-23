// Speichert den gesamten Zustand als ein JSON-Dokument in Cloudflare D1.
// Die Versionsnummer verhindert, dass sich gleichzeitige Änderungen
// (z. B. Abgleich mit Smoobu und Klick auf „Bestätigen“) gegenseitig überschreiben.
import L from '../../logic/logic.js';

const MAX_LOG = 100;

async function ensureTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL)').run();
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
