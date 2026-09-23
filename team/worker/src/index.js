// Cloudflare Worker für team.apartments-strauss.de
//  - fetch:     Web-App (Ordner public/) + API unter /api/…
//  - scheduled: alle 15 Minuten Abgleich mit Smoobu + Fristen prüfen
import L from '../../logic/logic.js';
import config from './config.js';
import { authenticate, allUsers, findUser, loginLink, topicFor, webhookToken, safeEqual } from './auth.js';
import { loadState, mutate, savePhoto, getPhoto, deletePhotos, pruneOldPhotos, resetAll } from './store.js';
import { fetchBookings, fetchBooking, fetchApartments, diagnose } from './smoobu.js';
import { deliver, sendPush } from './notify.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const fail = (message, status = 400) => json({ error: message }, status);
// Zugangsdaten: SMOOBU_API_KEY + SMOOBU_API_SECRET (HMAC). Leerzeichen,
// Zeilenumbrüche und Anführungszeichen vom Kopieren werden entfernt.
const clean = (v) => (v || '').trim().replace(/^["'„“]+|["'“”]+$/g, '').trim();
const smoobuCreds = (env) => ({ key: clean(env.SMOOBU_API_KEY), secret: clean(env.SMOOBU_API_SECRET) });

// ---------------------------------------------------------------------------
// Abgleich mit Smoobu + Fristen
// ---------------------------------------------------------------------------
export async function runSync(env, now = Date.now()) {
  const today = L.localParts(now, config.timezone).date;
  const from = L.addDays(today, -1);
  let bookings = null;
  let apartments = null;
  let syncError = null;

  if (smoobuCreds(env).key) {
    try {
      bookings = await fetchBookings(smoobuCreds(env), from, L.addDays(today, config.syncDaysAhead));
      apartments = await fetchApartments(smoobuCreds(env)).catch(() => null);
      // Reinigungen, deren Buchung nicht mehr in der Liste auftaucht (gelöscht oder
      // Abreise weit verschoben), einzeln nachfragen.
      const seen = new Set(bookings.map((b) => String(b.id)));
      const { state } = await loadState(env.DB);
      const missing = L.activeTaskIds(state, from).filter((id) => !seen.has(id)).slice(0, 20);
      for (const id of missing) {
        const single = await fetchBooking(smoobuCreds(env), id);
        bookings.push(single || { id, type: 'cancellation' });
      }
    } catch (e) {
      bookings = null;
      syncError = e.message;
    }
  } else {
    syncError = 'SMOOBU_API_KEY fehlt';
  }

  const result = await mutate(env.DB, (state) => {
    const notifications = [];
    if (bookings) {
      const synced = L.syncFromSmoobu(state, bookings, now, config);
      state = synced.state;
      notifications.push(...synced.notifications);
    }
    const deadlines = L.checkDeadlines(state, now, config);
    state = deadlines.state;
    state.syncError = syncError;
    state.lastRun = new Date(now).toISOString();
    if (bookings) state.lastSyncCount = bookings.length;
    if (apartments && apartments.length) state.apartments = apartments;
    return { state, notifications: notifications.concat(deadlines.notifications) };
  }, now);

  const delivery = await deliver(env, result.notifications);
  await pruneOldPhotos(env.DB, now - config.keepPhotosDays * 86400000).catch((e) => console.error(e));
  return { bookings: bookings ? bookings.length : 0, notifications: result.notifications.length, ...delivery, syncError };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
function viewFor(state, user, now) {
  const { date: today, time } = L.localParts(now, config.timezone);
  const base = { user: { id: user.id, name: user.name, role: user.role }, today, time,
    reminderTime: config.reminderTime, escalationTime: config.escalationTime };

  if (user.role === 'owner') {
    const apartments = {};
    for (const t of Object.values(state.tasks)) apartments[t.apartmentId] = t.apartmentName;
    for (const a of state.apartments || []) apartments[a.id] = a.name;
    return { ...base,
      allowReset: !!config.allowReset,
      openReports: L.openReports(state),
      tasks: L.listCleanings(state, { from: L.addDays(today, -7) }, config),
      log: (state.log || []).slice(0, 50).map((n) => ({ ...n, toName: n.to === config.owner.id ? 'Auftraggeber' : (findUser(n.to) || {}).name || n.to })),
      lastSync: state.lastSync || null, lastSyncCount: state.lastSyncCount ?? null, lastRun: state.lastRun || null, syncError: state.syncError || null,
      apartments: Object.entries(apartments).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true })),
      cleaners: config.cleaners.map((c) => ({ id: c.id, name: c.name, apartments: c.apartments })),
    };
  }

  const tasks = L.listCleanings(state, { cleanerId: user.id, from: today }, config).map((t) => {
    const { history, reminded, escalated, ...rest } = t;
    return { ...rest, escalated, guest: config.showGuestNames ? t.guest : '' };
  });
  return { ...base, tasks, log: (state.log || []).filter((n) => n.to === user.id).slice(0, 20) };
}

async function handleApi(request, env, url, ctx) {
  const path = url.pathname.replace(/\/+$/, '');
  const now = Date.now();

  // Einmalige Einrichtung: mit APP_SECRET alle persönlichen Links abrufen
  if (path === '/api/setup' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (!env.APP_SECRET || !safeEqual(String(body.secret || ''), env.APP_SECRET)) return fail('Falscher Schlüssel', 403);
    const users = [];
    for (const u of allUsers()) users.push({ id: u.id, name: u.name, role: u.role, link: await loginLink(env, u, url.origin), topic: await topicFor(env, u) });
    return json({ users, webhookUrl: `${url.origin}/api/smoobu-webhook/${await webhookToken(env)}` });
  }

  // Optionaler Smoobu-Webhook für sofortige Aktualisierung (sonst alle 15 Min.)
  const hook = path.match(/^\/api\/smoobu-webhook\/([A-Za-z0-9]+)$/);
  if (hook && request.method === 'POST') {
    if (!env.APP_SECRET || !safeEqual(hook[1], await webhookToken(env))) return fail('Unbekannt', 404);
    const payload = await request.json().catch(() => null);
    const booking = payload && L.fromSmoobuWebhook(payload);
    if (!booking || (payload.data && payload.data['is-blocked-booking'])) return json({ ok: true, ignored: true });
    const result = await mutate(env.DB, (state) =>
      state.initialized ? L.applyBooking(state, booking, now, config) : { state, notifications: [] }, now);
    ctx.waitUntil(deliver(env, result.notifications));
    return json({ ok: true });
  }

  const user = await authenticate(request, env);
  if (!user) return fail('Bitte den persönlichen Link verwenden', 401);

  if (path === '/api/me' && request.method === 'GET') {
    const { state } = await loadState(env.DB);
    return json({ ...viewFor(state, user, now), topic: await topicFor(env, user) });
  }

  const action = path.match(/^\/api\/tasks\/([^/]+)\/(confirm|done)$/);
  if (action && request.method === 'POST' && user.role === 'cleaner') {
    const fn = action[2] === 'confirm' ? L.confirmCleaning : L.completeCleaning;
    let result;
    try {
      result = await mutate(env.DB, (state) => fn(state, decodeURIComponent(action[1]), user.id, now, config), now);
    } catch (e) {
      return fail(e.message, 409);
    }
    ctx.waitUntil(deliver(env, result.notifications));
    return json(viewFor(result.state, user, now));
  }

  if (path === '/api/test-push' && request.method === 'POST') {
    try {
      await sendPush(env, user, { title: 'Test-Nachricht', body: `Hallo ${user.name}, die Push-Nachrichten funktionieren.`, kind: 'confirmed' });
      return json({ ok: true });
    } catch (e) {
      return fail(e.message, 502);
    }
  }

  // Foto anzeigen (für Auftraggeber und die zuständige Reinigungskraft)
  const photo = path.match(/^\/api\/photos\/([A-Za-z0-9-]+)$/);
  if (photo && request.method === 'GET') {
    const p = await getPhoto(env.DB, photo[1]);
    if (!p) return fail('Foto nicht gefunden', 404);
    return new Response(p.data, { headers: { 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' } });
  }

  // Reinigungskraft: Meldung mit Text und optional Fotos
  const report = path.match(/^\/api\/tasks\/([^/]+)\/report$/);
  if (report && request.method === 'POST' && user.role === 'cleaner') {
    const taskId = decodeURIComponent(report[1]);
    const { state } = await loadState(env.DB);
    const task = state.tasks[taskId];
    if (!task || !L.canAccess(config, task, user.id)) return fail('Reinigung nicht gefunden', 404);
    const form = await request.formData().catch(() => null);
    if (!form) return fail('Ungültige Anfrage');
    const files = form.getAll('photo').filter((f) => f && typeof f !== 'string');
    if (files.length > 5) return fail('Höchstens 5 Fotos pro Meldung');
    const photoIds = [];
    try {
      for (const file of files) {
        if (!/^image\//.test(file.type)) throw new Error('Nur Bilder können angehängt werden');
        if (file.size > 1900000) throw new Error('Ein Foto ist zu groß (max. 1,9 MB)');
        const id = 'p' + crypto.randomUUID();
        await savePhoto(env.DB, { id, taskId, mime: file.type, data: await file.arrayBuffer(), now });
        photoIds.push(id);
      }
      const reportId = 'r' + crypto.randomUUID().slice(0, 12);
      const result = await mutate(env.DB, (st) =>
        L.addReport(st, taskId, user.id, { id: reportId, text: String(form.get('text') || ''), photos: photoIds }, now, config), now);
      ctx.waitUntil(deliver(env, result.notifications));
      return json(viewFor(result.state, user, now));
    } catch (e) {
      await deletePhotos(env.DB, photoIds).catch(() => {});
      return fail(e.message, 400);
    }
  }

  // Auftraggeber: Meldung als behoben markieren
  const resolve = path.match(/^\/api\/tasks\/([^/]+)\/reports\/([^/]+)\/resolve$/);
  if (resolve && request.method === 'POST' && user.role === 'owner') {
    try {
      const result = await mutate(env.DB, (st) => L.resolveReport(st, decodeURIComponent(resolve[1]), decodeURIComponent(resolve[2]), now), now);
      return json(viewFor(result.state, user, now));
    } catch (e) {
      return fail(e.message, 404);
    }
  }

  // Auftraggeber: Reinigung manuell eintragen → Push an die Reinigungskraft
  if (path === '/api/manual' && request.method === 'POST' && user.role === 'owner') {
    const body = await request.json().catch(() => ({}));
    try {
      const result = await mutate(env.DB, (st) => {
        const apt = (st.apartments || []).find((a) => a.id === String(body.apartmentId))
          || Object.values(st.tasks).find((t) => t.apartmentId === String(body.apartmentId));
        return L.addManualCleaning(st, {
          id: 'm' + crypto.randomUUID().slice(0, 12), apartmentId: body.apartmentId,
          apartmentName: apt && (apt.name || apt.apartmentName), date: body.date, note: body.note,
        }, now, config);
      }, now);
      ctx.waitUntil(deliver(env, result.notifications));
      return json(viewFor(result.state, user, now));
    } catch (e) {
      return fail(e.message, 400);
    }
  }

  // Auftraggeber: manuelle Reinigung absagen
  const cancel = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
  if (cancel && request.method === 'POST' && user.role === 'owner') {
    try {
      const result = await mutate(env.DB, (st) => L.cancelManualCleaning(st, decodeURIComponent(cancel[1]), now, config), now);
      ctx.waitUntil(deliver(env, result.notifications));
      return json(viewFor(result.state, user, now));
    } catch (e) {
      return fail(e.message, 400);
    }
  }

  // Testphase: alles zurücksetzen und frisch aus Smoobu laden
  if (path === '/api/reset' && request.method === 'POST' && user.role === 'owner') {
    if (!config.allowReset) return fail('Zurücksetzen ist abgeschaltet', 403);
    const body = await request.json().catch(() => ({}));
    if (body.confirm !== 'ZURÜCKSETZEN') return fail('Bitte zur Bestätigung ZURÜCKSETZEN eingeben', 400);
    await resetAll(env.DB);
    const summary = await runSync(env, now);
    const { state } = await loadState(env.DB);
    return json({ summary, ...viewFor(state, user, now) });
  }

  if (path === '/api/diagnose' && request.method === 'POST' && user.role === 'owner') {
    if (!smoobuCreds(env).key) return fail('SMOOBU_API_KEY fehlt', 400);
    const today = L.localParts(now, config.timezone).date;
    return json({ results: await diagnose(smoobuCreds(env), L.addDays(today, -1), L.addDays(today, config.syncDaysAhead)) });
  }

  if (path === '/api/sync' && request.method === 'POST' && user.role === 'owner') {
    const summary = await runSync(env, now);
    const { state } = await loadState(env.DB);
    return json({ summary, ...viewFor(state, user, now) });
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
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env, event.scheduledTime).then((s) => console.log('Abgleich', JSON.stringify(s))));
  },
};
