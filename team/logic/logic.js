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
 *  - Reinigungstag 12:00 noch nicht erledigt → Erinnerung an Leitung, Mitarbeiterin, Admin
 *  - Reinigungstag 15:00 noch nicht erledigt → erneute Erinnerung an alle
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
    reminderTime: '12:00',       // Reinigungstag: erste Erinnerung, falls nicht erledigt
    secondReminderTime: '15:00', // Reinigungstag: zweite Erinnerung
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
    task.history.push({ at: nowIso, text });
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
    task.reminded1 = false;
    task.reminded2 = false;
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
      lateAlerted: false, reminded1: false, reminded2: false,
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
      arrival: r.arrival,
      departure: r.departure,
    };
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
  function applyBooking(state, booking, now, config, inPlace) {
    config = withConfig(config);
    if (!inPlace) state = clone(state);
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

    state.reservations[id] = { id, apartmentId: String(booking.apartmentId), arrival: booking.arrival, departure: booking.departure, guest: booking.guest || '' };

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
    if (booking.departure === existing.date || existing.status === STATUS.DONE) return { state, notifications };

    const oldDate = existing.date;
    const wasConfirmed = existing.status === STATUS.CONFIRMED;
    existing.date = booking.departure;
    resetForNewDate(existing, nowIso);
    const verb = existing.date > oldDate ? 'verlängert' : 'verkürzt';
    log(existing, nowIso, `Aufenthalt ${verb}: Reinigung ${formatDate(oldDate)} → ${formatDate(existing.date)}`);
    notifications.push(...notify(team(config, existing), 'rescheduled', existing, 'Reinigung verschoben',
      `${existing.apartmentName}: Aufenthalt ${verb}. Reinigung jetzt am ${formatDate(existing.date)} statt ${formatDate(oldDate)}. Bitte neu bestätigen.`));
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
      if (raw['is-blocked-booking']) { // Sperrzeit: nur für den Kalender merken, keine Reinigung
        state.reservations[String(raw.id)] = { id: String(raw.id), apartmentId: String(raw.apartment && raw.apartment.id),
          arrival: raw.arrival, departure: raw.departure, guest: '', blocked: true };
        continue;
      }
      const booking = fromSmoobuBooking(raw);
      if (!booking) continue;
      const res = applyBooking(state, booking, now, config, true);
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

  /** Reinigung erledigt (Ende). */
  function completeCleaning(state, taskId, userId, now, config) {
    config = withConfig(config);
    state = clone(state);
    const task = getTask(state, taskId);
    requireActive(task);
    if (!canWork(config, task, userId)) throw new Error('Diese Reinigung ist dir nicht zugewiesen');
    const nowIso = toIso(now);
    task.status = STATUS.DONE;
    task.doneAt = nowIso;
    task.doneBy = userId;
    const minutes = task.startedAt ? Math.round((Date.parse(nowIso) - Date.parse(task.startedAt)) / 60000) : null;
    const duration = minutes != null ? ` (Dauer ${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} Std.)` : '';
    log(task, nowIso, `Erledigt von ${personName(config, userId)}${duration}`);
    const to = [config.owner.id, ...leadIds(config)].filter((id) => id !== userId);
    return { state, notifications: notify(to, 'done', task, 'Reinigung erledigt',
      `${task.apartmentName} ist sauber – ${personName(config, userId)}${duration}.`) };
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

  function checkDeadlines(state, now, config) {
    config = withConfig(config);
    state = clone(state);
    const { date: today, time } = localParts(now, config.timezone);
    const nowIso = toIso(now);
    const notifications = [];
    const limit = config.confirmWithinHours * 3600000;

    for (const task of Object.values(state.tasks)) {
      if (!isActive(task)) continue;

      // 1) Nicht innerhalb von 6 Stunden vollständig bestätigt → Admin
      if (!task.lateAlerted && !fullyConfirmed(task) && task.confirmFrom && task.date >= today
          && Date.parse(nowIso) - Date.parse(task.confirmFrom) >= limit) {
        task.lateAlerted = true;
        log(task, nowIso, `Nach ${config.confirmWithinHours} Std. nicht bestätigt – Admin informiert`);
        notifications.push(...notify([config.owner.id], 'late', task, 'Reinigung nicht bestätigt',
          `${task.apartmentName} (${formatDate(task.date)}): seit ${config.confirmWithinHours} Std. nicht bestätigt – es fehlt: ${missingText(config, task)}.`));
      }

      // 2) Reinigungstag 12:00 / 15:00 noch nicht erledigt → Leitung, Mitarbeiterin, Admin
      const overdue = task.date < today;
      if (task.date !== today && !overdue) continue;
      const all = [...team(config, task), config.owner.id];
      if (!task.reminded2 && (overdue || time >= config.secondReminderTime)) {
        task.reminded1 = true;
        task.reminded2 = true;
        log(task, nowIso, 'Zweite Erinnerung: noch nicht erledigt');
        notifications.push(...notify(all, 'reminder2', task, 'Reinigung immer noch offen',
          `${task.apartmentName}: Reinigung ${overdue ? 'vom ' + formatDate(task.date) : 'heute'} ist um ${time} Uhr noch nicht erledigt – ${progressText(config, task)}.`));
      } else if (!task.reminded1 && time >= config.reminderTime) {
        task.reminded1 = true;
        log(task, nowIso, 'Erinnerung: noch nicht erledigt');
        notifications.push(...notify(all, 'reminder', task, 'Erinnerung: Reinigung heute',
          `${task.apartmentName}: Reinigung heute noch nicht erledigt – ${progressText(config, task)}.`));
      }
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
    task.reports.push({ id: String(report.id), at: nowIso, by: user.id, byRole: user.role, text, photos, resolved: false });
    log(task, nowIso, `${user.role === 'owner' ? 'Hinweis' : 'Meldung'} von ${author}`);
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
      .filter((t) => !options.from || t.date >= options.from)
      .filter((t) => !options.user || canAccess(config, t, options.user))
      .map((t) => Object.assign({}, t, {
        reports: t.reports || [],
        sameDayArrival: reservations.some((r) => r.apartmentId === t.apartmentId && r.arrival === t.date && r.id !== t.id),
      }))
      .sort((a, b) => (a.date + a.apartmentName).localeCompare(b.date + b.apartmentName, 'de', { numeric: true }));
  }

  /**
   * Belegungskalender: Wohnungen durchnummeriert, Buchungen/Sperrzeiten im Zeitraum.
   * showNames = Gastnamen anzeigen (Admin).
   */
  function calendar(state, from, days, showNames) {
    const to = addDays(from, days);
    const names = {};
    for (const t of Object.values(state.tasks)) names[t.apartmentId] = t.apartmentName;
    for (const a of state.apartments || []) names[a.id] = a.name;
    const apartments = Object.entries(names)
      .sort((a, b) => a[1].localeCompare(b[1], 'de', { numeric: true }))
      .map(([id, name], i) => ({ id, name, number: i + 1 }));
    const bookings = Object.values(state.reservations)
      .filter((r) => r.arrival < to && r.departure > from)
      .map((r) => ({ id: r.id, apartmentId: r.apartmentId, arrival: r.arrival, departure: r.departure, blocked: !!r.blocked,
        guest: showNames ? r.guest || '' : '' }));
    const cleanings = Object.values(state.tasks)
      .filter((t) => t.date >= from && t.date < to && t.status !== STATUS.CANCELLED)
      .map((t) => ({ id: t.id, apartmentId: t.apartmentId, date: t.date, status: t.status, manual: !!t.manual }));
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
    listCleanings, fullyConfirmed, calendar,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CleaningLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
