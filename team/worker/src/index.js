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
  loadSettings, saveSettings, upsertPace, loadPace, countPushQueue, recordDelivery, lockedFor, recordFailure, clearAttempts, loadStats, saveStats,
  codeLockState, codeFailure, codeSuccess, listCodeLocks, releaseCodeLock,
  inquiryTodo, saveInquiries, inquiryReport, inquirySample, inquiryExamples, resetInquiries,
  missingFingerprints, setFingerprints, automatedFingerprints, messagesOf, pastAnswers,
  getThread, saveThread, listThreads, countThreads, dueThreads, pollTimes, markPolled,
  getInvoice, invoiceByToken, saveInvoice, deleteInvoiceDraft, listInvoices, dueInvoices, takeInvoiceNumber, invoiceCounters, setInvoiceCounter,
  saveDoc, docByToken, docsOf,
} from './store.js';
import { cleanMessage, classify, snippet, phaseOf, inboundOf, mask, maskStrict, categoryOrder, labelOf } from './inquiries.js';
import { fetchBookings, fetchBooking, fetchApartments, fetchApartmentDetails, fetchMessages, sendMessageToGuest, fetchGuest, diagnose } from './smoobu.js';
import { needsReply, language, topicsOf, templateDraft, aiPrompt, planFacts, fingerprint, invoiceTotals, invoiceNumber, invoiceHtml, wgbHtml, TOPIC_LABELS } from './messages.js';
import { deliver, sendPush, flushPushQueue } from './notify.js';
import BUILTIN_CODES from './access-codes.js';
import GUIDES from './guides.js';
import DEFAULT_CRAFTSMEN from './craftsmen.js';
import ISSUERS from './issuers.js';

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
  // Vertretung: Mitarbeiterin, der der Admin die Rechte der Reinigungsleitung gegeben hat (bestätigen, einteilen, Leitungs-Nachrichten)
  const deputies = settings.staff.filter((s) => s.deputy).map((s) => ({ ...s, deputy: true }));
  return { cfg: { ...L.DEFAULT_CONFIG, ...config, leads: [...settings.leads, ...deputies], staff: settings.staff, langs: settings.lang || {} }, settings };
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

  // zuerst früher abgelehnte Nachrichten nachsenden (ntfy 429), dann die neuen
  const flushed = await flushPushQueue(env, cfg).catch((e) => { console.error('Warteschlange', e.message); return { sent: 0, left: 0 }; });
  const delivery = await deliver(env, cfg, result.notifications);
  await recordDelivery(env.DB, { ...(flushed.statuses || {}), ...(delivery.statuses || {}) }, now).catch((e) => console.error('Zustellstatus', e.message));
  // Versandergebnis merken, damit Fehler in der Admin-Ansicht sichtbar sind
  if (delivery.sent || delivery.failed || flushed.sent) {
    await mutate(env.DB, (state) => ({ state: { ...state, pushReport: {
      at: new Date(now).toISOString(), sent: delivery.sent + flushed.sent, failed: delivery.failed, errors: delivery.errors.slice(0, 5),
      resent: flushed.sent,
    } }, notifications: [] }), now).catch((e) => console.error(e));
  }
  await pruneOldPhotos(env.DB, now - cfg.keepPhotosDays * 86400000).catch((e) => console.error(e));
  await geocodeMissing(env, cfg, result.state, now).catch((e) => console.error('Geocoding', e.message));
  await trackOccupancy(env, cfg, result.state, now).catch((e) => console.error('Statistik', e.message));
  await updatePaceDaily(env, cfg, bookings, now).catch((e) => console.error('Pace', e.message));
  await paceWarnWeekly(env, cfg, now).catch((e) => console.error('Pace-Warnung', e.message));
  await loadApartmentInfo(env, result.state, now).catch((e) => console.error('Wohnungsdetails', e.message));
  return { bookings: bookings ? bookings.length : 0, notifications: result.notifications.length, ...delivery, syncError };
}

/** Senden und das Ergebnis (versendet / wartet / fehlgeschlagen) im Protokoll „Verschickte Nachrichten“ vermerken */
async function deliverLogged(env, cfg, notifications) {
  const d = await deliver(env, cfg, notifications);
  await recordDelivery(env.DB, d.statuses).catch((e) => console.error('Zustellstatus', e.message));
  return d;
}

/** Buchungstempo: einmal am Tag die beim Abgleich geholten Buchungen (inkl. Stornos) in den Pace-Speicher übernehmen */
async function updatePaceDaily(env, cfg, bookings, now) {
  if (!bookings || !bookings.length) return;
  const { date: today } = L.localParts(now, cfg.timezone);
  const stats = await loadStats(env.DB);
  if (!stats.pace || !stats.pace.full || stats.pace.day === today) return; // erst nach dem ersten vollständigen Laden
  await upsertPace(env.DB, L.paceEntries(bookings));
  stats.pace.day = today;
  await refreshStarts(env, (await loadState(env.DB)).state, stats);
  await saveStats(env.DB, stats);
}

/** Frühwarnung Buchungstempo prüfen (Stand heute vs. gleicher Stand im Vorjahr) */
async function paceCheck(env, cfg, now) {
  const { date: today } = L.localParts(now, cfg.timezone);
  const { state } = await loadState(env.DB);
  const entries = await loadPace(env.DB);
  if (!entries.length) return null;
  const report = L.paceReport(entries, statsApartments(state).counted.map((a) => a.id), today, { years: 1, months: 4 });
  return L.paceWarnings(report, (cfg.paceWarn || {}).points || 5, 3);
}
const paceWarnText = (w) => `• ${w.label}: ${String(w.pct).replace('.', ',')} % (Vorjahr ${String(w.prev).replace('.', ',')} %, ${String(w.diff).replace('.', ',')} Pkt.)`;
/** Einmal pro Woche (Standard: montags ab 9 Uhr) – Push an Admin nur, wenn etwas auffällt */
async function paceWarnWeekly(env, cfg, now) {
  const pw = cfg.paceWarn || {};
  const { date: today, time } = L.localParts(now, cfg.timezone);
  if (new Date(today + 'T12:00:00Z').getUTCDay() !== (pw.weekday ?? 1) || time < (pw.time || '09:00')) return;
  const stats = await loadStats(env.DB);
  if (!stats.pace || !stats.pace.full || (stats.pace.warn && stats.pace.warn.day === today)) return;
  const items = await paceCheck(env, cfg, now);
  if (!items) return;
  stats.pace.warn = { day: today, at: new Date(now).toISOString(), items };
  await saveStats(env.DB, stats);
  if (!items.length) return;
  const result = await mutate(env.DB, (st) => ({ state: st, notifications: [{ to: cfg.owner.id, kind: 'pace',
    title: `Buchungstempo: ${items.length} ${items.length === 1 ? 'Zeitraum' : 'Zeiträume'} hinter Vorjahr`,
    body: `Gleicher Buchungsstand wie heute vor 1 Jahr, inkl. Blockierungen:\n${items.map(paceWarnText).join('\n')}` }] }), now);
  await deliverLogged(env, cfg, result.notifications);
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
    if (!groups.has(cat)) groups.set(cat, { category: cat, apartments: [], booked: 0, blocked: 0, capacity: 0 });
    const g = groups.get(cat);
    g.apartments.push(a.id);
    g.booked += a.booked;
    g.blocked += a.blocked;
    g.capacity += a.nights != null ? a.nights : days; // nur Nächte, in denen die Wohnung schon in Vermietung ist
  }
  const pct = (x, n) => (n ? Math.round((x / n) * 1000) / 10 : 0);
  return [...groups.values()].map((g) => ({ ...g, count: g.apartments.length,
    bookedPct: pct(g.booked, g.capacity), pct: pct(g.booked + g.blocked, g.capacity) }))
    .sort((a, b) => b.bookedPct - a.bookedPct);
}

// ---- Statistik: Auslastung der nächsten 30 Nächte (Buchungen + Sperrzeiten) ----
async function statsView(env, cfg, state, now) {
  const stats = await loadStats(env.DB);
  const settings = await loadSettings(env.DB);
  const starts = startsOf(stats);
  const current = currentOccupancy(state, cfg, now, starts);
  const names = Object.fromEntries(apartmentList(state).map((a) => [a.id, a.name]));
  const allDays = Object.entries(stats.days).sort((a, b) => a[0].localeCompare(b[0]));
  // Tageswerte der letzten ~15 Monate (für Verlauf inkl. Vorjahreslinie), ältere nur als Monatswerte
  const history = allDays.slice(-460).map(([date, v]) => ({ date, ...v }));
  const monthMap = new Map();
  for (const [date, v] of allDays) {
    if (!v.actual) continue;
    const m = date.slice(0, 7);
    const x = monthMap.get(m) || { month: m, n: 0, pct: 0, bookedPct: 0 };
    x.n++; x.pct += v.actual.pct; x.bookedPct += v.actual.bookedPct;
    monthMap.set(m, x);
  }
  const months = [...monthMap.values()].map((x) => ({ month: x.month, nights: x.n, pct: Math.round((x.pct / x.n) * 10) / 10, bookedPct: Math.round((x.bookedPct / x.n) * 10) / 10 }));
  const perApartment = Object.entries(current.perApartment).map(([id, v]) => {
    const i = (settings.aptInfo || {})[id] || {};
    return { id, name: names[id] || id, ...v, bookedPct: v.nights ? Math.round((v.booked / v.nights) * 1000) / 10 : 0,
      category: sizeCategory(settings, id, names[id] || ''), ownCategory: ((settings.aptCategory || {})[id] || ''), bedrooms: i.bedrooms ?? null, maxOccupancy: i.maxOccupancy ?? null };
  }).sort((a, b) => L.compareApartments(a.name, b.name));
  // Tatsächliche Belegung: Durchschnitt der letzten 30 Nächte (soweit bekannt)
  const today = L.localParts(now, cfg.timezone).date;
  const last30 = history.filter((h) => h.actual && h.date < today && h.date >= L.addDays(today, -30));
  const avg = (k) => (last30.length ? Math.round((last30.reduce((s, h) => s + h.actual[k], 0) / last30.length) * 10) / 10 : null);
  // gleiche 30 Nächte im Vorjahr
  const lyFrom = L.yearsBack(L.addDays(today, -30), 1), lyTo = L.yearsBack(today, 1);
  const ly30 = allDays.filter(([d, v]) => v.actual && d >= lyFrom && d < lyTo).map(([, v]) => v.actual.pct);
  const prevYear30 = ly30.length >= 20 ? Math.round((ly30.reduce((s, x) => s + x, 0) / ly30.length) * 10) / 10 : null;
  return { days: STAT_DAYS, current: { ...current, perApartment }, groups: sizeGroups(settings, perApartment, STAT_DAYS),
    actual30: last30.length ? { pct: avg('pct'), bookedPct: avg('bookedPct'), blockedPct: avg('blockedPct'), nights: last30.length, prevYear: prevYear30 } : null,
    months, starts: starts || null,
    apartments: perApartment.length, excluded: statsApartments(state).excluded.map((a) => a.name), history, backfill: stats.backfill || null };
}

const STAT_DAYS = 30;
/**
 * Wohnungen, die in der Statistik zählen: die nummerierten Einheiten aus config.sizeByNumber (#EINS … #DREIZEHN).
 * Weitere Einheiten in Smoobu (z. B. alte oder übergeordnete) würden die Quote sonst verfälschen.
 */
function statsApartments(state) {
  const all = apartmentList(state);
  const numbered = all.filter((a) => (config.sizeByNumber || {})[L.apartmentNumber(a.name)]);
  const counted = numbered.length ? numbered : all;
  return { counted, excluded: all.filter((a) => !counted.includes(a)) };
}
function currentOccupancy(state, cfg, now, starts) {
  const today = L.localParts(now, cfg.timezone).date;
  const ids = statsApartments(state).counted.map((a) => a.id);
  return L.occupancy(L.nightIndex(L.reservationEntries(state)), ids, today, STAT_DAYS, undefined, starts || undefined);
}
/** In Vermietung seit (erste echte Buchung je Wohnung) – beim Laden der Buchungen berechnet und gemerkt */
const startsOf = (stats) => (stats.pace && stats.pace.starts && Object.keys(stats.pace.starts).length ? stats.pace.starts : null);
async function refreshStarts(env, state, stats) {
  const ids = statsApartments(state).counted.map((a) => a.id);
  stats.pace = { ...(stats.pace || {}), starts: L.unitStarts(await loadPace(env.DB), ids) };
}
/** Wert für heute festhalten (jeder Lauf überschreibt den heutigen Wert – am Tagesende steht der letzte Stand) */
async function trackOccupancy(env, cfg, state, now) {
  if (!state.initialized || !apartmentList(state).length) return;
  const today = L.localParts(now, cfg.timezone).date;
  const stats = await loadStats(env.DB);
  const starts = startsOf(stats);
  const o = currentOccupancy(state, cfg, now, starts);
  const ids = statsApartments(state).counted.map((a) => a.id);
  const night = L.nightOccupancy(L.nightIndex(L.reservationEntries(state)), ids, today, starts || undefined);
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

// ---------------------------------------------------------------------------
// Anfahrts-Anleitungen & Handwerker-Links (nur Admin legt an; Handwerker sehen nur ihre freigegebene Wohnung)
// ---------------------------------------------------------------------------
const GUIDE_DAYS = [1, 3, 7, 14, 30];
const guideNo = (name) => L.apartmentNumber(name);
/** Wo die SERVICE-Schlüsselbox hängt (vom Admin je Wohnung änderbar) */
export function serviceBoxText(no, settings) {
  const own = ((settings && settings.guideNotes) || {})[no];
  if (own) return own;
  if ([2, 4, 7].includes(no)) return 'Am Berliner Platz gibt es zwei SERVICE-Schlüsselboxen für alle 6 Wohnungen (innen hinter der Glastür am Eingang „STORAGE FRIENDS“ hinter Aldi). Für diese Wohnung die SERVICE-Box OBEN RECHTS verwenden (obere Reihe, ganz rechts, Aufschrift „SERVICE“).';
  if ([8, 10, 12].includes(no)) return 'Am Berliner Platz gibt es zwei SERVICE-Schlüsselboxen für alle 6 Wohnungen (innen hinter der Glastür am Eingang „STORAGE FRIENDS“ hinter Aldi). Für diese Wohnung die SERVICE-Box UNTEN RECHTS verwenden (untere Reihe, ganz rechts, Aufschrift „SERVICE“).';
  return 'Die SERVICE-Schlüsselbox hängt direkt hinter der Gäste-Schlüsselbox.';
}
const SERVICE_HOWTO = 'Mit dem SERVICE-Code (oben) öffnen, Schlüssel entnehmen und die Box wieder verschließen. Nach der Arbeit den Schlüssel wieder in die SERVICE-Box legen und verschließen.';
/** Anleitung für Handwerker: Schritte mit SERVICE-Box statt Gäste-Box */
function serviceSteps(guide, no, settings) {
  return (guide ? guide.service : ['{SERVICE}']).map((text) => text === '{SERVICE}'
    ? { text: `${serviceBoxText(no, settings)} ${SERVICE_HOWTO}`, service: true } : { text });
}
function guideLinkState(link, now) {
  if (link.revoked) return 'gesperrt';
  return Date.parse(link.expiresAt) <= now ? 'abgelaufen' : 'aktiv';
}
/** Handwerker-Verzeichnis (Startliste aus craftsmen.js, danach in den Einstellungen gespeichert) */
/** Handwerker: wann zuletzt einen Link geöffnet, wie viele Aufträge offen */
function craftsmanActivity(c, links, now) {
  const mine = links.filter((l) => l.craftsmanId === c.id);
  const last = mine.map((l) => l.lastViewAt).filter(Boolean).sort().pop() || null;
  return { ...c, lastViewAt: last, links: mine.length, openJobs: mine.filter((l) => l.job && !l.job.doneAt && guideLinkState(l, now) === 'aktiv').length };
}
const craftsmenOf = (settings) => (Array.isArray(settings.craftsmen) ? settings.craftsmen : DEFAULT_CRAFTSMEN);
const guideJobView = (l, now) => (l.job ? { linkId: l.id, reportId: l.job.reportId, taskId: l.job.taskId, craftsmanId: l.craftsmanId || null,
  name: l.name || '', createdAt: l.createdAt, doneAt: l.job.doneAt || null, doneNote: l.job.doneNote || '', state: guideLinkState(l, now) } : null);
const guideLinkView = (l, now) => ({ id: l.id, apartmentId: l.apartmentId, apartmentName: l.apartmentName, name: l.name || '',
  createdAt: l.createdAt, expiresAt: l.expiresAt, views: l.views || 0, lastViewAt: l.lastViewAt || null, state: guideLinkState(l, now),
  craftsmanId: l.craftsmanId || null, job: l.job ? { reportId: l.job.reportId, doneAt: l.job.doneAt || null } : null });

/** Telefonnummer (für WhatsApp-Einladung): nur Ziffern, +, Leerzeichen */
const cleanPhone = (v) => String(v || '').replace(/[^\d+ ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 25);
const person = (p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, ...(p.deputy ? { deputy: true, deputySince: p.deputySince || null } : {}) });
/** Team-Liste; Codes sieht der Admin für alle, die Leitung für ihre Mitarbeiterinnen. */
/** Push eingerichtet? (Person hat „Test-Nachricht angekommen“ bestätigt) – nur für Admin/Leitung sichtbar */
const withPush = (list, settings, show) => (show ? list.map((p) => ({ ...p, pushOkAt: (settings.pushOk || {})[p.id] || null, lastSeenAt: (settings.lastSeen || {})[p.id] || null })) : list);
async function teamFor(env, list, withCodes) {
  return Promise.all(list.map(async (p) => ({ ...person(p), ...(withCodes ? { code: await decryptCode(env, p.codeEnc), phone: p.phone || '' } : {}) })));
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

/** Öffentliche Angaben (Link zur Website, Adresse) je Wohnungs-ID – über die Nummer im Namen oder die Smoobu-ID */
export function apartmentDetails(cfg, state) {
  const all = cfg.apartmentDetails || {};
  const names = {};
  for (const t of Object.values(state.tasks || {})) names[t.apartmentId] = t.apartmentName;
  for (const a of state.apartments || []) names[a.id] = a.name;
  const out = {};
  for (const [id, name] of Object.entries(names)) {
    const d = Object.values(all).find((x) => x.smoobuId === String(id)) || all[L.apartmentNumber(name)];
    if (d) out[id] = { name: d.name, address: d.address, url: d.url };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Nachrichten an Gäste (Reiter „Nachrichten“): abrufen, Entwurf, Freigabe, Senden über Smoobu
// ---------------------------------------------------------------------------
/** Smoobu-Nachrichten → gespeicherte Form (Thema, Zeitpunkt, Fingerabdruck) */
function buildMsgs(raw, b) {
  return (raw || []).map((m, i) => {
    const text = cleanMessage(m.message || m.htmlMessage || m.text || m.body || '');
    const created = String(m.createdAt || m.created_at || m.date || m.sentAt || '').replace(' ', 'T');
    const inbound = inboundOf(m);
    const phase = phaseOf(created, b.arrival, b.departure);
    const found = inbound ? classify(text) : [];
    const cats = inbound ? (found.length ? found : ['other']).map((cat) => ({ cat, snippet: snippet(text, cat) })) : [];
    return { id: String(m.id != null ? m.id : `${b.id}-${i}`), created, inbound, phase, text, cats, fp: inbound === false ? fingerprint(text) : null };
  }).filter((m) => m.text);
}

const localIso = (now, cfg) => { const p = L.localParts(now, cfg.timezone); return `${p.date}T${p.time}`; };
const replyDefaults = (cfg, settings) => ({ checkin: '15:00', checkout: cfg.checkoutTime || '10:00', phone: ISSUERS.phone || '', ...(settings.replies || {}) });

/** Buchungen, deren Nachrichten regelmäßig abgerufen werden: Anreise in ≤ 14 Tagen bis 7 Tage nach Abreise */
function inboxBookings(state, today) {
  return Object.values(state.reservations || {}).filter((r) => r.arrival <= L.addDays(today, 14) && r.departure >= L.addDays(today, -7));
}
function aptNameOf(state, id) {
  const t = Object.values(state.tasks || {}).find((x) => x.apartmentId === String(id));
  const a = (state.apartments || []).find((x) => String(x.id) === String(id));
  return (a && a.name) || (t && t.apartmentName) || `Wohnung ${id}`;
}

/**
 * Vorgang einer Buchung neu bewerten: offene Gastnachrichten seit unserer letzten echten Antwort?
 * Liefert eine Push-Nachricht für den Admin, wenn etwas Neues kam.
 */
async function refreshThread(env, cfg, settings, state, res, now, auto) {
  const msgs = await messagesOf(env.DB, res.id);
  let t = await getThread(env.DB, res.id);
  const isReply = (m) => m.inbound === 0 && (String(m.id).startsWith('app-') || !auto.has(m.fp || ''));
  const lastReply = [t && t.lastReply, ...msgs.filter(isReply).map((m) => m.created)].filter(Boolean).sort().pop() || '';
  const since = [lastReply, t && t.doneMark].filter(Boolean).sort().pop() || '';
  const recent = localIso(now - 7 * 86400000, cfg);
  const open = msgs.filter((m) => m.inbound === 1 && m.created > since && m.created >= recent && needsReply(m.text));
  if (!open.length) {
    if (t && t.status === 'offen') { t.status = 'erledigt'; t.doneBy = lastReply > (t.lastIn || '') ? 'beantwortet' : 'keine Antwort nötig'; t.lastReply = lastReply; await saveThread(env.DB, t, now); }
    return null;
  }
  const newest = open[open.length - 1].created;
  if (t && t.lastIn === newest && t.status !== 'gesendet') return null; // nichts Neues
  const today = L.localParts(now, cfg.timezone).date;
  const phase = today < res.arrival ? 'vorher' : today <= res.departure ? 'während' : 'nachher';
  const topics = [...new Set(open.flatMap((m) => topicsOf(m.text)))];
  const lang = language(open.map((m) => m.text));
  let guestLink = t ? t.guestLink : undefined;
  if (guestLink === undefined && smoobuCreds(env).key) {
    const raw = await fetchBooking(smoobuCreds(env), res.id).catch(() => null);
    guestLink = (raw && (raw['guest-app-url'] || raw.guestAppUrl)) || '';
  }
  const plan = planFacts({ apartmentId: String(res.apartmentId), arrival: res.arrival, departure: res.departure, bookingId: String(res.id),
    tasks: Object.values(state.tasks || {}), reservations: Object.values(state.reservations || {}) });
  const s = replyDefaults(cfg, settings);
  const facts = factsFor(res.apartmentId, aptNameOf(state, res.apartmentId));
  const draftTpl = templateDraft({ lang, guest: res.guest, topics, text: open.map((m) => m.text).join('\n'), phase, s, plan, guestLink,
    arrival: res.arrival, departure: res.departure, facts });
  const notifiedIn = t && t.notifiedIn;
  t = { ...(t || {}), booking: String(res.id), apt: String(res.apartmentId), aptName: aptNameOf(state, res.apartmentId), guest: res.guest || '',
    arrival: res.arrival, departure: res.departure, channel: res.channel || '', status: 'offen', sendAt: null, lastIn: newest, lastReply,
    topics, lang, phase, plan, guestLink, draftTpl, draft: draftTpl, draftAi: null, draftBy: 'vorlage', edited: false, aiWanted: !!env.AI,
    openIds: open.map((m) => m.id), notifiedIn: newest, error: null };
  await saveThread(env.DB, t, now);
  if (notifiedIn === newest) return null;
  const urgent = phase === 'während' && topics.some((x) => x === 'problem' || x === 'access');
  const last = open[open.length - 1].text.replace(/\s+/g, ' ');
  return { to: cfg.owner.id, kind: urgent ? 'guesturgent' : 'guestmsg', title: `${urgent ? 'Dringend: ' : ''}Gastnachricht ${t.aptName}`,
    body: `${res.guest || 'Gast'}: ${last.slice(0, 160)}${last.length > 160 ? ' …' : ''}\nThema: ${topics.map((x) => TOPIC_LABELS[x] || x).join(', ') || 'Sonstiges'} · Entwurf liegt bereit` };
}

/** Nachrichten einer Buchung aus Smoobu holen, speichern und den Vorgang bewerten */
async function pollBooking(env, cfg, settings, state, res, now, auto) {
  const raw = await fetchMessages(smoobuCreds(env), res.id);
  const msgs = buildMsgs(raw, { id: res.id, arrival: res.arrival, departure: res.departure });
  await saveInquiries(env.DB, String(res.id), String(res.apartmentId), msgs, now);
  return refreshThread(env, cfg, settings, state, res, now, auto);
}

/** KI-Entwurf (Workers AI) mit Wissen, Verlauf, Vorlage und früheren echten Antworten */
async function aiDraftFor(env, cfg, settings, t, auto) {
  const msgs = await messagesOf(env.DB, t.booking);
  const examples = [];
  for (const cat of (t.topics || []).filter((x) => x !== 'wgb').slice(0, 2)) {
    const list = (await pastAnswers(env.DB, cat, 30)).filter((x) => !auto.has(x.fp || '') && x.a.length >= 15 && x.a.length <= 700);
    for (const x of list.slice(0, 2)) examples.push({ q: mask(x.q).slice(0, 300), a: mask(x.a).slice(0, 500) });
  }
  const details = apartmentDetails(cfg, { tasks: {}, apartments: [{ id: t.apt, name: t.aptName }] })[t.apt] || {};
  const prompt = aiPrompt({ lang: t.lang, guest: t.guest, apartmentName: t.aptName, address: details.address || '', arrival: t.arrival, departure: t.departure,
    phase: t.phase, plan: t.plan, guestLink: t.guestLink, s: replyDefaults(cfg, settings), template: t.draftTpl, examples, facts: factsFor(t.apt, t.aptName),
    history: msgs.map((m) => ({ inbound: m.inbound === 1, created: m.created, text: mask(m.text) })) });
  const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages: [{ role: 'user', content: prompt }], max_tokens: 700, temperature: 0.3 });
  return String((r && (r.response || r.result)) || '').trim();
}

/** Nachricht über Smoobu senden und im Verlauf vermerken */
async function sendThread(env, cfg, t, text, now) {
  await sendMessageToGuest(smoobuCreds(env), t.booking, 'Apartments Strauss', text);
  const at = localIso(now, cfg);
  await saveInquiries(env.DB, t.booking, t.apt, [{ id: `app-${now}`, created: at, inbound: false, phase: t.phase, text, cats: [], fp: fingerprint(text) }], now);
  Object.assign(t, { status: 'gesendet', sentAt: now, sentText: text, lastReply: at, sendAt: null, error: null });
  await saveThread(env.DB, t, now);
}

/** Zeitgesteuert (alle 5 Min.): einige Buchungen abrufen, geplante Nachrichten/Rechnungen senden, KI-Entwürfe */
export async function runInbox(env, now = Date.now(), cfg) {
  if (!smoobuCreds(env).key) return { skipped: true };
  const loaded = cfg ? { cfg, settings: await loadSettings(env.DB) } : await loadConfig(env);
  cfg = loaded.cfg;
  const settings = loaded.settings;
  const { state } = await loadState(env.DB);
  const today = L.localParts(now, cfg.timezone).date;
  const out = { polled: 0, sent: 0, invoices: 0, ai: 0, errors: [] };
  const notes = [];
  const auto = await automatedFingerprints(env.DB);
  // 1) Abrufen: am längsten nicht abgerufene zuerst; laufende Aufenthalte und Anreisen in ≤ 2 Tagen doppelt so oft
  const list = inboxBookings(state, today);
  const times = await pollTimes(env.DB, list.map((r) => String(r.id)));
  const hot = (r) => r.arrival <= L.addDays(today, 2) && r.departure >= today;
  const due = list.map((r) => ({ r, key: (times[r.id] || 0) - (hot(r) ? 15 * 60000 : 0) })).sort((a, b) => a.key - b.key).slice(0, 4).map((x) => x.r);
  for (const r of due) {
    try { const n = await pollBooking(env, cfg, settings, state, r, now, auto); if (n) notes.push(n); out.polled++; } catch (e) { out.errors.push(e.message); }
  }
  await markPolled(env.DB, due.map((r) => r.id), now);
  // 2) Geplante Antworten senden
  for (const t of await dueThreads(env.DB, now, 3)) {
    try { await sendThread(env, cfg, t, t.draft, now); out.sent++; } catch (e) {
      t.status = 'offen'; t.error = 'Senden fehlgeschlagen: ' + e.message; t.sendAt = null; await saveThread(env.DB, t, now); out.errors.push(e.message);
      notes.push({ to: cfg.owner.id, kind: 'guestmsg', title: `Senden fehlgeschlagen: ${t.aptName}`, body: e.message });
    }
  }
  // 3) Geplante Rechnungen senden
  for (const inv of await dueInvoices(env.DB, now, 2)) {
    try { await sendInvoiceMessage(env, cfg, inv, now); out.invoices++; } catch (e) { inv.sendAt = null; inv.error = e.message; await saveInvoice(env.DB, inv); out.errors.push(e.message); }
  }
  // 4) KI-Entwürfe (höchstens 2 je Lauf)
  if (env.AI) {
    for (const t of (await listThreads(env.DB, ['offen'], 20)).filter((x) => x.aiWanted).slice(0, 2)) {
      try {
        const text = await aiDraftFor(env, cfg, settings, t, auto);
        const cur = await getThread(env.DB, t.booking);
        if (!cur || cur.lastIn !== t.lastIn) continue;
        cur.aiWanted = false;
        if (text) { cur.draftAi = text; if (!cur.edited) { cur.draft = text; cur.draftBy = 'ki'; } }
        await saveThread(env.DB, cur, now); out.ai++;
      } catch (e) { t.aiWanted = false; t.aiError = e.message; await saveThread(env.DB, t, now); out.errors.push('KI: ' + e.message); }
    }
  }
  if (notes.length) await deliverLogged(env, cfg, notes);
  return out;
}

// ---- Rechnungen ----
/** Rechnungs-Einstellungen: gespeicherte Werte, sonst Voreinstellung (Aussteller und Zuordnung aus issuers.js, Präfix = Wohnungsname) */
function invoiceSettings(settings) {
  const own = settings.invoice || {};
  const defApts = {};
  for (const [num, d] of Object.entries(config.apartmentDetails || {})) {
    const word = (String(d.name || '').match(/#\s*([A-ZÄÖÜ]+)/) || [])[1];
    if (d.smoobuId) defApts[d.smoobuId] = { issuer: (ISSUERS.byNumber || {})[num] || '', prefix: word ? word + '-' : '' };
  }
  return { format: own.format || '{prefix}{jahr}-{nr3}', issuers: own.issuers && own.issuers.length ? own.issuers : (ISSUERS.issuers || []),
    apts: { ...defApts, ...(own.apts || {}) } };
}
/** Ausstattung einer Wohnung (Betten, Babyausstattung) über Smoobu-ID oder Nummer im Namen */
function factsFor(aptId, aptName) {
  const all = config.apartmentDetails || {};
  const num = Object.keys(all).find((n) => all[n].smoobuId === String(aptId)) || L.apartmentNumber(aptName);
  return (config.apartmentFacts || {})[num] || null;
}
const docUrl = (cfg, request, token) => `${request ? new URL(request.url).origin : cfg.appUrl}/dok/${token}`;
function guestAddress(g) {
  if (!g) return '';
  const a = g.address || g;
  const street = a.street || a.addressStreet || '';
  const city = [a.postalCode || a.zip || a.postcode || '', a.city || a.location || ''].filter(Boolean).join(' ');
  const country = a.country && !/^(de|deutschland|germany)$/i.test(a.country) ? a.country : '';
  return [street, city, country].filter(Boolean).join('\n');
}
/** Rechnungsentwurf aus der Smoobu-Buchung (Firma aus den Nachrichten per KI, sonst Gast) */
async function invoiceDraft(env, cfg, settings, state, booking, now) {
  const creds = smoobuCreds(env);
  const raw = await fetchBooking(creds, booking);
  if (!raw) throw new Error('Buchung in Smoobu nicht gefunden');
  const apt = String((raw.apartment && raw.apartment.id) || raw.apartmentId || '');
  const inv = invoiceSettings(settings);
  const map = inv.apts[apt] || {};
  const issuer = inv.issuers.find((x) => x.id === map.issuer) || null;
  const guestName = raw['guest-name'] || [raw.firstname, raw.lastname].filter(Boolean).join(' ');
  let address = '';
  if (raw.guestId) address = guestAddress(await fetchGuest(creds, raw.guestId).catch(() => null));
  let recipient = [guestName, address].filter(Boolean).join('\n');
  if (env.AI) {
    const msgs = (await messagesOf(env.DB, booking)).filter((m) => m.inbound === 1 && /rechnung|invoice|firma|company|gmbh|ag\b|ltd|ust|vat|adresse|address/i.test(m.text));
    if (msgs.length) {
      const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { max_tokens: 200, temperature: 0, messages: [{ role: 'user', content:
        `Aus diesen Gastnachrichten die gewünschte Rechnungsadresse herauslesen (Firma/Name, ggf. z. Hd., Straße, PLZ Ort, Land falls nicht Deutschland, USt-IdNr. falls genannt). Antworte NUR mit den Adresszeilen, eine je Zeile, ohne weiteren Text. Gibt es keine Rechnungsadresse, antworte genau: KEINE\n\n${msgs.slice(-5).map((m) => m.text.slice(0, 800)).join('\n---\n')}` }] }).catch(() => null);
      const text = String((r && r.response) || '').trim();
      if (text && !/^KEINE/i.test(text) && text.length < 400) recipient = text;
    }
  }
  const nights = Math.round((Date.parse(raw.departure) - Date.parse(raw.arrival)) / 86400000);
  const aptName = (raw.apartment && raw.apartment.name) || aptNameOf(state, apt);
  const channel = (raw.channel && raw.channel.name) || '';
  const paid = /^yes|true|1$/i.test(String(raw['price-paid'] ?? ''));
  const dm = (iso) => iso.split('-').reverse().join('.');
  const vat = issuer && issuer.smallBusiness ? 0 : Number(issuer && issuer.vat != null ? issuer.vat : 7);
  return {
    id: randomId('re', 12), booking: String(booking), apt, status: 'entwurf', created: now,
    issuerId: issuer ? issuer.id : '', recipient, guest: guestName, arrival: raw.arrival, departure: raw.departure, aptName, channel,
    bookingRef: String(raw['reference-id'] || booking), date: L.localParts(now, cfg.timezone).date,
    lines: [{ text: `Übernachtung ${aptName}\n${nights} ${nights === 1 ? 'Nacht' : 'Nächte'} vom ${dm(raw.arrival)} bis ${dm(raw.departure)}`, gross: Number(raw.price) || 0, vat }],
    payment: paid || /booking|airbnb|expedia|agoda/i.test(channel) ? `Der Betrag wurde bereits${channel ? ` über ${channel}` : ''} bezahlt.` : 'Bitte überweisen Sie den Betrag innerhalb von 14 Tagen auf das unten angegebene Konto.',
    note: '', lang: /^(de|deu|german)/i.test(String(raw.language || 'de')) ? 'de' : 'en',
  };
}
function invoiceView(inv, cfg, request) {
  return { ...inv, totals: invoiceTotals(inv.lines), url: inv.token ? docUrl(cfg, request, inv.token) : null };
}
async function sendInvoiceMessage(env, cfg, inv, now) {
  const url = docUrl(cfg, null, inv.token);
  const de = inv.lang !== 'en';
  const name = (inv.guest || '').split(/\s+/)[0];
  const text = de ? `Hallo${name ? ' ' + name : ''},\n\nvielen Dank für deinen Aufenthalt bei Apartments Strauss! Deine Rechnung ${inv.number} findest du hier (zum Speichern als PDF auf „Drucken“ tippen):\n${url}\n\nLiebe Grüße\nLea\nApartments Strauss`
    : `Hi${name ? ' ' + name : ''},\n\nthank you for staying with Apartments Strauss! You can find your invoice ${inv.number} here (tap “Print” to save it as PDF):\n${url}\n\nBest regards\nLea\nApartments Strauss`;
  await sendMessageToGuest(smoobuCreds(env), inv.booking, `Rechnung ${inv.number}`, text);
  inv.sentAt = now; inv.sendAt = null; inv.error = null;
  await saveInvoice(env.DB, inv);
  await saveInquiries(env.DB, inv.booking, inv.apt, [{ id: `app-${now}-re`, created: localIso(now, cfg), inbound: false, phase: '', text, cats: [], fp: fingerprint(text) }], now);
}

async function viewFor(env, cfg, settings, state, user, now) {
  const { date: today, time } = L.localParts(now, cfg.timezone);
  const recipient = user.role === 'owner' ? cfg.owner.id : user.id;
  const since = new Date(now - 14 * 86400000).toISOString();
  const base = {
    user: { id: user.id, name: user.name, role: user.role, ...(user.deputy ? { deputy: true } : {}) }, today, time, now: new Date(now).toISOString(),
    aptDetails: user.role === 'owner' ? apartmentDetails(cfg, state) : {}, // nur Admin
    ...(user.role === 'owner' ? { craftsmen: craftsmenOf(settings).map((c) => craftsmanActivity(c, settings.guideLinks || [], now)), jobs: (settings.guideLinks || []).map((l) => guideJobView(l, now)).filter(Boolean) } : {}),
    startBy: cfg.startBy, finishBy: cfg.finishBy, checkoutTime: cfg.checkoutTime, confirmWithinHours: cfg.confirmWithinHours,
    topic: await topicFor(env, user),
    leads: withPush(await teamFor(env, cfg.leads.filter((l) => !l.deputy), user.role === 'owner'), settings, user.role === 'owner'),
    staff: withPush(await teamFor(env, cfg.staff, user.role === 'owner' || user.role === 'lead'), settings, user.role === 'owner' || user.role === 'lead'),
    // Änderungen der letzten 14 Tage für diese Person (oben „Neuigkeiten“)
    changes: (state.log || []).filter((n) => n.to === recipient && CHANGE_KINDS.includes(n.kind) && n.at >= since).slice(0, 30),
    seenAt: (state.seen || {})[user.id] || null,
    pushOk: !!(settings.pushOk || {})[user.id], // Push auf diesem Konto eingerichtet (bleibt beim Zurücksetzen)
    hasNtfyToken: !!(env.NTFY_TOKEN || '').trim(),
    pushQueued: user.role === 'owner' ? await countPushQueue(env.DB).catch(() => 0) : 0,
    inboxOpen: user.role === 'owner' ? ((await countThreads(env.DB).catch(() => ({}))).offen || 0) : 0,
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

  // ---- Handwerker-Link: Anleitung für genau eine Wohnung (ohne Anmeldung, nur mit gültigem Link) ----
  const guideReq = path.match(/^\/api\/guide\/([a-z0-9]{16,40})$/);
  if (guideReq && request.method === 'GET') {
    const link = (settings.guideLinks || []).find((l) => l.id === guideReq[1]);
    if (!link) return fail('Dieser Link ist ungültig.', 404);
    const st = guideLinkState(link, now);
    if (st !== 'aktiv') return fail(st === 'abgelaufen' ? 'Dieser Link ist abgelaufen – bitte bei Apartments Strauss einen neuen anfordern.' : 'Dieser Link wurde gesperrt – bitte bei Apartments Strauss melden.', 410);
    const no = link.no;
    const guide = GUIDES[no];
    const codes = await loadAccessCodes(env, settings, [{ id: link.apartmentId, name: link.apartmentName }]);
    const c = codes[link.apartmentId] || {};
    const details = (config.apartmentDetails || {})[no] || {};
    link.views = (link.views || 0) + 1;
    link.lastViewAt = new Date(now).toISOString();
    await saveSettings(env.DB, settings);
    return json({ title: guide ? guide.title : link.apartmentName, apartmentName: link.apartmentName, address: details.address || '',
      location: c.description || '', serviceCode: c.service || '', serviceBox: serviceBoxText(no, settings),
      door: (guide && guide.door) || null,
      steps: serviceSteps(guide, no, settings), photos: (guide ? guide.photos : []).map((p) => ({ url: `/${p.f}?t=${link.id}`, caption: p.c })),
      name: link.name || '', expiresAt: link.expiresAt,
      job: link.job ? { text: link.job.text, apartmentName: link.apartmentName, createdAt: link.createdAt, doneAt: link.job.doneAt || null, doneNote: link.job.doneNote || '',
        media: (link.job.photos || []).map((id) => ({ id, video: id.startsWith('v'), url: `/api/guide/${link.id}/media/${encodeURIComponent(id)}` })) } : null });
  }
  // Auftrag: Fotos/Videos der Meldung – nur über den gültigen Link und nur die Medien dieses Auftrags
  const guideMedia = path.match(/^\/api\/guide\/([a-z0-9]{16,40})\/media\/([A-Za-z0-9-]+)$/);
  if (guideMedia && request.method === 'GET') {
    const link = (settings.guideLinks || []).find((l) => l.id === guideMedia[1]);
    if (!link || guideLinkState(link, now) !== 'aktiv' || !link.job || !(link.job.photos || []).includes(guideMedia[2])) return fail('Nicht erlaubt', 403);
    if (guideMedia[2].startsWith('v')) return serveVideo(guideMedia[2]);
    const p = await getPhoto(env.DB, guideMedia[2]);
    if (!p) return fail('Foto nicht gefunden', 404);
    return new Response(p.data, { headers: { 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=3600' } });
  }
  // Auftrag erledigt melden (Handwerker) → Push an Apartments Strauss
  const guideDone = path.match(/^\/api\/guide\/([a-z0-9]{16,40})\/done$/);
  if (guideDone && request.method === 'POST') {
    const link = (settings.guideLinks || []).find((l) => l.id === guideDone[1]);
    if (!link || guideLinkState(link, now) !== 'aktiv' || !link.job) return fail('Dieser Link ist nicht (mehr) gültig.', 410);
    if (link.job.doneAt) return json({ ok: true, doneAt: link.job.doneAt });
    link.job.doneAt = new Date(now).toISOString();
    link.job.doneNote = String((await readJson()).note || '').trim().slice(0, 1000);
    await saveSettings(env.DB, settings);
    ctx.waitUntil(deliver(env, cfg, [{ to: cfg.owner.id, kind: 'report', title: `Auftrag erledigt: ${link.apartmentName}`,
      body: `${link.name || 'Handwerker'} meldet „erledigt“.${link.job.doneNote ? ' Notiz: ' + link.job.doneNote : ''}` }]).catch(() => {}));
    return json({ ok: true, doneAt: link.job.doneAt });
  }

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
    if (payload && /message/i.test(String(payload.action || ''))) { // neue Gastnachricht: diese Buchung gleich abrufen
      const d = payload.data || {};
      const rid = String(d.reservationId || d.bookingId || (d.reservation && d.reservation.id) || d.id || '');
      const { state } = await loadState(env.DB);
      const res = (state.reservations || {})[rid];
      if (res) ctx.waitUntil((async () => {
        const n = await pollBooking(env, cfg, settings, state, res, now, await automatedFingerprints(env.DB));
        await markPolled(env.DB, [rid], now);
        if (n) await deliverLogged(env, cfg, [n]);
      })().catch((e) => console.error('Webhook Nachricht', e.message)));
      return json({ ok: true });
    }
    const booking = payload && L.fromSmoobuWebhook(payload);
    if (!booking || (payload.data && payload.data['is-blocked-booking'])) return json({ ok: true, ignored: true });
    const result = await mutate(env.DB, (state) =>
      state.initialized ? withDeadlines(L.applyBooking(state, booking, now, cfg), now, cfg) : { state, notifications: [] }, now);
    ctx.waitUntil(deliverLogged(env, cfg, result.notifications));
    return json({ ok: true });
  }

  const user = await authenticate(request, env, cfg);
  if (!user) return fail('Bitte anmelden', 401);
  const role = user.role;
  // „zuletzt genutzt“ je Person merken (höchstens alle 15 Min. speichern)
  const seen = (settings.lastSeen || {})[user.id];
  if (!seen || now - Date.parse(seen) > 15 * 60000) {
    settings.lastSeen = { ...(settings.lastSeen || {}), [user.id]: new Date(now).toISOString() };
    await saveSettings(env.DB, settings).catch((e) => console.error('lastSeen', e.message));
  }
  const view = async (state, extra) => json({ ...(await viewFor(env, cfg, settings, state, user, now)), ...extra });
  /** Änderung speichern, Push verschicken, neue Ansicht zurückgeben */
  const change = async (fn, status = 400) => {
    let result;
    try {
      result = await mutate(env.DB, (st) => withDeadlines(fn(st), now, cfg), now);
    } catch (e) {
      return fail(e.message, status);
    }
    ctx.waitUntil(deliverLogged(env, cfg, result.notifications));
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
  const act = path.match(/^\/api\/tasks\/([^/]+)\/(lead-confirm|assign|confirm|start|done|edit|cancel|report|period-request|period-decide|period|keys-resolved|supplies|period-withdraw|block-released)$/);
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
      case 'period-withdraw':
        if (role === 'owner') break;
        return change((st) => L.withdrawPeriod(st, id, user, now, cfg), 409);
      case 'block-released':
        if (role !== 'owner') break;
        return change((st) => L.releaseBlockDone(st, id, now));
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
      ctx.waitUntil(deliverLogged(env, cfg, result.notifications));
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
  // Vertretung darf Reinigungen bestätigen/einteilen, aber nicht das Team verwalten
  const mayManage = (kind) => role === 'owner' || (role === 'lead' && !user.deputy && kind === 'staff');

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
    const phone = cleanPhone(body.phone);
    if (phone) entry.phone = phone;
    const code = await withNewCode(entry);
    listFor(kind).push(entry);
    await saveSettings(env.DB, settings);
    return teamReply({ newCode: { name, code } });
  }

  const team = path.match(/^\/api\/team\/([a-z0-9]+)(?:\/(code|delete|deputy))?$/);
  if (team && request.method === 'POST') {
    const kind = settings.leads.some((p) => p.id === team[1]) ? 'lead' : 'staff';
    const entry = listFor(kind).find((p) => p.id === team[1]);
    if (!entry) return fail('Person nicht gefunden', 404);
    if (!mayManage(kind)) return fail('Nicht erlaubt', 403);
    if (team[2] === 'deputy') { // nur Admin: Mitarbeiterin vertritt die Reinigungsleitung (an/aus)
      if (role !== 'owner' || kind !== 'staff') return fail('Nicht erlaubt', 403);
      const on = !!(await readJson()).on;
      if (on) { entry.deputy = true; entry.deputySince = new Date(now).toISOString(); } else { delete entry.deputy; delete entry.deputySince; }
      await saveSettings(env.DB, settings);
      const next = await loadConfig(env);
      const msg = on ? 'Du vertrittst ab sofort die Reinigungsleitung: Reinigungen bestätigen und einteilen. Bitte die App neu öffnen.'
        : 'Die Vertretung der Reinigungsleitung ist beendet.';
      ctx.waitUntil(deliver(env, next.cfg, [{ to: entry.id, kind: 'request', title: on ? 'Vertretung Reinigungsleitung' : 'Vertretung beendet', body: msg }]).catch(() => {}));
      return teamReply({});
    }
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
    const body = await readJson();
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) return fail('Bitte einen Namen eingeben');
    entry.name = name;
    if ('phone' in body) { const phone = cleanPhone(body.phone); if (phone) entry.phone = phone; else delete entry.phone; }
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

  // Statistik rückwirkend berechnen – in Abschnitten (max. 62 Tage je Aufruf, wegen Rechenzeit-Grenze von Cloudflare).
  // Die App ruft das nacheinander für bis zu 1,5 Jahre auf. Buchungen mit Eintragungs-/Stornodatum aus Smoobu.
  // Buchungstempo (Pace): Buchungen abschnittsweise aus Smoobu laden (Abreise von–bis, max. ~100 Tage je Aufruf)
  if (path === '/api/pace/sync' && request.method === 'POST') {
    const creds = smoobuCreds(env);
    if (!creds.key) return fail('Smoobu ist nicht verbunden');
    const body = await readJson();
    const isDay = (x) => /^\d{4}-\d{2}-\d{2}$/.test(x || '');
    if (!isDay(body.from) || !isDay(body.to) || body.from > body.to || L.addDays(body.from, 100) < body.to) return fail('Zeitraum ungültig');
    let raw;
    try { raw = await fetchBookings(creds, body.from, body.to); } catch (e) { return fail('Smoobu: ' + e.message, 502); }
    const entries = L.paceEntries(raw);
    await upsertPace(env.DB, entries);
    if (body.last) {
      const stats = await loadStats(env.DB);
      const { date: today } = L.localParts(now, cfg.timezone);
      stats.pace = { ...(stats.pace || {}), full: new Date(now).toISOString(), day: today };
      await refreshStarts(env, (await loadState(env.DB)).state, stats);
      await saveStats(env.DB, stats);
    }
    return json({ count: entries.length, from: body.from, to: body.to });
  }
  // Gästeanfragen: Nachrichten der Buchungen (3 Jahre zurück) abschnittsweise aus Smoobu lesen und nach Themen sortieren
  if (path === '/api/inquiries/sync' && request.method === 'POST') {
    const creds = smoobuCreds(env);
    if (!creds.key) return fail('Smoobu ist nicht verbunden');
    const body = await readJson();
    if (body.reset) await resetInquiries(env.DB);
    const { date: today } = L.localParts(now, cfg.timezone);
    const todo = await inquiryTodo(env.DB, L.addDays(today, -3 * 365), L.addDays(today, 365), 8);
    if (!todo.list.length && !todo.remaining) {
      if ((await inquiryReport(env.DB)).totals.bookings) return json({ done: 0, remaining: 0, messages: 0 });
      return fail('Bitte zuerst unter „Buchungstempo“ die Buchungen aus Smoobu laden', 409);
    }
    let messages = 0;
    for (const b of todo.list) {
      let raw;
      try { raw = await fetchMessages(creds, b.id); } catch (e) { return fail('Smoobu: ' + e.message, 502); }
      const msgs = buildMsgs(raw, b);
      messages += msgs.length;
      await saveInquiries(env.DB, String(b.id), b.apt, msgs, now);
    }
    return json({ done: todo.list.length, remaining: Math.max(0, todo.remaining - todo.list.length), messages });
  }
  if (path === '/api/inquiries' && request.method === 'GET') {
    const r = await inquiryReport(env.DB);
    const phases = {};
    for (const p of r.phases) (phases[p.cat] = phases[p.cat] || {})[p.phase] = p.n;
    const examples = {};
    for (const e of r.examples) (examples[e.cat] = examples[e.cat] || []).push(e.snippet);
    const topics = r.cats.map((c) => ({ id: c.cat, label: labelOf(c.cat), msgs: c.msgs, bookings: c.bookings,
      phases: phases[c.cat] || {}, examples: examples[c.cat] || [], noise: c.cat === 'thanks' || c.cat === 'other' }))
      .sort((a, b) => b.bookings - a.bookings || categoryOrder(a.id) - categoryOrder(b.id));
    const dir = (v) => (r.dirs.find((d) => d.inbound === v) || { n: 0 }).n;
    return json({ ...r.totals, inbound: dir(1), outbound: dir(0), unknown: dir(null), topics });
  }
  // Export als Text (anonymisiert) – zum Weitergeben für die Planung automatischer Antworten
  if (path === '/api/inquiries/export' && request.method === 'GET') {
    const r = await inquiryReport(env.DB);
    if (!r.totals.bookings) return fail('Bitte zuerst die Nachrichten lesen', 409);
    const ex = await inquiryExamples(env.DB, 8, 30);
    const phases = {};
    for (const p of r.phases) (phases[p.cat] = phases[p.cat] || {})[p.phase] = p.n;
    const dir = (v) => (r.dirs.find((d) => d.inbound === v) || { n: 0 }).n;
    const one = (t, n) => maskStrict(String(t || '')).replace(/\s+/g, ' ').trim().slice(0, n);
    const cats = r.cats.slice().sort((a, b) => b.bookings - a.bookings || categoryOrder(a.cat) - categoryOrder(b.cat));
    const lines = [`GÄSTEANFRAGEN – Export ${new Date(now).toISOString().slice(0, 10)} (Telefon/E-Mail/Links/Zahlen/Codes entfernt)`,
      `Buchungen gelesen: ${r.totals.bookings} · mit Gastnachricht: ${r.totals.asking} · Gastnachrichten: ${dir(1)} · eigene Nachrichten: ${dir(0)} · ohne Richtung: ${dir(null)} · älteste: ${String(r.totals.oldest || '').slice(0, 10)}`, '',
      'THEMEN (Buchungen | Nachrichten | vor Anreise / im Aufenthalt / nach Abreise):'];
    for (const c of cats) {
      const p = phases[c.cat] || {};
      lines.push(`- ${labelOf(c.cat)} [${c.cat}]: ${c.bookings} | ${c.msgs} | ${p.vorher || 0} / ${p['während'] || 0} / ${p.nachher || 0}`);
    }
    for (const c of cats.filter((x) => x.cat !== 'thanks')) {
      const list = ex.filter((e) => e.cat === c.cat);
      if (!list.length) continue;
      lines.push('', `### ${labelOf(c.cat)} [${c.cat}] – Beispiele`);
      for (const e of list) {
        lines.push(`• (${e.phase}) Gast: ${one(e.snippet, 200)}`);
        if (e.reply) lines.push(`  ↳ Antwort: ${one(e.reply, 220)}`);
      }
    }
    return json({ text: lines.join('\n') });
  }
  // ---- Reiter „Nachrichten“ ----
  if (path === '/api/inbox' && request.method === 'GET') {
    const view = url.searchParams.get('view') || 'offen';
    const statuses = view === 'erledigt' ? ['erledigt', 'gesendet'] : view === 'geplant' ? ['geplant'] : ['offen'];
    const threads = await listThreads(env.DB, statuses, view === 'offen' ? 40 : 30);
    const auto = await automatedFingerprints(env.DB);
    const examples = {};
    const out = [];
    for (const t of threads) {
      const msgs = await messagesOf(env.DB, t.booking);
      const history = msgs.slice(-14).map((m) => ({ id: m.id, created: m.created, inbound: m.inbound === 1,
        auto: m.inbound === 0 && !String(m.id).startsWith('app-') && auto.has(m.fp || ''), text: m.text.slice(0, 2000) }));
      if (view === 'offen') {
        for (const cat of (t.topics || []).filter((x) => x !== 'wgb')) {
          if (examples[cat]) continue;
          examples[cat] = (await pastAnswers(env.DB, cat, 30)).filter((x) => !auto.has(x.fp || '') && x.a.length >= 15 && x.a.length <= 900)
            .slice(0, 3).map((x) => ({ q: x.q.slice(0, 400), a: x.a.slice(0, 900) }));
        }
      }
      out.push({ ...t, history, invoices: (await listInvoices(env.DB, 5, t.booking)).map((i) => invoiceView(i, cfg, request)),
        docs: (await docsOf(env.DB, t.booking)).map((d) => ({ id: d.id, kind: d.kind, created: d.created, url: docUrl(cfg, request, d.token) })) });
    }
    return json({ view, threads: out, counts: await countThreads(env.DB), examples, labels: TOPIC_LABELS, settings: replyDefaults(cfg, settings), ai: !!env.AI });
  }
  if (path === '/api/inbox/poll' && request.method === 'POST') {
    if (!smoobuCreds(env).key) return fail('Smoobu ist nicht verbunden');
    const body = await readJson();
    const since = Number(body.since) || now;
    const { state } = await loadState(env.DB);
    const today = L.localParts(now, cfg.timezone).date;
    const list = inboxBookings(state, today);
    const times = await pollTimes(env.DB, list.map((r) => String(r.id)));
    const todo = list.filter((r) => !times[r.id] || times[r.id] < since);
    // ältere ausgehende Nachrichten einmalig mit Fingerabdruck versehen (Automatik erkennen)
    const miss = await missingFingerprints(env.DB, 400);
    if (miss.length) await setFingerprints(env.DB, miss.map((m) => ({ id: m.id, fp: fingerprint(m.text) })));
    const auto = await automatedFingerprints(env.DB);
    const notes = [];
    const batch = todo.slice(0, 6);
    for (const r of batch) {
      try { const n = await pollBooking(env, cfg, settings, state, r, now, auto); if (n) notes.push(n); } catch (e) { return fail('Smoobu: ' + e.message, 502); }
    }
    await markPolled(env.DB, batch.map((r) => r.id), now);
    if (notes.length) ctx.waitUntil(deliverLogged(env, cfg, notes).catch(() => {}));
    return json({ done: batch.length, remaining: todo.length - batch.length, total: list.length, fingerprints: miss.length });
  }
  if (path === '/api/inbox/settings' && request.method === 'POST') {
    const body = await readJson();
    const keys = ['checkin', 'checkout', 'earlyFee', 'lateFee', 'luggage', 'parking', 'wifi', 'cot', 'tips', 'doorTip', 'phone', 'signatureDe', 'signatureEn', 'knowledge'];
    settings.replies = Object.fromEntries(keys.map((k) => [k, String(body[k] || '').slice(0, k === 'knowledge' ? 12000 : 1500).trim()]).filter(([, v]) => v));
    await saveSettings(env.DB, settings);
    return json({ settings: replyDefaults(cfg, settings) });
  }
  const ib = path.match(/^\/api\/inbox\/(\w+)\/(draft|send|done|reopen|ai|template)$/);
  if (ib && request.method === 'POST') {
    const t = await getThread(env.DB, ib[1]);
    if (!t) return fail('Vorgang nicht gefunden', 404);
    const body = await readJson();
    const text = String(body.text != null ? body.text : t.draft || '').trim().slice(0, 5000);
    if (ib[2] === 'draft') { t.draft = text; t.edited = true; }
    else if (ib[2] === 'template') { t.draft = t.draftTpl; t.draftBy = 'vorlage'; t.edited = false; }
    else if (ib[2] === 'ai') {
      if (!env.AI) return fail('Cloudflare Workers AI ist nicht eingerichtet', 501);
      try { t.draftAi = await aiDraftFor(env, cfg, settings, t, await automatedFingerprints(env.DB)); } catch (e) { return fail('KI-Entwurf fehlgeschlagen: ' + e.message, 502); }
      t.draft = t.draftAi; t.draftBy = 'ki'; t.edited = false; t.aiWanted = false;
    } else if (ib[2] === 'done') { t.status = 'erledigt'; t.doneBy = 'ohne Antwort'; t.doneMark = localIso(now, cfg); t.sendAt = null; }
    else if (ib[2] === 'reopen') { t.status = 'offen'; t.doneMark = null; }
    else if (ib[2] === 'send') {
      if (!text) return fail('Die Nachricht ist leer');
      if (/\[(bitte ergänzen|please add)[^\]]*\]/i.test(text)) return fail('Bitte zuerst die Stellen „[bitte ergänzen]“ im Text ausfüllen');
      t.draft = text;
      if (body.at) {
        const at = Number(body.at);
        if (!at || at < now - 60000) return fail('Zeitpunkt liegt in der Vergangenheit');
        t.status = 'geplant'; t.sendAt = at;
      } else {
        try { await sendThread(env, cfg, t, text, now); } catch (e) { return fail('Senden fehlgeschlagen: ' + e.message, 502); }
        return json({ thread: t });
      }
    }
    await saveThread(env.DB, t, now);
    return json({ thread: t });
  }

  // ---- Rechnungen ----
  if (path === '/api/invoices' && request.method === 'GET') {
    const { state } = await loadState(env.DB);
    return json({ settings: invoiceSettings(settings), counters: await invoiceCounters(env.DB),
      apartments: apartmentList(state).map((a) => ({ id: a.id, name: a.name })), invoices: (await listInvoices(env.DB, 100)).map((i) => invoiceView(i, cfg, request)) });
  }
  if (path === '/api/invoices/settings' && request.method === 'POST') {
    const body = await readJson();
    const str = (v, n) => String(v || '').trim().slice(0, n);
    const issuers = (Array.isArray(body.issuers) ? body.issuers : []).slice(0, 6).map((x, i) => ({
      id: str(x.id, 20) || `a${i + 1}`, name: str(x.name, 200), address: str(x.address, 400), taxNo: str(x.taxNo, 60), vatId: str(x.vatId, 60),
      bank: str(x.bank, 300), footer: str(x.footer, 400), smallBusiness: !!x.smallBusiness, vat: x.vat === '' || x.vat == null ? 7 : Number(x.vat) || 0,
      place: str(x.place, 60), signer: str(x.signer, 100) })).filter((x) => x.name);
    const apts = {};
    for (const [id, v] of Object.entries(body.apts || {})) apts[id] = { issuer: str(v.issuer, 20), prefix: str(v.prefix, 30) };
    settings.invoice = { format: str(body.format, 60) || '{prefix}{jahr}-{nr3}', issuers, apts };
    await saveSettings(env.DB, settings);
    const counters = await invoiceCounters(env.DB);
    for (const [id, v] of Object.entries(body.next || {})) {
      const n = Math.floor(Number(v));
      if (n >= 1 && n !== counters[id]) await setInvoiceCounter(env.DB, id, n);
    }
    return json({ settings: invoiceSettings(settings), counters: await invoiceCounters(env.DB) });
  }
  if (path === '/api/invoices/draft' && request.method === 'POST') {
    if (!smoobuCreds(env).key) return fail('Smoobu ist nicht verbunden');
    const body = await readJson();
    if (!/^\w+$/.test(String(body.booking || ''))) return fail('Buchung fehlt');
    const existing = (await listInvoices(env.DB, 10, body.booking)).find((i) => i.status === 'entwurf');
    if (existing) return json({ invoice: invoiceView(existing, cfg, request) });
    let inv;
    try { inv = await invoiceDraft(env, cfg, settings, (await loadState(env.DB)).state, String(body.booking), now); } catch (e) { return fail(e.message, 502); }
    await saveInvoice(env.DB, inv);
    return json({ invoice: invoiceView(inv, cfg, request) });
  }
  if (path === '/api/invoices.csv' && request.method === 'GET') {
    const list = (await listInvoices(env.DB, 5000)).filter((i) => i.number).reverse();
    const iss = invoiceSettings(settings).issuers;
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const num = (n) => String(n.toFixed(2)).replace('.', ',');
    const rows = [['Nummer', 'Datum', 'Status', 'Aussteller', 'Wohnung', 'Empfänger', 'Leistung von', 'bis', 'Netto', 'USt', 'Brutto', 'Buchung'].map(q).join(';')];
    for (const i of list) {
      const t = invoiceTotals(i.lines);
      rows.push([i.number, i.date, i.status, (i.issuer || iss.find((x) => x.id === i.issuerId) || {}).name, i.aptName, String(i.recipient || '').split('\n')[0],
        i.arrival, i.departure, num(t.net), num(t.vat), num(t.gross), i.bookingRef].map(q).join(';'));
    }
    return new Response('﻿' + rows.join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="rechnungen.csv"' } });
  }
  const iv = path.match(/^\/api\/invoices\/(\w+)(?:\/(issue|cancel|send|delete))?$/);
  if (iv && request.method === 'POST') {
    const inv = await getInvoice(env.DB, iv[1]);
    if (!inv) return fail('Rechnung nicht gefunden', 404);
    const body = await readJson();
    const iset = invoiceSettings(settings);
    if (!iv[2]) { // Entwurf speichern
      if (inv.status !== 'entwurf') return fail('Ausgestellte Rechnungen können nicht geändert werden – bitte stornieren');
      if (body.recipient != null) inv.recipient = String(body.recipient).slice(0, 600);
      if (body.issuerId != null) inv.issuerId = String(body.issuerId);
      if (Array.isArray(body.lines)) inv.lines = body.lines.slice(0, 20).map((l) => ({ text: String(l.text || '').slice(0, 500), gross: Math.round((Number(String(l.gross).replace(',', '.')) || 0) * 100) / 100, vat: Number(l.vat) || 0 }));
      for (const k of ['payment', 'note', 'date', 'lang']) if (body[k] != null) inv[k] = String(body[k]).slice(0, 800);
      await saveInvoice(env.DB, inv);
      return json({ invoice: invoiceView(inv, cfg, request) });
    }
    if (iv[2] === 'delete') {
      if (inv.status !== 'entwurf') return fail('Nur Entwürfe können gelöscht werden');
      await deleteInvoiceDraft(env.DB, inv.id);
      return json({ ok: true });
    }
    if (iv[2] === 'issue') {
      if (inv.status !== 'entwurf') return fail('Rechnung ist bereits ausgestellt');
      const issuer = iset.issuers.find((x) => x.id === inv.issuerId);
      if (!issuer) return fail('Bitte zuerst einen Aussteller wählen (Einstellungen → Rechnungen)');
      if (!String(issuer.address || '').trim()) return fail(`Anschrift von „${issuer.name}“ fehlt (Pflichtangabe) – bitte unter Nachrichten → Rechnungen eintragen`);
      if (!issuer.taxNo && !issuer.vatId) return fail(`Steuernummer oder USt-IdNr. von „${issuer.name}“ fehlt (Pflichtangabe)`);
      if (!String(inv.recipient || '').trim()) return fail('Empfänger fehlt');
      if (!invoiceTotals(inv.lines).gross) return fail('Betrag fehlt');
      const n = await takeInvoiceNumber(env.DB, inv.apt || 'x');
      inv.date = inv.date || L.localParts(now, cfg.timezone).date;
      inv.number = invoiceNumber(iset.format, (iset.apts[inv.apt] || {}).prefix || '', n, inv.date);
      inv.issuer = issuer; inv.status = 'ausgestellt'; inv.token = randomId('', 24); inv.issuedAt = now;
      await saveInvoice(env.DB, inv);
      return json({ invoice: invoiceView(inv, cfg, request) });
    }
    if (iv[2] === 'cancel') {
      if (inv.status !== 'ausgestellt') return fail('Nur ausgestellte Rechnungen können storniert werden');
      const n = await takeInvoiceNumber(env.DB, inv.apt || 'x');
      const date = L.localParts(now, cfg.timezone).date;
      const st = { ...inv, id: randomId('re', 12), status: 'storno', created: now, date, refNumber: inv.number, refId: inv.id, sendAt: null, sentAt: null,
        lines: inv.lines.map((l) => ({ ...l, gross: -l.gross })), number: invoiceNumber(iset.format, (iset.apts[inv.apt] || {}).prefix || '', n, date),
        token: randomId('', 24), issuedAt: now, payment: '' };
      await saveInvoice(env.DB, st);
      inv.cancelled = true; inv.status = 'storniert'; inv.cancelId = st.id; inv.sendAt = null;
      await saveInvoice(env.DB, inv);
      return json({ invoice: invoiceView(inv, cfg, request), storno: invoiceView(st, cfg, request) });
    }
    if (iv[2] === 'send') {
      if (!['ausgestellt', 'storno'].includes(inv.status)) return fail('Bitte die Rechnung zuerst ausstellen');
      if (body.at) { inv.sendAt = Number(body.at); inv.error = null; await saveInvoice(env.DB, inv); return json({ invoice: invoiceView(inv, cfg, request) }); }
      try { await sendInvoiceMessage(env, cfg, inv, now); } catch (e) { return fail('Senden fehlgeschlagen: ' + e.message, 502); }
      return json({ invoice: invoiceView(inv, cfg, request) });
    }
  }

  // ---- Wohnungsgeberbestätigung ----
  if (path === '/api/wgb' && request.method === 'POST') {
    const body = await readJson();
    const names = (Array.isArray(body.names) ? body.names : String(body.names || '').split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
    if (!names.length) return fail('Bitte die Namen eintragen');
    const t = body.booking ? await getThread(env.DB, body.booking) : null;
    const iset = invoiceSettings(settings);
    const apt = String(body.apt || (t && t.apt) || '');
    const issuer = iset.issuers.find((x) => x.id === (iset.apts[apt] || {}).issuer) || iset.issuers[0];
    const { state } = await loadState(env.DB);
    const details = apartmentDetails(cfg, state)[apt] || {};
    const b = builtinFor(aptNameOf(state, apt));
    const doc = { id: randomId('wg', 12), kind: 'wgb', booking: body.booking ? String(body.booking) : null, token: randomId('', 24), created: now,
      names, moveIn: /^\d{4}-\d\d-\d\d$/.test(body.moveIn || '') ? body.moveIn : (t && t.arrival) || '',
      address: String(body.address || details.address || (b && b.address) || '').trim(),
      landlord: String(body.landlord || (issuer ? `${issuer.name}\n${issuer.address}` : '')).trim(), owner: String(body.owner || '').trim(),
      place: (issuer && issuer.place) || 'Braunschweig', signer: (issuer && issuer.signer) || '', date: L.localParts(now, cfg.timezone).date };
    if (!doc.address) return fail('Anschrift der Wohnung fehlt – bitte eintragen');
    if (!doc.landlord) return fail('Wohnungsgeber fehlt – bitte unter Rechnungen einen Aussteller anlegen oder eintragen');
    await saveDoc(env.DB, doc);
    return json({ doc: { id: doc.id, kind: 'wgb', url: docUrl(cfg, request, doc.token) } });
  }
  if (path === '/api/inquiries/ai' && request.method === 'POST') {
    if (!env.AI) return fail('Cloudflare Workers AI ist nicht eingerichtet', 501);
    const sample = (await inquirySample(env.DB, 80)).map((t) => mask(t).replace(/\s+/g, ' ').slice(0, 240));
    if (sample.length < 10) return fail('Zu wenige Gastnachrichten – bitte zuerst die Nachrichten laden', 409);
    const prompt = `Du analysierst Nachrichten von Gästen an einen Vermieter von Ferienwohnungen (Apartments Strauss).
Hier ist eine zufällige Stichprobe von ${sample.length} Gastnachrichten (eine je Zeile, persönliche Daten entfernt):
${sample.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Ermittle die 10 häufigsten Anliegen/Fragen der Gäste. Antworte auf Deutsch als nummerierte Liste:
"<Nr>. <Anliegen> – ca. <Anzahl> Nachrichten – eignet sich für automatische Antwort: ja/teilweise/nein".
Keine Einleitung, kein Schluss.`;
    try {
      const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages: [{ role: 'user', content: prompt }], max_tokens: 900, temperature: 0.2 });
      return json({ text: String((r && (r.response || r.result)) || '').trim(), sample: sample.length });
    } catch (e) { return fail('KI-Auswertung fehlgeschlagen: ' + e.message, 502); }
  }
  if (path === '/api/pace/warn-check' && request.method === 'POST') {
    const items = await paceCheck(env, cfg, now);
    if (!items) return fail('Bitte zuerst die Buchungen laden', 409);
    return json({ items, points: (cfg.paceWarn || {}).points || 5 });
  }
  if (path === '/api/pace' && request.method === 'GET') {
    const { date: today } = L.localParts(now, cfg.timezone);
    const { state } = await loadState(env.DB);
    const counted = statsApartments(state).counted;
    const entries = await loadPace(env.DB);
    const stats = await loadStats(env.DB);
    const report = L.paceReport(entries, counted.map((a) => a.id), today);
    return json({ ...report, loaded: (stats.pace && stats.pace.full) || null, updated: (stats.pace && stats.pace.day) || null,
      warn: { ...(cfg.paceWarn || {}), last: (stats.pace && stats.pace.warn) || null },
      units: counted.map((a) => ({ id: a.id, name: a.name, start: report.starts[a.id] || null })) });
  }

  // Rückwirkend berechnen (bis 3 Jahre, je Aufruf max. 62 Tage): aus dem gespeicherten Buchungsbestand (Pace),
  // belegt = Buchungen inkl. Blockierungen, Wohnungen erst ab ihrer ersten echten Buchung im Nenner
  if (path === '/api/stats/backfill' && request.method === 'POST') {
    const { date: today } = L.localParts(now, cfg.timezone);
    const body = await readJson();
    const isDay = (x) => /^\d{4}-\d{2}-\d{2}$/.test(x || '');
    let to = isDay(body.to) ? body.to : L.addDays(today, -1);
    if (to >= today) to = L.addDays(today, -1);
    let from = isDay(body.from) ? body.from : L.addDays(to, -(Math.min(62, Math.max(1, Number(body.days) || 60)) - 1));
    if (from < L.addDays(to, -61)) from = L.addDays(to, -61);
    if (from > to) return fail('Zeitraum ungültig');
    const all = await loadPace(env.DB);
    if (!all.length) return fail('Bitte zuerst die Buchungen laden (Statistik → Buchungstempo → „Buchungen aus Smoobu laden“)', 409);
    const { state } = await loadState(env.DB);
    const ids = statsApartments(state).counted.map((a) => a.id);
    const stats = await loadStats(env.DB);
    if (!startsOf(stats)) await refreshStarts(env, state, stats);
    const starts = startsOf(stats) || {};
    // nur Einträge, die den Zeitraum (+30 Nächte Vorausblick) berühren – spart Rechenzeit
    const last = L.addDays(to, STAT_DAYS + 1);
    const index = L.nightIndex(all.filter((e) => e.departure > from && e.arrival < last));
    let added = 0;
    for (let d = from; d <= to; d = L.addDays(d, 1)) {
      const night = L.nightOccupancy(index, ids, d, starts);
      const actual = { pct: night.pct, bookedPct: night.bookedPct, blockedPct: night.blockedPct, units: night.apartments };
      if (stats.days[d] && stats.days[d].source === 'live') { stats.days[d].actual = actual; continue; } // echte Tageswerte haben Vorrang
      const o = L.occupancy(index, ids, d, STAT_DAYS, d, starts);
      stats.days[d] = { pct: o.pct, bookedPct: o.bookedPct, blockedPct: o.blockedPct, apartments: night.apartments, source: 'rückwirkend', actual };
      added++;
    }
    const prev = stats.backfill || {};
    stats.backfill = { at: new Date(now).toISOString(), oldest: prev.oldest && prev.oldest < from ? prev.oldest : from, bookings: all.length, from, to };
    await saveStats(env.DB, stats);
    if (body.quiet) return json({ backfilled: added, from, to });
    return view((await loadState(env.DB)).state, { backfilled: added, from, to });
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

  // Nacht prüfen: frisch aus Smoobu – welche Wohnung ist in dieser Nacht gebucht / blockiert / frei?
  if (path === '/api/stats/night' && request.method === 'GET') {
    const creds = smoobuCreds(env);
    if (!creds.key) return fail('Smoobu ist nicht verbunden');
    const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '') ? url.searchParams.get('day') : L.localParts(now, cfg.timezone).date;
    const info = {};
    let raw;
    try {
      raw = await fetchBookings(creds, L.addDays(day, 1), L.addDays(day, 120), info); // Abreise nach dieser Nacht
    } catch (e) {
      return fail('Smoobu: ' + e.message, 502);
    }
    const { state } = await loadState(env.DB);
    const { counted: apartments, excluded } = statsApartments(state);
    const rows = apartments.map((a) => {
      const covering = raw.filter((r) => r && String(r.apartment && r.apartment.id) === a.id && r.arrival <= day && day < r.departure);
      const active = covering.filter((r) => r.type !== 'cancellation');
      const pick = active.find((r) => !r['is-blocked-booking']) || active[0] || null;
      return { id: a.id, name: a.name, status: !pick ? 'frei' : pick['is-blocked-booking'] ? 'blockiert' : 'gebucht',
        arrival: pick ? pick.arrival : null, departure: pick ? pick.departure : null, cancelledOnly: !active.length && covering.length > 0 };
    });
    const idsInSmoobu = [...new Set(raw.map((r) => String(r && r.apartment && r.apartment.id)))].filter((id) => !apartments.some((a) => a.id === id));
    return json({ day, rows, fetch: info, unknownApartments: idsInSmoobu, excluded: excluded.map((a) => a.name) });
  }

  // Gesperrte Anmeldungen: freischalten → wieder 3 Versuche
  if (path === '/api/login-locks/release' && request.method === 'POST') {
    const target = String((await readJson()).ip || '');
    if (!target) return fail('Adresse fehlt');
    await releaseCodeLock(env.DB, target);
    return view((await loadState(env.DB)).state);
  }

  // Zugangscodes verwalten (verschlüsselt in der Datenbank, nie im Programmcode)
  // Anleitungen (Masteransicht, mit Gäste-Anleitung) – nur Admin, auf Abruf
  if (path === '/api/guides' && request.method === 'GET') {
    const { state } = await loadState(env.DB);
    const apartments = apartmentList(state).map((a) => ({ ...a, no: guideNo(a.name) })).filter((a) => a.no);
    const codes = await loadAccessCodes(env, settings, apartments);
    const token = (request.headers.get('Authorization') || '').slice(7);
    return json({ days: GUIDE_DAYS, apartments: apartments.map((a) => { const g = GUIDES[a.no];
      return { id: a.id, name: a.name, no: a.no, title: g ? g.title : a.name, hasGuide: !!g, original: g ? g.original : [],
        steps: serviceSteps(g, a.no, settings), serviceBox: serviceBoxText(a.no, settings), ownServiceBox: ((settings.guideNotes || {})[a.no]) || '',
        door: (g && g.door) || null, serviceCode: (codes[a.id] || {}).service || '', location: (codes[a.id] || {}).description || '',
        photos: (g ? g.photos : []).map((p) => ({ url: `/${p.f}?a=${encodeURIComponent(token)}`, caption: p.c })) }; }),
      links: (settings.guideLinks || []).map((l) => guideLinkView(l, now)).reverse() });
  }
  if (path === '/api/guide-links' && request.method === 'POST') {
    const body = await readJson();
    const { state } = await loadState(env.DB);
    const apt = apartmentList(state).find((a) => a.id === String(body.apartmentId || ''));
    if (!apt || !guideNo(apt.name)) return fail('Bitte eine Wohnung auswählen');
    const days = GUIDE_DAYS.includes(Number(body.days)) ? Number(body.days) : 7;
    const craftsman = body.craftsmanId ? craftsmenOf(settings).find((c) => c.id === body.craftsmanId) : null;
    const link = { id: randomId('', 24), apartmentId: apt.id, apartmentName: apt.name, no: guideNo(apt.name),
      name: (craftsman ? craftsman.name : String(body.name || '').trim()).slice(0, 60), craftsmanId: craftsman ? craftsman.id : null,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + days * 86400000).toISOString(), views: 0 };
    // Auftrag aus einer Meldung: Text + Fotos/Videos der Meldung gehen mit
    if (body.reportId) {
      const task = state.tasks[String(body.taskId || '')];
      const report = task && (task.reports || []).find((r) => r.id === body.reportId);
      if (!report || task.apartmentId !== apt.id) return fail('Meldung nicht gefunden');
      const extra = String(body.note || '').trim().slice(0, 1000);
      link.job = { taskId: task.id, reportId: report.id, text: [extra, report.text].filter(Boolean).join('\n\nAus der Meldung: ').trim() || 'Bitte vor Ort ansehen.',
        photos: (report.photos || []).slice(0, 12) };
    }
    // abgelaufene/gesperrte Links nach 60 Tagen aufräumen
    settings.guideLinks = (settings.guideLinks || []).filter((l) => guideLinkState(l, now) === 'aktiv' || now - Date.parse(l.expiresAt) < 60 * 86400000);
    settings.guideLinks.push(link);
    await saveSettings(env.DB, settings);
    return json({ link: guideLinkView(link, now), url: `${new URL(request.url).origin}/anleitung/${link.id}` });
  }
  const revokeGuide = path.match(/^\/api\/guide-links\/([a-z0-9]+)\/revoke$/);
  if (revokeGuide && request.method === 'POST') {
    const link = (settings.guideLinks || []).find((l) => l.id === revokeGuide[1]);
    if (!link) return fail('Link nicht gefunden', 404);
    link.revoked = new Date(now).toISOString();
    await saveSettings(env.DB, settings);
    return json({ ok: true });
  }
  // Handwerker-Verzeichnis: anlegen/ändern, löschen
  if (path === '/api/craftsmen' && request.method === 'POST') {
    const body = await readJson();
    const clean = (v, n) => String(v || '').trim().slice(0, n);
    const entry = { id: clean(body.id, 40) || randomId('h-', 8), name: clean(body.name, 80), trade: clean(body.trade, 80), company: clean(body.company, 80),
      phone: cleanPhone(body.phone), phone2: cleanPhone(body.phone2), phone2Label: clean(body.phone2Label, 30), email: clean(body.email, 120), note: clean(body.note, 500) };
    if (!entry.name) return fail('Bitte einen Namen eingeben');
    if (entry.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entry.email)) return fail('E-Mail-Adresse prüfen');
    const list = craftsmenOf(settings).slice();
    const i = list.findIndex((c) => c.id === entry.id);
    for (const k of Object.keys(entry)) if (!entry[k]) delete entry[k];
    if (i >= 0) list[i] = entry; else list.push(entry);
    settings.craftsmen = list;
    await saveSettings(env.DB, settings);
    return view((await loadState(env.DB)).state);
  }
  const delCraftsman = path.match(/^\/api\/craftsmen\/([A-Za-z0-9-]+)\/delete$/);
  if (delCraftsman && request.method === 'POST') {
    settings.craftsmen = craftsmenOf(settings).filter((c) => c.id !== delCraftsman[1]);
    await saveSettings(env.DB, settings);
    return view((await loadState(env.DB)).state);
  }

  if (path === '/api/guide-note' && request.method === 'POST') {
    const body = await readJson();
    const no = Number(body.no);
    if (!(no >= 1 && no <= 99)) return fail('Wohnung unbekannt');
    settings.guideNotes = settings.guideNotes || {};
    const text = String(body.text || '').trim().slice(0, 500);
    if (text) settings.guideNotes[no] = text; else delete settings.guideNotes[no];
    await saveSettings(env.DB, settings);
    return json({ ok: true, serviceBox: serviceBoxText(no, settings) });
  }

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

  // Push-Versand von Hand auslösen (wie der automatische Lauf, aber ohne Smoobu-Abgleich):
  // Warteschlange nachsenden, Fristen/Erinnerungen prüfen und senden
  if (path === '/api/push/run' && request.method === 'POST') {
    const flushed = await flushPushQueue(env, cfg, 25).catch((e) => ({ sent: 0, left: 0, error: e.message }));
    const result = await mutate(env.DB, (st) => L.checkDeadlines(st, now, cfg), now);
    const delivery = await deliver(env, cfg, result.notifications);
    await recordDelivery(env.DB, { ...(flushed.statuses || {}), ...(delivery.statuses || {}) }, now).catch((e) => console.error('Zustellstatus', e.message));
    const pushReport = { at: new Date(now).toISOString(), sent: delivery.sent + flushed.sent, failed: delivery.failed,
      errors: delivery.errors.slice(0, 5), resent: flushed.sent, manual: true };
    await mutate(env.DB, (st) => ({ state: { ...st, pushReport }, notifications: [] }), now).catch((e) => console.error(e));
    const summary = { resent: flushed.sent, sent: delivery.sent, failed: delivery.failed, queued: delivery.queued || 0,
      left: await countPushQueue(env.DB).catch(() => 0), error: (delivery.errors[0] || {}).error || null };
    return view((await loadState(env.DB)).state, { pushRun: summary });
  }

  if (path === '/api/sync' && request.method === 'POST') {
    const summary = await runSync(env, now, cfg);
    return view((await loadState(env.DB)).state, { summary });
  }

  return fail('Nicht gefunden', 404);
}

async function guidePhoto(request, env, url) {
  const file = url.pathname.slice(1);
  const denied = () => new Response('Nicht erlaubt', { status: 403, headers: { 'Cache-Control': 'no-store' } });
  if (request.method !== 'GET' || !/^g\/[a-f0-9]{24}\.jpg$/.test(file)) return denied();
  const { cfg, settings } = await loadConfig(env);
  const token = url.searchParams.get('t');
  let ok = false;
  if (token) {
    const link = (settings.guideLinks || []).find((l) => l.id === token);
    ok = !!link && guideLinkState(link, Date.now()) === 'aktiv' && ((GUIDES[link.no] || {}).photos || []).some((p) => p.f === file);
  } else {
    const user = await authenticate(request, env, cfg);
    ok = !!user && user.role === 'owner';
  }
  if (!ok) return denied();
  const res = await env.ASSETS.fetch(new Request(new URL('/' + file, url)));
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' } });
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
    // Handwerker-Anleitung: /anleitung/<link> → public/anleitung.html (Daten holt die Seite über /api/guide/<link>)
    if (/^\/anleitung\/[a-z0-9]{16,40}$/.test(url.pathname) && request.method === 'GET') {
      const page = await env.ASSETS.fetch(new Request(new URL('/anleitung', url), request));
      return new Response(page.body, { status: page.status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' } });
    }
    // Rechnungen / Wohnungsgeberbestätigung per Link: /dok/<token>
    const dok = url.pathname.match(/^\/dok\/([a-z0-9]{24})$/);
    if (dok && request.method === 'GET') {
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' };
      const inv = await invoiceByToken(env.DB, dok[1]).catch(() => null);
      if (inv && inv.number) return new Response(invoiceHtml(inv), { headers });
      const doc = await docByToken(env.DB, dok[1]).catch(() => null);
      if (doc && doc.kind === 'wgb') return new Response(wgbHtml(doc), { headers });
      return new Response('Dokument nicht gefunden', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    // Fotos der Anleitungen (public/g/…): nur mit gültigem Handwerker-Link (?t=) für diese Wohnung oder als Admin (?a=)
    if (url.pathname.startsWith('/g/')) return guidePhoto(request, env, url);
    // /admin (und andere unbekannte Seiten) → die App selbst
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404 && request.method === 'GET') return env.ASSETS.fetch(new Request(new URL('/', url), request));
    return res;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env, event.scheduledTime).then((s) => console.log('Abgleich', JSON.stringify(s)))
      .then(() => runInbox(env, event.scheduledTime)).then((r) => console.log('Nachrichten', JSON.stringify(r))).catch((e) => console.error('Nachrichten', e)));
  },
};
