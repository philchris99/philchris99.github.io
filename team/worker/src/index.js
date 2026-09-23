// Cloudflare Worker für team.apartments-strauss.de
//  - fetch:     Web-App (Ordner public/, /admin = Anmeldung Auftraggeber) + API unter /api/…
//  - scheduled: alle 15 Minuten Abgleich mit Smoobu + Fristen prüfen
import L from '../../logic/logic.js';
import config from './config.js';
import {
  authenticate, allUsers, findUser, sessionFor, topicFor, webhookToken, safeEqual,
  newCode, randomId, hashCode, findByCode,
} from './auth.js';
import {
  loadState, mutate, savePhoto, getPhoto, deletePhotos, pruneOldPhotos, resetAll,
  loadSettings, saveSettings, tooManyAttempts, recordFailure, clearAttempts,
} from './store.js';
import { fetchBookings, fetchBooking, fetchApartments, diagnose } from './smoobu.js';
import { deliver, sendPush } from './notify.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const fail = (message, status = 400) => json({ error: message }, status);
// Zugangsdaten: SMOOBU_API_KEY + SMOOBU_API_SECRET (HMAC). Leerzeichen,
// Zeilenumbrüche und Anführungszeichen vom Kopieren werden entfernt.
const clean = (v) => (v || '').trim().replace(/^["'„“]+|["'“”]+$/g, '').trim();
const smoobuCreds = (env) => ({ key: clean(env.SMOOBU_API_KEY), secret: clean(env.SMOOBU_API_SECRET) });

// Admin-Code des Auftraggebers liegt (gehasht) in settings.ownerCode
const OWNER_CODE_ID = '__owner__';
/** Alle Codes: Reinigungskräfte + Admin-Code (für Anmeldung und Eindeutigkeit) */
const codeHolders = (settings) => [
  ...(settings.cleaners || []),
  ...(settings.ownerCode ? [{ id: OWNER_CODE_ID, ...settings.ownerCode }] : []),
];
/** Leicht zu erratende Codes ablehnen (000000, 123456, 654321 …) */
function weakCode(code) {
  if (/^(\d)\1{5}$/.test(code)) return true;
  const digits = [...code].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]);
  return steps.every((x) => x === 1) || steps.every((x) => x === -1);
}

/** Konfiguration + aktuelle Reinigungskräfte aus der Datenbank. */
async function loadConfig(env) {
  const settings = await loadSettings(env.DB);
  return { cfg: { ...config, cleaners: settings.cleaners || [] }, settings };
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
    syncError = 'SMOOBU_API_KEY fehlt – bitte in Cloudflare als „Secret“ eintragen';
  }

  const result = await mutate(env.DB, (state) => {
    const notifications = [];
    if (bookings) {
      const synced = L.syncFromSmoobu(state, bookings, now, cfg);
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

async function viewFor(env, cfg, state, user, now) {
  const { date: today, time } = L.localParts(now, cfg.timezone);
  const base = {
    user: { id: user.id, name: user.name, role: user.role }, today, time, now: new Date(now).toISOString(),
    reminderTime: cfg.reminderTime, escalationTime: cfg.escalationTime,
    topic: await topicFor(env, user),
  };

  if (user.role === 'owner') {
    return { ...base,
      allowReset: !!cfg.allowReset,
      hasOwnerCode: !!(await loadSettings(env.DB)).ownerCode,
      openReports: L.openReports(state),
      tasks: L.listCleanings(state, { from: L.addDays(today, -7) }, cfg),
      log: (state.log || []).slice(0, 50).map((n) => ({ ...n, toName: n.to === cfg.owner.id ? 'Auftraggeber' : (findUser(cfg, n.to) || {}).name || n.to })),
      lastSync: state.lastSync || null, lastSyncCount: state.lastSyncCount ?? null, lastRun: state.lastRun || null, syncError: state.syncError || null,
      apartments: apartmentList(state),
      cleaners: cfg.cleaners.map((c) => ({ id: c.id, name: c.name, apartments: c.apartments, hasCode: !!c.codeHash, createdAt: c.createdAt })),
      webhookUrl: `${cfg.appUrl}/api/smoobu-webhook/${await webhookToken(env)}`,
    };
  }

  // Reinigungskraft: auch die letzten 7 Tage (erledigte bleiben grau sichtbar)
  const tasks = L.listCleanings(state, { cleanerId: user.id, from: L.addDays(today, -7) }, cfg).map((t) => {
    const { history, reminded, ...rest } = t;
    return { ...rest, guest: cfg.showGuestNames ? t.guest : '' };
  });
  return { ...base, tasks, log: (state.log || []).filter((n) => n.to === user.id).slice(0, 20) };
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

  // ---- Anmeldung Reinigungskraft: persönlicher 6-stelliger Code ----
  if (path === '/api/login' && request.method === 'POST') {
    if (await tooManyAttempts(env.DB, 'ip:' + ip, now)) return fail('Zu viele Versuche – bitte 15 Minuten warten', 429);
    const code = String((await readJson()).code || '').replace(/\D/g, '');
    const match = code.length === 6 ? await findByCode(codeHolders(settings), code) : null;
    if (!match || !env.APP_SECRET) {
      await recordFailure(env.DB, 'ip:' + ip, now);
      return fail('Code nicht bekannt – bitte prüfen oder bei Apartment Strauss nachfragen', 401);
    }
    await clearAttempts(env.DB, 'ip:' + ip);
    const user = match.id === OWNER_CODE_ID
      ? allUsers(cfg).find((u) => u.role === 'owner')
      : { ...match, role: 'cleaner' };
    return json({ session: await sessionFor(env, user) });
  }

  // ---- Anmeldung Auftraggeber: /admin mit ADMIN_PASSWORD ----
  if (path === '/api/admin-login' && request.method === 'POST') {
    const expected = clean(env.ADMIN_PASSWORD) || clean(env.APP_SECRET);
    if (await tooManyAttempts(env.DB, 'admin', now)) return fail('Zu viele Versuche – bitte 15 Minuten warten', 429);
    if (!expected || !safeEqual(String((await readJson()).password || ''), expected)) {
      await recordFailure(env.DB, 'admin', now);
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
      state.initialized ? L.applyBooking(state, booking, now, cfg) : { state, notifications: [] }, now);
    ctx.waitUntil(deliver(env, cfg, result.notifications));
    return json({ ok: true });
  }

  const user = await authenticate(request, env, cfg);
  if (!user) return fail('Bitte anmelden', 401);
  const owner = user.role === 'owner';
  const view = async (state) => json(await viewFor(env, cfg, state, user, now));
  /** Änderung speichern, Push verschicken, neue Ansicht zurückgeben (Fehler → 400) */
  const change = async (fn, status = 400) => {
    let result;
    try {
      result = await mutate(env.DB, fn, now);
    } catch (e) {
      return fail(e.message, status);
    }
    ctx.waitUntil(deliver(env, cfg, result.notifications));
    return view(result.state);
  };

  if (path === '/api/me' && request.method === 'GET') return view((await loadState(env.DB)).state);

  // ---- Reinigungskraft: bestätigen / erledigt ----
  const action = path.match(/^\/api\/tasks\/([^/]+)\/(confirm|done)$/);
  if (action && request.method === 'POST' && !owner) {
    const fn = action[2] === 'confirm' ? L.confirmCleaning : L.completeCleaning;
    return change((st) => fn(st, decodeURIComponent(action[1]), user.id, now, cfg), 409);
  }

  // ---- Foto anzeigen ----
  const photo = path.match(/^\/api\/photos\/([A-Za-z0-9-]+)$/);
  if (photo && request.method === 'GET') {
    const p = await getPhoto(env.DB, photo[1]);
    if (!p) return fail('Foto nicht gefunden', 404);
    return new Response(p.data, { headers: { 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' } });
  }

  // ---- Reinigungskraft: Meldung mit Text und optional Fotos ----
  const report = path.match(/^\/api\/tasks\/([^/]+)\/report$/);
  if (report && request.method === 'POST' && !owner) {
    const taskId = decodeURIComponent(report[1]);
    const { state } = await loadState(env.DB);
    const task = state.tasks[taskId];
    if (!task || !L.canAccess(cfg, task, user.id)) return fail('Reinigung nicht gefunden', 404);
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
        L.addReport(st, taskId, user.id, { id: reportId, text: String(form.get('text') || ''), photos: photoIds }, now, cfg), now);
      ctx.waitUntil(deliver(env, cfg, result.notifications));
      return view(result.state);
    } catch (e) {
      await deletePhotos(env.DB, photoIds).catch(() => {});
      return fail(e.message, 400);
    }
  }

  if (path === '/api/test-push' && request.method === 'POST') {
    try {
      await sendPush(env, user, { title: 'Test-Nachricht', body: `Hallo ${user.name}, die Push-Nachrichten funktionieren.`, kind: 'confirmed' });
      return json({ ok: true });
    } catch (e) {
      return fail(e.message, 502);
    }
  }

  // ======================= ab hier nur Auftraggeber =======================
  if (!owner) return fail('Nicht gefunden', 404);

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

  const cancel = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
  if (cancel && request.method === 'POST') {
    return change((st) => L.cancelManualCleaning(st, decodeURIComponent(cancel[1]), now, cfg));
  }

  // ---- Team: Reinigungskräfte verwalten (Code wird nur einmal angezeigt) ----
  const teamReply = async (extra) => {
    const next = await loadConfig(env);
    const { state } = await loadState(env.DB);
    return json({ ...(await viewFor(env, next.cfg, state, user, now)), ...extra });
  };
  const cleanApartments = (a) => (a === 'all' || !Array.isArray(a) ? 'all' : a.map(String).slice(0, 100));
  const withNewCode = async (cleaner) => {
    let code;
    do { code = newCode(); } while (weakCode(code) || await findByCode(codeHolders(settings).filter((c) => c.id !== cleaner.id), code));
    cleaner.codeSalt = randomId('', 16);
    cleaner.codeHash = await hashCode(code, cleaner.codeSalt);
    return code;
  };

  if (path === '/api/owner-code' && request.method === 'POST') {
    const code = String((await readJson()).code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) return fail('Bitte genau 6 Ziffern eingeben');
    if (weakCode(code)) return fail('Bitte keinen leicht zu erratenden Code wie 123456 oder 111111 wählen');
    if (await findByCode(settings.cleaners || [], code)) return fail('Dieser Code ist schon vergeben – bitte einen anderen wählen');
    const salt = randomId('', 16);
    settings.ownerCode = { codeSalt: salt, codeHash: await hashCode(code, salt), setAt: new Date(now).toISOString() };
    await saveSettings(env.DB, settings);
    return teamReply({});
  }

  if (path === '/api/team' && request.method === 'POST') {
    const body = await readJson();
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) return fail('Bitte einen Namen eingeben');
    const cleaner = { id: randomId('k', 8), name, apartments: cleanApartments(body.apartments), version: 1, createdAt: new Date(now).toISOString() };
    const code = await withNewCode(cleaner);
    settings.cleaners = [...(settings.cleaners || []), cleaner];
    await saveSettings(env.DB, settings);
    return teamReply({ newCode: { name, code } });
  }

  const team = path.match(/^\/api\/team\/([a-z0-9]+)(?:\/(code|delete))?$/);
  if (team && request.method === 'POST') {
    const cleaner = (settings.cleaners || []).find((c) => c.id === team[1]);
    if (!cleaner) return fail('Reinigungskraft nicht gefunden', 404);
    if (team[2] === 'delete') {
      settings.cleaners = settings.cleaners.filter((c) => c.id !== cleaner.id);
      await saveSettings(env.DB, settings);
      return teamReply({});
    }
    if (team[2] === 'code') {
      const code = await withNewCode(cleaner);
      cleaner.version = (cleaner.version || 1) + 1; // alte Anmeldungen werden ungültig
      await saveSettings(env.DB, settings);
      return teamReply({ newCode: { name: cleaner.name, code } });
    }
    const body = await readJson();
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) return fail('Bitte einen Namen eingeben');
    cleaner.name = name;
    cleaner.apartments = cleanApartments(body.apartments);
    await saveSettings(env.DB, settings);
    return teamReply({});
  }

  if (path === '/api/reset' && request.method === 'POST') {
    if (!cfg.allowReset) return fail('Zurücksetzen ist abgeschaltet', 403);
    if ((await readJson()).confirm !== 'ZURÜCKSETZEN') return fail('Bitte zur Bestätigung ZURÜCKSETZEN eingeben', 400);
    await resetAll(env.DB);
    const summary = await runSync(env, now, cfg);
    const { state } = await loadState(env.DB);
    return json({ summary, ...(await viewFor(env, cfg, state, user, now)) });
  }

  if (path === '/api/diagnose' && request.method === 'POST') {
    if (!smoobuCreds(env).key) return fail('SMOOBU_API_KEY fehlt – bitte in Cloudflare als „Secret“ eintragen', 400);
    const today = L.localParts(now, cfg.timezone).date;
    return json({ results: await diagnose(smoobuCreds(env), L.addDays(today, -1), L.addDays(today, cfg.syncDaysAhead)) });
  }

  if (path === '/api/sync' && request.method === 'POST') {
    const summary = await runSync(env, now, cfg);
    const { state } = await loadState(env.DB);
    return json({ summary, ...(await viewFor(env, cfg, state, user, now)) });
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
