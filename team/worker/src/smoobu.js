// Zugriff auf die Smoobu-API (https://docs.smoobu.com)
//
// Anmeldung: Seit 25.09.2026 verlangt Smoobu HMAC-SHA256-signierte Anfragen mit
// den Headern X-API-Key, X-Timestamp, X-Nonce und X-Signature. Die Signatur
// entsteht aus Methode, Pfad, sortierten Query-Parametern, Zeitstempel, Nonce,
// Body-Hash und API-Key. Weil Details (Zeitformat, Hash-Kodierung, Pfad mit /api)
// hier nicht geprüft werden konnten, ermittelt detect() einmalig die passende
// Variante mit einer harmlosen Leseabfrage und merkt sie sich.
// Ohne Secret wird der alte Header „Api-Key“ verwendet.
const BASE = 'https://login.smoobu.com/api';
const encoder = new TextEncoder();

function b64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function sha256(text, format) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  return format === 'hex' ? [...hash].map((b) => b.toString(16).padStart(2, '0')).join('') : b64(hash);
}

async function hmacBase64(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))));
}

// Mögliche Varianten, wahrscheinlichste zuerst
export const VARIANTS = [];
for (const bodyHash of ['hex', 'base64'])
  for (const apiPrefix of [true, false])
    for (const millis of [false, true])
      for (const emptyQueryLine of [true, false])
        VARIANTS.push({ bodyHash, apiPrefix, millis, emptyQueryLine });

export function describeVariant(v) {
  return `Hash ${v.bodyHash}, Pfad ${v.apiPrefix ? 'mit' : 'ohne'} /api, Zeit ${v.millis ? 'mit' : 'ohne'} ms, leere Query-Zeile ${v.emptyQueryLine ? 'ja' : 'nein'}`;
}

function canonicalQuery(params) {
  return [...new URLSearchParams(params)]
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export async function signedHeaders(creds, method, path, params, variant) {
  let timestamp = new Date().toISOString();
  if (!variant.millis) timestamp = timestamp.replace(/\.\d{3}Z$/, 'Z');
  const nonce = crypto.randomUUID();
  const query = canonicalQuery(params);
  const lines = [method, (variant.apiPrefix ? '/api' : '') + path];
  if (query || variant.emptyQueryLine) lines.push(query);
  lines.push(timestamp, nonce, await sha256('', variant.bodyHash), creds.key);
  return {
    'X-API-Key': creds.key,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': await hmacBase64(creds.secret, lines.join('\n')),
  };
}

async function request(creds, path, params, variant) {
  const auth = creds.secret ? await signedHeaders(creds, 'GET', path, params, variant) : { 'Api-Key': creds.key };
  const query = new URLSearchParams(params).toString();
  return fetch(`${BASE}${path}${query ? '?' + query : ''}`, {
    headers: { ...auth, 'Cache-Control': 'no-cache', Accept: 'application/json' },
  });
}

let detected = null; // gefundene Variante (pro Worker-Instanz)

/** Probiert die Varianten mit GET /apartments durch; liefert die passende oder null. */
export async function detect(creds, report) {
  for (const variant of VARIANTS) {
    const res = await request(creds, '/apartments', {}, variant);
    if (report) report.push({ variant, status: res.status });
    if (res.ok) return (detected = variant);
    if (res.status !== 401 && res.status !== 403) throw new Error(`Smoobu antwortet mit ${res.status} auf /apartments`);
  }
  return null;
}

async function call(creds, path, params = {}) {
  if (creds.secret && !detected && !(await detect(creds))) {
    throw new Error('Smoobu lehnt die Anmeldung ab (401) – bitte API-Key und Secret in Cloudflare prüfen');
  }
  let res = await request(creds, path, params, detected);
  if (res.status === 401 && creds.secret) {
    detected = null; // z. B. geänderte Zugangsdaten: einmal neu ermitteln
    if (await detect(creds)) res = await request(creds, path, params, detected);
  }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Smoobu lehnt die Anmeldung ab (${res.status}) – bitte API-Key${creds.secret ? ' und Secret' : ''} in Cloudflare prüfen`);
  }
  if (!res.ok) throw new Error(`Smoobu antwortet mit ${res.status} auf ${path}`);
  return res.json();
}

// Smoobu liefert die Liste unter „bookings“; zur Sicherheit auch andere Namen akzeptieren.
function listOf(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.bookings || data.reservations || data.data || [];
}

/** Alle Buchungen (inkl. Stornos) mit Abreise im Zeitraum. */
export async function fetchBookings(creds, departureFrom, departureTo) {
  const bookings = [];
  for (let page = 1; page <= 50; page++) {
    const data = await call(creds, '/reservations', {
      departureFrom, departureTo, showCancellation: 'true', excludeBlocked: 'true', pageSize: '100', page: String(page),
    });
    bookings.push(...listOf(data));
    if (!data || page >= (data.page_count || 1)) break;
  }
  return bookings;
}

/** Alle Wohnungen/Einheiten mit ihren Smoobu-Namen. */
export async function fetchApartments(creds) {
  const data = await call(creds, '/apartments');
  const list = (data && (data.apartments || data.data)) || (Array.isArray(data) ? data : []);
  return list.map((a) => ({ id: String(a.id), name: a.name || 'Wohnung ' + a.id }));
}

/** Eine einzelne Buchung; null, wenn sie in Smoobu gelöscht wurde. */
export function fetchBooking(creds, id) {
  return call(creds, `/reservations/${encodeURIComponent(id)}`);
}

function shape(label, value) {
  if (!value) return `${label}: fehlt`;
  const special = [...new Set(value.replace(/[A-Za-z0-9]/g, ''))].join(' ');
  return `${label}: Länge ${value.length}${special ? ', Sonderzeichen ' + special : ', nur Buchstaben/Ziffern'}`;
}

/**
 * Diagnose für die Übersicht: meldet nur Form der Zugangsdaten, Statuscodes,
 * Anzahlen und Feldnamen – keine Gästedaten, keine Schlüssel.
 */
export async function diagnose(creds, from, to) {
  const results = [{
    variant: 'Zugangsdaten (nur Form, nicht Inhalt)', status: '–', received: 0,
    topKeys: [shape('Key', creds.key), shape('Secret', creds.secret), creds.secret ? 'Verfahren: HMAC (neu)' : 'Verfahren: Api-Key (alt, endet 25.09.2026)'],
  }];

  if (creds.secret) {
    detected = null;
    const report = [];
    let found = null;
    try {
      found = await detect(creds, report);
    } catch (e) {
      results.push({ variant: 'Anmeldung', error: e.message });
    }
    results.push({
      variant: 'Anmeldung (HMAC)',
      status: found ? 200 : report.length ? report[report.length - 1].status : '–',
      topKeys: [found ? 'funktioniert: ' + describeVariant(found) : `${report.length} Varianten probiert, keine akzeptiert`],
      received: 0,
    });
    if (!found) return results;
  }

  try {
    const data = await call(creds, '/reservations', { departureFrom: from, departureTo: to, showCancellation: 'true', pageSize: '25' });
    const list = listOf(data);
    results.push({
      variant: 'Buchungen abrufen',
      status: 200,
      topKeys: data && !Array.isArray(data) ? Object.keys(data).slice(0, 12) : [],
      total: data && (data.total_items ?? null),
      pages: data && (data.page_count ?? null),
      received: list.length,
      departures: list.map((b) => b.departure).filter(Boolean).sort().filter((d, i, a) => i === 0 || i === a.length - 1),
      fields: list[0] ? Object.keys(list[0]).slice(0, 40) : [],
    });
  } catch (e) {
    results.push({ variant: 'Buchungen abrufen', error: e.message });
  }
  return results;
}
