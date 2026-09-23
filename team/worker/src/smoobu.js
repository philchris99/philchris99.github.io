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

/** Alle Buchungen (inkl. Stornos) mit Abreise im Zeitraum. */
export async function fetchBookings(apiKey, departureFrom, departureTo) {
  const bookings = [];
  for (let page = 1; page <= 50; page++) {
    const q = new URLSearchParams({
      departureFrom, departureTo, showCancellation: 'true', excludeBlocked: 'true', pageSize: '100', page: String(page),
    });
    const data = await call(apiKey, `/reservations?${q}`);
    bookings.push(...((data && data.bookings) || []));
    if (!data || page >= (data.page_count || 1)) break;
  }
  return bookings;
}

/** Eine einzelne Buchung; null, wenn sie in Smoobu gelöscht wurde. */
export function fetchBooking(apiKey, id) {
  return call(apiKey, `/reservations/${encodeURIComponent(id)}`);
}
