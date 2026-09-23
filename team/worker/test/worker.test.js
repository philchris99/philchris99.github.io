// Ende-zu-Ende-Test des Workers mit nachgebautem Smoobu, ntfy und D1.
// Ausführen: cd team/worker && node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { runSync } from '../src/index.js';

class FakeD1 {
  constructor() { this.row = null; this.photos = new Map(); }
  prepare(sql) {
    const db = this;
    let args = [];
    const ok = (changes) => ({ meta: { changes } });
    const stmt = {
      bind(...a) { args = a; return stmt; },
      async first() {
        if (sql.includes('FROM photos')) {
          const p = db.photos.get(args[0]);
          return p ? { mime: p.mime, data: [...new Uint8Array(p.data)] } : null; // wie ältere D1: Zahlen-Array
        }
        return db.row ? { ...db.row } : null;
      },
      async run() {
        if (sql.startsWith('CREATE')) return ok(0);
        if (sql.startsWith('INSERT INTO photos')) {
          db.photos.set(args[0], { taskId: args[1], created: args[2], mime: args[3], data: args[4] });
          return ok(1);
        }
        if (sql === 'DELETE FROM photos WHERE id = ?') return ok(db.photos.delete(args[0]) ? 1 : 0);
        if (sql.startsWith('DELETE FROM photos WHERE created_at')) {
          for (const [id, p] of db.photos) if (p.created < args[0]) db.photos.delete(id);
          return ok(0);
        }
        if (sql === 'DELETE FROM photos') { db.photos.clear(); return ok(0); }
        if (sql === 'DELETE FROM app_state') { db.row = null; return ok(0); }
        if (sql.startsWith('INSERT')) {
          if (db.row) return ok(0);
          db.row = { version: 1, data: args[0] };
          return ok(1);
        }
        if (sql.startsWith('UPDATE')) {
          if (!db.row || db.row.version !== args[1]) return ok(0);
          db.row = { version: db.row.version + 1, data: args[0] };
          return ok(1);
        }
        throw new Error('Unbekanntes SQL: ' + sql);
      },
    };
    return stmt;
  }
}

// --- Nachgebautes Internet ----------------------------------------------------
// Das nachgebaute Smoobu akzeptiert den alten Header „Api-Key“ oder eine
// HMAC-Signatur in einer bestimmten (absichtlich nicht naheliegenden) Form:
// Body-Hash base64, Pfad mit /api, Zeit ohne ms, keine leere Query-Zeile.
import { createHmac, createHash } from 'node:crypto';
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
  if (url.startsWith('https://login.smoobu.com/api/reservations?')) {
    return Response.json({ page_count: 1, page: 1, bookings: smoobuBookings });
  }
  if (url.startsWith('https://login.smoobu.com/api/reservations/')) {
    const id = url.split('/').pop();
    const b = smoobuBookings.find((x) => String(x.id) === id);
    return b ? Response.json(b) : new Response('not found', { status: 404 });
  }
  if (url === 'https://ntfy.sh') {
    pushes.push(JSON.parse(init.body));
    return Response.json({ id: 'x' });
  }
  throw new Error('Unerwarteter Aufruf: ' + url);
};

const env = { DB: new FakeD1(), APP_SECRET: 'test-geheimnis', SMOOBU_API_KEY: 'smoobu-test-key' };
const at = (date, time) => new Date(`${date}T${time}:00+02:00`).getTime();
const booking = (id, departure, extra) => ({
  id, type: 'reservation', arrival: '2026-09-20', departure,
  apartment: { id: 111, name: 'FeWo Elbblick' }, 'guest-name': 'Familie Müller', ...extra,
});

async function call(method, path, { user, body } = {}) {
  const pending = [];
  const headers = {};
  if (user) headers.Authorization = `Bearer ${user}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(
    new Request('https://team.apartments-strauss.de' + path, { method, headers, body: body && JSON.stringify(body) }),
    env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return { status: res.status, body: await res.json() };
}

let links;
const auth = (id) => {
  const u = new URL(links.find((x) => x.id === id).link);
  return `${u.searchParams.get('u')}.${u.searchParams.get('k')}`;
};

test('ganzer Ablauf: Import, neue Buchung, Bestätigen, Verlängern, Alarm, Löschen, Webhook', async () => {
  // 1. Erster Abgleich übernimmt vorhandene Buchungen ohne Push-Flut
  smoobuBookings = [booking(1, '2026-09-25')];
  let s = await runSync(env, at('2026-09-23', '09:00'));
  assert.equal(s.syncError, null);
  assert.equal(pushes.length, 0);

  // 2. Persönliche Links nur mit richtigem APP_SECRET
  assert.equal((await call('POST', '/api/setup', { body: { secret: 'falsch' } })).status, 403);
  const setup = await call('POST', '/api/setup', { body: { secret: 'test-geheimnis' } });
  links = setup.body.users;
  assert.match(links[0].link, /^https:\/\/team\.apartments-strauss\.de\/\?u=buero&k=/);
  const topic = (id) => links.find((x) => x.id === id).topic;

  // 3. Neue Buchung → Push an Reinigungskraft
  smoobuBookings.push(booking(2, '2026-09-27'));
  await runSync(env, at('2026-09-23', '09:15'));
  assert.deepEqual(pushes.map((p) => [p.topic, p.title]), [[topic('kraft1'), 'Neue Endreinigung']]);
  assert.match(pushes[0].click, /\?u=kraft1&k=/);

  // 4. Ansicht der Reinigungskraft: ohne Gastnamen
  assert.equal((await call('GET', '/api/me', { user: 'kraft1.falsch' })).status, 401);
  let me = await call('GET', '/api/me', { user: auth('kraft1') });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.tasks.map((t) => [t.id, t.guest]), [['1', ''], ['2', '']]);

  // 5. Bestätigen → Push an Auftraggeber
  pushes = [];
  const confirmed = await call('POST', '/api/tasks/2/confirm', { user: auth('kraft1') });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(pushes.map((p) => [p.topic, p.title]), [[topic('buero'), 'Reinigung bestätigt']]);
  assert.equal((await call('POST', '/api/tasks/2/confirm', { user: auth('buero') })).status, 404, 'Auftraggeber bestätigt nicht');

  // 6. Verlängerung in Smoobu → Push an Reinigungskraft + Auftraggeber, neu bestätigen
  pushes = [];
  smoobuBookings[1] = booking(2, '2026-09-28');
  await runSync(env, at('2026-09-23', '09:30'));
  assert.deepEqual(pushes.map((p) => p.title).sort(), ['Bestätigte Reinigung verschoben', 'Reinigung verschoben']);

  // 7. Am Reinigungstag von Buchung 1: 12 Uhr Erinnerung, 13 Uhr Alarm
  pushes = [];
  await runSync(env, at('2026-09-25', '12:00'));
  assert.deepEqual(pushes.map((p) => [p.title, p.priority]), [['Erinnerung: Reinigung bestätigen', 4]]);
  pushes = [];
  await runSync(env, at('2026-09-25', '13:00'));
  assert.deepEqual(pushes.map((p) => [p.topic, p.priority]).sort(), [[topic('buero'), 5], [topic('kraft1'), 5]].sort());

  // 8. Buchung in Smoobu gelöscht → Reinigung entfällt
  pushes = [];
  smoobuBookings = smoobuBookings.filter((b) => b.id !== 2);
  await runSync(env, at('2026-09-25', '13:15'));
  assert.deepEqual(pushes.map((p) => p.title), ['Reinigung entfällt']);

  // 9. Webhook: nur mit geheimem Pfad
  assert.equal((await call('POST', '/api/smoobu-webhook/falsch', { body: {} })).status, 404);
  const hookPath = new URL(setup.body.webhookUrl).pathname;
  pushes = [];
  const hook = await call('POST', hookPath, { body: { action: 'newReservation', data: booking(3, '2026-10-01') } });
  assert.equal(hook.status, 200);
  assert.deepEqual(pushes.map((p) => p.title), ['Neue Endreinigung']);

  // 10. Übersicht Auftraggeber
  me = await call('GET', '/api/me', { user: auth('buero') });
  assert.equal(me.body.user.role, 'owner');
  assert.deepEqual(me.body.apartments, [{ id: '111', name: 'FeWo Elbblick' }, { id: '222', name: 'Loft Altstadt' }]);
  assert.ok(me.body.log.length >= 5);
});

test('Smoobu nicht erreichbar → Fehler wird angezeigt, Fristen laufen trotzdem', async () => {
  const saved = env.SMOOBU_API_KEY;
  env.SMOOBU_API_KEY = 'falscher-key';
  const s = await runSync(env, at('2026-09-26', '09:00'));
  env.SMOOBU_API_KEY = saved;
  assert.match(s.syncError, /lehnt die Anmeldung ab \(401\)/);
});

test('Diagnose meldet Anzahlen und Feldnamen, aber keine Gästedaten', async () => {
  smoobuBookings = [booking(10, '2026-10-10')];
  const res = await call('POST', '/api/diagnose', { user: auth('buero') });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results[0].topKeys, ['Key: Länge 15, Sonderzeichen -', 'Secret: fehlt', 'Verfahren: Api-Key (alt, endet 25.09.2026)']);
  const list = res.body.results.find((r) => r.variant === 'Buchungen abrufen');
  assert.equal(list.received, 1);
  assert.ok(list.fields.includes('guest-name'));
  assert.ok(!JSON.stringify(res.body).includes('Müller'));
  assert.equal((await call('POST', '/api/diagnose', { user: auth('kraft1') })).status, 404);
});

test('HMAC: richtige Signaturform wird automatisch gefunden und wiederverwendet', async () => {
  const saved = { ...env };
  env.SMOOBU_API_KEY = ` "${HMAC_KEY}" `; // mit Anführungszeichen/Leerzeichen kopiert
  env.SMOOBU_API_SECRET = HMAC_SECRET;
  try {
    const diag = await call('POST', '/api/diagnose', { user: auth('buero') });
    const login = diag.body.results.find((r) => r.variant === 'Anmeldung (HMAC)');
    assert.equal(login.status, 200);
    assert.match(login.topKeys[0], /funktioniert: Hash base64, Pfad mit \/api, Zeit ohne ms, leere Query-Zeile nein/);
    assert.equal(diag.body.results.find((r) => r.variant === 'Buchungen abrufen').received, 1);

    // Normaler Abgleich nutzt die gefundene Form direkt (1 Aufruf für die Liste)
    smoobuCalls = 0;
    const s = await runSync(env, at('2026-09-26', '10:00'));
    assert.equal(s.syncError, null);
    assert.equal(smoobuCalls, 1 + 1 + 2, 'Buchungen + Wohnungen + Nachfrage zu Buchung 1 und 3, keine erneute Erkennung');

    // Falsches Secret → verständlicher Fehler
    env.SMOOBU_API_SECRET = 'falsch';
    const bad = await runSync(env, at('2026-09-26', '10:15'));
    assert.match(bad.syncError, /lehnt die Anmeldung ab \(401\) – bitte API-Key und Secret/);
  } finally {
    Object.assign(env, saved);
    delete env.SMOOBU_API_SECRET;
  }
});

async function upload(path, user, fields) {
  const form = new FormData();
  for (const [k, v] of fields) form.append(k, v);
  const pending = [];
  const res = await worker.fetch(
    new Request('https://team.apartments-strauss.de' + path, { method: 'POST', headers: { Authorization: `Bearer ${user}` }, body: form }),
    env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return { status: res.status, body: await res.json() };
}

test('Meldung mit Foto: Push an Auftraggeber, Foto abrufbar, als behoben markierbar', async () => {
  smoobuBookings = [booking(20, '2026-10-12')];
  await runSync(env, at('2026-09-27', '09:00'));
  pushes = [];
  const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], { type: 'image/jpeg' });
  const res = await upload('/api/tasks/20/report', auth('kraft1'), [['text', 'Kaffeemaschine defekt'], ['photo', jpeg]]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(pushes.map((p) => p.title), ['Meldung: FeWo Elbblick']);
  const rep = res.body.tasks.find((t) => t.id === '20').reports[0];
  assert.equal(rep.text, 'Kaffeemaschine defekt');
  assert.equal(rep.photos.length, 1);

  // Foto nur mit gültigem Zugang (per ?a= für <img>)
  const img = await worker.fetch(new Request(`https://x/api/photos/${rep.photos[0]}?a=${auth('buero')}`), env, { waitUntil() {} });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await img.arrayBuffer())], [0xff, 0xd8, 0xff, 1, 2, 3]);
  assert.equal((await worker.fetch(new Request(`https://x/api/photos/${rep.photos[0]}`), env, { waitUntil() {} })).status, 401);

  // Kein Bild → abgelehnt, nichts gespeichert
  const before = env.DB.photos.size;
  const bad = await upload('/api/tasks/20/report', auth('kraft1'), [['text', 'x'], ['photo', new Blob(['hallo'], { type: 'text/plain' })]]);
  assert.equal(bad.status, 400);
  assert.equal(env.DB.photos.size, before);

  // Übersicht zeigt offene Meldung; behoben → verschwindet
  let me = await call('GET', '/api/me', { user: auth('buero') });
  assert.equal(me.body.openReports.length, 1);
  const done = await call('POST', `/api/tasks/20/reports/${rep.id}/resolve`, { user: auth('buero') });
  assert.equal(done.status, 200);
  assert.equal(done.body.openReports.length, 0);
});

test('manuelle Reinigung: Push an Reinigungskraft, absagen möglich, Abgleich lässt sie in Ruhe', async () => {
  pushes = [];
  const res = await call('POST', '/api/manual', { user: auth('buero'), body: { apartmentId: '222', date: '2099-01-02', note: 'Grundreinigung' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const task = res.body.tasks.find((t) => t.manual);
  assert.equal(task.apartmentName, 'Loft Altstadt', 'Name aus der Smoobu-Wohnungsliste');
  assert.deepEqual(pushes.map((p) => p.title), ['Zusätzliche Reinigung']);
  assert.match(pushes[0].message, /Hinweis: Grundreinigung/);

  await runSync(env, at('2026-09-27', '09:15'));
  let me = await call('GET', '/api/me', { user: auth('kraft1') });
  assert.equal(me.body.tasks.find((t) => t.id === task.id).status, 'offen');

  assert.equal((await call('POST', '/api/manual', { user: auth('kraft1'), body: {} })).status, 404, 'nur Auftraggeber');
  pushes = [];
  const c = await call('POST', `/api/tasks/${task.id}/cancel`, { user: auth('buero') });
  assert.equal(c.status, 200);
  assert.deepEqual(pushes.map((p) => p.title), ['Reinigung entfällt']);
});

test('Zurücksetzen nur mit Bestätigung, lädt danach frisch aus Smoobu (ohne Push-Flut)', async () => {
  assert.equal((await call('POST', '/api/reset', { user: auth('buero'), body: { confirm: 'ja' } })).status, 400);
  assert.equal((await call('POST', '/api/reset', { user: auth('kraft1'), body: { confirm: 'ZURÜCKSETZEN' } })).status, 404);
  pushes = [];
  smoobuBookings = [booking(30, '2026-10-20'), booking(31, '2026-10-21')];
  const res = await call('POST', '/api/reset', { user: auth('buero'), body: { confirm: 'ZURÜCKSETZEN' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.tasks.map((t) => t.id), ['30', '31']);
  assert.equal(res.body.log.length, 0);
  assert.equal(env.DB.photos.size, 0);
  assert.equal(pushes.length, 0);
});
