// Ausführen mit: node --test logic/logic.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./logic.js');

// Zeitpunkte in deutscher Sommerzeit (UTC+2)
const at = (date, time) => new Date(`${date}T${time}:00+02:00`);
const NOW = at('2026-09-23', '09:00');

const CFG = {
  leads: [{ id: 'lea', name: 'Lea (Leitung)' }],
  staff: [{ id: 'mia', name: 'Mia' }, { id: 'ida', name: 'Ida' }],
};
const OWNER = { id: 'buero', role: 'owner' };
const LEAD = { id: 'lea', role: 'lead' };
const MIA = { id: 'mia', role: 'staff' };
const IDA = { id: 'ida', role: 'staff' };

const booking = (overrides) => Object.assign({
  action: 'new', id: '100', apartmentId: '3', apartmentName: 'Loft am Markt', guest: 'Familie Müller', guestPhone: '+49 170 1234567',
  arrival: '2026-09-28', departure: '2026-10-02',
}, overrides);
const who = (notes) => notes.map((n) => `${n.to}:${n.kind}`).sort();

/** Neue Reinigung, von Lea an Mia zugewiesen und von Mia bestätigt */
function confirmedTask(overrides) {
  let { state } = L.applyBooking(L.createState(), booking(overrides), NOW, CFG);
  const id = (overrides && overrides.id) || '100';
  ({ state } = L.assignCleaning(state, id, 'lea', 'mia', NOW, CFG));
  ({ state } = L.staffConfirm(state, id, 'mia', NOW, CFG));
  return state;
}

test('neue Buchung geht nur an die Reinigungsleitung, inkl. Telefonnummer des Gastes', () => {
  const { state, notifications } = L.applyBooking(L.createState(), booking(), NOW, CFG);
  const t = state.tasks['100'];
  assert.equal(t.status, 'offen');
  assert.equal(t.guestPhone, '+49 170 1234567');
  assert.equal(t.source, 'smoobu');
  assert.deepEqual(who(notifications), ['lea:new']);
});

test('Mitarbeiterin sieht eine Reinigung erst nach Zuweisung', () => {
  let { state } = L.applyBooking(L.createState(), booking(), NOW, CFG);
  assert.equal(L.listCleanings(state, { user: MIA }, CFG).length, 0);
  assert.equal(L.listCleanings(state, { user: LEAD }, CFG).length, 1);
  const res = L.assignCleaning(state, '100', 'lea', 'mia', NOW, CFG);
  assert.deepEqual(who(res.notifications), ['mia:assigned']);
  assert.equal(L.listCleanings(res.state, { user: MIA }, CFG).length, 1);
  assert.equal(L.listCleanings(res.state, { user: IDA }, CFG).length, 0);
  assert.ok(res.state.tasks['100'].leadConfirmedAt, 'Zuweisen = Erhalt durch Leitung bestätigt');
});

test('bestätigt erst, wenn Leitung UND Mitarbeiterin bestätigt haben', () => {
  let { state } = L.applyBooking(L.createState(), booking(), NOW, CFG);
  ({ state } = L.leadConfirm(state, '100', 'lea', NOW, CFG));
  assert.equal(state.tasks['100'].status, 'offen');
  ({ state } = L.assignCleaning(state, '100', 'lea', 'mia', NOW, CFG));
  assert.equal(state.tasks['100'].status, 'offen');
  assert.throws(() => L.staffConfirm(state, '100', 'ida', NOW, CFG), /nicht zugewiesen/);
  const res = L.staffConfirm(state, '100', 'mia', NOW, CFG);
  assert.equal(res.state.tasks['100'].status, 'bestätigt');
  assert.deepEqual(who(res.notifications), ['owner:confirmed']);
  assert.throws(() => L.leadConfirm(state, '100', 'mia', NOW, CFG), /Reinigungsleitung/);
});

test('Neuvergabe: alte Mitarbeiterin wird informiert, neue muss bestätigen', () => {
  const state = confirmedTask();
  const res = L.assignCleaning(state, '100', 'lea', 'ida', NOW, CFG);
  assert.deepEqual(who(res.notifications), ['ida:assigned', 'mia:unassigned']);
  assert.equal(res.state.tasks['100'].status, 'offen');
  assert.equal(L.listCleanings(res.state, { user: MIA }, CFG).length, 0);
});

test('Leitung kann sich selbst zuweisen (gilt sofort als bestätigt)', () => {
  let { state } = L.applyBooking(L.createState(), booking(), NOW, CFG);
  const res = L.assignCleaning(state, '100', 'lea', 'lea', NOW, CFG);
  assert.equal(res.state.tasks['100'].status, 'bestätigt');
  assert.deepEqual(who(res.notifications), ['owner:confirmed']);
});

test('6 Stunden nach Eintragung nicht vollständig bestätigt → Admin, nur einmal', () => {
  let { state } = L.applyBooking(L.createState(), booking(), NOW, CFG);
  ({ state } = L.assignCleaning(state, '100', 'lea', 'mia', NOW, CFG));
  let res = L.checkDeadlines(state, at('2026-09-23', '14:59'), CFG);
  assert.equal(res.notifications.length, 0);
  res = L.checkDeadlines(res.state, at('2026-09-23', '15:00'), CFG);
  assert.deepEqual(who(res.notifications), ['owner:late']);
  assert.match(res.notifications[0].body, /es fehlt: Bestätigung Mia/);
  res = L.checkDeadlines(res.state, at('2026-09-23', '16:00'), CFG);
  assert.equal(res.notifications.length, 0);
});

test('rechtzeitig bestätigt → kein 6-Stunden-Alarm', () => {
  const res = L.checkDeadlines(confirmedTask(), at('2026-09-23', '20:00'), CFG);
  assert.equal(res.notifications.length, 0);
});

test('Reinigungstag: 12 Uhr und 15 Uhr Erinnerung an Leitung, Mitarbeiterin und Admin, falls nicht erledigt', () => {
  const day = '2026-10-02';
  let res = L.checkDeadlines(confirmedTask(), at(day, '11:59'), CFG);
  assert.equal(res.notifications.length, 0);
  res = L.checkDeadlines(res.state, at(day, '12:00'), CFG);
  assert.deepEqual(who(res.notifications), ['lea:reminder', 'mia:reminder', 'owner:reminder']);
  assert.match(res.notifications[0].body, /noch nicht begonnen \(Mia\)/);
  res = L.checkDeadlines(res.state, at(day, '14:00'), CFG);
  assert.equal(res.notifications.length, 0);
  ({ state: res.state } = L.startCleaning(res.state, '100', 'mia', at(day, '14:30'), CFG));
  res = L.checkDeadlines(res.state, at(day, '15:00'), CFG);
  assert.deepEqual(who(res.notifications), ['lea:reminder2', 'mia:reminder2', 'owner:reminder2']);
  assert.match(res.notifications[0].body, /läuft seit 14:30 Uhr/);
  res = L.checkDeadlines(res.state, at(day, '16:00'), CFG);
  assert.equal(res.notifications.length, 0);
});

test('erledigt → keine Erinnerungen; Dauer wird aus Start/Ende berechnet', () => {
  const day = '2026-10-02';
  let { state } = L.startCleaning(confirmedTask(), '100', 'mia', at(day, '10:00'), CFG);
  assert.throws(() => L.startCleaning(state, '100', 'ida', at(day, '10:00'), CFG), /nicht zugewiesen/);
  const done = L.completeCleaning(state, '100', 'mia', at(day, '11:45'), CFG);
  assert.equal(done.state.tasks['100'].status, 'erledigt');
  assert.deepEqual(who(done.notifications), ['lea:done', 'owner:done']);
  assert.match(done.notifications[0].body, /Dauer 1:45 Std\./);
  assert.equal(L.checkDeadlines(done.state, at(day, '15:00'), CFG).notifications.length, 0);
});

test('Verlängerung: Datum neu, Bestätigungen zurückgesetzt, Leitung + Mitarbeiterin + Admin informiert', () => {
  const res = L.applyBooking(confirmedTask(), booking({ action: 'update', departure: '2026-10-04' }), at('2026-09-24', '10:00'), CFG);
  const t = res.state.tasks['100'];
  assert.equal(t.date, '2026-10-04');
  assert.equal(t.status, 'offen');
  assert.equal(t.assignedTo, 'mia', 'Zuweisung bleibt');
  assert.equal(t.staffConfirmedAt, null);
  assert.deepEqual(who(res.notifications), ['lea:rescheduled', 'mia:rescheduled', 'owner:rescheduled']);
  assert.match(res.notifications.find((n) => n.to === 'mia').body, /verlängert.*So, 04\.10\.2026 statt Fr, 02\.10\.2026/);
  // 6-Stunden-Frist startet ab der Änderung neu
  assert.equal(L.checkDeadlines(res.state, at('2026-09-24', '15:59'), CFG).notifications.length, 0);
  assert.deepEqual(who(L.checkDeadlines(res.state, at('2026-09-24', '16:00'), CFG).notifications), ['owner:late']);
});

test('Storno informiert Leitung und zugewiesene Mitarbeiterin', () => {
  const res = L.applyBooking(confirmedTask(), booking({ action: 'cancel' }), NOW, CFG);
  assert.equal(res.state.tasks['100'].status, 'storniert');
  assert.deepEqual(who(res.notifications), ['lea:cancelled', 'mia:cancelled']);
});

test('manuelle Reinigung: an Leitung; verschieben setzt Bestätigung zurück; absagen', () => {
  let res = L.addManualCleaning(L.createState(), { id: 'm1', apartmentId: '7', apartmentName: 'Suite', date: '2026-09-25', note: 'Fenster' }, NOW, CFG);
  assert.deepEqual(who(res.notifications), ['lea:new']);
  let { state } = L.assignCleaning(res.state, 'm1', 'lea', 'mia', NOW, CFG);
  ({ state } = L.staffConfirm(state, 'm1', 'mia', NOW, CFG));
  res = L.editManualCleaning(state, 'm1', { date: '2026-09-26' }, NOW, CFG);
  assert.equal(res.state.tasks.m1.status, 'offen');
  assert.deepEqual(who(res.notifications), ['lea:rescheduled', 'mia:rescheduled']);
  res = L.editManualCleaning(res.state, 'm1', { note: 'Fenster + Balkon' }, NOW, CFG);
  assert.deepEqual(who(res.notifications), ['lea:edited', 'mia:edited']);
  assert.throws(() => L.editManualCleaning(res.state, 'm1', { date: '2026-09-01' }, NOW, CFG), /Vergangenheit/);
  const s2 = L.applyBooking(res.state, booking(), NOW, CFG).state;
  assert.throws(() => L.editManualCleaning(s2, '100', { date: '2026-10-05' }, NOW, CFG), /Smoobu/);
  const c = L.cancelManualCleaning(res.state, 'm1', NOW, CFG);
  assert.deepEqual(who(c.notifications), ['lea:cancelled', 'mia:cancelled']);
  assert.deepEqual(L.activeTaskIds(s2, '2026-09-01'), ['100'], 'manuelle nicht bei Smoobu nachfragen');
});

test('Meldungen: Mitarbeiterin → Admin + Leitung; Admin-Hinweis → Leitung + Mitarbeiterin', () => {
  const state = confirmedTask();
  let res = L.addReport(state, '100', MIA, { id: 'r1', text: 'Handtücher fehlen', photos: ['p1', 'p2'] }, NOW, CFG);
  assert.deepEqual(who(res.notifications), ['lea:report', 'owner:report']);
  assert.match(res.notifications[0].body, /Mia: Handtücher fehlen \(2 Fotos\)/);
  assert.equal(L.openReports(res.state).length, 1);
  res = L.addReport(res.state, '100', OWNER, { id: 'r2', text: 'Bitte Kaffee auffüllen', photos: ['p3'] }, NOW, CFG);
  assert.deepEqual(who(res.notifications), ['lea:note', 'mia:note']);
  assert.equal(L.openReports(res.state).length, 1, 'Admin-Hinweise sind keine offenen Meldungen');
  assert.throws(() => L.addReport(state, '100', IDA, { id: 'x', text: 'x' }, NOW, CFG), /Berechtigung/);
});

test('Fotos: eigene löschen erlaubt, fremde nicht; leere Meldung verschwindet', () => {
  let { state } = L.addReport(confirmedTask(), '100', MIA, { id: 'r1', text: '', photos: ['p1', 'p2'] }, NOW, CFG);
  assert.throws(() => L.removePhoto(state, '100', 'r1', 'p1', IDA), /eigene/);
  ({ state } = L.removePhoto(state, '100', 'r1', 'p1', MIA));
  assert.deepEqual(state.tasks['100'].reports[0].photos, ['p2']);
  ({ state } = L.removePhoto(state, '100', 'r1', 'p2', OWNER));
  assert.equal(state.tasks['100'].reports.length, 0);
});

test('Abgleich: erster still, danach Nachrichten; Sperrzeiten ignoriert; Telefonnummer übernommen', () => {
  const sm = (o) => Object.assign({ id: 700, type: 'reservation', arrival: '2026-09-28', departure: '2026-10-02',
    apartment: { id: 3, name: 'Loft' }, 'guest-name': 'Müller', phone: '+49 30 123', 'is-blocked-booking': false }, o);
  let res = L.syncFromSmoobu(L.createState(), [sm()], NOW, CFG);
  assert.equal(res.notifications.length, 0);
  assert.equal(res.state.tasks['700'].guestPhone, '+49 30 123');
  res = L.syncFromSmoobu(res.state, [sm(), sm({ id: 701 }), sm({ id: 702, 'is-blocked-booking': true })], NOW, CFG);
  assert.deepEqual(who(res.notifications), ['lea:new']);
  assert.equal(res.state.tasks['702'], undefined);
});

test('Zeitzone: 12:00 Berlin ist 10:00 UTC im Sommer, 11:00 UTC im Winter', () => {
  assert.deepEqual(L.localParts(new Date('2026-10-02T10:00:00Z'), 'Europe/Berlin'), { date: '2026-10-02', time: '12:00' });
  assert.deepEqual(L.localParts(new Date('2026-11-02T11:00:00Z'), 'Europe/Berlin'), { date: '2026-11-02', time: '12:00' });
});

test('Wechseltag wird erkannt', () => {
  let { state } = L.applyBooking(L.createState(), booking(), NOW, CFG);
  ({ state } = L.applyBooking(state, booking({ id: '101', arrival: '2026-10-02', departure: '2026-10-06' }), NOW, CFG));
  const list = L.listCleanings(state, {}, CFG);
  assert.equal(list[0].sameDayArrival, true);
  assert.equal(list[1].sameDayArrival, false);
});

test('Kalender: Sperrzeiten gespeichert, Wohnungen nummeriert, Namen nur für Admin', () => {
  const sm = (o) => Object.assign({ id: 800, type: 'reservation', arrival: '2026-09-25', departure: '2026-09-29',
    apartment: { id: 5, name: 'B-Loft' }, 'guest-name': 'Frau Weber', 'is-blocked-booking': false }, o);
  let { state } = L.syncFromSmoobu(L.createState(), [sm(), sm({ id: 801, apartment: { id: 6, name: 'A-Suite' }, 'is-blocked-booking': true, arrival: '2026-09-26', departure: '2026-09-30' })], NOW, CFG, 30, '2026-09-22');
  state.apartments = [{ id: '5', name: 'B-Loft' }, { id: '6', name: 'A-Suite' }, { id: '7', name: 'C-Studio' }];
  assert.equal(state.tasks['801'], undefined, 'Sperrzeit ist keine Reinigung');
  const cal = L.calendar(state, '2026-09-22', 14, true);
  assert.deepEqual(cal.apartments.map((a) => [a.number, a.name]), [[1, 'A-Suite'], [2, 'B-Loft'], [3, 'C-Studio']]);
  assert.deepEqual(cal.bookings.map((b) => [b.id, b.guest, b.blocked]).sort(), [['800', 'Frau Weber', false], ['801', '', true]]);
  assert.deepEqual(cal.cleanings.map((c) => [c.id, c.date]), [['800', '2026-09-29']]);
  assert.equal(L.calendar(state, '2026-09-22', 14, false).bookings.find((b) => b.id === '800').guest, '');
  // Sperrzeit in Smoobu aufgehoben → verschwindet beim nächsten Abgleich
  ({ state } = L.syncFromSmoobu(state, [sm()], NOW, CFG, 30, '2026-09-22'));
  assert.equal(state.reservations['801'], undefined);
  assert.ok(state.reservations['800']);
});
