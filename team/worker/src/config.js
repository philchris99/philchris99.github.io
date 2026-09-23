// Einstellungen für team.apartments-strauss.de
// Hier stehen KEINE Geheimnisse. API-Schlüssel, APP_SECRET und ADMIN_PASSWORD liegen als
// „Secrets“ bei Cloudflare (siehe README).
export default {
  appUrl: 'https://team.apartments-strauss.de',
  timezone: 'Europe/Berlin',
  reminderTime: '12:00',   // Erinnerung an die Reinigungskraft am Reinigungstag
  escalationTime: '13:00', // Alarm an Reinigungskraft UND Auftraggeber
  showGuestNames: false,   // Gästenamen für Reinigungskräfte ausblenden (Datenschutz)
  syncDaysAhead: 365,      // so weit im Voraus werden Buchungen aus Smoobu geholt
  allowReset: true,        // Testphase: „Alles zurücksetzen“ in der Übersicht (später auf false)
  keepPhotosDays: 45,      // Fotos werden danach automatisch gelöscht

  // Pseudo-Empfänger 'owner' aus der Logik → geht an alle Auftraggeber
  owner: { id: 'owner', name: 'Apartment Strauss' },

  // Auftraggeber (Anmeldung über /admin mit ADMIN_PASSWORD).
  // version erhöhen = auf allen Geräten abmelden + neuer Push-Kanal
  owners: [
    { id: 'buero', name: 'Apartment Strauss', version: 1 },
  ],

  // Reinigungskräfte werden in der App unter „Team“ verwaltet (Datenbank), nicht hier.
  cleaners: [],

  // Optional: eigene Wohnungsnamen statt der Smoobu-Namen, z. B. { id: '123456', name: 'Wohnung 1' }
  apartments: [],
};
