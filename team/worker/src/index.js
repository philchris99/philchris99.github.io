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
  saveVideo, getVideoInfo, getVideoChunk, VIDEO_CHUNK,
  loadSettings, saveSettings, lockedFor, recordFailure, clearAttempts, loadStats, saveStats,
  codeLockState, codeFailure, codeSuccess, listCodeLocks, releaseCodeLock,
} from './store.js';
import { fetchBookings, fetchBooking, fetchApartments, fetchApartmentDetails, diagnose } from './smoobu.js';
import { deliver, sendPush } from './notify.js';
import BUILTIN_CODES from './access-codes.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const fail = (message, status = 400, extra) => json({ error: message, ...extra }, status);
// Zugangsdaten: SMOOBU_API_KEY + SMOOBU_API_SECRET (HMAC). Leerzeichen,
// Zeilenumbrüche und Anführungszeichen vom Kopieren werden entfernt.
const clean = (v) => (v || '').trim().replace(/^["'„“]+|["'“”]+$/g, '').trim();
const smoobuCreds = (env) => ({ key: clean(env.SMOOBU_API_KEY), secret: clean(env.SMOOBU_API_SECRET) });

// Anmeldung: nach 3 falschen Codes 1 Minute gesperrt; Admin-Passwort 5 Versuche / 15 Min.
const MAX_VIDEO = 40 * 1024 * 1024;
const BLOCKED_TEXT = 'Anmeldung von diesem Gerät gesperrt – bitte Apartments Strauss anrufen, damit der Zugang wieder freigeschaltet wird';
const waitText = (sec) => (sec >= 90 ? `${Math.ceil(sec / 60)} Minuten` : `${sec} Sekunden`);
// Zusätzlich systemweit (gegen Durchprobieren von vielen Adressen aus): 30 Fehlversuche/Std. → 1 Std. Sperre + Push an Admin.
// Der Admin kommt über /admin mit Passwort trotzdem hinein.
const GLOBAL_LOCK = { max: 30, windowMs: 60 * 60 * 1000 };
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
  return { cfg: { ...L.DEFAULT_CONFIG, ...config, leads: settings.leads, staff: settings.staff, langs: settings.lang || {} }, settings };
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
  await geocodeMissing(env, cfg, result.state, now).catch((e) => console.error('Geocoding', e.message));
  await trackOccupancy(env, cfg, result.state, now).catch((e) => console.error('Statistik', e.message));
  await loadApartmentInfo(env, result.state, now).catch((e) => console.error('Wohnungsdetails', e.message));
  return { bookings: bookings ? bookings.length : 0, notifications: result.notifications.length, ...delivery, syncError };
}

/** In der App gespeicherte Zugangscodes je Wohnungs-ID (AES-GCM verschlüsselt in settings.accessCodes) */
async function loadSavedCodes(env, settings) {
  if (!settings.accessCodes) return {};
  try {
    return JSON.parse(await decryptCode(env, settings.accessCodes)) || {};
  } catch (e) {
    return {};
  }
}

const normName = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
/** Für Adressvergleich: „Allerstraße 9“ = „Allerstr. 9“ = „allerstrasse 9“ */
const normAddress = (x) => String(x || '').toLowerCase().replace(/ß/g, 'ss')
  .replace(/stra?sse|str\./g, 'str').replace(/[^a-z0-9äöü]/g, '');
const translit = (x) => String(x || '').toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
const words = (x) => translit(x).split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Fest hinterlegter Eintrag zu einem Smoobu-Wohnungsnamen:
 * 1. Kürzel als eigenes Wort („#EINS | …“, „EINS – …“, „Apartment Eins“; „DREI“ ≠ „DREIZEHN“)
 * 2. sonst eindeutige Adresse („Allerstr. 9“, „Berliner Platz 1c (070)“)
 */
export function builtinFor(name) {
  const entries = Object.entries(BUILTIN_CODES);
  const w = words(name);
  const byWord = entries.filter(([key]) => w.includes(translit(key).replace('#', '')));
  if (byWord.length === 1) return byWord[0][1];
  const full = normAddress(name);
  const byAddress = entries.filter(([, e]) => e.address && full.includes(normAddress(e.address)));
  if (byAddress.length === 1) return byAddress[0][1];
  // „Berliner Platz 1c“ ohne Wohnungsnummer passt auf mehrere – dann über „(070)“ bzw. „WE 070“
  const unit = /\b(\d{3})\b/.exec(String(name || ''));
  if (unit) {
    const byUnit = entries.filter(([, e]) => e.address && e.address.includes(`(${unit[1]})`));
    if (byUnit.length === 1) return byUnit[0][1];
  }
  return null;
}

// ---- Routenplanung: Adressen der Wohnungen → Koordinaten (OpenStreetMap, einmalig, gespeichert) ----
const cleanAddress = (a) => String(a || '').replace(/\([^)]*\)/g, '').replace(/(\d+[a-z]?)\/\d+/i, '$1').replace(/\s+/g, ' ').trim();

/** Fehlende Koordinaten nachschlagen – höchstens 2 je Lauf (Nutzungsregeln von OpenStreetMap: max. 1 Anfrage/Sek.) */
async function geocodeMissing(env, cfg, state, now) {
  const settings = await loadSettings(env.DB);
  const geo = settings.geo || {};
  const names = new Set([...Object.values(state.tasks || {}).map((t) => t.apartmentName), ...(state.apartments || []).map((a) => a.name)]);
  const todo = [];
  for (const name of names) {
    const b = builtinFor(name);
    if (!b || !b.address) continue;
    const g = geo[b.address];
    if (!g || (g.failed && now - Date.parse(g.at) > 7 * 86400000)) if (!todo.includes(b.address)) todo.push(b.address);
  }
  if (!todo.length) return;
  for (const address of todo.slice(0, 2)) {
    const q = `${cleanAddress(address)}, ${cfg.routeCity || ''}`.replace(/, $/, '');
    const url = `${env.GEOCODE_URL || 'https://nominatim.openstreetmap.org/search'}?format=json&limit=1&countrycodes=de&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'apartments-strauss-team/1.0 (team.apartments-strauss.de)', 'Accept-Language': 'de' } });
    const list = res.ok ? await res.json().catch(() => []) : [];
    geo[address] = list[0] ? { lat: Number(list[0].lat), lon: Number(list[0].lon), at: new Date(now).toISOString() }
      : { failed: true, at: new Date(now).toISOString() };
  }
  settings.geo = geo;
  await saveSettings(env.DB, settings);
}

/** Punkte je Wohnungs-ID für die Route */
function routePoints(settings, apartments, cfg) {
  const points = {};
  for (const a of apartments) {
    const b = builtinFor(a.name);
    if (!b || !b.address) continue;
    const g = (settings.geo || {})[b.address];
    points[a.id] = { address: b.address, lat: g && !g.failed ? g.lat : null, lon: g && !g.failed ? g.lon : null, city: cfg.routeCity || '' };
  }
  return points;
}

/** Link zu Google Maps mit allen Stopps in der empfohlenen Reihenfolge */
function mapsUrl(stops) {
  const where = (s) => (s.point && s.point.lat != null ? `${s.point.lat},${s.point.lon}` : s.point && s.point.address ? `${cleanAddress(s.point.address)}, ${s.point.city}` : '');
  const list = stops.map(where).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(list[0])}`;
  const p = new URLSearchParams({ api: '1', origin: list[0], destination: list[list.length - 1], travelmode: 'driving' });
  if (list.length > 2) p.set('waypoints', list.slice(1, -1).join('|'));
  return 'https://www.google.com/maps/dir/?' + p.toString();
}

// ---- Wohnungsgröße aus Smoobu (Schlafzimmer, max. Personen) – höchstens 3 je Lauf, alle 30 Tage aktualisiert ----
async function loadApartmentInfo(env, state, now) {
  const creds = smoobuCreds(env);
  if (!creds.key) return;
  const settings = await loadSettings(env.DB);
  const info = settings.aptInfo || {};
  const todo = apartmentList(state).filter((a) => !info[a.id] || now - Date.parse(info[a.id].at) > 30 * 86400000).slice(0, 3);
  if (!todo.length) return;
  for (const a of todo) {
    try {
      info[a.id] = { ...(await fetchApartmentDetails(creds, a.id)), at: new Date(now).toISOString() };
    } catch (e) {
      info[a.id] = { bedrooms: null, maxOccupancy: null, type: '', failed: true, at: new Date(now).toISOString() };
    }
  }
  settings.aptInfo = info;
  await saveSettings(env.DB, settings);
}

/** Größenkategorie: eigene Festlegung in der App, sonst feste Zuordnung (config.sizeByNumber), sonst aus Smoobu */
function sizeCategory(settings, id, name) {
  const own = ((settings.aptCategory || {})[id] || '').trim();
  if (own) return own;
  const fixed = (config.sizeByNumber || {})[L.apartmentNumber(name)];
  if (fixed) return fixed;
  const i = (settings.aptInfo || {})[id] || {};
  if (i.bedrooms === 0) return 'Studio';
  if (i.bedrooms != null) return i.bedrooms === 1 ? '1 Schlafzimmer' : `${i.bedrooms} Schlafzimmer`;
  if (i.maxOccupancy != null) return `bis ${i.maxOccupancy} Personen`;
  return 'ohne Angabe';
}

/** Auslastung je Größenkategorie (nächste 30 Nächte): gebucht (Nachfrage) und inkl. Blockierungen */
function sizeGroups(settings, perApartment, days) {
  const groups = new Map();
  for (const a of perApartment) {
    const cat = sizeCategory(settings, a.id, a.name);
    if (!groups.has(cat)) groups.set(cat, { category: cat, apartments: [], booked: 0, blocked: 0 });
    const g = groups.get(cat);
    g.apartments.push(a.id);
    g.booked += a.booked;
    g.blocked += a.blocked;
  }
  const pct = (x, n) => (n ? Math.round((x / n) * 1000) / 10 : 0);
  return [...groups.values()].map((g) => ({ ...g, count: g.apartments.length,
    bookedPct: pct(g.booked, g.apartments.length * days), pct: pct(g.booked + g.blocked, g.apartments.length * days) }))
    .sort((a, b) => b.bookedPct - a.bookedPct);
}

// ---- Statistik: Auslastung der nächsten 30 Nächte (Buchungen + Sperrzeiten) ----
async function statsView(env, cfg, state, now) {
  const stats = await loadStats(env.DB);
  const settings = await loadSettings(env.DB);
  const current = currentOccupancy(state, cfg, now);
  const names = Object.fromEntries(apartmentList(state).map((a) => [a.id, a.name]));
  const history = Object.entries(stats.days).sort((a, b) => a[0].localeCompare(b[0])).slice(-180).map(([date, v]) => ({ date, ...v }));
  const perApartment = Object.entries(current.perApartment).map(([id, v]) => {
    const i = (settings.aptInfo || {})[id] || {};
    return { id, name: names[id] || id, ...v, bookedPct: STAT_DAYS ? Math.round((v.booked / STAT_DAYS) * 1000) / 10 : 0,
      category: sizeCategory(settings, id, names[id] || ''), ownCategory: ((settings.aptCategory || {})[id] || ''), bedrooms: i.bedrooms ?? null, maxOccupancy: i.maxOccupancy ?? null };
  }).sort((a, b) => L.compareApartments(a.name, b.name));
  // Tatsächliche Belegung: Durchschnitt der letzten 30 Nächte (soweit bekannt)
  const today = L.localParts(now, cfg.timezone).date;
  const last30 = history.filter((h) => h.actual && h.date < today && h.date >= L.addDays(today, -30));
  const avg = (k) => (last30.length ? Math.round((last30.reduce((s, h) => s + h.actual[k], 0) / last30.length) * 10) / 10 : null);
  return { days: STAT_DAYS, current: { ...current, perApartment }, groups: sizeGroups(settings, perApartment, STAT_DAYS),
    actual30: last30.length ? { pct: avg('pct'), bookedPct: avg('bookedPct'), blockedPct: avg('blockedPct'), nights: last30.length } : null,
    apartments: perApartment.length, history, backfill: stats.backfill || null };
}

const STAT_DAYS = 30;
function currentOccupancy(state, cfg, now) {
  const today = L.localParts(now, cfg.timezone).date;
  const ids = apartmentList(state).map((a) => a.id);
  return L.occupancy(L.nightIndex(L.reservationEntries(state)), ids, today, STAT_DAYS);
}
/** Wert für heute festhalten (jeder Lauf überschreibt den heutigen Wert – am Tagesende steht der letzte Stand) */
async function trackOccupancy(env, cfg, state, now) {
  if (!state.initialized || !apartmentList(state).length) return;
  const today = L.localParts(now, cfg.timezone).date;
  const o = currentOccupancy(state, cfg, now);
  const ids = apartmentList(state).map((a) => a.id);
  const night = L.nightOccupancy(L.nightIndex(L.reservationEntries(state)), ids, today);
  const stats = await loadStats(env.DB);
  const prev = stats.days[today];
  const actual = { pct: night.pct, bookedPct: night.bookedPct, blockedPct: night.blockedPct };
  const row = { pct: o.pct, bookedPct: o.bookedPct, blockedPct: o.blockedPct, apartments: ids.length, source: 'live', actual };
  if (prev && prev.source === 'live' && prev.pct === row.pct && prev.bookedPct === row.bookedPct && prev.actual && prev.actual.pct === actual.pct) return;
  stats.days[today] = row;
  await saveStats(env.DB, stats);
}

/** Zugangscodes je Wohnungs-ID: in der App gespeicherte haben Vorrang, sonst die fest hinterlegten */
async function loadAccessCodes(env, settings, apartments) {
  const saved = await loadSavedCodes(env, settings);
  const out = {};
  for (const a of apartments) {
    const b = builtinFor(a.name);
    if (saved[a.id]) out[a.id] = { ...saved[a.id], builtin: false };
    else if (b) out[a.id] = { guest: b.guest, service: b.service, description: b.description, builtin: true };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ansichten
// ---------------------------------------------------------------------------
function apartmentList(state) {
  const apartments = {};
  for (const t of Object.values(state.tasks)) apartments[t.apartmentId] = t.apartmentName;
  for (const a of state.apartments || []) apartments[a.id] = a.name;
  return Object.entries(apartments).map(([id, name]) => ({ id, name }))
    .sort((a, b) => L.compareApartments(a.name, b.name)); // #EINS … #DREIZEHN in Zahlenfolge
}

const person = (p) => ({ id: p.id, name: p.name, createdAt: p.createdAt });
/** Team-Liste; Codes sieht der Admin für alle, die Leitung für ihre Mitarbeiterinnen. */
async function teamFor(env, list, withCodes) {
  return Promise.all(list.map(async (p) => ({ ...person(p), ...(withCodes ? { code: await decryptCode(env, p.codeEnc) } : {}) })));
}
const CHANGE_KINDS = ['new', 'assigned', 'unassigned', 'rescheduled', 'cancelled', 'edited', 'note', 'report', 'late', 'request', 'period', 'keys'];

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
    lang: (settings.lang || {})[user.id] || 'de',
    checklist: cfg.checklist,
    supplyItems: cfg.supplies,
    shopping: user.role === 'staff' ? [] : L.shoppingList(state, cfg),
    missingKeys: user.role === 'owner' ? L.missingKeys(state) : [],
    maxPeriodDays: cfg.maxPeriodDays,
  };
  const list = L.listCleanings(state, { user, from: L.addDays(today, -7) }, cfg);
  // Lage der Wohnung (Adresse, Stockwerk/Seite) – ohne Codes, die gibt es nur per Knopf
  const apts = [...new Map(list.map((t) => [t.apartmentId, { id: t.apartmentId, name: t.apartmentName }])).values()];
  const codes = await loadAccessCodes(env, settings, apts);
  const tasks = list.map((t) => {
    const { history, ...rest } = t;
    const b = builtinFor(t.apartmentName);
    const out = { ...rest, guestPhone: cfg.showGuestPhone ? t.guestPhone : '', overdue: L.overdueReason(t, now, cfg),
      location: { address: (b && b.address) || '', description: (codes[t.apartmentId] && codes[t.apartmentId].description) || '' },
      aptNote: ((settings.aptNotes || {})[t.apartmentId] || {}).text || '' };
    if (user.role !== 'owner' && !cfg.showGuestNames) out.guest = '';
    if (user.role !== 'staff') out.history = history;
    return out;
  });

  // Empfohlene Route für heute und morgen – Mitarbeiterin: ihre eigene; Leitung/Admin: je Person (+ noch nicht zugewiesen)
  const points = routePoints(settings, apts, cfg);
  const routes = [];
  for (const day of [today, L.addDays(today, 1)]) {
    const onDay = list.filter((t) => (t.status === 'offen' || t.status === 'bestätigt') && t.date <= day && L.lastDay(t) >= day);
    const groups = new Map();
    for (const t of onDay) {
      if (user.role === 'staff' && t.assignedTo !== user.id) continue;
      const key = t.assignedTo || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t.id);
    }
    for (const [who, ids] of groups) {
      const r = L.planRoute(state, ids, day, points, cfg);
      if (!r.stops.length) continue;
      routes.push({ ...r, who, whoName: who ? (findUser(cfg, who) || {}).name || '' : '', mapsUrl: mapsUrl(r.stops),
        stops: r.stops.map(({ point, ...s }) => ({ ...s, hasPoint: !!(point && point.lat != null) })) });
    }
  }

  if (user.role !== 'owner') return { ...base, tasks, routes };
  return { ...base, tasks, routes,
    allowReset: !!cfg.allowReset,
    hasOwnerCode: !!settings.ownerCode,
    log: (state.log || []).slice(0, 50).map((n) => ({ ...n, toName: n.to === cfg.owner.id ? 'Admin' : (findUser(cfg, n.to) || {}).name || n.to })),
    lastSync: state.lastSync || null, lastSyncCount: state.lastSyncCount ?? null, lastRun: state.lastRun || null, syncError: state.syncError || null,
    pushReport: state.pushReport || null,
    loginLocks: await listCodeLocks(env.DB, now),
    stats: await statsView(env, cfg, state, now),
    aptNotes: settings.aptNotes || {},
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
  // Offline erfasste Aktionen bringen ihre Uhrzeit mit (höchstens 12 Std. zurück, nie in der Zukunft)
  const clientTime = (at) => {
    const t = typeof at === 'number' ? at : Date.parse(at || '');
    return Number.isFinite(t) && t <= now && t >= now - 12 * 3600000 ? t : now;
  };

  // ---- Anmeldung mit 6-stelligem Code (Admin, Leitung, Mitarbeiterin) ----
  // Stand der Sperre für dieses Gerät/diese Adresse – die Anmeldeseite zeigt ohne Versuche gar kein Eingabefeld
  if (path === '/api/login-status' && request.method === 'GET') {
    return json(await codeLockState(env.DB, ip, now));
  }

  if (path === '/api/login' && request.method === 'POST') {
    const globalWait = await lockedFor(env.DB, 'code:alle', now, GLOBAL_LOCK);
    if (globalWait) {
      return fail('Anmeldung wegen vieler Fehlversuche vorübergehend gesperrt – bitte später erneut versuchen oder Apartments Strauss anrufen', 429,
        { retryAfter: globalWait });
    }
    const lock = await codeLockState(env.DB, ip, now);
    if (lock.blocked) return fail(BLOCKED_TEXT, 403, { blocked: true });
    if (lock.wait) return fail(`Zu viele falsche Versuche – gesperrt, noch ${waitText(lock.wait)}`, 429, { retryAfter: lock.wait });
    const code = String((await readJson()).code || '').replace(/\D/g, '');
    const match = code.length === 6 ? await findByCode(codeHolders(settings), code) : null;
    if (!match || !env.APP_SECRET) {
      const total = await recordFailure(env.DB, 'code:alle', now, GLOBAL_LOCK);
      if (total === GLOBAL_LOCK.max) {
        ctx.waitUntil(deliver(env, cfg, [{ to: cfg.owner.id, kind: 'security', title: 'Viele falsche Anmeldeversuche',
          body: `${total} falsche Codes innerhalb einer Stunde – Anmeldung per Code für 1 Stunde gesperrt. Admin-Zugang: /admin mit Passwort.` }]));
      }
      const after = await codeFailure(env.DB, ip, now);
      if (after.blocked) {
        if (after.justBlocked) {
          ctx.waitUntil(deliver(env, cfg, [{ to: cfg.owner.id, kind: 'security', title: 'Anmeldung dauerhaft gesperrt',
            body: `Adresse ${ip}: zu viele falsche Codes – dauerhaft gesperrt. Freischalten im Admin-Bereich unter „Gesperrte Anmeldungen“.` }]));
        }
        return fail(BLOCKED_TEXT, 403, { blocked: true });
      }
      if (after.wait) return fail(`Falscher Code – Anmeldung gesperrt für ${waitText(after.wait)}`, 429, { retryAfter: after.wait });
      return fail(`Code nicht bekannt – noch ${after.left} Versuch${after.left === 1 ? '' : 'e'}`, 401, { left: after.left });
    }
    await codeSuccess(env.DB, ip);
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

  // Sprache der App je Person (Deutsch / Ungarisch) – gilt auch für die Push-Überschriften
  if (path === '/api/lang' && request.method === 'POST') {
    const lang = (await readJson()).lang === 'hu' ? 'hu' : 'de';
    settings.lang = { ...(settings.lang || {}), [user.id]: lang };
    await saveSettings(env.DB, settings);
    return view((await loadState(env.DB)).state);
  }

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
  const act = path.match(/^\/api\/tasks\/([^/]+)\/(lead-confirm|assign|confirm|start|done|edit|cancel|report|period-request|period-decide|period|keys-resolved|supplies)$/);
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
      case 'start': {
        if (role === 'owner') break;
        const when = clientTime((await readJson()).at);
        return change((st) => L.startCleaning(st, id, user.id, when, cfg), 409);
      }
      case 'done': {
        if (role === 'owner') break;
        const body = await readJson();
        const when = clientTime(body.at);
        return change((st) => L.completeCleaning(st, id, user.id, when, cfg,
          { keysInBox: body.keysInBox, keysNote: body.keysNote, checklist: body.checklist, supplies: body.supplies }), 409);
      }
      case 'supplies': {
        const body = await readJson();
        return change((st) => L.reportSupplies(st, id, user, body.items, now, cfg));
      }
      case 'keys-resolved': {
        if (role !== 'owner') break;
        const body = await readJson();
        return change((st) => L.resolveKeys(st, id, body.note, now), 409);
      }
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
    const videos = files.filter((f) => /^video\//.test(f.type));
    if (files.length - videos.length > 5) return fail('Höchstens 5 Fotos pro Meldung');
    if (videos.length > 2) return fail('Höchstens 2 Videos pro Meldung');
    const photoIds = [];
    try {
      for (const file of files) {
        if (/^video\//.test(file.type)) {
          if (file.size > MAX_VIDEO) throw new Error('Ein Video ist zu groß (max. 40 MB – bitte kürzer aufnehmen, ca. 30 Sekunden)');
          const vid = 'v' + crypto.randomUUID();
          await saveVideo(env.DB, { id: vid, taskId, mime: file.type, data: await file.arrayBuffer(), now });
          photoIds.push(vid);
          continue;
        }
        if (!/^image\//.test(file.type)) throw new Error('Nur Fotos und Videos können angehängt werden');
        if (file.size > 1900000) throw new Error('Ein Foto ist zu groß (max. 1,9 MB)');
        const pid = 'p' + crypto.randomUUID();
        await savePhoto(env.DB, { id: pid, taskId, mime: file.type, data: await file.arrayBuffer(), now });
        photoIds.push(pid);
      }
      const reportId = 'r' + crypto.randomUUID().slice(0, 12);
      const result = await mutate(env.DB, (st) =>
        L.addReport(st, taskId, user, { id: reportId, text: String(form.get('text') || ''), photos: photoIds, final: form.get('final') === '1' }, now, cfg), now);
      ctx.waitUntil(deliver(env, cfg, result.notifications));
      return view(result.state);
    } catch (e) {
      await deletePhotos(env.DB, photoIds).catch(() => {});
      return fail(e.message, 400);
    }
  }

  /** Video in Stücken ausliefern – mit „Range“ (iPhone/Safari spielt Videos nur so ab) */
  async function serveVideo(id) {
    const info = await getVideoInfo(env.DB, id);
    if (!info) return fail('Video nicht gefunden', 404);
    const size = info.size;
    let start = 0, end = size - 1, partial = false;
    const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') || '');
    if (m && (m[1] || m[2])) {
      partial = true;
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); } else { start = Math.max(0, size - Number(m[2])); }
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      end = Math.min(end, start + 2 * VIDEO_CHUNK - 1); // höchstens ~4 MB je Antwort, der Browser holt den Rest nach
    }
    const first = Math.floor(start / VIDEO_CHUNK), last = Math.floor(end / VIDEO_CHUNK);
    let idx = first;
    const body = new ReadableStream({
      async pull(controller) {
        if (idx > last) return controller.close();
        const chunk = await getVideoChunk(env.DB, id, idx);
        const offset = idx * VIDEO_CHUNK;
        controller.enqueue(chunk.subarray(Math.max(0, start - offset), Math.min(chunk.length, end - offset + 1)));
        idx++;
      },
    });
    const headers = { 'Content-Type': info.mime, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Cache-Control': 'private, max-age=86400' };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    return new Response(body, { status: partial ? 206 : 200, headers });
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

  // Zugangscodes der Wohnung zu einer Reinigung (Gäste-Code, Service-Schlüsselbox) – Abruf wird protokolliert
  const codesOf = path.match(/^\/api\/tasks\/([^/]+)\/codes$/);
  if (codesOf && request.method === 'POST') {
    const id = decodeURIComponent(codesOf[1]);
    const task = (await loadState(env.DB)).state.tasks[id];
    if (!task || !L.mayViewCodes(cfg, task, user, now)) return fail('Codes für diese Reinigung nicht verfügbar', 403);
    const entry = (await loadAccessCodes(env, settings, [{ id: task.apartmentId, name: task.apartmentName }]))[task.apartmentId];
    if (!entry || !(entry.guest || entry.service)) {
      return fail(role === 'staff' ? 'Für diese Wohnung sind noch keine Codes hinterlegt – bitte Apartments Strauss fragen'
        : `Für „${task.apartmentName}“ sind keine Codes hinterlegt – bitte unter „Zugangscodes der Wohnungen“ eintragen`, 404);
    }
    try {
      await mutate(env.DB, (st) => L.logCodeAccess(st, id, user, now, cfg), now);
    } catch (e) {
      return fail(e.message, 403);
    }
    return json({ apartmentName: task.apartmentName, guest: entry.guest || '', service: entry.service || '',
      description: entry.description || '', updatedAt: entry.updatedAt || null });
  }

  // Foto anzeigen
  const photo = path.match(/^\/api\/photos\/([A-Za-z0-9-]+)$/);
  if (photo && request.method === 'GET' && photo[1].startsWith('v')) return serveVideo(photo[1]);
  if (photo && request.method === 'GET') {
    const p = await getPhoto(env.DB, photo[1]);
    if (!p) return fail('Foto nicht gefunden', 404);
    return new Response(p.data, { headers: { 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' } });
  }

  if (path === '/api/test-push' && request.method === 'POST') {
    try {
      const hu = (settings.lang || {})[user.id] === 'hu';
      await sendPush(env, user, hu
        ? { title: 'Tesztüzenet', body: `Szia ${user.name}, a push-értesítések működnek.`, kind: 'reminder' }
        : { title: 'Test-Nachricht', body: `Hallo ${user.name}, die Push-Nachrichten funktionieren.`, kind: 'reminder' });
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
    // Es gibt genau eine Reinigungsleitung
    if (kind === 'lead' && settings.leads.length) {
      return fail('Es gibt bereits eine Reinigungsleitung – zum Wechseln bitte zuerst Namen ändern oder die bisherige entfernen');
    }
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

  // Reinigung (auch aus Smoobu) auf einen anderen Tag legen
  const move = path.match(/^\/api\/tasks\/([^/]+)\/move$/);
  if (move && request.method === 'POST') {
    const date = String((await readJson()).date || '');
    return change((st) => L.moveCleaning(st, decodeURIComponent(move[1]), date, now, cfg));
  }

  // Übergabe-Notiz je Wohnung (steht bei jeder Reinigung dieser Wohnung; bleibt beim Zurücksetzen erhalten)
  if (path === '/api/apt-notes' && request.method === 'POST') {
    const body = await readJson();
    const id = String(body.apartmentId || '');
    if (!id) return fail('Wohnung fehlt');
    const text = String(body.text || '').trim().slice(0, 1000);
    settings.aptNotes = { ...(settings.aptNotes || {}) };
    if (text) settings.aptNotes[id] = { text, updatedAt: new Date(now).toISOString() };
    else delete settings.aptNotes[id];
    await saveSettings(env.DB, settings);
    return view((await loadState(env.DB)).state);
  }

  // Statistik rückwirkend berechnen: Buchungen der letzten Monate aus Smoobu mit Eintragungs-/Stornodatum
  if (path === '/api/stats/backfill' && request.method === 'POST') {
    const creds = smoobuCreds(env);
    if (!creds.key) return fail('Smoobu ist nicht verbunden');
    const { date: today } = L.localParts(now, cfg.timezone);
    const back = Math.min(365, Math.max(7, Number((await readJson()).days) || 90));
    let raw;
    try {
      raw = await fetchBookings(creds, L.addDays(today, -back - 60), L.addDays(today, STAT_DAYS + 60));
    } catch (e) {
      return fail('Smoobu: ' + e.message, 502);
    }
    const { state } = await loadState(env.DB);
    const ids = apartmentList(state).map((a) => a.id);
    const index = L.nightIndex(L.smoobuEntries(raw));
    const stats = await loadStats(env.DB);
    let added = 0;
    for (let i = back; i >= 1; i--) {
      const d = L.addDays(today, -i);
      // tatsächliche Belegung der Nacht: immer aus dem heutigen (endgültigen) Stand
      const night = L.nightOccupancy(index, ids, d);
      const actual = { pct: night.pct, bookedPct: night.bookedPct, blockedPct: night.blockedPct };
      if (stats.days[d] && stats.days[d].source === 'live') { stats.days[d].actual = actual; continue; } // Vorausblick: echte Tageswerte haben Vorrang
      const o = L.occupancy(index, ids, d, STAT_DAYS, d);
      stats.days[d] = { pct: o.pct, bookedPct: o.bookedPct, blockedPct: o.blockedPct, apartments: ids.length, source: 'rückwirkend', actual };
      added++;
    }
    const withCreated = raw.filter((r) => r && (r['created-at'] || r.createdAt || r.created_at)).length;
    stats.backfill = { at: new Date(now).toISOString(), days: back, bookings: raw.length, withCreated, apartments: ids.length };
    await saveStats(env.DB, stats);
    return view((await loadState(env.DB)).state, { backfilled: added });
  }

  // Größenkategorie einer Wohnung selbst festlegen (leer = automatisch aus Smoobu)
  if (path === '/api/apt-category' && request.method === 'POST') {
    const body = await readJson();
    const id = String(body.apartmentId || '');
    if (!id) return fail('Wohnung fehlt');
    const category = String(body.category || '').trim().slice(0, 40);
    settings.aptCategory = { ...(settings.aptCategory || {}) };
    if (category) settings.aptCategory[id] = category; else delete settings.aptCategory[id];
    await saveSettings(env.DB, settings);
    return view((await loadState(env.DB)).state);
  }

  // Gesperrte Anmeldungen: freischalten → wieder 3 Versuche
  if (path === '/api/login-locks/release' && request.method === 'POST') {
    const target = String((await readJson()).ip || '');
    if (!target) return fail('Adresse fehlt');
    await releaseCodeLock(env.DB, target);
    return view((await loadState(env.DB)).state);
  }

  // Zugangscodes verwalten (verschlüsselt in der Datenbank, nie im Programmcode)
  if (path === '/api/access-codes' && request.method === 'GET') {
    const { state } = await loadState(env.DB);
    const apartments = apartmentList(state);
    return json({ apartments, codes: await loadAccessCodes(env, settings, apartments) });
  }
  if (path === '/api/access-codes' && request.method === 'POST') {
    const body = await readJson();
    const { state } = await loadState(env.DB);
    const apartments = apartmentList(state);
    const byId = new Map(apartments.map((a) => [a.id, a]));
    const saved = await loadSavedCodes(env, settings);
    const effective = await loadAccessCodes(env, settings, apartments);
    const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
    const same = (a, b) => !!a && !!b && a.guest === b.guest && a.service === b.service && a.description === b.description;
    for (const e of Array.isArray(body.entries) ? body.entries : []) {
      const id = String(e.apartmentId || '');
      if (!byId.has(id)) continue;
      const next = { guest: clean(e.guest, 40), service: clean(e.service, 40), description: clean(e.description, 200) };
      if (same(next, effective[id] || { guest: '', service: '', description: '' })) continue;
      const builtin = builtinFor(byId.get(id).name);
      if (builtin && same(next, builtin)) delete saved[id]; // wieder der fest hinterlegte Stand
      else if (!next.guest && !next.service && !next.description && !builtin) delete saved[id];
      else saved[id] = { ...next, updatedAt: new Date(now).toISOString() };
    }
    settings.accessCodes = await encryptCode(env, JSON.stringify(saved));
    await saveSettings(env.DB, settings);
    return json({ apartments, codes: await loadAccessCodes(env, settings, apartments) });
  }

  // Einkaufsliste: aufgefüllt (ein Artikel in einer Wohnung / alles einer Wohnung / ein Artikel überall)
  if (path === '/api/supplies/resolve' && request.method === 'POST') {
    const body = await readJson();
    return change((st) => L.resolveSupplies(st, body.apartmentId || null, body.itemId || null));
  }

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
