// Cloudflare Worker für team.apartments-strauss.de (Apartments Strauss)
//  - fetch:     Web-App (Ordner public/, /admin = Notzugang mit Passwort) + API unter /api/…
//  - scheduled: alle 5 Minuten Abgleich mit Smoobu + Fristen prüfen
import L from '../../logic/logic.js';
import config from './config.js';
import {
  authenticate, allUsers, findUser, sessionFor, topicFor, webhookToken, safeEqual,
  newCode, randomId, hashCode, findByCode, encryptCode, decryptCode,
} from './auth.js';
import {
  loadState, mutate, savePhoto, getPhoto, deletePhotos, pruneOldPhotos, resetAll,
  loadSettings, saveSettings, lockedFor, recordFailure, clearAttempts,
} from './store.js';
import { fetchBookings, fetchBooking, fetchApartments, diagnose } from './smoobu.js';
import { deliver, sendPush } from './notify.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const fail = (message, status = 400, extra) => json({ error: message, ...extra }, status);
// Zugangsdaten: SMOOBU_API_KEY + SMOOBU_API_SECRET (HMAC). Leerzeichen,
// Zeilenumbrüche und Anführungszeichen vom Kopieren werden entfernt.
const clean = (v) => (v || '').trim().replace(/^["'„“]+|["'“”]+$/g, '').trim();
const smoobuCreds = (env) => ({ key: clean(env.SMOOBU_API_KEY), secret: clean(env.SMOOBU_API_SECRET) });

// Anmeldung: nach 3 falschen Codes 1 Minute gesperrt; Admin-Passwort 5 Versuche / 15 Min.
const CODE_LOCK = { max: 3, windowMs: 60 * 1000 };
const ADMIN_LOCK = { max: 5, windowMs: 15 * 60 * 1000 };

// Admin-Code liegt (gehasht) in settings.ownerCode
const OWNER_CODE_ID = '__owner__';
const codeHolders = (settings) => [
  ...(settings.leads || []),
  ...(settings.staff || []),
  ...(settings.ownerCode ? [{ id: OWNER_CODE_ID, ...settings.ownerCode }] : []),
];
/** Leicht zu erratende Codes ablehnen (000000, 123456, 654321 …) */
function weakCode(code) {
  if (/^(\d)\1{5}$/.test(code)) return true;
  const digits = [...code].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]);
  return steps.every((x) => x === 1) || steps.every((x) => x === -1);
}

/** Konfiguration + Team (Reinigungsleitung, Mitarbeiterinnen) aus der Datenbank. */
async function loadConfig(env) {
  const settings = await loadSettings(env.DB);
  if (settings.cleaners && !settings.staff) settings.staff = settings.cleaners; // ältere Version
  delete settings.cleaners;
  settings.leads = settings.leads || [];
  settings.staff = settings.staff || [];
  return { cfg: { ...config, leads: settings.leads, staff: settings.staff }, settings };
}

// ---------------------------------------------------------------------------
// Abgleich mit Smoobu + Fristen
// ---------------------------------------------------------------------------
export async function runSync(env, now = Date.now(), cfg) {
  if (!cfg) cfg = (await loadConfig(env)).cfg;
  const today = L.localParts(now, cfg.timezone).date;
  const from = L.addDays(today, -1);
  let bookings = null;
  let apartments = null;
  let syncError = null;

  if (smoobuCreds(env).key) {
    try {
      bookings = await fetchBookings(smoobuCreds(env), from, L.addDays(today, cfg.syncDaysAhead));
      apartments = await fetchApartments(smoobuCreds(env)).catch(() => null);
      // Reinigungen, deren Buchung nicht mehr in der Liste auftaucht, einzeln nachfragen.
      const seen = new Set(bookings.map((b) => String(b.id)));
      const { state } = await loadState(env.DB);
      // max. 5 je Durchlauf (Cloudflare-Limit: 50 Anfragen nach außen; läuft ohnehin alle 5 Min.)
      const missing = L.activeTaskIds(state, from).filter((id) => !seen.has(id)).slice(0, 5);
      for (const id of missing) {
        const single = await fetchBooking(smoobuCreds(env), id);
        bookings.push(single || { id, type: 'cancellation' });
      }
    } catch (e) {
      bookings = null;
      syncError = e.message;
    }
  } else {
    syncError = 'SMOOBU_API_KEY fehlt – bitte in Cloudflare als „Secret“ eintragen';
  }

  const result = await mutate(env.DB, (state) => {
    const notifications = [];
    if (bookings) {
      const synced = L.syncFromSmoobu(state, bookings, now, cfg, 30, from);
      state = synced.state;
      notifications.push(...synced.notifications);
    }
    const deadlines = L.checkDeadlines(state, now, cfg);
    state = deadlines.state;
    state.syncError = syncError;
    state.lastRun = new Date(now).toISOString();
    if (bookings) state.lastSyncCount = bookings.length;
    if (apartments && apartments.length) state.apartments = apartments;
    return { state, notifications: notifications.concat(deadlines.notifications) };
  }, now);

  const delivery = await deliver(env, cfg, result.notifications);
  // Versandergebnis merken, damit Fehler in der Admin-Ansicht sichtbar sind
  if (delivery.sent || delivery.failed) {
    await mutate(env.DB, (state) => ({ state: { ...state, pushReport: {
      at: new Date(now).toISOString(), sent: delivery.sent, failed: delivery.failed, errors: delivery.errors.slice(0, 5),
    } }, notifications: [] }), now).catch((e) => console.error(e));
  }
  await pruneOldPhotos(env.DB, now - cfg.keepPhotosDays * 86400000).catch((e) => console.error(e));
  return { bookings: bookings ? bookings.length : 0, notifications: result.notifications.length, ...delivery, syncError };
}

// ---------------------------------------------------------------------------
// Ansichten
// ---------------------------------------------------------------------------
function apartmentList(state) {
  const apartments = {};
  for (const t of Object.values(state.tasks)) apartments[t.apartmentId] = t.apartmentName;
  for (const a of state.apartments || []) apartments[a.id] = a.name;
  return Object.entries(apartments).map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
}

const person = (p) => ({ id: p.id, name: p.name, createdAt: p.createdAt });
/** Team-Liste; Codes sieht der Admin für alle, die Leitung für ihre Mitarbeiterinnen. */
async function teamFor(env, list, withCodes) {
  return Promise.all(list.map(async (p) => ({ ...person(p), ...(withCodes ? { code: await decryptCode(env, p.codeEnc) } : {}) })));
}
const CHANGE_KINDS = ['new', 'assigned', 'unassigned', 'rescheduled', 'cancelled', 'edited', 'note', 'report', 'late', 'request', 'period'];

/**
 * Nach jeder Änderung sofort die Fristen prüfen: Wird eine Reinigung erst nach 12 bzw. 15 Uhr
 * für heute eingetragen oder auf heute verschoben, kommt die Erinnerung gleich (nicht erst beim nächsten Lauf).
 */
function withDeadlines(result, now, cfg) {
  const d = L.checkDeadlines(result.state, now, cfg, { remindersOnly: true });
  return { state: d.state, notifications: [...result.notifications, ...d.notifications] };
}

async function viewFor(env, cfg, settings, state, user, now) {
  const { date: today, time } = L.localParts(now, cfg.timezone);
  const recipient = user.role === 'owner' ? cfg.owner.id : user.id;
  const since = new Date(now - 14 * 86400000).toISOString();
  const base = {
    user: { id: user.id, name: user.name, role: user.role }, today, time, now: new Date(now).toISOString(),
    startBy: cfg.startBy, finishBy: cfg.finishBy, confirmWithinHours: cfg.confirmWithinHours,
    topic: await topicFor(env, user),
    leads: await teamFor(env, cfg.leads, user.role === 'owner'),
    staff: await teamFor(env, cfg.staff, user.role === 'owner' || user.role === 'lead'),
    // Änderungen der letzten 14 Tage für diese Person (oben „Neuigkeiten“)
    changes: (state.log || []).filter((n) => n.to === recipient && CHANGE_KINDS.includes(n.kind) && n.at >= since).slice(0, 30),
    seenAt: (state.seen || {})[user.id] || null,
    pushOk: !!(settings.pushOk || {})[user.id], // Push auf diesem Konto eingerichtet (bleibt beim Zurücksetzen)
    hasNtfyToken: !!(env.NTFY_TOKEN || '').trim(),
    openReports: user.role === 'staff' ? [] : L.openReports(state),
    openRequests: user.role === 'owner' ? L.openPeriodRequests(state) : [],
    maxPeriodDays: cfg.maxPeriodDays,
  };
  const tasks = L.listCleanings(state, { user, from: L.addDays(today, -7) }, cfg).map((t) => {
    const { history, ...rest } = t;
    const out = { ...rest, guestPhone: cfg.showGuestPhone ? t.guestPhone : '', overdue: L.overdueReason(t, now, cfg) };
    if (user.role !== 'owner' && !cfg.showGuestNames) out.guest = '';
    if (user.role !== 'staff') out.history = history;
    return out;
  });

  if (user.role !== 'owner') return { ...base, tasks };
  return { ...base, tasks,
    allowReset: !!cfg.allowReset,
    hasOwnerCode: !!settings.ownerCode,
    log: (state.log || []).slice(0, 50).map((n) => ({ ...n, toName: n.to === cfg.owner.id ? 'Admin' : (findUser(cfg, n.to) || {}).name || n.to })),
    lastSync: state.lastSync || null, lastSyncCount: state.lastSyncCount ?? null, lastRun: state.lastRun || null, syncError: state.syncError || null,
    pushReport: state.pushReport || null,
    rules: { startBy: cfg.startBy, finishBy: cfg.finishBy, repeatMinutes: cfg.repeatMinutes, quietFrom: cfg.quietFrom },
    apartments: apartmentList(state),
    webhookUrl: `${cfg.appUrl}/api/smoobu-webhook/${await webhookToken(env)}`,
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function handleApi(request, env, url, ctx) {
  const path = url.pathname.replace(/\/+$/, '');
  const now = Date.now();
  const { cfg, settings } = await loadConfig(env);
  const ip = request.headers.get('CF-Connecting-IP') || 'lokal';
  const readJson = () => request.json().catch(() => ({}));

  // ---- Anmeldung mit 6-stelligem Code (Admin, Leitung, Mitarbeiterin) ----
  if (path === '/api/login' && request.method === 'POST') {
    const key = 'code:' + ip;
    const wait = await lockedFor(env.DB, key, now, CODE_LOCK);
    if (wait) return fail(`Zu viele falsche Versuche – bitte ${wait} Sekunden warten`, 429, { retryAfter: wait });
    const code = String((await readJson()).code || '').replace(/\D/g, '');
    const match = code.length === 6 ? await findByCode(codeHolders(settings), code) : null;
    if (!match || !env.APP_SECRET) {
      const count = await recordFailure(env.DB, key, now, CODE_LOCK);
      if (count >= CODE_LOCK.max) return fail('3 × falscher Code – Anmeldung für 1 Minute gesperrt', 429, { retryAfter: 60 });
      return fail(`Code nicht bekannt – noch ${CODE_LOCK.max - count} Versuch${CODE_LOCK.max - count === 1 ? '' : 'e'}`, 401);
    }
    await clearAttempts(env.DB, key);
    const user = match.id === OWNER_CODE_ID ? allUsers(cfg).find((u) => u.role === 'owner') : findUser(cfg, match.id);
    return json({ session: await sessionFor(env, user) });
  }

  // ---- Notzugang Admin: /admin mit ADMIN_PASSWORD ----
  if (path === '/api/admin-login' && request.method === 'POST') {
    const expected = clean(env.ADMIN_PASSWORD) || clean(env.APP_SECRET);
    const wait = await lockedFor(env.DB, 'admin', now, ADMIN_LOCK);
    if (wait) return fail(`Zu viele Versuche – bitte ${Math.ceil(wait / 60)} Minuten warten`, 429, { retryAfter: wait });
    if (!expected || !safeEqual(String((await readJson()).password || ''), expected)) {
      await recordFailure(env.DB, 'admin', now, ADMIN_LOCK);
      return fail('Passwort falsch', 401);
    }
    await clearAttempts(env.DB, 'admin');
    return json({ session: await sessionFor(env, allUsers(cfg).find((u) => u.role === 'owner')) });
  }

  // ---- Optionaler Smoobu-Webhook für sofortige Aktualisierung (sonst alle 15 Min.) ----
  const hook = path.match(/^\/api\/smoobu-webhook\/([A-Za-z0-9]+)$/);
  if (hook && request.method === 'POST') {
    if (!env.APP_SECRET || !safeEqual(hook[1], await webhookToken(env))) return fail('Unbekannt', 404);
    const payload = await request.json().catch(() => null);
    const booking = payload && L.fromSmoobuWebhook(payload);
    if (!booking || (payload.data && payload.data['is-blocked-booking'])) return json({ ok: true, ignored: true });
    const result = await mutate(env.DB, (state) =>
      state.initialized ? withDeadlines(L.applyBooking(state, booking, now, cfg), now, cfg) : { state, notifications: [] }, now);
    ctx.waitUntil(deliver(env, cfg, result.notifications));
    return json({ ok: true });
  }

  const user = await authenticate(request, env, cfg);
  if (!user) return fail('Bitte anmelden', 401);
  const role = user.role;
  const view = async (state, extra) => json({ ...(await viewFor(env, cfg, settings, state, user, now)), ...extra });
  /** Änderung speichern, Push verschicken, neue Ansicht zurückgeben */
  const change = async (fn, status = 400) => {
    let result;
    try {
      result = await mutate(env.DB, (st) => withDeadlines(fn(st), now, cfg), now);
    } catch (e) {
      return fail(e.message, status);
    }
    ctx.waitUntil(deliver(env, cfg, result.notifications));
    return view(result.state);
  };

  if (path === '/api/me' && request.method === 'GET') return view((await loadState(env.DB)).state);

  // Push-Nachrichten eingerichtet (Test-Nachricht angekommen) – je Benutzerkonto
  if (path === '/api/push-ok' && request.method === 'POST') {
    settings.pushOk = { ...(settings.pushOk || {}), [user.id]: new Date(now).toISOString() };
    await saveSettings(env.DB, settings);
    return view((await loadState(env.DB)).state);
  }

  // „Neuigkeiten“ als gelesen markieren
  if (path === '/api/seen' && request.method === 'POST') {
    return change((st) => ({ state: { ...st, seen: { ...(st.seen || {}), [user.id]: new Date(now).toISOString() } }, notifications: [] }));
  }

  // ---- Reinigung: Leitung bestätigt / weist zu; Mitarbeiterin bestätigt; Beginn; Erledigt ----
  const act = path.match(/^\/api\/tasks\/([^/]+)\/(lead-confirm|assign|confirm|start|done|edit|cancel|report|period-request|period-decide|period)$/);
  if (act && request.method === 'POST') {
    const id = decodeURIComponent(act[1]);
    switch (act[2]) {
      case 'lead-confirm':
        if (role !== 'lead') break;
        return change((st) => L.leadConfirm(st, id, user.id, now, cfg), 409);
      case 'assign': {
        if (role !== 'lead') break;
        const to = String((await readJson()).to || '');
        return change((st) => L.assignCleaning(st, id, user.id, to, now, cfg), 409);
      }
      case 'confirm':
        if (role === 'owner') break;
        return change((st) => L.staffConfirm(st, id, user.id, now, cfg), 409);
      case 'start':
        if (role === 'owner') break;
        return change((st) => L.startCleaning(st, id, user.id, now, cfg), 409);
      case 'done':
        if (role === 'owner') break;
        return change((st) => L.completeCleaning(st, id, user.id, now, cfg), 409);
      case 'edit': {
        if (role !== 'owner') break;
        const body = await readJson();
        return change((st) => L.editManualCleaning(st, id, { date: body.date, note: body.note }, now, cfg));
      }
      case 'cancel':
        if (role !== 'owner') break;
        return change((st) => L.cancelManualCleaning(st, id, now, cfg));
      case 'report':
        return handleReport(id);
      // Zeitraum: Reinigungsteam beantragt, Admin entscheidet oder legt selbst fest
      case 'period-request': {
        if (role === 'owner') break;
        const body = await readJson();
        return change((st) => L.requestPeriod(st, id, user, { until: body.until, reason: body.reason }, now, cfg));
      }
      case 'period-decide': {
        if (role !== 'owner') break;
        const body = await readJson();
        return change((st) => L.decidePeriod(st, id, !!body.approve, body.comment, now, cfg));
      }
      case 'period': {
        if (role !== 'owner') break;
        const body = await readJson();
        return change((st) => L.setPeriod(st, id, body.until || null, now, cfg));
      }
    }
    return fail('Nicht erlaubt', 403);
  }

  // Hinweis / Meldung mit Text und optional Fotos (alle Rollen)
  async function handleReport(taskId) {
    const { state } = await loadState(env.DB);
    const task = state.tasks[taskId];
    if (!task || !L.canAccess(cfg, task, user)) return fail('Reinigung nicht gefunden', 404);
    const form = await request.formData().catch(() => null);
    if (!form) return fail('Ungültige Anfrage');
    const files = form.getAll('photo').filter((f) => f && typeof f !== 'string');
    if (files.length > 5) return fail('Höchstens 5 Fotos pro Meldung');
    const photoIds = [];
    try {
      for (const file of files) {
        if (!/^image\//.test(file.type)) throw new Error('Nur Bilder können angehängt werden');
        if (file.size > 1900000) throw new Error('Ein Foto ist zu groß (max. 1,9 MB)');
        const pid = 'p' + crypto.randomUUID();
        await savePhoto(env.DB, { id: pid, taskId, mime: file.type, data: await file.arrayBuffer(), now });
        photoIds.push(pid);
      }
      const reportId = 'r' + crypto.randomUUID().slice(0, 12);
      const result = await mutate(env.DB, (st) =>
        L.addReport(st, taskId, user, { id: reportId, text: String(form.get('text') || ''), photos: photoIds }, now, cfg), now);
      ctx.waitUntil(deliver(env, cfg, result.notifications));
      return view(result.state);
    } catch (e) {
      await deletePhotos(env.DB, photoIds).catch(() => {});
      return fail(e.message, 400);
    }
  }

  // Foto löschen (eigene; Admin alle)
  const delPhoto = path.match(/^\/api\/tasks\/([^/]+)\/reports\/([^/]+)\/photos\/([A-Za-z0-9-]+)\/delete$/);
  if (delPhoto && request.method === 'POST') {
    const [, taskId, reportId, photoId] = delPhoto.map(decodeURIComponent);
    let result;
    try {
      result = await mutate(env.DB, (st) => L.removePhoto(st, taskId, reportId, photoId, user), now);
    } catch (e) {
      return fail(e.message, 403);
    }
    await deletePhotos(env.DB, [photoId]);
    return view(result.state);
  }

  // Belegungskalender (Admin mit Gastnamen, Leitung ohne)
  if (path === '/api/calendar' && request.method === 'GET' && role !== 'staff') {
    const { state } = await loadState(env.DB);
    const today = L.localParts(now, cfg.timezone).date;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : L.addDays(today, -3);
    const days = Math.min(62, Math.max(7, Number(url.searchParams.get('days')) || 35));
    return json({ today, ...L.calendar(state, from, days, role === 'owner' || cfg.showGuestNames, cfg, now) });
  }

  // Foto anzeigen
  const photo = path.match(/^\/api\/photos\/([A-Za-z0-9-]+)$/);
  if (photo && request.method === 'GET') {
    const p = await getPhoto(env.DB, photo[1]);
    if (!p) return fail('Foto nicht gefunden', 404);
    return new Response(p.data, { headers: { 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' } });
  }

  if (path === '/api/test-push' && request.method === 'POST') {
    try {
      await sendPush(env, user, { title: 'Test-Nachricht', body: `Hallo ${user.name}, die Push-Nachrichten funktionieren.`, kind: 'reminder' });
      return json({ ok: true });
    } catch (e) {
      return fail(e.message, 502);
    }
  }

  // ---- Team: Admin verwaltet Leitung + Mitarbeiterinnen, Leitung ihre Mitarbeiterinnen ----
  const teamReply = async (extra) => {
    const next = await loadConfig(env);
    const { state } = await loadState(env.DB);
    return json({ ...(await viewFor(env, next.cfg, next.settings, state, user, now)), ...extra });
  };
  const withNewCode = async (entry) => {
    let code;
    do { code = newCode(); } while (weakCode(code) || await findByCode(codeHolders(settings).filter((c) => c.id !== entry.id), code));
    entry.codeSalt = randomId('', 16);
    entry.codeHash = await hashCode(code, entry.codeSalt);
    entry.codeEnc = await encryptCode(env, code);
    return code;
  };
  const listFor = (kind) => (kind === 'lead' ? settings.leads : settings.staff);
  const mayManage = (kind) => role === 'owner' || (role === 'lead' && kind === 'staff');

  if (path === '/api/team' && request.method === 'POST') {
    const body = await readJson();
    const kind = body.role === 'lead' ? 'lead' : 'staff';
    if (!mayManage(kind)) return fail('Nicht erlaubt', 403);
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) return fail('Bitte einen Namen eingeben');
    const entry = { id: randomId(kind === 'lead' ? 'l' : 'm', 8), name, version: 1, createdAt: new Date(now).toISOString(), createdBy: user.id };
    const code = await withNewCode(entry);
    listFor(kind).push(entry);
    await saveSettings(env.DB, settings);
    return teamReply({ newCode: { name, code } });
  }

  const team = path.match(/^\/api\/team\/([a-z0-9]+)(?:\/(code|delete))?$/);
  if (team && request.method === 'POST') {
    const kind = settings.leads.some((p) => p.id === team[1]) ? 'lead' : 'staff';
    const entry = listFor(kind).find((p) => p.id === team[1]);
    if (!entry) return fail('Person nicht gefunden', 404);
    if (!mayManage(kind)) return fail('Nicht erlaubt', 403);
    if (team[2] === 'delete') {
      if (kind === 'lead') settings.leads = settings.leads.filter((p) => p !== entry);
      else settings.staff = settings.staff.filter((p) => p !== entry);
      await saveSettings(env.DB, settings);
      return teamReply({});
    }
    if (team[2] === 'code') {
      const code = await withNewCode(entry);
      entry.version = (entry.version || 1) + 1; // alte Anmeldungen werden ungültig
      await saveSettings(env.DB, settings);
      return teamReply({ newCode: { name: entry.name, code } });
    }
    const name = String((await readJson()).name || '').trim().slice(0, 60);
    if (!name) return fail('Bitte einen Namen eingeben');
    entry.name = name;
    await saveSettings(env.DB, settings);
    return teamReply({});
  }

  // ======================= ab hier nur Admin =======================
  if (role !== 'owner') return fail('Nicht gefunden', 404);

  const resolve = path.match(/^\/api\/tasks\/([^/]+)\/reports\/([^/]+)\/resolve$/);
  if (resolve && request.method === 'POST') {
    return change((st) => L.resolveReport(st, decodeURIComponent(resolve[1]), decodeURIComponent(resolve[2]), now), 404);
  }

  if (path === '/api/manual' && request.method === 'POST') {
    const body = await readJson();
    return change((st) => {
      const apt = apartmentList(st).find((a) => a.id === String(body.apartmentId));
      return L.addManualCleaning(st, {
        id: 'm' + crypto.randomUUID().slice(0, 12), apartmentId: body.apartmentId,
        apartmentName: apt && apt.name, date: body.date, note: body.note,
      }, now, cfg);
    });
  }

  if (path === '/api/owner-code' && request.method === 'POST') {
    const code = String((await readJson()).code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) return fail('Bitte genau 6 Ziffern eingeben');
    if (weakCode(code)) return fail('Bitte keinen leicht zu erratenden Code wie 123456 oder 111111 wählen');
    if (await findByCode([...settings.leads, ...settings.staff], code)) return fail('Dieser Code ist schon vergeben – bitte einen anderen wählen');
    const salt = randomId('', 16);
    settings.ownerCode = { codeSalt: salt, codeHash: await hashCode(code, salt), setAt: new Date(now).toISOString() };
    await saveSettings(env.DB, settings);
    return teamReply({});
  }

  if (path === '/api/reset' && request.method === 'POST') {
    if (!cfg.allowReset) return fail('Zurücksetzen ist abgeschaltet', 403);
    if ((await readJson()).confirm !== 'ZURÜCKSETZEN') return fail('Bitte zur Bestätigung ZURÜCKSETZEN eingeben', 400);
    await resetAll(env.DB);
    const summary = await runSync(env, now, cfg);
    return view((await loadState(env.DB)).state, { summary });
  }

  if (path === '/api/diagnose' && request.method === 'POST') {
    if (!smoobuCreds(env).key) return fail('SMOOBU_API_KEY fehlt – bitte in Cloudflare als „Secret“ eintragen', 400);
    const today = L.localParts(now, cfg.timezone).date;
    return json({ results: await diagnose(smoobuCreds(env), L.addDays(today, -1), L.addDays(today, cfg.syncDaysAhead)) });
  }

  if (path === '/api/sync' && request.method === 'POST') {
    const summary = await runSync(env, now, cfg);
    return view((await loadState(env.DB)).state, { summary });
  }

  return fail('Nicht gefunden', 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url, ctx);
      } catch (e) {
        console.error(e);
        return fail('Serverfehler: ' + e.message, 500);
      }
    }
    // /admin (und andere unbekannte Seiten) → die App selbst
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404 && request.method === 'GET') return env.ASSETS.fetch(new Request(new URL('/', url), request));
    return res;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env, event.scheduledTime).then((s) => console.log('Abgleich', JSON.stringify(s))));
  },
};
