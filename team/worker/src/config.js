// Einstellungen für team.apartments-strauss.de
// Hier stehen KEINE Geheimnisse. API-Schlüssel und APP_SECRET liegen als
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
  owner: { id: 'owner', name: 'Apartment Strauß' },

  // version erhöhen = persönlichen Link + Push-Kanal dieser Person sperren und neu erzeugen
  owners: [
    { id: 'buero', name: 'Apartment Strauß', version: 1 },
  ],
  cleaners: [
    // apartments: 'all' oder Liste von Smoobu-Apartment-IDs, z. B. ['123456', '123457']
    // Die IDs stehen nach dem ersten Abgleich in der Auftraggeber-Ansicht.
    { id: 'kraft1', name: 'Reinigungskraft 1', apartments: 'all', version: 1 },
  ],

  // Optional: eigene Wohnungsnamen statt der Smoobu-Namen, z. B. { id: '123456', name: 'Wohnung 1' }
  apartments: [],
};
