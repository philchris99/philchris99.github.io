// Zugriff auf die Smoobu-API (https://docs.smoobu.com)
const BASE = 'https://login.smoobu.com/api';

async function call(apiKey, path) {
  const res = await fetch(BASE + path, {
    headers: { 'Api-Key': apiKey, 'Cache-Control': 'no-cache', Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new Error(`Smoobu lehnt den API-Schlüssel ab (${res.status}) – bitte Schlüssel in Cloudflare prüfen`);
  if (!res.ok) throw new Error(`Smoobu antwortet mit ${res.status} auf ${path.split('?')[0]}`);
  return res.json();
}

// Smoobu liefert die Liste unter „bookings“; zur Sicherheit auch andere Namen akzeptieren.
function listOf(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.bookings || data.reservations || data.data || [];
}

/** Alle Buchungen (inkl. Stornos) mit Abreise im Zeitraum. */
export async function fetchBookings(apiKey, departureFrom, departureTo) {
  const bookings = [];
  for (let page = 1; page <= 50; page++) {
    const q = new URLSearchParams({
      departureFrom, departureTo, showCancellation: 'true', excludeBlocked: 'true', pageSize: '100', page: String(page),
    });
    const data = await call(apiKey, `/reservations?${q}`);
    bookings.push(...listOf(data));
    if (!data || page >= (data.page_count || 1)) break;
  }
  return bookings;
}

/** Eine einzelne Buchung; null, wenn sie in Smoobu gelöscht wurde. */
export function fetchBooking(apiKey, id) {
  return call(apiKey, `/reservations/${encodeURIComponent(id)}`);
}

/**
 * Diagnose für die Übersicht: probiert Endpunkte und Anmeldeformen durch und
 * meldet nur Statuscodes, Anzahlen und Feldnamen – keine Gästedaten, keinen Schlüssel.
 */
export async function diagnose(apiKey, from, to) {
  const keyInfo = {
    variant: 'Schlüssel (nur Form, nicht Inhalt)',
    status: '–',
    error: null,
    received: 0,
    topKeys: [`Länge ${apiKey.length}`, /^[A-Za-z0-9]+$/.test(apiKey) ? 'nur Buchstaben/Ziffern' : `Sonderzeichen: ${[...new Set(apiKey.replace(/[A-Za-z0-9]/g, ''))].join(' ')}`,
      /\s/.test(apiKey) ? 'enthält Leerzeichen!' : 'ohne Leerzeichen'],
  };
  const range = new URLSearchParams({ departureFrom: from, departureTo: to, pageSize: '25' });
  const variants = [
    ['Header Api-Key · /api/me', '/me', { 'Api-Key': apiKey }],
    ['Header Api-Key · /api/apartments', '/apartments', { 'Api-Key': apiKey }],
    ['Header Api-Key · Buchungen', `/reservations?${range}`, { 'Api-Key': apiKey }],
    ['Header X-Api-Key · Buchungen', `/reservations?${range}`, { 'X-Api-Key': apiKey }],
    ['Bearer · Buchungen', `/reservations?${range}`, { Authorization: `Bearer ${apiKey}` }],
    ['Header Api-Key · Buchungen ohne Filter', '/reservations?pageSize=25', { 'Api-Key': apiKey }],
  ];
  const results = [keyInfo];
  for (const [name, path, auth] of variants) {
    try {
      const res = await fetch(BASE + path, { headers: { ...auth, 'Cache-Control': 'no-cache', Accept: 'application/json' } });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) { /* keine JSON-Antwort */ }
      const list = path.startsWith('/reservations') ? listOf(data) : [];
      results.push({
        variant: name,
        status: res.status,
        topKeys: data && !Array.isArray(data) ? Object.keys(data).slice(0, 12) : [],
        total: data && (data.total_items ?? data.totalItems ?? null),
        pages: data && (data.page_count ?? data.pageCount ?? null),
        received: list.length,
        departures: list.map((b) => b.departure).filter(Boolean).sort().filter((d, i, a) => i === 0 || i === a.length - 1),
        fields: list[0] ? Object.keys(list[0]).slice(0, 40) : [],
        // Fehlertexte von Smoobu enthalten keine Buchungsdaten; Erfolgsantworten werden nicht angezeigt
        error: res.ok ? null : text.slice(0, 160),
      });
    } catch (e) {
      results.push({ variant: name, error: e.message });
    }
  }
  return results;
}
