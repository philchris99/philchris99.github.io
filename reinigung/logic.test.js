// Ausführen mit: node --test reinigung/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./logic.js');

// Zeitpunkte in deutscher Sommerzeit (UTC+2)
const at = (date, time) => new Date(`${date}T${time}:00+02:00`);
const NOW = at('2026-09-23', '09:00');

const booking = (overrides) => Object.assign({
  action: 'new', id: '100', apartmentId: '3', guest: 'Familie Müller',
  arrival: '2026-09-28', departure: '2026-10-02',
}, overrides);

const recipients = (notifications) => notifications.map((n) => n.to).sort();

test('neue Buchung legt offene Reinigung am Abreisetag an und benachrichtigt die Zuständigen', () => {
  const { state, notifications } = L.applyBooking(L.createState(), booking(), NOW);
  const task = state.tasks['100'];
  assert.equal(task.date, '2026-10-02');
  assert.equal(task.status, 'offen');
  assert.equal(task.apartmentName, 'Wohnung 3');
  // Wohnung 3: Anna (alle) + Maria (1–7)
  assert.deepEqual(recipients(notifications), ['anna', 'maria']);
  assert.match(notifications[0].body, /Fr, 02\.10\.2026/);
});

test('Wohnung 10 wird nur an Anna gemeldet', () => {
  const { notifications } = L.applyBooking(L.createState(), booking({ apartmentId: '10' }), NOW);
  assert.deepEqual(recipients(notifications), ['anna']);
});

test('Bestätigen weist die Reinigung zu und informiert den Auftraggeber', () => {
  let { state } = L.applyBooking(L.createState(), booking(), NOW);
  const res = L.confirmCleaning(state, '100', 'maria', NOW);
  assert.equal(res.state.tasks['100'].status, 'bestätigt');
  assert.equal(res.state.tasks['100'].assignedTo, 'maria');
  assert.deepEqual(recipients(res.notifications), ['owner']);
  assert.throws(() => L.confirmCleaning(res.state, '100', 'anna', NOW), /jemand anderem/);
});

test('Verlängerung verschiebt das Datum und benachrichtigt nur die zugewiesene Kraft + Auftraggeber', () => {
  let { state } = L.applyBooking(L.createState(), booking(), NOW);
  ({ state } = L.confirmCleaning(state, '100', 'maria', NOW));
  const res = L.applyBooking(state, booking({ action: 'update', departure: '2026-10-04' }), NOW);
  const task = res.state.tasks['100'];
  assert.equal(task.date, '2026-10-04');
  assert.equal(task.status, 'offen', 'neues Datum muss neu bestätigt werden');
  assert.equal(task.assignedTo, 'maria');
  assert.deepEqual(recipients(res.notifications), ['maria', 'owner']);
  assert.match(res.notifications[0].body, /verlängert/);
});

test('Update ohne geänderte Abreise erzeugt keine Nachricht', () => {
  let { state } = L.applyBooking(L.createState(), booking(), NOW);
  const res = L.applyBooking(state, booking({ action: 'update', guest: 'Neuer Name' }), NOW);
  assert.equal(res.notifications.length, 0);
  assert.equal(res.state.tasks['100'].guest, 'Neuer Name');
});

test('Stornierung setzt Reinigung auf storniert und informiert', () => {
  let { state } = L.applyBooking(L.createState(), booking(), NOW);
  const res = L.applyBooking(state, booking({ action: 'cancel' }), NOW);
  assert.equal(res.state.tasks['100'].status, 'storniert');
  assert.equal(res.notifications[0].kind, 'cancelled');
});

test('Fristen: 12 Uhr Erinnerung, 13 Uhr Alarm an Reinigungskraft und Auftraggeber – jeweils nur einmal', () => {
  let { state } = L.applyBooking(L.createState(), booking({ apartmentId: '10' }), NOW);
  const day = '2026-10-02';

  let res = L.checkDeadlines(state, at(day, '11:59'));
  assert.equal(res.notifications.length, 0);

  res = L.checkDeadlines(res.state, at(day, '12:00'));
  assert.deepEqual(res.notifications.map((n) => `${n.to}:${n.kind}`), ['anna:reminder']);

  res = L.checkDeadlines(res.state, at(day, '12:30'));
  assert.equal(res.notifications.length, 0, 'keine doppelte Erinnerung');

  res = L.checkDeadlines(res.state, at(day, '13:00'));
  assert.deepEqual(res.notifications.map((n) => `${n.to}:${n.kind}`), ['anna:escalation', 'owner:escalation']);

  res = L.checkDeadlines(res.state, at(day, '15:00'));
  assert.equal(res.notifications.length, 0, 'kein doppelter Alarm');
});

test('Fristen: bestätigte Reinigungen lösen keinen Alarm aus', () => {
  let { state } = L.applyBooking(L.createState(), booking(), NOW);
  ({ state } = L.confirmCleaning(state, '100', 'anna', NOW));
  const res = L.checkDeadlines(state, at('2026-10-02', '14:00'));
  assert.equal(res.notifications.length, 0);
});

test('Fristen: nach Verschiebung wird am neuen Tag wieder erinnert', () => {
  let { state } = L.applyBooking(L.createState(), booking(), NOW);
  ({ state } = L.checkDeadlines(state, at('2026-10-02', '13:00'))); // Alarm am alten Tag
  ({ state } = L.applyBooking(state, booking({ action: 'update', departure: '2026-10-05' }), NOW));
  const res = L.checkDeadlines(state, at('2026-10-05', '12:05'));
  assert.equal(res.notifications[0].kind, 'reminder');
});

test('Fristen: Zeitzone – 12:00 Berlin ist 10:00 UTC im Sommer', () => {
  let { state } = L.applyBooking(L.createState(), booking(), NOW);
  const res = L.checkDeadlines(state, new Date('2026-10-02T10:00:00Z'));
  assert.equal(res.notifications[0].kind, 'reminder');
});

test('Liste markiert Wechseltag (nächster Gast reist am Reinigungstag an)', () => {
  let { state } = L.applyBooking(L.createState(), booking(), NOW);
  ({ state } = L.applyBooking(state, booking({ id: '101', arrival: '2026-10-02', departure: '2026-10-06' }), NOW));
  const list = L.listCleanings(state);
  assert.equal(list[0].id, '100');
  assert.equal(list[0].sameDayArrival, true);
  assert.equal(list[1].sameDayArrival, false);
});

test('Liste für Reinigungskraft zeigt nur zuständige bzw. eigene Reinigungen', () => {
  let { state } = L.applyBooking(L.createState(), booking(), NOW);
  ({ state } = L.applyBooking(state, booking({ id: '200', apartmentId: '12' }), NOW));
  assert.deepEqual(L.listCleanings(state, { cleanerId: 'maria' }).map((t) => t.id), ['100']);
  assert.deepEqual(L.listCleanings(state, { cleanerId: 'anna' }).map((t) => t.id).sort(), ['100', '200']);
  ({ state } = L.confirmCleaning(state, '100', 'anna', NOW));
  assert.deepEqual(L.listCleanings(state, { cleanerId: 'maria' }).map((t) => t.id), []);
});

test('Smoobu-Webhook wird in eine Buchung übersetzt', () => {
  const b = L.fromSmoobuWebhook({
    action: 'updateReservation',
    user: 1,
    data: {
      id: 555, arrival: '2026-10-01', departure: '2026-10-03',
      apartment: { id: 7, name: 'Ferienwohnung Sonne' }, 'guest-name': 'Max Mustermann',
    },
  });
  assert.deepEqual(b, {
    action: 'update', id: '555', apartmentId: '7', apartmentName: 'Ferienwohnung Sonne',
    guest: 'Max Mustermann', arrival: '2026-10-01', departure: '2026-10-03',
  });
  assert.equal(L.fromSmoobuWebhook({ action: 'newMessage', data: {} }), null);
});
