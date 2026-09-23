// Ende-zu-Ende-Test des Workers mit nachgebautem Smoobu, ntfy und D1.
// Ausführen: cd team/worker && node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { runSync } from '../src/index.js';

class FakeD1 {
  constructor() { this.row = null; }
  prepare(sql) {
    const db = this;
    let args = [];
    const stmt = {
      bind(...a) { args = a; return stmt; },
      async first() { return db.row ? { ...db.row } : null; },
      async run() {
        if (sql.startsWith('CREATE')) return { meta: { changes: 0 } };
        if (sql.startsWith('INSERT')) {
          if (db.row) return { meta: { changes: 0 } };
          db.row = { version: 1, data: args[0] };
          return { meta: { changes: 1 } };
        }
        if (!db.row || db.row.version !== args[1]) return { meta: { changes: 0 } };
        db.row = { version: db.row.version + 1, data: args[0] };
        return { meta: { changes: 1 } };
      },
    };
    return stmt;
  }
}

// --- Nachgebautes Internet ----------------------------------------------------
let smoobuBookings = [];
let pushes = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://login.smoobu.com/api/me') || url.startsWith('https://login.smoobu.com/api/apartments')) {
    return Response.json({ id: 1 });
  }
  if (url.startsWith('https://login.smoobu.com/api/reservations?')) {
    if (init.headers['Api-Key'] !== 'smoobu-test-key') return Response.json({ status: 401 }, { status: 401 });
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
  assert.deepEqual(me.body.apartments, [{ id: '111', name: 'FeWo Elbblick' }]);
  assert.ok(me.body.log.length >= 5);
});

test('Smoobu nicht erreichbar → Fehler wird angezeigt, Fristen laufen trotzdem', async () => {
  const saved = env.SMOOBU_API_KEY;
  env.SMOOBU_API_KEY = 'falscher-key';
  const s = await runSync(env, at('2026-09-26', '09:00'));
  env.SMOOBU_API_KEY = saved;
  assert.match(s.syncError, /lehnt den API-Schlüssel ab \(401\)/);
});

test('Diagnose meldet Anzahlen und Feldnamen, aber keine Gästedaten', async () => {
  smoobuBookings = [booking(10, '2026-10-10')];
  const res = await call('POST', '/api/diagnose', { user: auth('buero') });
  assert.equal(res.status, 200);
  assert.equal(res.body.results.length, 7);
  assert.deepEqual(res.body.results[0].topKeys, ['Länge 15', 'enthält Sonderzeichen', 'ohne Leerzeichen']);
  const ok = res.body.results.find((r) => r.variant === 'Header Api-Key · Buchungen');
  assert.equal(ok.received, 1);
  assert.ok(ok.fields.includes('guest-name'));
  assert.equal(res.body.results.find((r) => r.variant === 'Bearer · Buchungen').status, 401);
  assert.ok(!JSON.stringify(res.body).includes('Müller'));
  assert.equal((await call('POST', '/api/diagnose', { user: auth('kraft1') })).status, 404);
});
