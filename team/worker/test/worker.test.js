// Ende-zu-Ende-Test des Workers mit nachgebautem Smoobu und ntfy und einer
// echten SQLite-Datenbank (node:sqlite) anstelle von Cloudflare D1.
// Ausführen: cd worker && npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker, { runSync } from '../src/index.js';

/** Minimaler D1-Ersatz: prepare(sql).bind(...).first()/run() */
class SqliteD1 {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql) {
    const db = this.db;
    let args = [];
    const conv = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
    const stmt = {
      bind(...a) { args = a.map(conv); return stmt; },
      async first() { const row = db.prepare(sql).get(...args); return row ? { ...row } : null; },
      async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    };
    return stmt;
  }
  count(table) { return this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; }
}

// --- Nachgebautes Smoobu (HMAC in einer nicht naheliegenden Variante) und ntfy ---
const HMAC_KEY = 'hmac-key-123';
const HMAC_SECRET = 'geheim+secret/abc=';
function smoobuAuthorized(url, headers) {
  if (headers['Api-Key'] === 'smoobu-test-key') return true;
  if (headers['X-API-Key'] !== HMAC_KEY) return false;
  const u = new URL(url);
  const query = [...u.searchParams].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const lines = ['GET', u.pathname];
  if (query) lines.push(query);
  lines.push(headers['X-Timestamp'], headers['X-Nonce'], createHash('sha256').update('').digest('base64'), HMAC_KEY);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(headers['X-Timestamp'])) return false;
  return headers['X-Signature'] === createHmac('sha256', HMAC_SECRET).update(lines.join('\n')).digest('base64');
}
let smoobuBookings = [];
let pushes = [];
let smoobuCalls = 0;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://login.smoobu.com/api/')) {
    smoobuCalls++;
    if (!smoobuAuthorized(url, init.headers)) {
      return Response.json({ status: 401, title: 'Unauthorized', detail: 'Authentication required' }, { status: 401 });
    }
  }
  if (url.startsWith('https://login.smoobu.com/api/apartments')) {
    return Response.json({ apartments: [{ id: 111, name: 'FeWo Elbblick' }, { id: 222, name: 'Loft Altstadt' }] });
  }
  if (url.startsWith('https://login.smoobu.com/api/reservations?')) return Response.json({ page_count: 1, page: 1, bookings: smoobuBookings });
  if (url.startsWith('https://login.smoobu.com/api/reservations/')) {
    const b = smoobuBookings.find((x) => String(x.id) === url.split('/').pop());
    return b ? Response.json(b) : new Response('not found', { status: 404 });
  }
  if (url === 'https://ntfy.sh') {
    pushes.push(JSON.parse(init.body));
    return Response.json({ id: 'x' });
  }
  throw new Error('Unerwarteter Aufruf: ' + url);
};

const env = {
  DB: new SqliteD1(), APP_SECRET: 'test-geheimnis', ADMIN_PASSWORD: 'admin-passwort', SMOOBU_API_KEY: 'smoobu-test-key',
  ASSETS: {
    fetch: async (req) => {
      const root = new URL(req.url).pathname === '/';
      return new Response(root ? 'APP' : 'nicht da', { status: root ? 200 : 404 });
    },
  },
};
const at = (date, time) => new Date(`${date}T${time}:00+02:00`).getTime();
const booking = (id, departure, extra) => ({
  id, type: 'reservation', arrival: '2026-09-20', departure,
  apartment: { id: 111, name: 'FeWo Elbblick' }, 'guest-name': 'Familie Müller', ...extra,
});

async function call(method, path, { session, body, headers = {} } = {}) {
  const pending = [];
  if (session) headers.Authorization = `Bearer ${session}`;
  const isForm = body instanceof FormData;
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(
    new Request('https://team.apartments-strauss.de' + path, { method, headers, body: isForm ? body : body && JSON.stringify(body) }),
    env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  const type = res.headers.get('Content-Type') || '';
  if (type.startsWith('image/')) return { status: res.status, type, bytes: [...new Uint8Array(await res.arrayBuffer())] };
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
}

let admin; // Sitzung Auftraggeber
let anna;  // Sitzung Reinigungskraft
let annaId;
const topicOf = async (session) => (await call('GET', '/api/me', { session })).body.topic;

test('Anmeldung: /admin mit Passwort, Reinigungskraft anlegen, Anmeldung mit 6-stelligem Code', async () => {
  assert.equal((await call('GET', '/admin')).body, 'APP', '/admin liefert die App');
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('POST', '/api/admin-login', { body: { password: 'falsch' } })).status, 401);
  const login = await call('POST', '/api/admin-login', { body: { password: 'admin-passwort' } });
  assert.equal(login.status, 200);
  admin = login.body.session;

  const created = await call('POST', '/api/team', { session: admin, body: { name: 'Anna', apartments: 'all' } });
  assert.equal(created.status, 200);
  const code = created.body.newCode.code;
  assert.match(code, /^\d{6}$/);
  annaId = created.body.cleaners[0].id;
  assert.equal(created.body.cleaners[0].codeHash, undefined, 'Code-Hash wird nie ausgeliefert');
  assert.ok(!env.DB.db.prepare('SELECT data FROM settings').get().data.includes(code), 'Code nicht im Klartext gespeichert');

  assert.equal((await call('POST', '/api/login', { body: { code: code === '000000' ? '111111' : '000000' } })).status, 401);
  const cl = await call('POST', '/api/login', { body: { code } });
  assert.equal(cl.status, 200);
  anna = cl.body.session;
  const me = await call('GET', '/api/me', { session: anna });
  assert.equal(me.body.user.name, 'Anna');
  assert.equal(me.body.user.role, 'cleaner');
  assert.equal((await call('POST', '/api/team', { session: anna, body: { name: 'X' } })).status, 404, 'nur Auftraggeber');
});

test('Admin-Code: festlegen und damit auf der Startseite in die Gesamtübersicht', async () => {
  assert.equal((await call('POST', '/api/owner-code', { session: admin, body: { code: '123456' } })).status, 400, 'zu leicht');
  assert.equal((await call('POST', '/api/owner-code', { session: admin, body: { code: '12a456' } })).status, 400);
  assert.equal((await call('POST', '/api/owner-code', { session: anna, body: { code: '482913' } })).status, 404, 'nur Auftraggeber');
  const res = await call('POST', '/api/owner-code', { session: admin, body: { code: '482913' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.hasOwnerCode, true);
  assert.ok(!env.DB.db.prepare('SELECT data FROM settings').get().data.includes('482913'), 'nur als Hash gespeichert');
  const login = await call('POST', '/api/login', { body: { code: '482 913' } });
  assert.equal(login.status, 200);
  const me = await call('GET', '/api/me', { session: login.body.session });
  assert.equal(me.body.user.role, 'owner');
});

test('Zu viele falsche Codes → Sperre für diese Verbindung', async () => {
  const headers = () => ({ 'CF-Connecting-IP': '203.0.113.9' });
  for (let i = 0; i < 8; i++) await call('POST', '/api/login', { body: { code: '99999' + i }, headers: headers() });
  assert.equal((await call('POST', '/api/login', { body: { code: '999990' }, headers: headers() })).status, 429);
});

test('Ablauf: Import, neue Buchung, Bestätigen, Verlängern, Fristen, Löschen, Webhook', async () => {
  smoobuBookings = [booking(1, '2026-09-25')];
  const s = await runSync(env, at('2026-09-23', '09:00'));
  assert.equal(s.syncError, null);
  assert.equal(pushes.length, 0, 'erster Abgleich still');

  smoobuBookings.push(booking(2, '2026-09-27'));
  await runSync(env, at('2026-09-23', '09:15'));
  assert.deepEqual(pushes.map((p) => [p.topic, p.title]), [[await topicOf(anna), 'Neue Endreinigung']]);

  let me = await call('GET', '/api/me', { session: anna });
  assert.deepEqual(me.body.tasks.map((t) => [t.id, t.guest, t.source]), [['1', '', 'smoobu'], ['2', '', 'smoobu']]);
  assert.ok(me.body.tasks[1].createdAt, 'Eintragungszeit wird mitgeliefert');

  pushes = [];
  assert.equal((await call('POST', '/api/tasks/2/confirm', { session: anna })).status, 200);
  assert.deepEqual(pushes.map((p) => [p.topic, p.title]), [[await topicOf(admin), 'Reinigung bestätigt']]);

  pushes = [];
  smoobuBookings[1] = booking(2, '2026-09-28');
  await runSync(env, at('2026-09-23', '09:30'));
  assert.deepEqual(pushes.map((p) => p.title).sort(), ['Bestätigte Reinigung verschoben', 'Reinigung verschoben']);

  pushes = [];
  await runSync(env, at('2026-09-25', '12:00'));
  assert.deepEqual(pushes.map((p) => [p.title, p.priority]), [['Erinnerung: Reinigung bestätigen', 4]]);
  pushes = [];
  await runSync(env, at('2026-09-25', '13:00'));
  assert.equal(pushes.length, 2, 'Alarm an Reinigungskraft und Auftraggeber');

  pushes = [];
  smoobuBookings = smoobuBookings.filter((b) => b.id !== 2);
  await runSync(env, at('2026-09-25', '13:15'));
  assert.deepEqual(pushes.map((p) => p.title), ['Reinigung entfällt']);

  const hookPath = new URL((await call('GET', '/api/me', { session: admin })).body.webhookUrl).pathname;
  assert.equal((await call('POST', '/api/smoobu-webhook/falsch', { body: {} })).status, 404);
  pushes = [];
  assert.equal((await call('POST', hookPath, { body: { action: 'newReservation', data: booking(3, '2026-10-01') } })).status, 200);
  assert.deepEqual(pushes.map((p) => p.title), ['Neue Endreinigung']);

  me = await call('GET', '/api/me', { session: admin });
  assert.deepEqual(me.body.apartments, [{ id: '111', name: 'FeWo Elbblick' }, { id: '222', name: 'Loft Altstadt' }]);
});

test('Erledigte Reinigungen bleiben für die Reinigungskraft sichtbar', async () => {
  smoobuBookings = [booking(40, '2099-09-26')];
  await runSync(env, at('2026-09-26', '08:00'));
  assert.equal((await call('POST', '/api/tasks/40/confirm', { session: anna })).status, 200);
  assert.equal((await call('POST', '/api/tasks/40/done', { session: anna })).status, 200);
  const me = await call('GET', '/api/me', { session: anna });
  assert.equal(me.body.tasks.find((x) => x.id === '40').status, 'erledigt');
});

test('Meldung mit Foto: Push an Auftraggeber, Foto nur mit Anmeldung, als behoben markierbar', async () => {
  smoobuBookings = [booking(20, '2099-10-12')];
  await runSync(env, at('2026-09-27', '09:00'));
  pushes = [];
  const form = new FormData();
  form.append('text', 'Kaffeemaschine defekt');
  form.append('photo', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], { type: 'image/jpeg' }), 'foto.jpg');
  const res = await call('POST', '/api/tasks/20/report', { session: anna, body: form });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(pushes.map((p) => p.title), ['Meldung: FeWo Elbblick']);
  const rep = res.body.tasks.find((t) => t.id === '20').reports[0];

  const img = await call('GET', `/api/photos/${rep.photos[0]}?a=${admin}`);
  assert.equal(img.status, 200);
  assert.equal(img.type, 'image/jpeg');
  assert.deepEqual(img.bytes, [0xff, 0xd8, 0xff, 1, 2, 3], 'Foto unverändert');
  assert.equal((await call('GET', `/api/photos/${rep.photos[0]}`)).status, 401);

  const before = env.DB.count('photos');
  const bad = new FormData();
  bad.append('text', 'x');
  bad.append('photo', new Blob(['hallo'], { type: 'text/plain' }), 'x.txt');
  assert.equal((await call('POST', '/api/tasks/20/report', { session: anna, body: bad })).status, 400);
  assert.equal(env.DB.count('photos'), before, 'nichts gespeichert');

  const me = await call('GET', '/api/me', { session: admin });
  assert.equal(me.body.openReports.length, 1);
  const done = await call('POST', `/api/tasks/20/reports/${rep.id}/resolve`, { session: admin });
  assert.equal(done.body.openReports.length, 0);
});

test('manuelle Reinigung: Push an Reinigungskraft, absagen, Abgleich lässt sie in Ruhe', async () => {
  pushes = [];
  const res = await call('POST', '/api/manual', { session: admin, body: { apartmentId: '222', date: '2099-01-02', note: 'Grundreinigung' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const task = res.body.tasks.find((t) => t.manual);
  assert.equal(task.apartmentName, 'Loft Altstadt');
  assert.equal(task.source, 'manuell');
  assert.deepEqual(pushes.map((p) => p.title), ['Zusätzliche Reinigung']);
  await runSync(env, at('2026-09-27', '09:15'));
  const me = await call('GET', '/api/me', { session: anna });
  assert.equal(me.body.tasks.find((t) => t.id === task.id).status, 'offen');
  pushes = [];
  assert.equal((await call('POST', `/api/tasks/${task.id}/cancel`, { session: admin })).status, 200);
  assert.deepEqual(pushes.map((p) => p.title), ['Reinigung entfällt']);
});

test('Team: bearbeiten, neuer Code meldet alte Geräte ab', async () => {
  let res = await call('POST', `/api/team/${annaId}`, { session: admin, body: { name: 'Anna M.', apartments: ['111'] } });
  assert.deepEqual(res.body.cleaners.map((c) => [c.name, c.apartments]), [['Anna M.', ['111']]]);
  res = await call('POST', `/api/team/${annaId}/code`, { session: admin });
  assert.match(res.body.newCode.code, /^\d{6}$/);
  assert.equal((await call('GET', '/api/me', { session: anna })).status, 401, 'alte Anmeldung ungültig');
  anna = (await call('POST', '/api/login', { body: { code: res.body.newCode.code } })).body.session;
  assert.equal((await call('GET', '/api/me', { session: anna })).status, 200);
});

test('Zurücksetzen nur mit Bestätigung; Team und Anmeldungen bleiben erhalten', async () => {
  assert.equal((await call('POST', '/api/reset', { session: admin, body: { confirm: 'ja' } })).status, 400);
  pushes = [];
  smoobuBookings = [booking(30, '2099-10-20'), booking(31, '2099-10-21')];
  const res = await call('POST', '/api/reset', { session: admin, body: { confirm: 'ZURÜCKSETZEN' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.tasks.map((t) => t.id), ['30', '31']);
  assert.equal(env.DB.count('photos'), 0);
  assert.equal(pushes.length, 0);
  assert.equal(res.body.cleaners.length, 1, 'Reinigungskraft bleibt');
  assert.equal((await call('GET', '/api/me', { session: anna })).status, 200, 'Anmeldung bleibt gültig');
});

test('Team: Reinigungskraft entfernen → Anmeldung ungültig', async () => {
  const res = await call('POST', `/api/team/${annaId}/delete`, { session: admin });
  assert.equal(res.body.cleaners.length, 0);
  assert.equal((await call('GET', '/api/me', { session: anna })).status, 401);
});

test('HMAC: richtige Signaturform wird automatisch gefunden', async () => {
  const saved = env.SMOOBU_API_KEY;
  env.SMOOBU_API_KEY = ` "${HMAC_KEY}" `; // mit Anführungszeichen/Leerzeichen kopiert
  env.SMOOBU_API_SECRET = HMAC_SECRET;
  try {
    const diag = await call('POST', '/api/diagnose', { session: admin });
    const login = diag.body.results.find((r) => r.variant === 'Anmeldung (HMAC)');
    assert.match(login.topKeys[0], /funktioniert: Hash base64, Pfad mit \/api, Zeit ohne ms, leere Query-Zeile nein/);
    assert.ok(!JSON.stringify(diag.body).includes('Müller'), 'keine Gästedaten');
    smoobuCalls = 0;
    const s = await runSync(env, at('2026-09-27', '10:00'));
    assert.equal(s.syncError, null);
    assert.equal(smoobuCalls, 2, 'Buchungen + Wohnungen, keine erneute Erkennung');
    env.SMOOBU_API_SECRET = 'falsch';
    assert.match((await runSync(env, at('2026-09-27', '10:15'))).syncError, /lehnt die Anmeldung ab \(401\)/);
  } finally {
    env.SMOOBU_API_KEY = saved;
    delete env.SMOOBU_API_SECRET;
  }
});

test('Fehlender Smoobu-Schlüssel wird klar gemeldet', async () => {
  const saved = env.SMOOBU_API_KEY;
  delete env.SMOOBU_API_KEY;
  const s = await runSync(env, at('2026-09-27', '11:00'));
  env.SMOOBU_API_KEY = saved;
  assert.match(s.syncError, /SMOOBU_API_KEY fehlt – bitte in Cloudflare als „Secret“ eintragen/);
});
