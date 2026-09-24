/*
 * Reinigungs-Logik für Apartments Strauss (Smoobu → Reinigungsleitung → Mitarbeiterinnen)
 *
 * Rollen
 *  - owner  (Apartments Strauss / Admin)
 *  - lead   (Reinigungsleitung): erhält alle neuen Reinigungen, bestätigt den Erhalt
 *            und weist sie einer Mitarbeiterin (oder sich selbst) zu
 *  - staff  (Mitarbeiterin): sieht nur die ihr zugewiesenen Reinigungen und bestätigt sie
 *
 * Eine Reinigung ist „bestätigt“, wenn Leitung UND zugewiesene Mitarbeiterin bestätigt haben.
 *
 * Fristen (deutsche Zeit)
 *  - 6 Stunden nach Eintragung (oder Verschiebung) nicht vollständig bestätigt → Alarm an Admin
 *  - Reinigungstag ab 12:00 noch nicht begonnen      → „überfällig“, wiederholte Erinnerung
 *  - Reinigungstag ab 15:00 noch nicht beendet       → „überfällig“, wiederholte Erinnerung
 *    (an Leitung, zugewiesene Mitarbeiterin und Admin, alle 30 Min. bis 20 Uhr;
 *     gilt auch für manuelle Reinigungen am selben Tag)
 *
 * Reine Funktionen ohne Abhängigkeiten: laufen im Browser, in Node (Tests) und im
 * Cloudflare Worker. Jede Funktion bekommt den Zustand und gibt einen NEUEN Zustand
 * plus eine Liste von Benachrichtigungen zurück. Verschickt werden sie vom Aufrufer.
 */
(function (root) {
  'use strict';

  const DEFAULT_CONFIG = {
    timezone: 'Europe/Berlin',
    confirmWithinHours: 6,       // so lange nach Eintragung muss alles bestätigt sein
    startBy: '12:00',            // Reinigungstag: bis dahin muss die Reinigung begonnen sein
    finishBy: '15:00',           // Reinigungstag: bis dahin muss sie erledigt sein
    repeatMinutes: 30,           // überfällig → Erinnerung wiederholen im Abstand von … Minuten
    quietFrom: '22:00',
    maxPeriodDays: 7,            // Zeitraum höchstens so viele Tage nach dem Check-out
    // Feste Punkte, die vor dem Beenden abgehakt sein müssen (de = Deutsch, hu = Ungarisch)
    checklist: [
      { id: 'bett', de: 'Bettwäsche gewechselt, Betten gemacht', hu: 'Ágynemű cserélve, ágyak bevetve' },
      { id: 'bad', de: 'Bad & WC gereinigt, Handtücher ausgetauscht', hu: 'Fürdőszoba és WC kitakarítva, törölközők kicserélve' },
      { id: 'kueche', de: 'Küche gereinigt, Geschirr sauber & eingeräumt, Kühlschrank geleert', hu: 'Konyha kitakarítva, edények tiszták és elpakolva, hűtő kiürítve' },
      { id: 'boden', de: 'Böden gesaugt & gewischt', hu: 'Padló porszívózva és felmosva' },
      { id: 'staub', de: 'Staub gewischt (Flächen, Regale, Fensterbänke)', hu: 'Portörlés (felületek, polcok, ablakpárkányok)' },
      { id: 'muell', de: 'Müll entsorgt, neue Beutel eingelegt', hu: 'Szemét kivive, új zsák behelyezve' },
      { id: 'auffuellen', de: 'Verbrauchsmaterial aufgefüllt (Toilettenpapier, Seife, Kaffee …)', hu: 'Fogyóeszközök feltöltve (WC-papír, szappan, kávé …)' },
      { id: 'fenster', de: 'Fenster geschlossen, Heizung/Klima heruntergeregelt', hu: 'Ablakok bezárva, fűtés/klíma lejjebb véve' },
      { id: 'licht', de: 'Licht & Geräte aus, Wohnung abgeschlossen', hu: 'Világítás és készülékek kikapcsolva, lakás bezárva' },
    ],
    // „Knapp“-Knöpfe → Einkaufsliste für den Admin
    supplies: [
      { id: 'klopapier', de: 'Toilettenpapier', hu: 'WC-papír' },
      { id: 'kuechenrolle', de: 'Küchenrolle', hu: 'Papírtörlő' },
      { id: 'seife', de: 'Handseife', hu: 'Kézszappan' },
      { id: 'duschgel', de: 'Duschgel / Shampoo', hu: 'Tusfürdő / sampon' },
      { id: 'spuelmittel', de: 'Spülmittel', hu: 'Mosogatószer' },
      { id: 'tabs', de: 'Spülmaschinentabs', hu: 'Mosogatógép-tabletta' },
      { id: 'schwamm', de: 'Schwämme / Lappen', hu: 'Szivacs / törlőkendő' },
      { id: 'muellbeutel', de: 'Müllbeutel', hu: 'Szemeteszsák' },
      { id: 'kaffee', de: 'Kaffee', hu: 'Kávé' },
      { id: 'tee', de: 'Tee', hu: 'Tea' },
      { id: 'zucker', de: 'Zucker / Salz / Pfeffer', hu: 'Cukor / só / bors' },
      { id: 'reiniger', de: 'Reinigungsmittel', hu: 'Tisztítószer' },
      { id: 'waesche', de: 'Bettwäsche / Handtücher', hu: 'Ágynemű / törölköző' },
      { id: 'batterien', de: 'Batterien / Glühbirnen', hu: 'Elem / izzó' },
    ],          // ab dann keine Erinnerungen mehr (Nachtruhe)
    owner: { id: 'owner', name: 'Apartments Strauss' },
    leads: [],                   // [{ id, name }]
    staff: [],                   // [{ id, name }]
    apartments: [],              // optionale Namen: [{ id, name }]
  };

  const STATUS = {
    OPEN: 'offen',          // noch nicht vollständig bestätigt
    CONFIRMED: 'bestätigt', // Leitung + Mitarbeiterin haben bestätigt
    DONE: 'erledigt',
    CANCELLED: 'storniert',
  };

  // ---------------------------------------------------------------------------
  // Datum / Zeit
  // ---------------------------------------------------------------------------

  /** Letzter Sonntag eines Monats um 01:00 UTC (EU-Sommerzeitregel). */
  function lastSundayUtc(year, month) {
    const last = new Date(Date.UTC(year, month + 1, 0, 1));
    return last.getTime() - last.getUTCDay() * 86400000;
  }

  /**
   * Liefert { date: 'YYYY-MM-DD', time: 'HH:MM' } in der gewünschten Zeitzone.
   * Für Europe/Berlin ohne Intl gerechnet: Das erste Intl.DateTimeFormat kostet
   * ~12 ms Rechenzeit, im kostenlosen Cloudflare-Tarif sind nur 10 ms erlaubt.
   */
  function localParts(now, timezone) {
    const d = now instanceof Date ? now : new Date(now);
    if (timezone === 'Europe/Berlin') {
      const y = d.getUTCFullYear();
      const summer = d.getTime() >= lastSundayUtc(y, 2) && d.getTime() < lastSundayUtc(y, 9);
      const local = new Date(d.getTime() + (summer ? 2 : 1) * 3600000).toISOString();
      return { date: local.slice(0, 10), time: local.slice(11, 16) };
    }
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d);
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }

  const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

  /** '2026-10-03' → 'Sa, 03.10.2026' */
  function formatDate(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    return `${wd}, ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
  }

  function addDays(isoDate, days) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  }

  const toIso = (now) => new Date(now).toISOString();
  const hhmm = (iso, tz) => localParts(iso, tz).time;

  // ---------------------------------------------------------------------------
  // Hilfsfunktionen
  // ---------------------------------------------------------------------------

  function createState() {
    return { tasks: {}, reservations: {} };
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function withConfig(config) {
    return Object.assign({}, DEFAULT_CONFIG, config || {});
  }

  function apartmentName(config, apartmentId, fallback) {
    const apt = (config.apartments || []).find((a) => a.id === String(apartmentId));
    return apt ? apt.name : fallback || 'Wohnung ' + apartmentId;
  }

  function personName(config, id) {
    const p = [...config.leads, ...config.staff].find((x) => x.id === id);
    return p ? p.name : 'Unbekannt';
  }

  const leadIds = (config) => config.leads.map((l) => l.id);
  const isLead = (config, id) => config.leads.some((l) => l.id === id);
  const isStaff = (config, id) => config.staff.some((s) => s.id === id);
  const uniq = (list) => [...new Set(list.filter(Boolean))];

  /** Leitung + ggf. zugewiesene Person (ohne den Auslöser selbst) */
  function team(config, task, except) {
    return uniq([...leadIds(config), task.assignedTo]).filter((id) => id !== except);
  }

  function notify(to, kind, task, title, body) {
    return uniq(to).map((recipient) => ({ to: recipient, kind, taskId: task.id, title, body }));
  }

  function log(task, nowIso, text) {
    (task.history = task.history || []).push({ at: nowIso, text });
  }

  function fullyConfirmed(task) {
    return !!(task.leadConfirmedAt && task.assignedTo && task.staffConfirmedAt);
  }

  function updateStatus(task) {
    if (task.status === STATUS.DONE || task.status === STATUS.CANCELLED) return;
    task.status = fullyConfirmed(task) ? STATUS.CONFIRMED : STATUS.OPEN;
  }

  const isActive = (t) => t.status === STATUS.OPEN || t.status === STATUS.CONFIRMED;

  function getTask(state, taskId) {
    const task = state.tasks[taskId];
    if (!task) throw new Error('Reinigung nicht gefunden');
    // Einträge aus älteren Versionen haben evtl. noch keine Listen für Meldungen/Verlauf
    if (!Array.isArray(task.reports)) task.reports = [];
    if (!Array.isArray(task.history)) task.history = [];
    return task;
  }

  function requireActive(task) {
    if (task.status === STATUS.CANCELLED) throw new Error('Reinigung wurde abgesagt');
    if (task.status === STATUS.DONE) throw new Error('Reinigung ist bereits erledigt');
  }

  /** Neues Datum → alle Bestätigungen zurücksetzen, Fristen neu starten */
  function resetForNewDate(task, nowIso) {
    task.changedAt = nowIso;
    task.confirmFrom = nowIso;
    task.leadConfirmedAt = null;
    task.leadConfirmedBy = null;
    task.staffConfirmedAt = null;
    task.lateAlerted = false;
    task.lastReminderAt = null;
    task.lastReminderReason = null;
    task.pastReminded = false;
    if (task.latestDate) {
      task.latestDate = null;
      log(task, nowIso, 'Zeitraum aufgehoben (neues Datum)');
    }
    if (task.periodRequest && task.periodRequest.status === 'offen') task.periodRequest.status = 'hinfällig';
    updateStatus(task);
  }

  function newTask(fields, nowIso) {
    return Object.assign({
      manual: false, guest: '', guestPhone: '', note: '',
      createdAt: nowIso, changedAt: null, confirmFrom: nowIso,
      status: STATUS.OPEN,
      leadConfirmedAt: null, leadConfirmedBy: null,
      assignedTo: null, assignedAt: null, staffConfirmedAt: null,
      startedAt: null, startedBy: null, doneAt: null, doneBy: null,
      lateAlerted: false, lastReminderAt: null, pastReminded: false,
      latestDate: null, periodRequest: null,
      history: [], reports: [],
    }, fields);
  }

  // ---------------------------------------------------------------------------
  // Buchungen aus Smoobu
  // ---------------------------------------------------------------------------

  function mapSmoobu(r, action) {
    return {
      action,
      id: String(r.id),
      apartmentId: String(r.apartment && r.apartment.id),
      apartmentName: r.apartment && r.apartment.name,
      guest: r['guest-name'] || [r.firstname, r.lastname].filter(Boolean).join(' '),
      guestPhone: String(r.phone || '').trim(),
      channel: (r.channel && r.channel.name) || '',
      arrival: r.arrival,
      departure: r.departure,
      adults: count(r.adults),
      children: count(r.children),
      checkIn: timeOf(r['check-in']),
    };
  }

  /** Personenzahl aus Smoobu (fehlt/ungültig → null = unbekannt) */
  function count(value) {
    const n = Number(value);
    return value === '' || value == null || !Number.isFinite(n) || n < 0 ? null : Math.round(n);
  }

  /** Uhrzeit „16:00“ aus Smoobu (check-in), sonst '' */
  function timeOf(value) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(value || '').trim());
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
  }

  /** z. B. „2 Erwachsene, 1 Kind“; unbekannt (oder 0 Personen) → '' */
  function guestsText(adults, children) {
    if (!adults && !children) return '';
    const parts = [];
    if (adults != null) parts.push(`${adults} ${adults === 1 ? 'Erwachsener' : 'Erwachsene'}`);
    if (children) parts.push(`${children} ${children === 1 ? 'Kind' : 'Kinder'}`);
    return parts.join(', ');
  }

  /** Smoobu-Webhook { action, data } → einheitliche Buchung */
  function fromSmoobuWebhook(payload) {
    const actions = { newReservation: 'new', updateReservation: 'update', cancelReservation: 'cancel', deleteReservation: 'cancel' };
    const action = actions[payload.action];
    if (!action) return null;
    return mapSmoobu(payload.data || {}, action);
  }

  /** Buchung aus GET /api/reservations; Sperrzeiten → null (keine Reinigung), Stornos → cancel */
  function fromSmoobuBooking(r) {
    if (!r || r['is-blocked-booking']) return null;
    return mapSmoobu(r, r.type === 'cancellation' ? 'cancel' : 'update');
  }

  /** IDs aller aktiven Smoobu-Reinigungen ab einem Datum (manuelle ausgenommen). */
  function activeTaskIds(state, fromDate) {
    return Object.values(state.tasks).filter((t) => !t.manual && isActive(t) && t.date >= fromDate).map((t) => t.id);
  }

  /**
   * Neue / geänderte / stornierte Buchung verarbeiten.
   * booking: { action: 'new'|'update'|'cancel', id, apartmentId, apartmentName, guest, guestPhone, arrival, departure }
   */
  function applyBooking(state, booking, now, config, inPlace, skipPeriods) {
    config = withConfig(config);
    if (!inPlace) state = clone(state);
    const result = applyBookingInner(state, booking, now, config);
    // Neue/geänderte Buchung kann einen genehmigten Zeitraum in derselben Wohnung blockieren
    if (!skipPeriods && booking.action !== 'cancel') {
      result.notifications.push(...enforcePeriods(result.state, config, toIso(now), String(booking.apartmentId)));
    }
    return result;
  }

  function applyBookingInner(state, booking, now, config) {
    const nowIso = toIso(now);
    const notifications = [];
    const id = String(booking.id);
    const existing = state.tasks[id];

    if (booking.action === 'cancel') {
      delete state.reservations[id];
      if (!existing || !isActive(existing)) return { state, notifications };
      existing.status = STATUS.CANCELLED;
      existing.changedAt = nowIso;
      log(existing, nowIso, 'Buchung storniert – Reinigung entfällt');
      notifications.push(...notify(team(config, existing), 'cancelled', existing, 'Reinigung entfällt',
        `${existing.apartmentName}: Endreinigung am ${formatDate(existing.date)} entfällt (Buchung storniert).`));
      return { state, notifications };
    }

    state.reservations[id] = { id, apartmentId: String(booking.apartmentId), arrival: booking.arrival, departure: booking.departure,
      guest: booking.guest || '', phone: booking.guestPhone || '', channel: booking.channel || '',
      adults: booking.adults == null ? null : booking.adults, children: booking.children == null ? null : booking.children,
      checkIn: booking.checkIn || '' };

    if (!existing || existing.status === STATUS.CANCELLED) {
      const task = newTask({
        id, apartmentId: String(booking.apartmentId),
        apartmentName: apartmentName(config, booking.apartmentId, booking.apartmentName),
        guest: booking.guest || '', guestPhone: booking.guestPhone || '',
        date: booking.departure, source: 'smoobu',
      }, nowIso);
      log(task, nowIso, `Aus Smoobu eingetragen für ${formatDate(task.date)}`);
      state.tasks[id] = task;
      notifications.push(...notify(leadIds(config), 'new', task, 'Neue Reinigung',
        `${task.apartmentName}: Endreinigung am ${formatDate(task.date)}. Bitte bestätigen und zuweisen.`));
      return { state, notifications };
    }

    // Änderung einer bestehenden Buchung
    existing.guest = booking.guest || existing.guest;
    existing.guestPhone = booking.guestPhone || existing.guestPhone || '';
    const oldCheckout = existing.checkoutDate || existing.date;
    if (booking.departure === oldCheckout || existing.status === STATUS.DONE) return { state, notifications };

    const verb = booking.departure > oldCheckout ? 'verlängert' : 'verkürzt';
    const diff = dayDiffText(oldCheckout, booking.departure);
    // Vom Admin auf einen späteren Tag gelegt und der liegt weiterhin nach dem neuen Check-out → Reinigungstag bleibt
    if (existing.movedByAdmin && existing.date >= booking.departure) {
      existing.checkoutDate = booking.departure;
      existing.changedAt = nowIso;
      log(existing, nowIso, `Aufenthalt ${verb} (${diff}): Check-out ${formatDate(oldCheckout)} → ${formatDate(booking.departure)} – Reinigung bleibt am ${formatDate(existing.date)}`);
      notifications.push(...notify([...team(config, existing), config.owner.id], 'rescheduled', existing, 'Check-out geändert – wichtig',
        `${existing.apartmentName}: Aufenthalt ${verb} (${diff}). Check-out jetzt am ${formatDate(booking.departure)} statt ${formatDate(oldCheckout)}. Die Reinigung bleibt am ${formatDate(existing.date)}.`));
      return { state, notifications };
    }

    const oldDate = existing.date;
    const wasConfirmed = existing.status === STATUS.CONFIRMED;
    existing.date = booking.departure;
    existing.checkoutDate = null;
    existing.movedByAdmin = false;
    resetForNewDate(existing, nowIso);
    existing.prevDate = oldDate;
    log(existing, nowIso, `Aufenthalt ${verb} (${diff}): Reinigung ${formatDate(oldDate)} → ${formatDate(existing.date)}`);
    notifications.push(...notify(team(config, existing), 'rescheduled', existing, 'Reinigung verschoben',
      `WICHTIG – ${existing.apartmentName}: Aufenthalt ${verb} (${diff}). Reinigung jetzt am ${formatDate(existing.date)} statt ${formatDate(oldDate)}. Bitte neu bestätigen.`));
    if (wasConfirmed) {
      notifications.push(...notify([config.owner.id], 'rescheduled', existing, 'Bestätigte Reinigung verschoben',
        `${existing.apartmentName}: ${formatDate(oldDate)} → ${formatDate(existing.date)}. Neue Bestätigung ausstehend.`));
    }
    return { state, notifications };
  }

  /**
   * Abgleich mit der Buchungsliste aus Smoobu. Beim allerersten Abgleich still
   * (keine Push-Flut). Alte Einträge (älter als keepDays) werden aufgeräumt.
   */
  function syncFromSmoobu(state, smoobuBookings, now, config, keepDays, windowFrom) {
    config = withConfig(config);
    const silent = !state.initialized;
    const notifications = [];
    state = clone(state); // einmal kopieren, dann direkt ändern (Cloudflare-Rechenzeitlimit)
    const seen = new Set();
    for (const raw of smoobuBookings) {
      if (!raw) continue;
      seen.add(String(raw.id));
      if (raw['is-blocked-booking'] && raw.type === 'cancellation') { // aufgehobene Sperrzeit
        delete state.reservations[String(raw.id)];
        continue;
      }
      if (raw['is-blocked-booking']) { // Sperrzeit: nur für den Kalender merken, keine Reinigung
        state.reservations[String(raw.id)] = { id: String(raw.id), apartmentId: String(raw.apartment && raw.apartment.id),
          arrival: raw.arrival, departure: raw.departure, guest: '', blocked: true };
        continue;
      }
      const booking = fromSmoobuBooking(raw);
      if (!booking) continue;
      const res = applyBooking(state, booking, now, config, true, true);
      if (!silent) notifications.push(...res.notifications);
    }
    // Im abgefragten Zeitraum nicht mehr vorhanden (z. B. Sperrzeit aufgehoben) → aus dem Kalender entfernen
    if (windowFrom) {
      for (const r of Object.values(state.reservations)) {
        if (r.departure >= windowFrom && !seen.has(r.id) && !(state.tasks[r.id] && isActive(state.tasks[r.id]))) delete state.reservations[r.id];
      }
    }
    const cutoff = addDays(localParts(now, config.timezone).date, -(keepDays || 30));
    for (const t of Object.values(state.tasks)) if (t.date < cutoff) delete state.tasks[t.id];
    for (const r of Object.values(state.reservations)) if (r.departure < cutoff) delete state.reservations[r.id];
    // Zeiträume gegen neue Buchungen/Sperrzeiten prüfen (einmal für alle Wohnungen)
    const periodNotes = enforcePeriods(state, config, toIso(now));
    if (!silent) notifications.push(...periodNotes);
    state.initialized = true;
    state.lastSync = toIso(now);
    return { state, notifications };
  }

  // ---------------------------------------------------------------------------
  // Manuelle Reinigungen (Admin)
  // ---------------------------------------------------------------------------

  function checkDate(date, now, config) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Bitte ein gültiges Datum wählen');
    if (date < localParts(now, config.timezone).date) throw new Error('Das Datum liegt in der Vergangenheit');
  }

  /** input: { id, apartmentId, apartmentName, date, note } */
  function addManualCleaning(state, input, now, config) {
    config = withConfig(config);
    if (!input.apartmentId) throw new Error('Bitte eine Wohnung wählen');
    checkDate(input.date, now, config);
    state = clone(state);
    const id = String(input.id);
    if (state.tasks[id]) throw new Error('Reinigung existiert bereits');
    const nowIso = toIso(now);
    const task = newTask({
      id, manual: true, source: 'manuell',
      apartmentId: String(input.apartmentId),
      apartmentName: apartmentName(config, input.apartmentId, input.apartmentName),
      note: (input.note || '').trim().slice(0, 500),
      date: input.date,
    }, nowIso);
    log(task, nowIso, `Manuell eingetragen für ${formatDate(task.date)}`);
    state.tasks[id] = task;
    const notifications = notify(leadIds(config), 'new', task, 'Zusätzliche Reinigung',
      `${task.apartmentName}: Reinigung am ${formatDate(task.date)}.${task.note ? ' Hinweis: ' + task.note : ''} Bitte bestätigen und zuweisen.`);
    return { state, notifications };
  }

  /** Manuelle Reinigung ändern (Datum, Hinweis). Datum geändert → neu bestätigen. */
  function editManualCleaning(state, taskId, input, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = getTask(state, taskId);
    if (!task.manual) throw new Error('Reinigungen aus Smoobu bitte in Smoobu ändern');
    requireActive(task);
    const nowIso = toIso(now);
    const notifications = [];
    const note = input.note == null ? task.note : String(input.note).trim().slice(0, 500);
    if (input.date && input.date !== task.date) {
      checkDate(input.date, now, config);
      const oldDate = task.date;
      task.date = input.date;
      task.note = note;
      resetForNewDate(task, nowIso);
      log(task, nowIso, `Verschoben: ${formatDate(oldDate)} → ${formatDate(task.date)}`);
      notifications.push(...notify(team(config, task), 'rescheduled', task, 'Reinigung verschoben',
        `${task.apartmentName}: Reinigung jetzt am ${formatDate(task.date)} statt ${formatDate(oldDate)}.${note ? ' Hinweis: ' + note : ''} Bitte neu bestätigen.`));
    } else if (note !== task.note) {
      task.note = note;
      task.changedAt = nowIso;
      log(task, nowIso, 'Hinweis geändert');
      notifications.push(...notify(team(config, task), 'edited', task, 'Hinweis geändert',
        `${task.apartmentName} (${formatDate(task.date)}): ${note || 'Hinweis entfernt'}`));
    }
    return { state, notifications };
  }

  /** „7 Tage später“ / „1 Tag früher“ */
  function dayDiffText(from, to) {
    const n = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
    const abs = Math.abs(n);
    return `${abs} ${abs === 1 ? 'Tag' : 'Tage'} ${n > 0 ? 'später' : 'früher'}`;
  }

  /**
   * Admin legt eine Reinigung (auch aus Smoobu) auf einen anderen Tag, z. B. eine Woche nach dem Check-out.
   * Nicht vor dem Check-out, nicht nach der Anreise des nächsten Gastes. Team wird informiert und bestätigt neu.
   */
  function moveCleaning(state, taskId, date, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = getTask(state, taskId);
    requireActive(task);
    checkDate(date, now, config);
    if (date === task.date) return { state, notifications: [] };
    const checkout = task.manual ? null : (task.checkoutDate || task.date);
    if (checkout && date < checkout) throw new Error(`Die Reinigung kann nicht vor dem Check-out (${formatDate(checkout)}) liegen`);
    if (checkout) {
      let arrival = null;
      for (const r of Object.values(state.reservations || {})) {
        if (r.apartmentId !== task.apartmentId || r.id === task.id || r.blocked || r.arrival < checkout) continue;
        if (!arrival || r.arrival < arrival) arrival = r.arrival;
      }
      if (arrival && date > arrival) throw new Error(`Am ${formatDate(arrival)} reist der nächste Gast an – die Reinigung muss spätestens an diesem Tag sein`);
    }
    const nowIso = toIso(now);
    const oldDate = task.date;
    if (checkout) {
      task.checkoutDate = checkout;
      task.movedByAdmin = date !== checkout;
    }
    task.date = date;
    resetForNewDate(task, nowIso);
    task.prevDate = oldDate;
    const diff = dayDiffText(oldDate, date);
    log(task, nowIso, `Vom Admin verschoben (${diff}): ${formatDate(oldDate)} → ${formatDate(date)}`);
    return { state, notifications: notify(team(config, task), 'rescheduled', task, 'Reinigung verschoben',
      `WICHTIG – ${task.apartmentName}: Reinigung jetzt am ${formatDate(date)} statt ${formatDate(oldDate)} (${diff}). Bitte neu bestätigen.`) };
  }

  /**
   * Muss in Smoobu blockiert werden? Zwischen Check-out und (letztem) Reinigungstag darf kein Gast buchen.
   * Liefert { from, to } (Nächte from … to-1) oder null, wenn nichts nötig bzw. schon blockiert ist.
   */
  function needsBlock(state, task) {
    if (task.manual || !isActive(task)) return null;
    const from = task.checkoutDate || task.date;
    const to = lastDay(task);
    if (to <= from) return null;
    const blocks = Object.values(state.reservations || {}).filter((r) => r.blocked && r.apartmentId === task.apartmentId);
    for (let d = from; d < to; d = addDays(d, 1)) {
      if (!blocks.some((b) => b.arrival <= d && d < b.departure)) return { from, to };
    }
    return null;
  }

  function cancelManualCleaning(state, taskId, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = getTask(state, taskId);
    if (!task.manual) throw new Error('Reinigungen aus Smoobu bitte in Smoobu ändern');
    if (!isActive(task)) return { state, notifications: [] };
    const nowIso = toIso(now);
    task.status = STATUS.CANCELLED;
    task.changedAt = nowIso;
    log(task, nowIso, 'Vom Admin abgesagt');
    return { state, notifications: notify(team(config, task), 'cancelled', task, 'Reinigung entfällt',
      `${task.apartmentName}: Reinigung am ${formatDate(task.date)} entfällt.`) };
  }

  // ---------------------------------------------------------------------------
  // Reinigungsleitung
  // ---------------------------------------------------------------------------

  /** Info an Admin, sobald eine Reinigung vollständig bestätigt ist. */
  function confirmedNote(config, task, before) {
    if (before === STATUS.CONFIRMED || task.status !== STATUS.CONFIRMED) return [];
    return notify([config.owner.id], 'confirmed', task, 'Reinigung bestätigt',
      `${task.apartmentName} am ${formatDate(task.date)}: übernimmt ${personName(config, task.assignedTo)}.`);
  }

  /** Leitung bestätigt den Erhalt. */
  function leadConfirm(state, taskId, leadId, now, config) {
    config = withConfig(config);
    if (!isLead(config, leadId)) throw new Error('Nur die Reinigungsleitung kann das bestätigen');
    state = clone(state);
    const task = getTask(state, taskId);
    requireActive(task);
    const nowIso = toIso(now);
    task.leadConfirmedAt = nowIso;
    task.leadConfirmedBy = leadId;
    log(task, nowIso, `Erhalt bestätigt von ${personName(config, leadId)} (Leitung)`);
    const before = task.status;
    updateStatus(task);
    return { state, notifications: confirmedNote(config, task, before) };
  }

  /** Leitung weist die Reinigung einer Mitarbeiterin (oder sich selbst) zu. */
  function assignCleaning(state, taskId, leadId, assigneeId, now, config) {
    config = withConfig(config);
    if (!isLead(config, leadId)) throw new Error('Nur die Reinigungsleitung kann zuweisen');
    if (!isStaff(config, assigneeId) && !isLead(config, assigneeId)) throw new Error('Bitte eine Mitarbeiterin auswählen');
    state = clone(state);
    const task = getTask(state, taskId);
    requireActive(task);
    const nowIso = toIso(now);
    const notifications = [];
    const previous = task.assignedTo;
    if (!task.leadConfirmedAt) { // Zuweisen heißt auch: Erhalt bestätigt
      task.leadConfirmedAt = nowIso;
      task.leadConfirmedBy = leadId;
    }
    if (previous !== assigneeId) {
      task.assignedTo = assigneeId;
      task.assignedAt = nowIso;
      task.staffConfirmedAt = assigneeId === leadId ? nowIso : null; // sich selbst zugewiesen = bestätigt
      log(task, nowIso, `Zugewiesen an ${personName(config, assigneeId)}`);
      if (previous) {
        notifications.push(...notify([previous], 'unassigned', task, 'Reinigung neu vergeben',
          `${task.apartmentName} (${formatDate(task.date)}) wurde an jemand anderen vergeben.`));
      }
      if (assigneeId !== leadId) {
        notifications.push(...notify([assigneeId], 'assigned', task, 'Neue Reinigung für dich',
          `${task.apartmentName}: Reinigung am ${formatDate(task.date)}.${task.note ? ' Hinweis: ' + task.note : ''} Bitte bestätigen.`));
      }
    }
    const before = task.status;
    updateStatus(task);
    notifications.push(...confirmedNote(config, task, before));
    return { state, notifications };
  }

  // ---------------------------------------------------------------------------
  // Mitarbeiterin
  // ---------------------------------------------------------------------------

  function canWork(config, task, userId) {
    return task.assignedTo === userId || isLead(config, userId);
  }

  /** Zugewiesene Mitarbeiterin bestätigt den Erhalt. */
  function staffConfirm(state, taskId, userId, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = getTask(state, taskId);
    requireActive(task);
    if (task.assignedTo !== userId) throw new Error('Diese Reinigung ist dir nicht zugewiesen');
    const nowIso = toIso(now);
    task.staffConfirmedAt = nowIso;
    task.prevDate = null; // Änderung gesehen und bestätigt
    log(task, nowIso, `Bestätigt von ${personName(config, userId)}`);
    const before = task.status;
    updateStatus(task);
    return { state, notifications: confirmedNote(config, task, before) };
  }

  /** Beginn der Reinigung erfassen (optional). */
  function startCleaning(state, taskId, userId, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = getTask(state, taskId);
    requireActive(task);
    if (!canWork(config, task, userId)) throw new Error('Diese Reinigung ist dir nicht zugewiesen');
    if (task.startedAt) return { state, notifications: [] };
    const nowIso = toIso(now);
    task.startedAt = nowIso;
    task.startedBy = userId;
    log(task, nowIso, `Reinigung begonnen (${personName(config, userId)})`);
    return { state, notifications: [] };
  }

  /**
   * Reinigung erledigt (Ende). Pflicht-Checkpunkt: input.keysInBox (true/false) –
   * sind die Gästeschlüssel in der Box? Nein → sofort dringende Push an den Admin.
   */
  function completeCleaning(state, taskId, userId, now, config, input) {
    config = withConfig(config);
    input = input || {};
    const checked = new Set(Array.isArray(input.checklist) ? input.checklist : []);
    const missing = config.checklist.filter((c) => !checked.has(c.id));
    if (missing.length) throw new Error(`Bitte zuerst alle Punkte der Checkliste abhaken (es fehlt: ${missing.map((c) => c.de).join('; ')})`);
    if (typeof input.keysInBox !== 'boolean') throw new Error('Bitte angeben, ob die Gästeschlüssel in der Box sind (Ja/Nein)');
    state = clone(state);
    const task = getTask(state, taskId);
    requireActive(task);
    if (!canWork(config, task, userId)) throw new Error('Diese Reinigung ist dir nicht zugewiesen');
    const nowIso = toIso(now);
    const keysNote = String(input.keysNote || '').trim().slice(0, 500);
    task.status = STATUS.DONE;
    task.doneAt = nowIso;
    task.doneBy = userId;
    task.keysInBox = input.keysInBox;
    task.keysNote = keysNote;
    task.keysResolvedAt = null;
    task.checklistDone = config.checklist.map((c) => c.id);
    const newSupplies = markSupplies(state, task, userId, input.supplies, nowIso, config);
    const minutes = task.startedAt ? Math.round((Date.parse(nowIso) - Date.parse(task.startedAt)) / 60000) : null;
    const duration = minutes != null ? ` (Dauer ${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} Std.)` : '';
    log(task, nowIso, `Erledigt von ${personName(config, userId)}${duration} · Gästeschlüssel ${input.keysInBox ? 'in der Box ✓' : 'NICHT in der Box'}${keysNote ? ': ' + keysNote : ''}`);
    const to = [config.owner.id, ...leadIds(config)].filter((id) => id !== userId);
    const next = nextBooking(state, task);
    const nextText = next ? ` Nächste Anreise: ${formatDate(next.arrival)}${next.checkIn ? ' ab ' + next.checkIn + ' Uhr' : ''}${next.guests ? ' (' + next.guests + ')' : ''}.` : '';
    const notifications = notify(to, 'done', task, `Wohnung fertig: ${task.apartmentName}`,
      `Fertig um ${hhmm(nowIso, config.timezone)} Uhr – ${personName(config, userId)}${duration}. Schlüssel ${input.keysInBox ? 'in der Box ✓' : 'fehlen!'}${nextText}`);
    if (newSupplies.length) notifications.push(...suppliesNote(config, task, userId, newSupplies));
    if (!input.keysInBox) {
      notifications.push(...notify([config.owner.id], 'keys', task, `Schlüssel fehlen: ${task.apartmentName}`,
        `${personName(config, userId)} meldet: Gästeschlüssel sind NICHT in der Box (${formatDate(task.date)}).${keysNote ? ' ' + keysNote : ''} Bitte umgehend klären.`));
    }
    return { state, notifications };
  }

  /**
   * Zugangscodes (Gäste-Code, Service-Schlüsselbox) dürfen abgerufen werden von: Admin, Reinigungsleitung
   * und der zugewiesenen Mitarbeiterin – nur solange die Reinigung ansteht (bzw. am Tag der Erledigung).
   */
  function mayViewCodes(config, task, user, now) {
    config = withConfig(config);
    if (task.status === STATUS.CANCELLED) return false;
    if (user.role === 'owner') return true;
    if (user.role === 'staff' && task.assignedTo !== user.id) return false;
    if (isActive(task)) return true;
    return task.status === STATUS.DONE && !!task.doneAt
      && localParts(task.doneAt, config.timezone).date === localParts(now, config.timezone).date;
  }

  /** Abruf der Codes im Verlauf festhalten (wer, wann) – keine Push-Nachricht */
  function logCodeAccess(state, taskId, user, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = getTask(state, taskId);
    if (!mayViewCodes(config, task, user, now)) throw new Error('Codes für diese Reinigung nicht verfügbar');
    const name = user.role === 'owner' ? config.owner.name : personName(config, user.id);
    log(task, toIso(now), `Zugangscodes abgerufen von ${name}`);
    return { state, notifications: [] };
  }

  // ---------------------------------------------------------------------------
  // Verbrauchsmaterial: „knapp“ melden → Einkaufsliste (je Wohnung, bis der Admin „aufgefüllt“ tippt)
  // ---------------------------------------------------------------------------

  /** Trägt die Artikel ein; liefert die neu gemeldeten Artikel-IDs */
  function markSupplies(state, task, userId, items, nowIso, config) {
    const known = new Set(config.supplies.map((s) => s.id));
    state.supplies = state.supplies || {};
    const list = state.supplies[task.apartmentId] = state.supplies[task.apartmentId] || {};
    const added = [];
    for (const id of Array.isArray(items) ? items : []) {
      if (!known.has(id) || list[id]) continue;
      list[id] = { at: nowIso, by: userId, taskId: task.id };
      added.push(id);
    }
    if (added.length) log(task, nowIso, `Knapp gemeldet: ${added.map((id) => supplyName(config, id)).join(', ')}`);
    return added;
  }

  const supplyName = (config, id) => (config.supplies.find((s) => s.id === id) || { de: id }).de;

  function suppliesNote(config, task, userId, ids) {
    return notify([config.owner.id], 'supplies', task, `Knapp: ${task.apartmentName}`,
      `${personName(config, userId)} meldet: ${ids.map((id) => supplyName(config, id)).join(', ')}.`);
  }

  /** Reinigungsteam meldet, was knapp ist (eine Nachricht je Meldung, nicht je Artikel) */
  function reportSupplies(state, taskId, user, items, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = getTask(state, taskId);
    if (!canAccess(config, task, user) || task.status === STATUS.CANCELLED) throw new Error('Keine Berechtigung für diese Reinigung');
    const added = markSupplies(state, task, user.id, items, toIso(now), config);
    if (!added.length) throw new Error('Bitte mindestens einen Artikel auswählen, der noch nicht gemeldet ist');
    return { state, notifications: user.role === 'owner' ? [] : suppliesNote(config, task, user.id, added) };
  }

  /** Admin: aufgefüllt – ein Artikel in einer Wohnung, alle einer Wohnung oder ein Artikel überall */
  function resolveSupplies(state, apartmentId, itemId) {
    state = clone(state);
    state.supplies = state.supplies || {};
    for (const apt of Object.keys(state.supplies)) {
      if (apartmentId && apt !== String(apartmentId)) continue;
      for (const id of Object.keys(state.supplies[apt])) if (!itemId || id === itemId) delete state.supplies[apt][id];
      if (!Object.keys(state.supplies[apt]).length) delete state.supplies[apt];
    }
    return { state, notifications: [] };
  }

  /** Einkaufsliste: je Artikel die Wohnungen, in denen er knapp ist */
  function shoppingList(state, config) {
    config = withConfig(config);
    const names = {};
    for (const t of Object.values(state.tasks)) names[t.apartmentId] = t.apartmentName;
    for (const a of state.apartments || []) names[a.id] = a.name;
    const out = [];
    for (const s of config.supplies) {
      const apartments = [];
      for (const [apt, list] of Object.entries(state.supplies || {})) {
        if (list[s.id]) apartments.push({ id: apt, name: names[apt] || apt, at: list[s.id].at, by: list[s.id].by });
      }
      if (apartments.length) out.push({ id: s.id, de: s.de, hu: s.hu, apartments: apartments.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true })) });
    }
    return out;
  }

  /** Admin: fehlende Schlüssel geklärt */
  function resolveKeys(state, taskId, note, now) {
    state = clone(state);
    const task = getTask(state, taskId);
    if (task.keysInBox !== false) throw new Error('Für diese Reinigung fehlen keine Schlüssel');
    const nowIso = toIso(now);
    task.keysResolvedAt = nowIso;
    note = String(note || '').trim().slice(0, 500);
    log(task, nowIso, `Schlüssel geklärt${note ? ': ' + note : ''}`);
    return { state, notifications: [] };
  }

  /** Erledigte Reinigungen mit fehlenden Schlüsseln, noch nicht geklärt (für den Admin) */
  function missingKeys(state) {
    return Object.values(state.tasks)
      .filter((t) => t.status === STATUS.DONE && t.keysInBox === false && !t.keysResolvedAt)
      .map((t) => ({ taskId: t.id, apartmentName: t.apartmentName, date: t.date, doneAt: t.doneAt, doneBy: t.doneBy, note: t.keysNote || '' }))
      .sort((a, b) => b.doneAt.localeCompare(a.doneAt));
  }

  // ---------------------------------------------------------------------------
  // Zeitraum: Reinigung darf z. B. am 01.10. ODER 02.10. stattfinden.
  // Reinigungsteam beantragt (mit Begründung), Admin genehmigt/lehnt ab oder legt selbst fest.
  // Fristen (12/15 Uhr) gelten dann erst am letzten Tag.
  // ---------------------------------------------------------------------------

  function lastDay(task) {
    return task.latestDate && task.latestDate > task.date ? task.latestDate : task.date;
  }

  function periodText(task) {
    return lastDay(task) > task.date ? `${formatDate(task.date)}–${formatDate(lastDay(task))}` : formatDate(task.date);
  }

  /** Nächste Anreise eines Gastes in dieser Wohnung ab dem Reinigungstag (Sperrzeiten zählen nicht). */
  function nextArrival(state, task) {
    let best = null;
    for (const r of Object.values(state.reservations || {})) {
      if (r.apartmentId !== task.apartmentId || r.id === task.id || r.blocked || r.arrival < task.date) continue;
      if (!best || r.arrival < best) best = r.arrival;
    }
    return best;
  }

  /** Nächste Buchung in dieser Wohnung ab dem Reinigungstag: Anreise und erwartete Gäste */
  function nextBooking(state, task) {
    let best = null;
    for (const r of Object.values(state.reservations || {})) {
      if (r.apartmentId !== task.apartmentId || r.id === task.id || r.blocked || r.arrival < task.date) continue;
      if (!best || r.arrival < best.arrival) best = r;
    }
    if (!best) return null;
    const adults = best.adults == null ? null : best.adults;
    const children = best.children == null ? null : best.children;
    return { arrival: best.arrival, departure: best.departure, adults, children, guests: guestsText(adults, children), checkIn: best.checkIn || '' };
  }

  /**
   * Erster Tag nach dem Check-out, an dem die Wohnung laut Smoobu NICHT frei ist: in der Nacht davor war schon ein
   * anderer Gast da. Der Anreisetag selbst ist noch nutzbar (Reinigung bis 15 Uhr, vor dem Check-in).
   * Sperrzeiten zählen nicht – sie werden oft gerade für die Reinigung eingetragen.
   * Liefert { date, arrival, blocked, sameDay } oder null (alles frei).
   */
  function firstOccupied(state, task) {
    const d0 = addDays(task.date, 1);
    let best = null;
    for (const r of Object.values(state.reservations || {})) {
      if (r.apartmentId !== task.apartmentId || r.id === task.id || r.blocked || !r.arrival || !r.departure) continue;
      const afterArrival = addDays(r.arrival, 1);
      const start = afterArrival > d0 ? afterArrival : d0;
      if (r.departure < start) continue; // Nacht vor „start“ nicht belegt
      if (!best || start < best.date) best = { date: start, arrival: r.arrival, blocked: !!r.blocked, sameDay: r.arrival <= task.date };
    }
    return best;
  }

  /** Letzter möglicher Tag für einen Zeitraum (null = kein späterer Tag möglich) und Grund */
  function periodLimit(state, task, config) {
    config = withConfig(config);
    let last = addDays(task.date, config.maxPeriodDays);
    const occ = firstOccupied(state, task);
    let reason = '';
    if (occ && addDays(occ.date, -1) < last) {
      last = addDays(occ.date, -1);
      reason = occ.sameDay ? `Am ${formatDate(task.date)} reist bereits der nächste Gast an (Wechseltag)`
        : occ.blocked ? `Ab ${formatDate(occ.arrival)} ist die Wohnung in Smoobu blockiert`
        : `Am ${formatDate(occ.arrival)} reist der nächste Gast an (Reinigung spätestens an diesem Tag bis ${config.finishBy} Uhr)`;
    }
    return { last: last > task.date ? last : null, reason };
  }

  function checkUntil(state, task, until, now, config) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until || '')) throw new Error('Bitte ein gültiges Datum wählen');
    if (until <= task.date) throw new Error(`Der Zeitraum muss nach dem ${formatDate(task.date)} enden`);
    if (until < localParts(now, config.timezone).date) throw new Error('Das Datum liegt in der Vergangenheit');
    const limit = periodLimit(state, task, config);
    if (!limit.last) throw new Error(`${limit.reason} – ein späterer Reinigungstag ist nicht möglich`);
    if (until > limit.last) {
      throw new Error(limit.reason ? `${limit.reason} – spätestens am ${formatDate(limit.last)} möglich`
        : `Höchstens ${config.maxPeriodDays} Tage nach dem ${formatDate(task.date)}`);
    }
  }

  /**
   * Neue Buchung/Sperrzeit fällt in einen genehmigten Zeitraum → Zeitraum sofort verkürzen
   * (bzw. aufheben) und Team + Admin informieren; offene Anträge, die nicht mehr passen, entfallen.
   */
  function enforcePeriods(state, config, nowIso, apartmentId) {
    const notifications = [];
    for (const task of Object.values(state.tasks)) {
      if (!isActive(task) || (apartmentId && task.apartmentId !== apartmentId)) continue;
      const req = task.periodRequest && task.periodRequest.status === 'offen' ? task.periodRequest : null;
      if (!task.latestDate && !req) continue;
      const limit = periodLimit(state, task, config);
      if (task.latestDate && task.latestDate > task.date && (!limit.last || task.latestDate > limit.last)) {
        const before = periodText(task);
        task.latestDate = limit.last;
        task.lastReminderAt = null;
        task.lastReminderReason = null;
        task.changedAt = nowIso;
        const now = task.latestDate ? `nur noch ${periodText(task)}` : `wieder fest am ${formatDate(task.date)}`;
        log(task, nowIso, `Zeitraum ${before} verkürzt – ${limit.reason}: ${now}`);
        notifications.push(...notify([...team(config, task), config.owner.id], 'period', task, 'Zeitraum verkürzt – neue Buchung',
          `${task.apartmentName}: ${limit.reason}. Reinigung ${now}, bis ${config.finishBy} Uhr.`));
      }
      if (req && (!limit.last || req.until > limit.last)) {
        req.status = 'hinfällig';
        log(task, nowIso, `Antrag bis ${formatDate(req.until)} entfällt – ${limit.reason}`);
        notifications.push(...notify([config.owner.id, req.by], 'period', task, 'Antrag nicht mehr möglich',
          `${task.apartmentName}: ${limit.reason} – Antrag bis ${formatDate(req.until)} entfällt. Reinigung ${periodText(task)}, bis ${config.finishBy} Uhr.`));
      }
    }
    return notifications;
  }

  /** Reinigungsleitung oder Mitarbeiterin beantragt einen Zeitraum. input: { until, reason } */
  function requestPeriod(state, taskId, user, input, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = getTask(state, taskId);
    requireActive(task);
    if (user.role === 'owner' || !canAccess(config, task, user)) throw new Error('Keine Berechtigung für diese Reinigung');
    const reason = String(input.reason || '').trim().slice(0, 500);
    if (reason.length < 3) throw new Error('Bitte kurz begründen');
    checkUntil(state, task, input.until, now, config);
    const nowIso = toIso(now);
    task.periodRequest = { until: input.until, reason, by: user.id, at: nowIso, status: 'offen' };
    const name = personName(config, user.id);
    const period = `${formatDate(task.date)}–${formatDate(input.until)}`;
    log(task, nowIso, `Zeitraum ${period} beantragt von ${name}: ${reason}`);
    return { state, notifications: notify([config.owner.id, ...leadIds(config).filter((id) => id !== user.id)], 'request', task,
      `Antrag: ${task.apartmentName} ${period}`, `${name} möchte die Reinigung im Zeitraum ${period} erledigen (am jeweiligen Tag bis ${config.finishBy} Uhr). Grund: ${reason}`) };
  }

  /** Admin genehmigt oder lehnt einen Antrag ab. */
  function decidePeriod(state, taskId, approve, comment, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = getTask(state, taskId);
    const req = task.periodRequest;
    if (!req || req.status !== 'offen') throw new Error('Kein offener Antrag');
    requireActive(task);
    const nowIso = toIso(now);
    comment = String(comment || '').trim().slice(0, 500);
    if (approve) {
      checkUntil(state, task, req.until, now, config);
      task.latestDate = req.until;
      task.lastReminderAt = null;
      task.lastReminderReason = null;
    }
    Object.assign(req, { status: approve ? 'genehmigt' : 'abgelehnt', decidedAt: nowIso, comment });
    const period = `${formatDate(task.date)}–${formatDate(req.until)}`;
    log(task, nowIso, `Zeitraum ${period} ${approve ? 'genehmigt' : 'abgelehnt'}${comment ? ': ' + comment : ''}`);
    const body = approve
      ? `${task.apartmentName}: Reinigung darf im Zeitraum ${period} stattfinden – auch am späteren Tag bis spätestens ${config.finishBy} Uhr erledigt.${comment ? ' ' + comment : ''}`
      : `${task.apartmentName}: Reinigung bleibt am ${formatDate(task.date)}.${comment ? ' ' + comment : ''}`;
    return { state, notifications: notify([...team(config, task), req.by], 'period', task,
      approve ? 'Zeitraum genehmigt' : 'Zeitraum abgelehnt', body) };
  }

  /** Admin legt den Zeitraum selbst fest (until = letzter Tag) oder hebt ihn auf (until leer). */
  function setPeriod(state, taskId, until, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = getTask(state, taskId);
    requireActive(task);
    const nowIso = toIso(now);
    const next = until && until !== task.date ? until : null;
    if (next) checkUntil(state, task, next, now, config);
    if ((task.latestDate || null) === next) return { state, notifications: [] };
    task.latestDate = next;
    task.lastReminderAt = null;
    task.lastReminderReason = null;
    task.pastReminded = false;
    task.changedAt = nowIso;
    if (task.periodRequest && task.periodRequest.status === 'offen') {
      Object.assign(task.periodRequest, { status: next === task.periodRequest.until ? 'genehmigt' : 'übersteuert', decidedAt: nowIso });
    }
    log(task, nowIso, next ? `Zeitraum festgelegt: ${periodText(task)}` : `Zeitraum aufgehoben – Reinigung am ${formatDate(task.date)}`);
    return { state, notifications: notify(team(config, task), 'period', task, next ? 'Reinigung im Zeitraum' : 'Zeitraum aufgehoben',
      next ? `${task.apartmentName}: Reinigung darf im Zeitraum ${periodText(task)} stattfinden – auch am späteren Tag bis spätestens ${config.finishBy} Uhr erledigt.`
        : `${task.apartmentName}: Reinigung wieder fest am ${formatDate(task.date)}.`) };
  }

  /** Offene Anträge (für den Admin) */
  function openPeriodRequests(state) {
    return Object.values(state.tasks)
      .filter((t) => isActive(t) && t.periodRequest && t.periodRequest.status === 'offen')
      .map((t) => Object.assign({ taskId: t.id, apartmentName: t.apartmentName, date: t.date }, t.periodRequest))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // ---------------------------------------------------------------------------
  // Fristen (alle 15 Minuten prüfen)
  // ---------------------------------------------------------------------------

  function missingText(config, task) {
    const missing = [];
    if (!task.leadConfirmedAt) missing.push('Bestätigung Leitung');
    if (!task.assignedTo) missing.push('Zuweisung');
    else if (!task.staffConfirmedAt) missing.push(`Bestätigung ${personName(config, task.assignedTo)}`);
    return missing.join(', ');
  }

  function progressText(config, task) {
    if (task.startedAt) return `läuft seit ${hhmm(task.startedAt, config.timezone)} Uhr`;
    if (!task.assignedTo) return 'noch niemandem zugewiesen';
    return `noch nicht begonnen (${personName(config, task.assignedTo)})`;
  }

  /**
   * Überfällig: am Reinigungstag ab 12:00 nicht begonnen oder ab 15:00 nicht beendet,
   * oder ein vergangener Tag und nicht erledigt. Liefert 'start' | 'finish' | 'past' | null.
   */
  function overdueReason(task, now, config) {
    config = withConfig(config);
    if (!isActive(task)) return null;
    const { date: today, time } = localParts(now, config.timezone);
    const last = lastDay(task); // bei Zeitraum zählt der letzte Tag
    if (last < today) return 'past';
    if (last > today) return null;
    if (time >= config.finishBy) return 'finish';
    if (time >= config.startBy && !task.startedAt) return 'start';
    return null;
  }

  /** options.remindersOnly: nur 12/15-Uhr-Erinnerungen (sofort nach einer Änderung), ohne 6-Std.-Alarm */
  function checkDeadlines(state, now, config, options) {
    config = withConfig(config);
    state = clone(state);
    const { time } = localParts(now, config.timezone);
    const nowMs = Date.parse(toIso(now));
    const nowIso = toIso(now);
    const notifications = [];
    const limit = config.confirmWithinHours * 3600000;
    const today = localParts(now, config.timezone).date;

    for (const task of Object.values(state.tasks)) {
      if (!isActive(task)) continue;

      // 1) Nicht innerhalb von 6 Stunden vollständig bestätigt → Admin (einmal)
      if (!(options && options.remindersOnly) && !task.lateAlerted && !fullyConfirmed(task) && task.confirmFrom && lastDay(task) >= today
          && nowMs - Date.parse(task.confirmFrom) >= limit) {
        task.lateAlerted = true;
        log(task, nowIso, `Nach ${config.confirmWithinHours} Std. nicht bestätigt – Admin informiert`);
        notifications.push(...notify([config.owner.id], 'late', task, 'Reinigung nicht bestätigt',
          `${task.apartmentName} (${formatDate(task.date)}): seit ${config.confirmWithinHours} Std. nicht bestätigt – es fehlt: ${missingText(config, task)}.`));
      }

      // 2) Überfällig → Reinigungsteam (Leitung + zugewiesene Mitarbeiterin; noch nicht
      //    zugewiesen: alle Mitarbeiterinnen) und Admin
      const reason = overdueReason(task, now, config);
      if (!reason) continue;
      const crew = task.assignedTo ? team(config, task) : [...leadIds(config), ...config.staff.map((s) => s.id)];
      const all = [...crew, config.owner.id];
      if (reason === 'past') { // vergangener Tag nicht erledigt: einmal melden
        if (task.pastReminded) continue;
        task.pastReminded = true;
        notifications.push(...notify(all, 'overdue', task, 'Reinigung nicht erledigt',
          `${task.apartmentName}: Reinigung vom ${periodText(task)} wurde nicht als erledigt gemeldet – ${progressText(config, task)}.`));
        continue;
      }
      if (time >= config.quietFrom) continue; // Nachtruhe
      // Neue Stufe (12 Uhr → 15 Uhr) sofort melden, sonst im eingestellten Abstand wiederholen
      const sameStage = task.lastReminderReason === reason || (!task.lastReminderReason && reason === 'start');
      if (task.lastReminderAt && sameStage && nowMs - Date.parse(task.lastReminderAt) < config.repeatMinutes * 60000 - 60000) continue;
      task.lastReminderAt = nowIso;
      task.lastReminderReason = reason;
      task.reminderCount = (task.reminderCount || 0) + 1;
      let title;
      let body;
      if (reason === 'start') {
        title = 'Reinigung muss heute noch gestartet werden';
        body = `${task.apartmentName}: noch nicht begonnen (${task.assignedTo ? personName(config, task.assignedTo) : 'noch niemandem zugewiesen'}). Bitte jetzt starten – bis ${config.finishBy} Uhr fertig.`;
      } else if (task.startedAt) {
        title = 'Reinigung bitte beenden';
        body = `${task.apartmentName}: läuft seit ${hhmm(task.startedAt, config.timezone)} Uhr, aber noch nicht als erledigt gemeldet. Bitte beenden und „Erledigt“ tippen.`;
      } else {
        title = 'Reinigung immer noch nicht begonnen';
        body = `${task.apartmentName}: ${config.finishBy} Uhr vorbei und noch nicht begonnen (${task.assignedTo ? personName(config, task.assignedTo) : 'noch niemandem zugewiesen'}).`;
      }
      log(task, nowIso, `Erinnerung: ${title}`);
      notifications.push(...notify(all, reason === 'start' ? 'reminder' : 'reminder2', task, title, body));
    }
    return { state, notifications };
  }

  // ---------------------------------------------------------------------------
  // Hinweise / Meldungen mit Fotos (alle Rollen)
  // ---------------------------------------------------------------------------

  /** user: { id, role: 'owner'|'lead'|'staff' } */
  function canAccess(config, task, user) {
    if (user.role === 'owner' || user.role === 'lead') return true;
    return task.assignedTo === user.id;
  }

  /** report: { id, text, photos: [photoId, …] } */
  function addReport(state, taskId, user, report, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = getTask(state, taskId);
    if (!canAccess(config, task, user)) throw new Error('Keine Berechtigung für diese Reinigung');
    const text = (report.text || '').trim().slice(0, 2000);
    const photos = (report.photos || []).slice(0, 10);
    if (!text && !photos.length) throw new Error('Bitte einen Text eingeben oder ein Foto anhängen');
    const nowIso = toIso(now);
    const author = user.role === 'owner' ? config.owner.name : personName(config, user.id);
    // final = Abschlussbericht beim Beenden (Fotos/Videos, was gemacht wurde) – kein offenes Problem, keine eigene Push
    const final = !!report.final;
    task.reports.push({ id: String(report.id), at: nowIso, by: user.id, byRole: user.role, text, photos, resolved: final, final });
    log(task, nowIso, `${final ? 'Abschlussbericht' : user.role === 'owner' ? 'Hinweis' : 'Meldung'} von ${author}`);
    if (final) return { state, notifications: [] };
    const summary = text ? (text.length > 120 ? text.slice(0, 117) + '…' : text) : 'Fotos angehängt';
    const photoText = photos.length ? ` (${photos.length} Foto${photos.length > 1 ? 's' : ''})` : '';
    const fromOwner = user.role === 'owner';
    const to = fromOwner ? team(config, task) : [config.owner.id, ...team(config, task, user.id)];
    const title = fromOwner ? `Hinweis von ${config.owner.name}: ${task.apartmentName}` : `Meldung: ${task.apartmentName}`;
    return { state, notifications: notify(to, fromOwner ? 'note' : 'report', task, title, `${author}: ${summary}${photoText}`) };
  }

  /** Foto aus einer Meldung löschen (Verfasser oder Admin). Leere Meldung wird entfernt. */
  function removePhoto(state, taskId, reportId, photoId, user) {
    state = clone(state);
    const task = getTask(state, taskId);
    const report = task.reports.find((r) => r.id === String(reportId));
    if (!report || !report.photos.includes(photoId)) throw new Error('Foto nicht gefunden');
    if (user.role !== 'owner' && report.by !== user.id) throw new Error('Nur eigene Fotos können gelöscht werden');
    report.photos = report.photos.filter((p) => p !== photoId);
    if (!report.photos.length && !report.text) task.reports = task.reports.filter((r) => r !== report);
    return { state, notifications: [] };
  }

  function resolveReport(state, taskId, reportId, now) {
    state = clone(state);
    const task = getTask(state, taskId);
    const report = task.reports.find((r) => r.id === String(reportId));
    if (!report) throw new Error('Meldung nicht gefunden');
    report.resolved = true;
    report.resolvedAt = toIso(now);
    return { state, notifications: [] };
  }

  /** Offene Meldungen der Reinigungskräfte (Hinweise des Admins zählen nicht). */
  function openReports(state) {
    const list = [];
    for (const t of Object.values(state.tasks)) {
      for (const r of t.reports || []) {
        if (!r.resolved && r.byRole !== 'owner') list.push(Object.assign({ taskId: t.id, apartmentName: t.apartmentName, date: t.date }, r));
      }
    }
    return list.sort((a, b) => b.at.localeCompare(a.at));
  }

  // ---------------------------------------------------------------------------
  // Ansichten
  // ---------------------------------------------------------------------------

  /**
   * Reinigungen für eine Person, sortiert nach Datum.
   * options: { user: { id, role }, from } – Mitarbeiterin sieht nur ihr Zugewiesenes.
   * sameDayArrival = am Reinigungstag reist bereits der nächste Gast an.
   */
  function listCleanings(state, options, config) {
    config = withConfig(config);
    options = options || {};
    const reservations = Object.values(state.reservations);
    return Object.values(state.tasks)
      .filter((t) => !options.from || lastDay(t) >= options.from)
      .filter((t) => !options.user || canAccess(config, t, options.user))
      .map((t) => Object.assign({}, t, {
        reports: t.reports || [],
        sameDayArrival: reservations.some((r) => r.apartmentId === t.apartmentId && r.arrival === t.date && r.id !== t.id),
        nextArrival: nextArrival(state, t),
        nextBooking: nextBooking(state, t),
        supplies: Object.keys((state.supplies || {})[t.apartmentId] || {}),
        needsBlock: needsBlock(state, t),
        periodLimit: isActive(t) ? periodLimit(state, t, config) : null,
      }))
      .sort((a, b) => (a.date + a.apartmentName).localeCompare(b.date + b.apartmentName, 'de', { numeric: true }));
  }

  // ---------------------------------------------------------------------------
  // Empfohlene Route je Tag
  // ---------------------------------------------------------------------------

  function distanceKm(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return null;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(h));
  }

  /**
   * Empfohlene Reihenfolge der Reinigungen an einem Tag.
   * 1. Wohnungen, in die heute noch ein Gast einzieht (nach Check-in-Zeit)  2. übrige Pflicht-Reinigungen
   * 3. Reinigungen, die laut Zeitraum auch später erledigt werden dürfen („kann bis …“).
   * Innerhalb jeder Gruppe immer der nächstgelegene Stopp (gleiches Haus = 0 km).
   * points: { [apartmentId]: { lat, lon, address } }
   */
  function planRoute(state, taskIds, day, points, config) {
    config = withConfig(config);
    points = points || {};
    const stops = [];
    for (const id of taskIds) {
      const t = state.tasks[id];
      if (!t || !isActive(t) || t.date > day || lastDay(t) < day) continue;
      const next = nextBooking(state, t);
      const arrivalToday = !!next && next.arrival === day;
      const flexible = lastDay(t) > day;
      stops.push({
        taskId: t.id, apartmentId: t.apartmentId, apartmentName: t.apartmentName,
        address: (points[t.apartmentId] && points[t.apartmentId].address) || '', point: points[t.apartmentId] || null,
        group: arrivalToday && !flexible ? 0 : flexible ? 2 : 1,
        checkIn: arrivalToday ? next.checkIn || '' : '', guests: arrivalToday ? next.guests || '' : '',
        until: flexible ? lastDay(t) : null, started: !!t.startedAt,
      });
    }
    const out = [];
    let prev = null;
    for (const g of [0, 1, 2]) {
      let pool = stops.filter((s) => s.group === g);
      if (g === 0) { // Check-in-Zeit hat Vorrang, dann Entfernung
        pool.sort((a, b) => (a.checkIn || '99:99').localeCompare(b.checkIn || '99:99'));
        const byTime = [];
        while (pool.length) {
          const time = pool[0].checkIn;
          const same = pool.filter((s) => s.checkIn === time);
          pool = pool.filter((s) => s.checkIn !== time);
          byTime.push(...nearestOrder(same, prev));
          prev = byTime[byTime.length - 1];
        }
        out.push(...byTime);
      } else {
        const ordered = nearestOrder(pool, prev);
        out.push(...ordered);
        if (ordered.length) prev = ordered[ordered.length - 1];
      }
    }
    let total = 0;
    out.forEach((s, i) => {
      const d = i ? distanceKm(out[i - 1].point, s.point) : null;
      s.km = d == null ? null : Math.round(d * 10) / 10;
      if (d != null) total += d;
      s.reason = s.group === 0 ? `Anreise heute${s.checkIn ? ' ab ' + s.checkIn + ' Uhr' : ''}${s.guests ? ' · ' + s.guests : ''}`
        : s.group === 2 ? `kann auch bis ${formatDate(s.until)}` : '';
    });
    return { day, stops: out, totalKm: Math.round(total * 10) / 10 };
  }

  /** Nächster-Nachbar-Reihenfolge (ohne Koordinaten: gleiche Adresse zusammen, sonst Wohnungsnummer) */
  function nearestOrder(pool, start) {
    pool = pool.slice().sort((a, b) => compareApartments(a.apartmentName, b.apartmentName));
    const out = [];
    let cur = start;
    while (pool.length) {
      let best = 0, bestD = Infinity;
      pool.forEach((s, i) => {
        let d = distanceKm(cur && cur.point, s.point);
        if (d == null) d = cur && cur.address && s.address && cur.address.split('(')[0].trim() === s.address.split('(')[0].trim() ? 0 : 1e6 + i;
        if (d < bestD) { bestD = d; best = i; }
      });
      cur = pool.splice(best, 1)[0];
      out.push(cur);
    }
    return out;
  }

  // Wohnungsnummer aus dem Namen: „#EINS | …“ = 1 … „#DREIZEHN | …“ = 13 (auch „Wohnung 7“, „Apt. 12“)
  const NUMBER_WORDS = ['eins', 'zwei', 'drei', 'vier', 'fuenf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwoelf',
    'dreizehn', 'vierzehn', 'fuenfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn', 'zwanzig'];
  function apartmentNumber(name) {
    const words = String(name || '').toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
      .split(/[^a-z0-9]+/).filter(Boolean);
    for (const w of words) { const i = NUMBER_WORDS.indexOf(w); if (i >= 0) return i + 1; }
    const m = /^\s*#?\s*(?:wohnung|apartment|apt\.?|nr\.?)?\s*(\d{1,3})\b/i.exec(String(name || ''));
    return m ? Number(m[1]) : null;
  }
  /** Sortierung der Wohnungen: nach Nummer (1–13), sonst alphabetisch dahinter */
  function compareApartments(a, b) {
    const na = apartmentNumber(a), nb = apartmentNumber(b);
    if (na != null && nb != null && na !== nb) return na - nb;
    if (na != null && nb == null) return -1;
    if (na == null && nb != null) return 1;
    return String(a).localeCompare(String(b), 'de', { numeric: true });
  }

  /**
   * Belegungskalender: Wohnungen durchnummeriert, Buchungen/Sperrzeiten und Reinigungen
   * im Zeitraum. showNames = Gastname und Telefonnummer anzeigen.
   */
  function calendar(state, from, days, showNames, config, now) {
    config = withConfig(config);
    const to = addDays(from, days);
    const names = {};
    for (const t of Object.values(state.tasks)) names[t.apartmentId] = t.apartmentName;
    for (const a of state.apartments || []) names[a.id] = a.name;
    const sorted = Object.entries(names).sort((a, b) => compareApartments(a[1], b[1]));
    const used = new Set();
    const apartments = sorted.map(([id, name], i) => {
      // Nummer im Kreis = Nummer aus dem Namen (#EINS = 1); ohne erkennbare Nummer fortlaufend
      let number = apartmentNumber(name);
      if (number == null || used.has(number)) { number = i + 1; while (used.has(number)) number++; }
      used.add(number);
      return { id, name, number };
    });
    const bookings = Object.values(state.reservations)
      .filter((r) => r.arrival < to && r.departure > from)
      .map((r) => ({ id: r.id, apartmentId: r.apartmentId, arrival: r.arrival, departure: r.departure, blocked: !!r.blocked,
        channel: r.channel || '', guest: showNames ? r.guest || '' : '', phone: showNames ? r.phone || '' : '',
        adults: r.adults == null ? null : r.adults, children: r.children == null ? null : r.children,
        guests: r.blocked ? '' : guestsText(r.adults == null ? null : r.adults, r.children == null ? null : r.children) }));
    const cleanings = Object.values(state.tasks)
      .filter((t) => lastDay(t) >= from && t.date < to && t.status !== STATUS.CANCELLED)
      .map((t) => ({
        id: t.id, apartmentId: t.apartmentId, apartmentName: t.apartmentName, date: t.date, status: t.status, manual: !!t.manual,
        note: t.note || '', overdue: !!overdueReason(t, now || Date.now(), config), overdueReason: overdueReason(t, now || Date.now(), config),
        leadConfirmed: !!t.leadConfirmedAt, assignedTo: t.assignedTo ? personName(config, t.assignedTo) : '',
        staffConfirmed: !!t.staffConfirmedAt, startedAt: t.startedAt, doneAt: t.doneAt,
        keysInBox: t.keysInBox == null ? null : t.keysInBox, keysResolved: !!t.keysResolvedAt,
        guestPhone: t.guestPhone || '', reports: (t.reports || []).length,
        latestDate: lastDay(t) > t.date ? lastDay(t) : null,
        nextBooking: nextBooking(state, t),
        periodRequest: t.periodRequest && t.periodRequest.status === 'offen' ? { until: t.periodRequest.until, reason: t.periodRequest.reason } : null,
      }));
    return { from, days, apartments, bookings, cleanings };
  }

  const api = {
    DEFAULT_CONFIG, STATUS,
    createState, localParts, formatDate, addDays,
    fromSmoobuWebhook, fromSmoobuBooking, activeTaskIds, applyBooking, syncFromSmoobu,
    addManualCleaning, editManualCleaning, cancelManualCleaning,
    leadConfirm, assignCleaning, staffConfirm, startCleaning, completeCleaning,
    checkDeadlines,
    canAccess, addReport, removePhoto, resolveReport, openReports,
    listCleanings, fullyConfirmed, calendar, overdueReason,
    resolveKeys, missingKeys, planRoute, distanceKm, moveCleaning, needsBlock, apartmentNumber, compareApartments, reportSupplies, resolveSupplies, shoppingList, mayViewCodes, logCodeAccess, nextBooking, guestsText,
    requestPeriod, decidePeriod, setPeriod, openPeriodRequests, lastDay, nextArrival,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CleaningLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
