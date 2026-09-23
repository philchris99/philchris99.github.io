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

test('Überfällig: ab 12 Uhr nicht begonnen → wiederholte Erinnerung alle 30 Min. an Leitung, Mitarbeiterin, Admin', () => {
  const day = '2026-10-02';
  let res = L.checkDeadlines(confirmedTask(), at(day, '11:55'), CFG);
  assert.equal(res.notifications.length, 0);
  assert.equal(L.overdueReason(res.state.tasks['100'], at(day, '11:55'), CFG), null);
  res = L.checkDeadlines(res.state, at(day, '12:00'), CFG);
  assert.deepEqual(who(res.notifications), ['lea:reminder', 'mia:reminder', 'owner:reminder']);
  assert.equal(res.notifications[0].title, 'Reinigung muss heute noch gestartet werden');
  assert.equal(L.overdueReason(res.state.tasks['100'], at(day, '12:00'), CFG), 'start');
  res = L.checkDeadlines(res.state, at(day, '12:15'), CFG);
  assert.equal(res.notifications.length, 0, 'nicht öfter als alle 30 Min.');
  res = L.checkDeadlines(res.state, at(day, '12:30'), CFG);
  assert.equal(res.notifications.length, 3, 'nach 30 Min. erneut');
});

test('Überfällig: begonnen, aber um 15 Uhr nicht beendet → „bitte beenden“; begonnen vor 15 Uhr → nicht überfällig', () => {
  const day = '2026-10-02';
  let { state } = L.startCleaning(confirmedTask(), '100', 'mia', at(day, '12:10'), CFG);
  assert.equal(L.overdueReason(state.tasks['100'], at(day, '14:59'), CFG), null);
  let res = L.checkDeadlines(state, at(day, '14:59'), CFG);
  assert.equal(res.notifications.length, 0);
  res = L.checkDeadlines(res.state, at(day, '15:00'), CFG);
  assert.equal(res.notifications[0].title, 'Reinigung bitte beenden');
  assert.match(res.notifications[0].body, /läuft seit 12:10 Uhr/);
  assert.equal(res.notifications.length, 3);
  res = L.checkDeadlines(res.state, at(day, '21:55'), CFG);
  assert.equal(res.notifications.length, 3, 'bis 22 Uhr wird erinnert');
  res = L.checkDeadlines(res.state, at(day, '22:00'), CFG);
  assert.equal(res.notifications.length, 0, 'Nachtruhe ab 22 Uhr');
});

test('15-Uhr-Erinnerung kommt pünktlich, auch wenn um 14:45 noch an den Start erinnert wurde', () => {
  const day = '2026-10-02';
  let res = L.checkDeadlines(confirmedTask(), at(day, '14:45'), CFG);
  assert.equal(res.notifications[0].title, 'Reinigung muss heute noch gestartet werden');
  res = L.checkDeadlines(res.state, at(day, '15:00'), CFG);
  assert.deepEqual(who(res.notifications), ['lea:reminder2', 'mia:reminder2', 'owner:reminder2']);
  assert.equal(res.notifications[0].title, 'Reinigung immer noch nicht begonnen');
  res = L.checkDeadlines(res.state, at(day, '15:05'), CFG);
  assert.equal(res.notifications.length, 0);
  assert.equal(L.checkDeadlines(res.state, at(day, '15:30'), CFG).notifications.length, 3);
});

test('Überfällig und noch niemandem zugewiesen → ganzes Reinigungsteam + Admin', () => {
  const { state } = L.applyBooking(L.createState(), booking(), NOW, CFG);
  const res = L.checkDeadlines(state, at('2026-10-02', '12:00'), CFG);
  const reminders = res.notifications.filter((n) => n.kind === 'reminder');
  assert.deepEqual(who(reminders), ['ida:reminder', 'lea:reminder', 'mia:reminder', 'owner:reminder']);
});

test('Nach 15 Uhr für heute eingetragen → Erinnerung sofort beim nächsten Prüfen', () => {
  let { state } = L.addManualCleaning(L.createState(), { id: 'm2', apartmentId: '7', apartmentName: 'Suite', date: '2026-09-23' }, at('2026-09-23', '17:40'), CFG);
  const res = L.checkDeadlines(state, at('2026-09-23', '17:40'), CFG);
  const r = res.notifications.filter((n) => n.kind === 'reminder2');
  assert.equal(r.length, 4);
  assert.equal(r[0].title, 'Reinigung immer noch nicht begonnen');
});

test('Überfällig gilt auch für manuelle Reinigungen am selben Tag', () => {
  let { state } = L.addManualCleaning(L.createState(), { id: 'm1', apartmentId: '7', apartmentName: 'Suite', date: '2026-09-23' }, at('2026-09-23', '12:30'), CFG);
  const res = L.checkDeadlines(state, at('2026-09-23', '12:30'), CFG);
  assert.deepEqual(who(res.notifications.filter((n) => n.kind === 'reminder')), ['ida:reminder', 'lea:reminder', 'mia:reminder', 'owner:reminder']);
  assert.match(res.notifications.find((n) => n.kind === 'reminder').body, /noch niemandem zugewiesen/);
});

test('Vortag nicht erledigt → einmalige Meldung', () => {
  let res = L.checkDeadlines(confirmedTask(), at('2026-10-03', '08:00'), CFG);
  assert.deepEqual(who(res.notifications), ['lea:overdue', 'mia:overdue', 'owner:overdue']);
  res = L.checkDeadlines(res.state, at('2026-10-03', '09:00'), CFG);
  assert.equal(res.notifications.length, 0);
});

test('erledigt → keine Erinnerungen; Dauer wird aus Start/Ende berechnet', () => {
  const day = '2026-10-02';
  let { state } = L.startCleaning(confirmedTask(), '100', 'mia', at(day, '10:00'), CFG);
  assert.throws(() => L.startCleaning(state, '100', 'ida', at(day, '10:00'), CFG), /nicht zugewiesen/);
  assert.throws(() => L.completeCleaning(state, '100', 'mia', at(day, '11:45'), CFG), /Gästeschlüssel/);
  const done = L.completeCleaning(state, '100', 'mia', at(day, '11:45'), CFG, { keysInBox: true });
  assert.equal(done.state.tasks['100'].status, 'erledigt');
  assert.equal(done.state.tasks['100'].keysInBox, true);
  assert.deepEqual(who(done.notifications), ['lea:done', 'owner:done']);
  assert.match(done.notifications[0].body, /Dauer 1:45 Std\./);
  assert.equal(L.checkDeadlines(done.state, at(day, '15:00'), CFG).notifications.length, 0);
  assert.equal(L.overdueReason(done.state.tasks['100'], at(day, '16:00'), CFG), null);
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

test('Aufgehobene (stornierte) Sperrzeit wird NICHT als blockiert angezeigt', () => {
  const blockedCancelled = { id: 900, type: 'cancellation', arrival: '2026-10-01', departure: '2026-10-10',
    apartment: { id: 3, name: 'Wohnung 3' }, 'is-blocked-booking': true };
  let { state } = L.syncFromSmoobu(L.createState(), [blockedCancelled], NOW, CFG, 30, '2026-09-22');
  assert.equal(state.reservations['900'], undefined);
  // vorher gesperrt, dann in Smoobu aufgehoben
  ({ state } = L.syncFromSmoobu(state, [{ ...blockedCancelled, type: 'reservation' }], NOW, CFG, 30, '2026-09-22'));
  assert.equal(state.reservations['900'].blocked, true);
  ({ state } = L.syncFromSmoobu(state, [blockedCancelled], NOW, CFG, 30, '2026-09-22'));
  assert.equal(state.reservations['900'], undefined);
});

test('Kalender liefert Reinigungsdetails inkl. manueller Reinigungen, Telefonnummer und Kanal', () => {
  let { state } = L.applyBooking(L.createState(), { ...booking(), channel: 'Airbnb' }, NOW, CFG);
  ({ state } = L.assignCleaning(state, '100', 'lea', 'mia', NOW, CFG));
  ({ state } = L.addManualCleaning(state, { id: 'm1', apartmentId: '3', apartmentName: 'Loft am Markt', date: '2026-10-05', note: 'Fenster' }, NOW, CFG));
  const cal = L.calendar(state, '2026-09-28', 14, true, CFG);
  const b = cal.bookings[0];
  assert.deepEqual([b.guest, b.phone, b.channel], ['Familie Müller', '+49 170 1234567', 'Airbnb']);
  const c = cal.cleanings.find((x) => x.id === '100');
  assert.deepEqual([c.date, c.leadConfirmed, c.assignedTo, c.staffConfirmed, c.guestPhone], ['2026-10-02', true, 'Mia', false, '+49 170 1234567']);
  const m = cal.cleanings.find((x) => x.id === 'm1');
  assert.deepEqual([m.manual, m.note], [true, 'Fenster']);
  assert.equal(L.calendar(state, '2026-09-28', 14, false, CFG).bookings[0].phone, '', 'ohne Namen auch keine Nummer');
});

test('Zeitraum: Mitarbeiterin beantragt mit Begründung → Admin + Leitung; genehmigt → Fristen erst am letzten Tag', () => {
  let state = confirmedTask(); // Check-out 02.10.
  assert.throws(() => L.requestPeriod(state, '100', MIA, { until: '2026-10-03', reason: '' }, NOW, CFG), /begründen/);
  assert.throws(() => L.requestPeriod(state, '100', MIA, { until: '2026-10-02', reason: 'krank' }, NOW, CFG), /nach dem/);
  let res = L.requestPeriod(state, '100', MIA, { until: '2026-10-03', reason: 'Personalengpass' }, NOW, CFG);
  assert.deepEqual(who(res.notifications), ['lea:request', 'owner:request']);
  assert.match(res.notifications[0].body, /02\.10\.2026–Sa, 03\.10\.2026.*Personalengpass/);
  assert.equal(L.openPeriodRequests(res.state).length, 1);
  assert.match(res.notifications[0].body, /bis 15:00 Uhr/);
  res = L.decidePeriod(res.state, '100', true, 'ok', NOW, CFG);
  assert.deepEqual(who(res.notifications), ['lea:period', 'mia:period']);
  assert.match(res.notifications[0].body, /auch am späteren Tag bis spätestens 15:00 Uhr erledigt/);
  assert.equal(res.state.tasks['100'].latestDate, '2026-10-03');
  assert.equal(L.openPeriodRequests(res.state).length, 0);
  // am 02.10. keine Erinnerung, am 03.10. ab 12 Uhr schon
  assert.equal(L.overdueReason(res.state.tasks['100'], at('2026-10-02', '16:00'), CFG), null);
  assert.equal(L.checkDeadlines(res.state, at('2026-10-02', '16:00'), CFG).notifications.length, 0);
  assert.equal(L.overdueReason(res.state.tasks['100'], at('2026-10-03', '12:00'), CFG), 'start');
  // erledigt am ersten Tag ist natürlich auch gut
  const done = L.completeCleaning(res.state, '100', 'mia', at('2026-10-02', '11:00'), CFG, { keysInBox: true });
  assert.equal(done.state.tasks['100'].status, 'erledigt');
});

test('Zeitraum: Ablehnung, Admin legt selbst fest bzw. hebt auf, nächster Gast begrenzt', () => {
  let state = confirmedTask();
  ({ state } = L.applyBooking(state, booking({ id: '200', arrival: '2026-10-04', departure: '2026-10-08' }), NOW, CFG));
  assert.throws(() => L.setPeriod(state, '100', '2026-10-05', NOW, CFG), /04\.10\.2026 reist der nächste Gast an/);
  assert.throws(() => L.setPeriod(state, '100', '2026-10-04', NOW, CFG), /spätestens am Sa, 03\.10\.2026/, 'Anreisetag ist nicht frei');
  let res = L.requestPeriod(state, '100', LEAD, { until: '2026-10-03', reason: 'Engpass' }, NOW, CFG);
  assert.deepEqual(who(res.notifications), ['owner:request']);
  res = L.decidePeriod(res.state, '100', false, 'Gast kommt früh', NOW, CFG);
  assert.equal(res.state.tasks['100'].latestDate, null);
  assert.equal(res.notifications[0].title, 'Zeitraum abgelehnt');
  // Admin übersteuert direkt
  res = L.setPeriod(res.state, '100', '2026-10-03', NOW, CFG);
  assert.equal(res.state.tasks['100'].latestDate, '2026-10-03');
  assert.deepEqual(who(res.notifications), ['lea:period', 'mia:period']);
  const cal = L.calendar(res.state, '2026-10-01', 7, true, CFG, NOW).cleanings.find((c) => c.id === '100');
  assert.equal(cal.latestDate, '2026-10-03');
  res = L.setPeriod(res.state, '100', null, NOW, CFG);
  assert.equal(res.state.tasks['100'].latestDate, null);
  assert.equal(res.notifications[0].title, 'Zeitraum aufgehoben');
});

test('Zeitraum: Smoobu verschiebt den Check-out → Zeitraum und offener Antrag entfallen', () => {
  let { state } = L.setPeriod(confirmedTask(), '100', '2026-10-03', NOW, CFG);
  ({ state } = L.requestPeriod(state, '100', MIA, { until: '2026-10-04', reason: 'x y z' }, NOW, CFG));
  ({ state } = L.applyBooking(state, booking({ action: 'update', departure: '2026-10-05' }), NOW, CFG));
  assert.equal(state.tasks['100'].latestDate, null);
  assert.equal(state.tasks['100'].periodRequest.status, 'hinfällig');
  assert.ok(state.tasks['100'].history.some((h) => /Zeitraum aufgehoben/.test(h.text)));
});

test('Meldung zu einer alten Reinigung ohne Meldungs-/Verlaufsliste (ältere Version) funktioniert', () => {
  const state = confirmedTask();
  delete state.tasks['100'].reports;
  delete state.tasks['100'].history;
  const res = L.addReport(state, '100', MIA, { id: 'r1', text: 'Handtücher fehlen', photos: [] }, NOW, CFG);
  assert.equal(res.state.tasks['100'].reports.length, 1);
  assert.equal(res.state.tasks['100'].history.length, 1);
});

test('Schlüssel nicht in der Box → sofort dringende Nachricht an Admin; Admin klärt', () => {
  const res = L.completeCleaning(confirmedTask(), '100', 'mia', at('2026-10-02', '11:00'), CFG, { keysInBox: false, keysNote: 'Gast hat sie mitgenommen' });
  assert.deepEqual(who(res.notifications), ['lea:done', 'owner:done', 'owner:keys']);
  const keys = res.notifications.find((n) => n.kind === 'keys');
  assert.match(keys.title, /Schlüssel fehlen/);
  assert.match(keys.body, /Gast hat sie mitgenommen/);
  assert.equal(L.missingKeys(res.state).length, 1);
  assert.throws(() => L.resolveKeys(confirmedTask(), '100', '', NOW), /keine Schlüssel/);
  const ok = L.resolveKeys(res.state, '100', 'Gast bringt sie zurück', NOW);
  assert.equal(L.missingKeys(ok.state).length, 0);
  assert.ok(ok.state.tasks['100'].history.some((h) => /Schlüssel geklärt: Gast bringt/.test(h.text)));
});

test('Gästezahl: aus Smoobu übernommen, im Kalender und bei der Reinigung davor als „nächste Anreise“', () => {
  const next = L.fromSmoobuBooking({ id: 300, type: 'reservation', arrival: '2026-10-03', departure: '2026-10-06', apartment: { id: '3', name: 'Loft am Markt' },
    'guest-name': 'Fam. Weber', adults: '2', children: 1, 'check-in': '16:00' });
  assert.equal(next.adults, 2);
  assert.equal(next.children, 1);
  let { state } = L.applyBooking(confirmedTask(), next, NOW, CFG);
  const task = L.listCleanings(state, {}, CFG).find((t) => t.id === '100');
  assert.deepEqual(task.nextBooking, { arrival: '2026-10-03', departure: '2026-10-06', adults: 2, children: 1, guests: '2 Erwachsene, 1 Kind', checkIn: '16:00' });
  assert.equal(L.guestsText(0, 0), '', '0 Personen = nicht angegeben');
  const cal = L.calendar(state, '2026-10-01', 7, false, CFG, NOW);
  assert.equal(cal.bookings.find((b) => b.id === '300').guests, '2 Erwachsene, 1 Kind');
  assert.equal(cal.cleanings.find((c) => c.id === '100').nextBooking.guests, '2 Erwachsene, 1 Kind');
  assert.equal(L.guestsText(1, 0), '1 Erwachsener');
  assert.equal(L.guestsText(null, null), '');
  // Anzahl unbekannt (Feld fehlt) → leer, Anreise trotzdem bekannt
  const x = L.fromSmoobuBooking({ id: 301, arrival: '2026-10-10', departure: '2026-10-12', apartment: { id: '9' } });
  assert.equal(x.adults, null);
});

test('Späterer Tag nur, wenn die Folgetage frei sind: Wechseltag und Sperrzeit verhindern den Antrag', () => {
  // Wechseltag: nächster Gast reist am Check-out-Tag an
  let { state } = L.applyBooking(confirmedTask(), booking({ id: '201', arrival: '2026-10-02', departure: '2026-10-05' }), NOW, CFG);
  let task = L.listCleanings(state, {}, CFG).find((t) => t.id === '100');
  assert.equal(task.periodLimit.last, null);
  assert.match(task.periodLimit.reason, /Wechseltag/);
  assert.throws(() => L.requestPeriod(state, '100', MIA, { until: '2026-10-03', reason: 'Engpass' }, NOW, CFG), /Wechseltag.*nicht möglich/);
  // Anreise am Folgetag → ebenfalls kein späterer Tag
  ({ state } = L.applyBooking(confirmedTask(), booking({ id: '202', arrival: '2026-10-03', departure: '2026-10-05' }), NOW, CFG));
  assert.throws(() => L.requestPeriod(state, '100', MIA, { until: '2026-10-03', reason: 'Engpass' }, NOW, CFG), /03\.10\.2026 reist der nächste Gast an – ein späterer Reinigungstag ist nicht möglich/);
  // Sperrzeit ab 04.10. → bis 03.10. möglich, danach nicht
  state = confirmedTask();
  state.reservations.b1 = { id: 'b1', apartmentId: '3', arrival: '2026-10-04', departure: '2026-10-10', blocked: true };
  assert.throws(() => L.requestPeriod(state, '100', MIA, { until: '2026-10-04', reason: 'Engpass' }, NOW, CFG), /blockiert/);
  assert.equal(L.requestPeriod(state, '100', MIA, { until: '2026-10-03', reason: 'Engpass' }, NOW, CFG).state.tasks['100'].periodRequest.status, 'offen');
});

test('Neue Buchung im genehmigten Zeitraum → Zeitraum sofort verkürzt, Team + Admin informiert; offener Antrag entfällt', () => {
  let { state } = L.setPeriod(confirmedTask(), '100', '2026-10-05', NOW, CFG); // Check-out 02.10., Zeitraum bis 05.10.
  let res = L.applyBooking(state, booking({ id: '203', arrival: '2026-10-04', departure: '2026-10-07' }), NOW, CFG);
  assert.equal(res.state.tasks['100'].latestDate, '2026-10-03');
  const n = res.notifications.filter((x) => x.title === 'Zeitraum verkürzt – neue Buchung');
  assert.deepEqual(who(n), ['lea:period', 'mia:period', 'owner:period']);
  assert.match(n[0].body, /04\.10\.2026 reist der nächste Gast an.*bis 15:00 Uhr/);
  // Anreise direkt am Folgetag → Zeitraum ganz aufgehoben
  res = L.applyBooking(res.state, booking({ id: '204', arrival: '2026-10-03', departure: '2026-10-04' }), NOW, CFG);
  assert.equal(res.state.tasks['100'].latestDate, null);
  // offener Antrag, der nicht mehr passt, entfällt (auch über den Abgleich)
  ({ state } = L.requestPeriod(confirmedTask(), '100', MIA, { until: '2026-10-04', reason: 'Engpass' }, NOW, CFG));
  state.initialized = true;
  const raw = { id: 205, type: 'reservation', arrival: '2026-10-04', departure: '2026-10-06', apartment: { id: '3', name: 'Loft am Markt' } };
  const own = { id: 100, type: 'reservation', arrival: '2026-09-28', departure: '2026-10-02', apartment: { id: '3', name: 'Loft am Markt' } };
  res = L.syncFromSmoobu(state, [own, raw], NOW, CFG, 30);
  assert.equal(res.state.tasks['100'].periodRequest.status, 'hinfällig');
  assert.deepEqual(who(res.notifications.filter((x) => x.title === 'Antrag nicht mehr möglich')), ['mia:period', 'owner:period']);
});
