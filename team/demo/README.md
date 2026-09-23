# Reinigungsplan Apartment Strauß (Smoobu → Reinigungskräfte)

Testversion der Logik für die Endreinigungen der 13 Ferienwohnungen.

## Ausprobieren

- **Oberfläche:** `index.html` im Browser öffnen (Doppelklick reicht, kein Server nötig).
  1. Reiter „Smoobu-Test“ → „Beispieldaten laden“ oder eigene Buchung anlegen
  2. Reiter „Reinigungskraft“ → als Anna/Maria „Bestätigen / Übernehmen“ klicken
  3. Im Reiter „Smoobu-Test“ eine Buchung verlängern → Push an die Reinigungskraft
  4. Oben die Zeit auf 12:00 / 13:00 springen → Erinnerung bzw. Alarm an Reinigungskraft + Auftraggeber
- **Automatische Tests:** `node --test logic/logic.test.js`

Die Testdaten liegen nur im eigenen Browser (localStorage). Es gibt noch keine Verbindung zu Smoobu.

## Was die Logik abdeckt (`logic.js`)

| Ereignis | Ergebnis | Benachrichtigt |
|---|---|---|
| Neue Buchung in Smoobu | Reinigung am Abreisetag, Status „offen“ | alle für die Wohnung zuständigen Reinigungskräfte |
| Reinigungskraft klickt „Bestätigen“ | Status „bestätigt“, ihr zugewiesen | Auftraggeber |
| Buchung verlängert/verkürzt | Datum wird aktualisiert, muss neu bestätigt werden | zugewiesene Kraft (sonst alle Zuständigen), bei vorher bestätigter Reinigung auch Auftraggeber |
| Buchung storniert | Status „storniert“ | zugewiesene Kraft bzw. alle Zuständigen |
| Reinigungstag 12:00, noch offen | Erinnerung | Reinigungskraft |
| Reinigungstag 13:00, noch offen | Alarm | Reinigungskraft **und** Auftraggeber |
| Reinigungskraft klickt „Erledigt“ | Status „erledigt“ | Auftraggeber |

Zusätzlich: Hinweis „Wechseltag“, wenn am Reinigungstag schon der nächste Gast anreist.

Anpassen in `DEFAULT_CONFIG` oben in `logic.js`: Uhrzeiten, Wohnungsnamen + Smoobu-Apartment-IDs,
Reinigungskräfte und für welche Wohnungen sie zuständig sind.

## Weg zum echten Betrieb (Vorschlag)

```
Smoobu ──Webhook──▶ Google Apps Script (kostenlos) ──▶ Google Tabelle (Reinigungen)
                         │  alle 15 Min: checkDeadlines()
                         └──▶ Push via ntfy / Telegram an Reinigungskraft + Auftraggeber
Reinigungskraft ──▶ Web-App (diese Oberfläche) ──▶ „Bestätigen“ zurück an Apps Script
```

1. Smoobu: Einstellungen → API → Webhook-URL eintragen (Aktionen `newReservation`, `updateReservation`,
   `cancelReservation`). `fromSmoobuWebhook()` übersetzt die Daten – Feldnamen mit einer echten Buchung gegenprüfen.
2. Push-Kanal: **ntfy** (App installieren, Thema abonnieren – ein HTTP-Aufruf pro Nachricht) oder **Telegram-Bot**.
   Echte Web-Push auf dem iPhone geht nur, wenn die Web-App zum Home-Bildschirm hinzugefügt ist.
3. Später: Fotos und To-dos pro Reinigung (z. B. Google Drive-Ordner bzw. eigene Spalte/Tabelle).
