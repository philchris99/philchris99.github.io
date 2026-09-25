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
  // Öffentliche Angaben je Wohnung (Nummer aus dem Namen) – Antippen des Wohnungsnamens zeigt sie mit Link zum Kopieren
  apartmentDetails: {
    1: { smoobuId: '1404092', name: '#EINS | BRAUNSCHWEIG ÖSTLICHES RINGGEBIET', address: 'Allerstraße 9, 38106 Braunschweig', url: 'https://www.apartments-strauss.de/apartments-detail/apartment-1-eins' },
    2: { smoobuId: '1404095', name: '#ZWEI | BRAUNSCHWEIG HAUPTBAHNHOF', address: 'Berliner Platz 1C, 38102 Braunschweig', url: 'https://www.apartments-strauss.de/apartments-detail/apartment-2-zwei' },
    3: { smoobuId: '1618864', name: '#DREI | BRAUNSCHWEIG ÖSTLICHES RINGGEBIET', address: 'Brucknerstraße 10, 38106 Braunschweig', url: 'https://www.apartments-strauss.de/apartments-detail/apartment-3-drei' },
    4: { smoobuId: '1894227', name: '#VIER | BRAUNSCHWEIG HAUPTBAHNHOF', address: 'Berliner Platz 1C, 38102 Braunschweig', url: 'https://www.apartments-strauss.de/apartments-detail/apartment-4-vier' },
    5: { smoobuId: '1993151', name: '#FÜNF | BRAUNSCHWEIG INNENSTADT', address: 'Sackring 10A, 38118 Braunschweig', url: 'https://www.apartments-strauss.de/apartments-detail/apartment-5-fuenf' },
    6: { smoobuId: '2092109', name: '#SECHS | BRAUNSCHWEIG PRINZENPARK', address: 'Hagenring 71, 38106 Braunschweig', url: 'https://www.apartments-strauss.de/apartments-detail/apartment-6-sechs' },
    7: { smoobuId: '2282501', name: '#SIEBEN | BRAUNSCHWEIG HAUPTBAHNHOF', address: 'Berliner Platz 1C, 38102 Braunschweig', url: 'https://www.apartments-strauss.de/apartments-detail/apartment-7-sieben' },
    8: { smoobuId: '2451618', name: '#ACHT | BRAUNSCHWEIG HAUPTBAHNHOF', address: 'Berliner Platz 1C, 38102 Braunschweig', url: 'https://www.apartments-strauss.de/apartments-detail/apartment-8-acht' },
    9: { smoobuId: '2609853', name: '#NEUN | BRAUNSCHWEIG SÜD', address: 'Goethestraße 11A, 38122 Braunschweig', url: 'https://www.apartments-strauss.de/apartments-detail/apartment-9-neun' },
    10: { smoobuId: '2645223', name: '#ZEHN | BRAUNSCHWEIG HAUPTBAHNHOF', address: 'Berliner Platz 1D, 38102 Braunschweig', url: 'https://www.apartments-strauss.de/apartments-detail/apartment-10-zehn' },
    11: { smoobuId: '2682988', name: '#ELF | BRAUNSCHWEIG INNENSTADT', address: 'Gördelingerstraße 18, 38100 Braunschweig', url: 'https://www.apartments-strauss.de/apartments-detail/apartment-11-elf' },
    12: { smoobuId: '2726728', name: '#ZWÖLF | BRAUNSCHWEIG HAUPTBAHNHOF', address: 'Berliner Platz 1C, 38102 Braunschweig', url: 'https://www.apartments-strauss.de/apartments-detail/apartment-10-zehn' },
    13: { smoobuId: '2911141', name: '#DREIZEHN | BRAUNSCHWEIG CITY', address: 'Juliusstraße 14, 38118 Braunschweig', url: 'https://www.apartments-strauss.de/apartments-detail/apartment-13-dreizehn' },
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
