// Zugriff auf die Smoobu-API (https://docs.smoobu.com)
const BASE = 'https://login.smoobu.com/api';

async function call(apiKey, path) {
  const res = await fetch(BASE + path, {
    headers: { 'Api-Key': apiKey, 'Cache-Control': 'no-cache', Accept: 'application/json' },
  });
  if (res.status === 404) return null;
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
 * Diagnose für die Übersicht: fragt Smoobu auf mehrere Arten ab und meldet nur
 * Statuscodes, Anzahlen und Feldnamen – keine Gästedaten, keinen Schlüssel.
 */
export async function diagnose(apiKey, from, to) {
  const variants = {
    'ohne Filter': { pageSize: '25' },
    'from/to': { from, to, pageSize: '25' },
    'arrivalFrom/arrivalTo': { arrivalFrom: from, arrivalTo: to, pageSize: '25' },
    'departureFrom/departureTo': { departureFrom: from, departureTo: to, pageSize: '25' },
    'departureFrom + showCancellation': { departureFrom: from, departureTo: to, showCancellation: 'true', excludeBlocked: 'true', pageSize: '25' },
  };
  const results = [];
  for (const [name, params] of Object.entries(variants)) {
    try {
      const res = await fetch(`${BASE}/reservations?${new URLSearchParams(params)}`, {
        headers: { 'Api-Key': apiKey, 'Cache-Control': 'no-cache', Accept: 'application/json' },
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) { /* keine JSON-Antwort */ }
      const list = listOf(data);
      results.push({
        variant: name,
        status: res.status,
        topKeys: data && !Array.isArray(data) ? Object.keys(data) : [],
        total: data && (data.total_items ?? data.totalItems ?? null),
        pages: data && (data.page_count ?? data.pageCount ?? null),
        received: list.length,
        departures: list.slice(0, 25).map((b) => b.departure).filter(Boolean).sort().slice(0, 1).concat(list.map((b) => b.departure).filter(Boolean).sort().slice(-1)),
        fields: list[0] ? Object.keys(list[0]).slice(0, 40) : [],
        error: res.ok ? null : text.slice(0, 200),
      });
    } catch (e) {
      results.push({ variant: name, error: e.message });
    }
  }
  return results;
}
