/*
 * Reinigungs-Logik für Apartment Strauß (Smoobu → Reinigungskräfte)
 *
 * Reine Funktionen ohne Abhängigkeiten: laufen im Browser (index.html),
 * in Node (Tests) und später z. B. in Google Apps Script oder einem
 * Cloudflare Worker. Jede Funktion bekommt den aktuellen Zustand und gibt
 * einen NEUEN Zustand plus eine Liste von Benachrichtigungen zurück.
 * Wie die Benachrichtigungen verschickt werden (Push, Telegram, E-Mail)
 * entscheidet der Aufrufer.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Konfiguration (anpassen: Smoobu-Apartment-IDs, Namen, Reinigungskräfte)
  // ---------------------------------------------------------------------------
  const DEFAULT_CONFIG = {
    timezone: 'Europe/Berlin',
    reminderTime: '12:00',   // Erinnerung an die Reinigungskräfte
    escalationTime: '13:00', // Alarm an Reinigungskräfte UND Auftraggeber
    owner: { id: 'owner', name: 'Apartment Strauß' },
    apartments: Array.from({ length: 13 }, (_, i) => ({
      id: String(i + 1),       // hier später die Smoobu-Apartment-ID eintragen
      name: 'Wohnung ' + (i + 1),
    })),
    // apartments: 'all' oder Liste von Apartment-IDs, für die jemand zuständig ist
    cleaners: [
      { id: 'anna', name: 'Anna', apartments: 'all' },
      { id: 'maria', name: 'Maria', apartments: ['1', '2', '3', '4', '5', '6', '7'] },
    ],
  };

  const STATUS = {
    OPEN: 'offen',          // noch niemand hat bestätigt
    CONFIRMED: 'bestätigt', // Reinigungskraft hat übernommen
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
    const apt = config.apartments.find((a) => a.id === String(apartmentId));
    return apt ? apt.name : fallback || 'Wohnung ' + apartmentId;
  }

  /** Alle Reinigungskräfte, die für eine Wohnung zuständig sind. */
  function cleanersFor(config, apartmentId) {
    return config.cleaners.filter(
      (c) => c.apartments === 'all' || c.apartments.includes(String(apartmentId))
    );
  }

  /** Empfänger: die zugewiesene Kraft, sonst alle Zuständigen. */
  function recipientsFor(config, task) {
    if (task.assignedTo) return [task.assignedTo];
    return cleanersFor(config, task.apartmentId).map((c) => c.id);
  }

  function notify(to, kind, task, title, body) {
    return to.map((recipient) => ({ to: recipient, kind, taskId: task.id, title, body }));
  }

  function log(task, nowIso, text) {
    task.history.push({ at: nowIso, text });
  }

  // ---------------------------------------------------------------------------
  // Buchungen aus Smoobu verarbeiten
  // ---------------------------------------------------------------------------

  /**
   * Wandelt einen Smoobu-Webhook in eine einheitliche Buchung um.
   * Smoobu schickt { action, data: { id, arrival, departure, apartment, 'guest-name', ... } }.
   */
  function fromSmoobuWebhook(payload) {
    const r = payload.data || {};
    const actions = {
      newReservation: 'new',
      updateReservation: 'update',
      cancelReservation: 'cancel',
      deleteReservation: 'cancel',
    };
    const action = actions[payload.action];
    if (!action) return null; // andere Webhooks (z. B. Nachrichten) ignorieren
    return {
      action,
      id: String(r.id),
      apartmentId: String(r.apartment && r.apartment.id),
      apartmentName: r.apartment && r.apartment.name,
      guest: r['guest-name'] || '',
      arrival: r.arrival,
      departure: r.departure,
    };
  }

  /**
   * Wandelt eine Buchung aus der Smoobu-API (GET /api/reservations) um.
   * Sperrzeiten (Blocked Bookings) werden ignoriert, Stornos werden zu 'cancel'.
   */
  function fromSmoobuBooking(r) {
    if (!r || r['is-blocked-booking']) return null;
    return {
      action: r.type === 'cancellation' ? 'cancel' : 'update',
      id: String(r.id),
      apartmentId: String(r.apartment && r.apartment.id),
      apartmentName: r.apartment && r.apartment.name,
      guest: r['guest-name'] || '',
      arrival: r.arrival,
      departure: r.departure,
    };
  }

  /** IDs aller noch offenen/bestätigten Reinigungen ab einem Datum. */
  function activeTaskIds(state, fromDate) {
    return Object.values(state.tasks)
      .filter((t) => !t.manual && (t.status === STATUS.OPEN || t.status === STATUS.CONFIRMED) && t.date >= fromDate)
      .map((t) => t.id);
  }

  /**
   * Gleicht den Zustand mit der aktuellen Buchungsliste aus Smoobu ab.
   * Beim allerersten Abgleich werden alle bestehenden Buchungen still
   * übernommen (sonst gäbe es dutzende Push-Nachrichten auf einmal).
   * Alte Einträge (älter als keepDays) werden aufgeräumt.
   */
  function syncFromSmoobu(state, smoobuBookings, now, config, keepDays) {
    config = withConfig(config);
    const silent = !state.initialized;
    const notifications = [];
    state = clone(state); // einmal kopieren, dann direkt ändern (Cloudflare-Rechenzeitlimit)
    for (const raw of smoobuBookings) {
      const booking = fromSmoobuBooking(raw);
      if (!booking) continue;
      const res = applyBooking(state, booking, now, config, true);
      if (!silent) notifications.push(...res.notifications);
    }
    const cutoff = addDays(localParts(now, config.timezone).date, -(keepDays || 30));
    for (const t of Object.values(state.tasks)) if (t.date < cutoff) delete state.tasks[t.id];
    for (const r of Object.values(state.reservations)) if (r.departure < cutoff) delete state.reservations[r.id];
    state.initialized = true;
    state.lastSync = new Date(now).toISOString();
    return { state, notifications };
  }

  /**
   * Verarbeitet eine neue / geänderte / stornierte Buchung.
   * booking: { action: 'new'|'update'|'cancel', id, apartmentId, guest, arrival, departure }
   * Rückgabe: { state, notifications }
   */
  function applyBooking(state, booking, now, config, inPlace) {
    config = withConfig(config);
    if (!inPlace) state = clone(state); // inPlace: nur intern (Abgleich), spart Rechenzeit
    const nowIso = new Date(now).toISOString();
    const notifications = [];
    const id = String(booking.id);
    const existing = state.tasks[id];

    if (booking.action === 'cancel') {
      delete state.reservations[id];
      if (!existing || existing.status === STATUS.CANCELLED || existing.status === STATUS.DONE) {
        return { state, notifications };
      }
      existing.status = STATUS.CANCELLED;
      log(existing, nowIso, 'Buchung storniert');
      notifications.push(
        ...notify(recipientsFor(config, existing), 'cancelled', existing,
          'Reinigung entfällt',
          `${existing.apartmentName}: Endreinigung am ${formatDate(existing.date)} entfällt (Buchung storniert).`)
      );
      return { state, notifications };
    }

    state.reservations[id] = {
      id,
      apartmentId: String(booking.apartmentId),
      arrival: booking.arrival,
      departure: booking.departure,
    };

    // Neue Buchung (oder Update zu einer uns unbekannten Buchung)
    if (!existing || existing.status === STATUS.CANCELLED) {
      const task = {
        id,
        apartmentId: String(booking.apartmentId),
        apartmentName: apartmentName(config, booking.apartmentId, booking.apartmentName),
        guest: booking.guest || '',
        date: booking.departure,
        status: STATUS.OPEN,
        assignedTo: null,
        reminded: false,
        escalated: false,
        history: [],
      };
      log(task, nowIso, `Reinigung angelegt für ${formatDate(task.date)}`);
      state.tasks[id] = task;
      notifications.push(
        ...notify(recipientsFor(config, task), 'new', task,
          'Neue Endreinigung',
          `${task.apartmentName}: Endreinigung am ${formatDate(task.date)}. Bitte in der App bestätigen.`)
      );
      return { state, notifications };
    }

    // Änderung einer bestehenden Buchung
    existing.guest = booking.guest || existing.guest;
    if (booking.departure === existing.date || existing.status === STATUS.DONE) {
      return { state, notifications }; // Abreise unverändert → keine Nachricht
    }

    const oldDate = existing.date;
    existing.date = booking.departure;
    existing.reminded = false;
    existing.escalated = false;
    const wasConfirmed = existing.status === STATUS.CONFIRMED;
    // Neues Datum muss neu bestätigt werden – die Zuweisung bleibt aber bestehen.
    existing.status = STATUS.OPEN;
    log(existing, nowIso, `Datum geändert: ${formatDate(oldDate)} → ${formatDate(existing.date)}`);

    const verb = existing.date > oldDate ? 'verlängert' : 'verkürzt';
    notifications.push(
      ...notify(recipientsFor(config, existing), 'rescheduled', existing,
        'Reinigung verschoben',
        `${existing.apartmentName}: Aufenthalt ${verb}. Endreinigung jetzt am ${formatDate(existing.date)} ` +
        `statt ${formatDate(oldDate)}. Bitte neu bestätigen.`)
    );
    if (wasConfirmed) {
      notifications.push(
        ...notify([config.owner.id], 'rescheduled', existing,
          'Bestätigte Reinigung verschoben',
          `${existing.apartmentName}: ${formatDate(oldDate)} → ${formatDate(existing.date)}. Neue Bestätigung ausstehend.`)
      );
    }
    return { state, notifications };
  }

  // ---------------------------------------------------------------------------
  // Aktionen der Reinigungskraft
  // ---------------------------------------------------------------------------

  /** Reinigungskraft klickt „Übernehmen / Bestätigen". */
  function confirmCleaning(state, taskId, cleanerId, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = state.tasks[taskId];
    if (!task) throw new Error('Reinigung nicht gefunden');
    if (task.status === STATUS.CANCELLED) throw new Error('Reinigung wurde storniert');
    if (task.status === STATUS.DONE) throw new Error('Reinigung ist bereits erledigt');
    if (task.assignedTo && task.assignedTo !== cleanerId) {
      throw new Error('Reinigung ist bereits von jemand anderem übernommen');
    }
    const cleaner = config.cleaners.find((c) => c.id === cleanerId);
    if (!cleaner) throw new Error('Unbekannte Reinigungskraft');

    task.status = STATUS.CONFIRMED;
    task.assignedTo = cleanerId;
    log(task, new Date(now).toISOString(), `Bestätigt von ${cleaner.name}`);
    const notifications = notify([config.owner.id], 'confirmed', task,
      'Reinigung bestätigt',
      `${cleaner.name} übernimmt ${task.apartmentName} am ${formatDate(task.date)}.`);
    return { state, notifications };
  }

  /** Reinigungskraft meldet „Erledigt". */
  function completeCleaning(state, taskId, cleanerId, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = state.tasks[taskId];
    if (!task) throw new Error('Reinigung nicht gefunden');
    if (task.status !== STATUS.CONFIRMED || task.assignedTo !== cleanerId) {
      throw new Error('Nur die zugewiesene Reinigungskraft kann eine bestätigte Reinigung abschließen');
    }
    const cleaner = config.cleaners.find((c) => c.id === cleanerId);
    task.status = STATUS.DONE;
    log(task, new Date(now).toISOString(), `Erledigt von ${cleaner ? cleaner.name : cleanerId}`);
    const notifications = notify([config.owner.id], 'done', task,
      'Reinigung erledigt',
      `${task.apartmentName} ist sauber (${cleaner ? cleaner.name : cleanerId}).`);
    return { state, notifications };
  }

  // ---------------------------------------------------------------------------
  // Fristen prüfen (z. B. alle 15 Minuten per Zeitsteuerung aufrufen)
  // ---------------------------------------------------------------------------

  /**
   * Am Reinigungstag:
   *  - ab reminderTime: Erinnerung an die Reinigungskraft(e)
   *  - ab escalationTime: Alarm an Reinigungskraft(e) UND Auftraggeber
   * Jede Stufe wird pro Reinigung nur einmal ausgelöst.
   */
  function checkDeadlines(state, now, config) {
    config = withConfig(config);
    state = clone(state);
    const { date: today, time } = localParts(now, config.timezone);
    const nowIso = new Date(now).toISOString();
    const notifications = [];

    for (const task of Object.values(state.tasks)) {
      if (task.status !== STATUS.OPEN) continue;
      const overdue = task.date < today;
      const isToday = task.date === today;
      if (!overdue && !isToday) continue;

      if (!task.escalated && (overdue || time >= config.escalationTime)) {
        task.escalated = true;
        task.reminded = true;
        log(task, nowIso, 'Nicht bestätigt – Auftraggeber alarmiert');
        notifications.push(
          ...notify(recipientsFor(config, task), 'escalation', task,
            'Reinigung nicht bestätigt!',
            `${task.apartmentName}: Endreinigung ${formatDate(task.date)} ist noch nicht bestätigt. Bitte sofort bestätigen.`),
          ...notify([config.owner.id], 'escalation', task,
            'Achtung: Reinigung offen',
            `${task.apartmentName}: Endreinigung ${formatDate(task.date)} wurde bis ${config.escalationTime} Uhr ` +
            'nicht bestätigt und kann evtl. nicht durchgeführt werden.')
        );
      } else if (!task.reminded && isToday && time >= config.reminderTime) {
        task.reminded = true;
        log(task, nowIso, 'Erinnerung verschickt');
        notifications.push(
          ...notify(recipientsFor(config, task), 'reminder', task,
            'Erinnerung: Reinigung bestätigen',
            `${task.apartmentName}: Endreinigung heute. Bitte bis ${config.escalationTime} Uhr bestätigen.`)
        );
      }
    }
    return { state, notifications };
  }

  // ---------------------------------------------------------------------------
  // Ansichten
  // ---------------------------------------------------------------------------

  /**
   * Liste der Reinigungen, sortiert nach Datum. Optional gefiltert auf eine
   * Reinigungskraft (zeigt nur, was sie sehen soll) und ab einem Datum.
   * sameDayArrival = am Reinigungstag reist bereits der nächste Gast an.
   */
  function listCleanings(state, options, config) {
    config = withConfig(config);
    options = options || {};
    const reservations = Object.values(state.reservations);
    return Object.values(state.tasks)
      .filter((t) => !options.from || t.date >= options.from)
      .filter((t) => {
        if (!options.cleanerId) return true;
        if (t.assignedTo) return t.assignedTo === options.cleanerId;
        return cleanersFor(config, t.apartmentId).some((c) => c.id === options.cleanerId);
      })
      .map((t) => Object.assign({}, t, {
        sameDayArrival: reservations.some(
          (r) => r.apartmentId === t.apartmentId && r.arrival === t.date && r.id !== t.id
        ),
      }))
      .sort((a, b) => (a.date + a.apartmentName).localeCompare(b.date + b.apartmentName, 'de', { numeric: true }));
  }

  // ---------------------------------------------------------------------------
  // Manuelle Reinigungen (vom Auftraggeber eingetragen)
  // ---------------------------------------------------------------------------

  /**
   * Trägt eine zusätzliche Reinigung ein, z. B. Zwischenreinigung.
   * input: { id, apartmentId, apartmentName, date: 'YYYY-MM-DD', note }
   */
  function addManualCleaning(state, input, now, config) {
    config = withConfig(config);
    if (!input.apartmentId) throw new Error('Bitte eine Wohnung wählen');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) throw new Error('Bitte ein gültiges Datum wählen');
    const today = localParts(now, config.timezone).date;
    if (input.date < today) throw new Error('Das Datum liegt in der Vergangenheit');
    state = clone(state);
    const id = String(input.id);
    if (state.tasks[id]) throw new Error('Reinigung existiert bereits');
    const task = {
      id,
      manual: true,
      apartmentId: String(input.apartmentId),
      apartmentName: apartmentName(config, input.apartmentId, input.apartmentName),
      guest: '',
      note: (input.note || '').trim().slice(0, 500),
      date: input.date,
      status: STATUS.OPEN,
      assignedTo: null,
      reminded: false,
      escalated: false,
      history: [],
    };
    log(task, new Date(now).toISOString(), `Manuell eingetragen für ${formatDate(task.date)}`);
    state.tasks[id] = task;
    const notifications = notify(recipientsFor(config, task), 'new', task,
      'Zusätzliche Reinigung',
      `${task.apartmentName}: Reinigung am ${formatDate(task.date)}.${task.note ? ' Hinweis: ' + task.note : ''} Bitte in der App bestätigen.`);
    return { state, notifications };
  }

  /** Manuell eingetragene Reinigung absagen (Smoobu-Reinigungen folgen der Buchung). */
  function cancelManualCleaning(state, taskId, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = state.tasks[taskId];
    if (!task) throw new Error('Reinigung nicht gefunden');
    if (!task.manual) throw new Error('Reinigungen aus Smoobu bitte in Smoobu ändern');
    if (task.status === STATUS.CANCELLED || task.status === STATUS.DONE) return { state, notifications: [] };
    task.status = STATUS.CANCELLED;
    log(task, new Date(now).toISOString(), 'Vom Auftraggeber abgesagt');
    const notifications = notify(recipientsFor(config, task), 'cancelled', task,
      'Reinigung entfällt',
      `${task.apartmentName}: Reinigung am ${formatDate(task.date)} entfällt.`);
    return { state, notifications };
  }

  // ---------------------------------------------------------------------------
  // Meldungen der Reinigungskraft (Text + optional Fotos)
  // ---------------------------------------------------------------------------

  /** Darf diese Reinigungskraft die Reinigung sehen/bearbeiten? */
  function canAccess(config, task, cleanerId) {
    if (task.assignedTo) return task.assignedTo === cleanerId;
    return cleanersFor(config, task.apartmentId).some((c) => c.id === cleanerId);
  }

  /**
   * Reinigungskraft meldet etwas (fehlt, kaputt, zu tun).
   * report: { id, text, photos: [photoId, …] }
   */
  function addReport(state, taskId, cleanerId, report, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = state.tasks[taskId];
    if (!task) throw new Error('Reinigung nicht gefunden');
    if (!canAccess(config, task, cleanerId)) throw new Error('Keine Berechtigung für diese Reinigung');
    const text = (report.text || '').trim().slice(0, 2000);
    const photos = (report.photos || []).slice(0, 10);
    if (!text && !photos.length) throw new Error('Bitte einen Text eingeben oder ein Foto anhängen');
    const cleaner = config.cleaners.find((c) => c.id === cleanerId);
    const nowIso = new Date(now).toISOString();
    task.reports = task.reports || [];
    task.reports.push({ id: String(report.id), at: nowIso, by: cleanerId, text, photos, resolved: false });
    log(task, nowIso, `Meldung von ${cleaner ? cleaner.name : cleanerId}`);
    const summary = text ? (text.length > 120 ? text.slice(0, 117) + '…' : text) : 'Fotos angehängt';
    const notifications = notify([config.owner.id], 'report', task,
      `Meldung: ${task.apartmentName}`,
      `${cleaner ? cleaner.name : cleanerId}: ${summary}${photos.length ? ` (${photos.length} Foto${photos.length > 1 ? 's' : ''})` : ''}`);
    return { state, notifications };
  }

  /** Auftraggeber markiert eine Meldung als behoben. */
  function resolveReport(state, taskId, reportId, now) {
    state = clone(state);
    const task = state.tasks[taskId];
    const report = task && (task.reports || []).find((r) => r.id === String(reportId));
    if (!report) throw new Error('Meldung nicht gefunden');
    report.resolved = true;
    report.resolvedAt = new Date(now).toISOString();
    return { state, notifications: [] };
  }

  /** Alle noch nicht behobenen Meldungen, neueste zuerst. */
  function openReports(state) {
    const list = [];
    for (const t of Object.values(state.tasks)) {
      for (const r of t.reports || []) if (!r.resolved) list.push(Object.assign({ taskId: t.id, apartmentName: t.apartmentName, date: t.date }, r));
    }
    return list.sort((a, b) => b.at.localeCompare(a.at));
  }

  const api = {
    DEFAULT_CONFIG,
    STATUS,
    createState,
    fromSmoobuWebhook,
    fromSmoobuBooking,
    activeTaskIds,
    syncFromSmoobu,
    applyBooking,
    confirmCleaning,
    completeCleaning,
    checkDeadlines,
    listCleanings,
    cleanersFor,
    canAccess,
    addManualCleaning,
    cancelManualCleaning,
    addReport,
    resolveReport,
    openReports,
    localParts,
    formatDate,
    addDays,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CleaningLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
