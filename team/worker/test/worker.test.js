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

let admin;   // Sitzung Admin
let lea;     // Sitzung Reinigungsleitung
let mia;     // Sitzung Mitarbeiterin
let leaId, miaId;
const me = async (session) => (await call('GET', '/api/me', { session })).body;
const topicOf = async (session) => (await me(session)).topic;
const who = () => pushes.map((p) => p.title);

test('Admin (Notzugang /admin) legt Leitung an, Leitung legt Mitarbeiterin an, Anmeldung per Code', async () => {
  assert.equal((await call('GET', '/admin')).body, 'APP');
  assert.equal((await call('POST', '/api/admin-login', { body: { password: 'falsch' } })).status, 401);
  admin = (await call('POST', '/api/admin-login', { body: { password: 'admin-passwort' } })).body.session;

  const lead = await call('POST', '/api/team', { session: admin, body: { name: 'Lea', role: 'lead' } });
  assert.equal(lead.status, 200);
  leaId = lead.body.leads[0].id;
  lea = (await call('POST', '/api/login', { body: { code: lead.body.newCode.code } })).body.session;
  assert.equal((await me(lea)).user.role, 'lead');

  assert.equal((await call('POST', '/api/team', { session: lea, body: { name: 'X', role: 'lead' } })).status, 403, 'Leitung legt keine Leitung an');
  const staff = await call('POST', '/api/team', { session: lea, body: { name: 'Mia' } });
  assert.equal(staff.status, 200);
  miaId = staff.body.staff[0].id;
  mia = (await call('POST', '/api/login', { body: { code: staff.body.newCode.code } })).body.session;
  const m = await me(mia);
  assert.equal(m.user.role, 'staff');
  assert.equal((await call('POST', '/api/team', { session: mia, body: { name: 'Y' } })).status, 403);
  assert.equal((await call('POST', `/api/team/${miaId}`, { session: lea, body: { name: 'Mia K.' } })).body.staff[0].name, 'Mia K.');
  assert.ok(!env.DB.db.prepare('SELECT data FROM settings').get().data.includes(staff.body.newCode.code), 'nur Hash gespeichert');
});

test('Admin-Code: festlegen und damit auf der Startseite anmelden', async () => {
  assert.equal((await call('POST', '/api/owner-code', { session: admin, body: { code: '123456' } })).status, 400);
  assert.equal((await call('POST', '/api/owner-code', { session: lea, body: { code: '482913' } })).status, 404);
  assert.equal((await call('POST', '/api/owner-code', { session: admin, body: { code: '482913' } })).body.hasOwnerCode, true);
  const login = await call('POST', '/api/login', { body: { code: '482913' } });
  assert.equal((await me(login.body.session)).user.role, 'owner');
});

test('3 falsche Codes → 1 Minute gesperrt', async () => {
  const headers = () => ({ 'CF-Connecting-IP': '203.0.113.9' });
  let r = await call('POST', '/api/login', { body: { code: '999990' }, headers: headers() });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /noch 2 Versuche/);
  await call('POST', '/api/login', { body: { code: '999991' }, headers: headers() });
  r = await call('POST', '/api/login', { body: { code: '999992' }, headers: headers() });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /1 Minute gesperrt/);
  r = await call('POST', '/api/login', { body: { code: '482913' }, headers: headers() });
  assert.equal(r.status, 429, 'auch richtiger Code während der Sperre abgelehnt');
  assert.ok(r.body.retryAfter > 0 && r.body.retryAfter <= 60);
});

test('Ablauf: neue Buchung → Leitung → Zuweisung → Mitarbeiterin sieht und bestätigt', async () => {
  smoobuBookings = [booking(1, '2099-09-25', { phone: '+49 170 555' })];
  await runSync(env, at('2026-09-23', '09:00'));
  assert.equal(pushes.length, 0, 'erster Abgleich still');
  smoobuBookings.push(booking(2, '2099-09-27'));
  await runSync(env, at('2026-09-23', '09:15'));
  assert.deepEqual(pushes.map((p) => [p.topic, p.title]), [[await topicOf(lea), 'Neue Reinigung']]);

  assert.equal((await me(mia)).tasks.length, 0, 'Mitarbeiterin sieht noch nichts');
  const leadView = await me(lea);
  assert.equal(leadView.tasks.length, 2);
  assert.equal(leadView.tasks[0].guestPhone, '+49 170 555', 'Telefonnummer des Gastes');
  assert.equal(leadView.tasks[0].guest, '', 'Gastname ausgeblendet');

  pushes = [];
  const assigned = await call('POST', '/api/tasks/2/assign', { session: lea, body: { to: miaId } });
  assert.equal(assigned.status, 200);
  assert.deepEqual(pushes.map((p) => [p.topic, p.title]), [[await topicOf(mia), 'Neue Reinigung für dich']]);
  assert.equal((await call('POST', '/api/tasks/2/assign', { session: mia, body: { to: miaId } })).status, 403);

  const mv = await me(mia);
  assert.deepEqual(mv.tasks.map((t) => t.id), ['2']);
  assert.equal(mv.changes[0].title, 'Neue Reinigung für dich', 'Neuigkeiten oben');
  pushes = [];
  const confirmed = await call('POST', '/api/tasks/2/confirm', { session: mia });
  assert.equal(confirmed.body.tasks[0].status, 'bestätigt');
  assert.deepEqual(pushes.map((p) => [p.topic, p.title]), [[await topicOf(admin), 'Reinigung bestätigt']]);

  const seen = await call('POST', '/api/seen', { session: mia });
  assert.ok(seen.body.seenAt);
});

test('Beginn und Ende erfassen; Admin kann nicht abhaken', async () => {
  assert.equal((await call('POST', '/api/tasks/2/start', { session: admin })).status, 403);
  const s = await call('POST', '/api/tasks/2/start', { session: mia });
  assert.ok(s.body.tasks[0].startedAt);
  pushes = [];
  assert.equal((await call('POST', '/api/tasks/2/done', { session: mia })).status, 409, 'Schlüssel-Frage ist Pflicht');
  const d = await call('POST', '/api/tasks/2/done', { session: mia, body: { keysInBox: false, keysNote: 'fehlt' } });
  assert.equal(d.body.tasks[0].status, 'erledigt');
  assert.deepEqual(who().sort(), ['Reinigung erledigt', 'Reinigung erledigt', 'Schlüssel fehlen: FeWo Elbblick']);
  assert.equal(pushes.find((p) => p.title.startsWith('Schlüssel')).priority, 5);
  assert.equal((await me(admin)).missingKeys.length, 1);
  assert.equal((await call('POST', '/api/tasks/2/keys-resolved', { session: mia })).status, 403);
  assert.equal((await call('POST', '/api/tasks/2/keys-resolved', { session: admin, body: { note: 'ok' } })).body.missingKeys.length, 0);
  assert.equal((await me(mia)).tasks[0].status, 'erledigt', 'bleibt sichtbar (grau)');
});

test('6-Stunden-Frist und 12/15-Uhr-Erinnerungen laufen über den Abgleich', async () => {
  pushes = [];
  smoobuBookings = [booking(1, '2099-09-25', { phone: '+49 170 555' })];
  await runSync(env, at('2026-09-23', '15:15'));
  assert.deepEqual(who(), ['Reinigung nicht bestätigt'], '6 Std. nach 09:00 nicht bestätigt → Admin');
  assert.equal(pushes[0].topic, await topicOf(admin));
  assert.equal(pushes[0].priority, 5);
});

test('Hinweis vom Admin mit Foto → Leitung + Mitarbeiterin; Mitarbeiterin löscht eigenes Foto', async () => {
  smoobuBookings = [booking(20, '2099-10-12')];
  await runSync(env, at('2026-09-27', '09:00'));
  await call('POST', '/api/tasks/20/assign', { session: lea, body: { to: miaId } });
  pushes = [];
  const note = new FormData();
  note.append('text', 'Bitte Kaffee auffüllen');
  note.append('photo', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 9])], { type: 'image/jpeg' }), 'a.jpg');
  const n = await call('POST', '/api/tasks/20/report', { session: admin, body: note });
  assert.equal(n.status, 200, JSON.stringify(n.body));
  assert.deepEqual(who().sort(), ['Hinweis von Apartments Strauss: FeWo Elbblick', 'Hinweis von Apartments Strauss: FeWo Elbblick']);

  pushes = [];
  const rep = new FormData();
  rep.append('text', 'Glühbirne defekt');
  rep.append('photo', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'b.jpg');
  rep.append('photo', new Blob([new Uint8Array([4, 5, 6])], { type: 'image/jpeg' }), 'c.jpg');
  const r = await call('POST', '/api/tasks/20/report', { session: mia, body: rep });
  assert.deepEqual(who().sort(), ['Meldung: FeWo Elbblick', 'Meldung: FeWo Elbblick'], 'an Admin + Leitung');
  const report = r.body.tasks.find((t) => t.id === '20').reports.find((x) => x.text === 'Glühbirne defekt');
  const adminNote = r.body.tasks.find((t) => t.id === '20').reports.find((x) => x.byRole === 'owner');
  assert.equal((await call('POST', `/api/tasks/20/reports/${adminNote.id}/photos/${adminNote.photos[0]}/delete`, { session: mia })).status, 403);
  const before = env.DB.count('photos');
  const del = await call('POST', `/api/tasks/20/reports/${report.id}/photos/${report.photos[0]}/delete`, { session: mia });
  assert.equal(del.status, 200);
  assert.equal(env.DB.count('photos'), before - 1, 'Foto auch aus der Datenbank gelöscht');
  const img = await call('GET', `/api/photos/${report.photos[1]}?a=${admin}`);
  assert.deepEqual(img.bytes, [4, 5, 6]);
  assert.equal((await me(admin)).openReports.length, 1, 'Meldung der Mitarbeiterin offen, Admin-Hinweis nicht');
});

test('Manuelle Reinigung: anlegen → Leitung; verschieben → Neuigkeit bei Leitung', async () => {
  pushes = [];
  const res = await call('POST', '/api/manual', { session: admin, body: { apartmentId: '222', date: '2099-01-02', note: 'Grundreinigung' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const task = res.body.tasks.find((t) => t.manual);
  assert.equal(task.apartmentName, 'Loft Altstadt');
  assert.deepEqual(who(), ['Zusätzliche Reinigung']);
  pushes = [];
  const moved = await call('POST', `/api/tasks/${task.id}/edit`, { session: admin, body: { date: '2099-01-05' } });
  assert.equal(moved.body.tasks.find((t) => t.id === task.id).date, '2099-01-05');
  assert.deepEqual(who(), ['Reinigung verschoben']);
  assert.match((await me(lea)).changes[0].body, /statt/);
  assert.equal((await call('POST', `/api/tasks/${task.id}/edit`, { session: lea, body: { date: '2099-01-06' } })).status, 403);
  assert.equal((await call('POST', `/api/tasks/${task.id}/cancel`, { session: admin })).status, 200);
});

test('Codes bleiben sichtbar: Admin sieht alle, Leitung ihre Mitarbeiterinnen, Mitarbeiterin keine', async () => {
  const a = await me(admin);
  assert.match(a.leads[0].code, /^\d{6}$/);
  assert.match(a.staff[0].code, /^\d{6}$/);
  const l = await me(lea);
  assert.equal(l.leads[0].code, undefined, 'Leitung sieht keine Leitungs-Codes');
  assert.equal(l.staff[0].code, a.staff[0].code);
  const m = await me(mia);
  assert.equal(m.staff[0].code, undefined);
  const raw = env.DB.db.prepare('SELECT data FROM settings').get().data;
  assert.ok(!raw.includes(a.staff[0].code), 'Code nur verschlüsselt gespeichert');
  // Mit dem angezeigten Code kann man sich anmelden
  assert.equal((await call('POST', '/api/login', { body: { code: a.staff[0].code } })).status, 200);
});

test('Belegungskalender: Buchungen mit Namen (Admin), Sperrzeiten, nummerierte Wohnungen', async () => {
  smoobuBookings = [
    booking(60, '2099-10-05', { arrival: '2099-10-01' }),
    { id: 61, type: 'reservation', arrival: '2099-10-03', departure: '2099-10-08', apartment: { id: 222, name: 'Loft Altstadt' }, 'guest-name': '', 'is-blocked-booking': true },
  ];
  await runSync(env, at('2026-09-27', '12:00'));
  const cal = (await call('GET', '/api/calendar?from=2099-09-30&days=14', { session: admin })).body;
  assert.deepEqual(cal.apartments.map((x) => [x.number, x.name]), [[1, 'FeWo Elbblick'], [2, 'Loft Altstadt']]);
  const b60 = cal.bookings.find((x) => x.id === '60');
  assert.equal(b60.guest, 'Familie Müller');
  assert.equal(cal.bookings.find((x) => x.id === '61').blocked, true);
  assert.ok(cal.cleanings.some((c) => c.id === '60' && c.date === '2099-10-05'));
  const leadCal = (await call('GET', '/api/calendar?from=2099-09-30&days=14', { session: lea })).body;
  assert.equal(leadCal.bookings.find((x) => x.id === '60').guest, '', 'Leitung ohne Gastnamen');
  assert.equal((await call('GET', '/api/calendar', { session: mia })).status, 404, 'Mitarbeiterin hat keinen Kalender');
  assert.equal((await me(lea)).tasks.some((t) => t.id === '61'), false, 'Sperrzeit ist keine Reinigung');
});

test('Push eingerichtet wird je Benutzerkonto gemerkt (auch nach Zurücksetzen)', async () => {
  assert.equal((await me(mia)).pushOk, false);
  const r = await call('POST', '/api/push-ok', { session: mia });
  assert.equal(r.body.pushOk, true);
  assert.equal((await me(lea)).pushOk, false, 'gilt nur für dieses Konto');
});

test('ntfy 429: erneuter Versuch, dann verständliche Meldung; mit NTFY_TOKEN wird Token mitgeschickt', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0; let authHeader = null;
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://ntfy.sh') { calls++; authHeader = init.headers.Authorization; return new Response('limit', { status: 429 }); }
    return realFetch(url, init);
  };
  try {
    const r = await call('POST', '/api/test-push', { session: mia });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /NTFY_TOKEN/);
    assert.equal(calls, 3, 'zwei weitere Versuche');
    env.NTFY_TOKEN = 'tk_test';
    globalThis.fetch = async (url, init) => {
      if (String(url) === 'https://ntfy.sh') { authHeader = init.headers.Authorization; return Response.json({ id: 'x' }); }
      return realFetch(url, init);
    };
    assert.equal((await call('POST', '/api/test-push', { session: mia })).status, 200);
    assert.equal(authHeader, 'Bearer tk_test');
  } finally {
    globalThis.fetch = realFetch;
    delete env.NTFY_TOKEN;
  }
});

test('Überfällige Reinigung heute: Erinnerung wird verschickt; Versandfehler werden für Admin sichtbar', async () => {
  const day = '2099-12-01';
  const mk = (h, m) => new Date(`${day}T${h}:${m}:00+01:00`).getTime();
  smoobuBookings = [booking(70, day, { arrival: '2099-11-28' })];
  await runSync(env, mk('08', '00'));
  await call('POST', '/api/tasks/70/assign', { session: lea, body: { to: miaId } });
  pushes = [];
  await runSync(env, mk('12', '05'));
  const titles = pushes.filter((p) => p.title === 'Reinigung muss heute noch gestartet werden').map((p) => p.topic).sort();
  assert.deepEqual(titles, [await topicOf(admin), await topicOf(lea), await topicOf(mia)].sort());
  pushes = [];
  await runSync(env, mk('12', '10'));
  assert.equal(pushes.filter((p) => p.title.startsWith('Reinigung muss')).length, 0, 'erst nach 30 Min. wieder');
  // Versand scheitert → Fehler in der Admin-Ansicht
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url) === 'https://ntfy.sh' ? new Response('x', { status: 429 }) : realFetch(url, init));
  try {
    await runSync(env, mk('12', '40'));
  } finally {
    globalThis.fetch = realFetch;
  }
  const report = (await me(admin)).pushReport;
  assert.ok(report.failed >= 3);
  assert.match(report.errors[0].error, /429/);
  assert.equal((await me(admin)).rules.quietFrom, '22:00');
});

test('Manuelle Reinigung nach 12 Uhr für heute eingetragen → Erinnerung kommt sofort', async () => {
  const day = '2099-12-03';
  const realNow = Date.now;
  Date.now = () => new Date(`${day}T13:20:00+01:00`).getTime();
  try {
    pushes = [];
    const res = await call('POST', '/api/manual', { session: admin, body: { apartmentId: '1', date: day, note: 'spät' } });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    const got = pushes.filter((p) => p.title === 'Reinigung muss heute noch gestartet werden').map((p) => p.topic);
    assert.ok(got.includes(await topicOf(admin)));
    assert.ok(got.includes(await topicOf(lea)));
    assert.ok(got.includes(await topicOf(mia)), 'noch nicht zugewiesen → alle Mitarbeiterinnen');
  } finally {
    Date.now = realNow;
  }
});

test('Zeitraum: Mitarbeiterin beantragt, Admin sieht Antrag und genehmigt; Admin kann selbst festlegen', async () => {
  smoobuBookings = [booking(80, '2099-10-01', { arrival: '2099-09-27' })];
  await runSync(env);
  await call('POST', '/api/tasks/80/assign', { session: lea, body: { to: miaId } });
  const topicAdmin = await topicOf(admin);
  pushes = [];
  const bad = await call('POST', '/api/tasks/80/period-request', { session: mia, body: { until: '2099-10-02', reason: '' } });
  assert.equal(bad.status, 400);
  const req = await call('POST', '/api/tasks/80/period-request', { session: mia, body: { until: '2099-10-02', reason: 'Personalengpass' } });
  assert.equal(req.status, 200);
  assert.ok(pushes.some((p) => p.topic === topicAdmin && p.title.startsWith('Antrag:')));
  assert.equal((await call('POST', '/api/tasks/80/period-decide', { session: mia, body: { approve: true } })).status, 403);
  const a = await me(admin);
  assert.equal(a.openRequests.length, 1);
  assert.equal(a.openRequests[0].reason, 'Personalengpass');
  const ok = await call('POST', '/api/tasks/80/period-decide', { session: admin, body: { approve: true, comment: 'passt' } });
  assert.equal(ok.body.openRequests.length, 0);
  assert.equal(ok.body.tasks.find((t) => t.id === '80').latestDate, '2099-10-02');
  assert.ok((await me(mia)).changes.some((c) => c.title === 'Zeitraum genehmigt'));
  // Admin übersteuert direkt und hebt wieder auf
  assert.equal((await call('POST', '/api/tasks/80/period', { session: admin, body: { until: '2099-10-03' } })).body.tasks.find((t) => t.id === '80').latestDate, '2099-10-03');
  assert.equal((await call('POST', '/api/tasks/80/period', { session: lea, body: { until: '2099-10-03' } })).status, 403);
  assert.equal((await call('POST', '/api/tasks/80/period', { session: admin, body: { until: null } })).body.tasks.find((t) => t.id === '80').latestDate, null);
});

test('Viele Nachrichten auf einmal → höchstens eine Sammelnachricht je Person', async () => {
  const { limit } = await import('../src/notify.js');
  const user = { id: 'u1', name: 'A' };
  const msgs = Array.from({ length: 30 }, (_, i) => ({ user: i % 2 ? user : { id: 'u2', name: 'B' }, kind: i % 3 ? 'new' : 'late', title: 'T' + i, body: 'B' + i }));
  const out = limit(msgs, 25);
  assert.equal(out.length, 2);
  assert.match(out[0].title, /15 Hinweise/);
});

test('Neuer Code meldet alte Geräte ab; Entfernen', async () => {
  const res = await call('POST', `/api/team/${miaId}/code`, { session: lea });
  assert.match(res.body.newCode.code, /^\d{6}$/);
  assert.equal((await call('GET', '/api/me', { session: mia })).status, 401);
  mia = (await call('POST', '/api/login', { body: { code: res.body.newCode.code } })).body.session;
  assert.equal((await call('GET', '/api/me', { session: mia })).status, 200);
});

test('Zurücksetzen: nur mit Bestätigung, Team bleibt', async () => {
  assert.equal((await call('POST', '/api/reset', { session: admin, body: { confirm: 'ja' } })).status, 400);
  assert.equal((await call('POST', '/api/reset', { session: lea, body: { confirm: 'ZURÜCKSETZEN' } })).status, 404);
  pushes = [];
  smoobuBookings = [booking(30, '2099-10-20')];
  const res = await call('POST', '/api/reset', { session: admin, body: { confirm: 'ZURÜCKSETZEN' } });
  assert.deepEqual(res.body.tasks.map((t) => t.id), ['30']);
  assert.equal(env.DB.count('photos'), 0);
  assert.equal(pushes.length, 0);
  assert.equal(res.body.leads.length, 1);
  assert.equal(res.body.staff.length, 1);
});

test('Viele gleichartige Nachrichten werden gebündelt', async () => {
  pushes = [];
  smoobuBookings = [booking(30, '2099-10-20'), ...[41, 42, 43, 44].map((id, i) => booking(id, `2099-11-0${i + 1}`))];
  await runSync(env, at('2026-09-28', '09:00'));
  assert.ok(who().includes('4 neue Reinigungen'));
  assert.ok(!who().includes('Neue Reinigung'), 'keine Einzelnachrichten');
  assert.match(pushes.find((p) => p.title === '4 neue Reinigungen').message, /• FeWo Elbblick/);
});

test('Leitung entfernen → Anmeldung ungültig', async () => {
  const res = await call('POST', `/api/team/${leaId}/delete`, { session: admin });
  assert.equal(res.body.leads.length, 0);
  assert.equal((await call('GET', '/api/me', { session: lea })).status, 401);
});

test('HMAC: richtige Signaturform wird automatisch gefunden', async () => {
  const saved = env.SMOOBU_API_KEY;
  env.SMOOBU_API_KEY = ` "${HMAC_KEY}" `;
  env.SMOOBU_API_SECRET = HMAC_SECRET;
  try {
    const diag = await call('POST', '/api/diagnose', { session: admin });
    const login = diag.body.results.find((r) => r.variant === 'Anmeldung (HMAC)');
    assert.match(login.topKeys[0], /funktioniert: Hash base64, Pfad mit \/api, Zeit ohne ms, leere Query-Zeile nein/);
    assert.ok(!JSON.stringify(diag.body).includes('Müller'), 'keine Gästedaten');
    smoobuCalls = 0;
    const s = await runSync(env, at('2026-09-28', '10:00'));
    assert.equal(s.syncError, null);
    assert.equal(smoobuCalls, 2, 'Buchungen + Wohnungen, keine erneute Erkennung');
    env.SMOOBU_API_SECRET = 'falsch';
    assert.match((await runSync(env, at('2026-09-28', '10:15'))).syncError, /lehnt die Anmeldung ab \(401\)/);
  } finally {
    env.SMOOBU_API_KEY = saved;
    delete env.SMOOBU_API_SECRET;
  }
});

test('Fehlender Smoobu-Schlüssel wird klar gemeldet', async () => {
  const saved = env.SMOOBU_API_KEY;
  delete env.SMOOBU_API_KEY;
  const s = await runSync(env, at('2026-09-28', '11:00'));
  env.SMOOBU_API_KEY = saved;
  assert.match(s.syncError, /SMOOBU_API_KEY fehlt/);
});
