// Einstellungen für team.apartments-strauss.de (Apartments Strauss)
// Hier stehen KEINE Geheimnisse. API-Schlüssel, APP_SECRET und ADMIN_PASSWORD liegen als
// „Secrets“ bei Cloudflare (siehe README).
export default {
  appUrl: 'https://team.apartments-strauss.de',
  timezone: 'Europe/Berlin',
  confirmWithinHours: 6,       // so lange nach Eintragung müssen Leitung + Mitarbeiterin bestätigt haben
  startBy: '12:00',            // Reinigungstag: bis dahin begonnen, sonst „überfällig“ + Erinnerung
  finishBy: '15:00',           // Reinigungstag: bis dahin erledigt, sonst „überfällig“ + Erinnerung
  repeatMinutes: 30,           // Erinnerung wiederholen, solange überfällig (Prüfung alle 5 Min.)
  quietFrom: '22:00',          // ab dann keine Erinnerungen mehr
  // Wohnungsgröße für die Statistik (Wohnungsnummer aus dem Namen: #EINS = 1 …) – geht vor den Smoobu-Angaben
  sizeByNumber: {
    1: '1 Zimmer', 2: '1 Zimmer', 4: '1 Zimmer', 7: '1 Zimmer', 8: '1 Zimmer', 10: '1 Zimmer', 11: '1 Zimmer', 12: '1 Zimmer',
    3: '3 Zimmer', 5: '3 Zimmer', 6: '3 Zimmer', 9: '3 Zimmer', 13: '3 Zimmer',
  },
  routeCity: 'Braunschweig',   // Ort der Wohnungen – für die Routenplanung (Adressen → Koordinaten über OpenStreetMap)
  maxPeriodDays: 7,            // Zeitraum für eine Reinigung: höchstens so viele Tage nach dem Check-out
  showGuestNames: false,   // Gästenamen für Reinigungskräfte ausblenden (Datenschutz)
  showGuestPhone: true,    // Telefonnummer des Gastes (aus Smoobu) als Anruf-Knopf anzeigen
  syncDaysAhead: 365,      // so weit im Voraus werden Buchungen aus Smoobu geholt
  allowReset: true,        // Testphase: „Alles zurücksetzen“ in der Übersicht (später auf false)
  keepPhotosDays: 45,      // Fotos werden danach automatisch gelöscht

  // Pseudo-Empfänger 'owner' aus der Logik → geht an alle Auftraggeber
  owner: { id: 'owner', name: 'Apartments Strauss' },

  // Auftraggeber (Anmeldung über /admin mit ADMIN_PASSWORD).
  // version erhöhen = auf allen Geräten abmelden + neuer Push-Kanal
  owners: [
    { id: 'buero', name: 'Apartments Strauss', version: 1 },
  ],

  // Reinigungsleitung und Mitarbeiterinnen werden in der App unter „Team“ verwaltet (Datenbank).
  leads: [],
  staff: [],

  // Optional: eigene Wohnungsnamen statt der Smoobu-Namen, z. B. { id: '123456', name: 'Wohnung 1' }
  apartments: [],
};
