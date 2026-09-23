# Apartments Strauss – Reinigungsplan mit Smoobu

Web-App unter **team.apartments-strauss.de**:
Buchungen aus Smoobu → Endreinigungen → Bestätigung durch die Reinigungskraft → Push-Nachrichten.

```
Smoobu ──(alle 5 Min. + optional Webhook)──▶ Cloudflare Worker „strauss-team“ ──▶ ntfy-Push aufs Handy
                                               │  D1-Datenbank, Fristen 6 Std. / überfällig ab 12 / 15 Uhr
team.apartments-strauss.de ─(CNAME bei goneo)─▶ Cloudflare Pages ──▶ Worker (Web-App + API)
```

| Ordner | Inhalt |
|---|---|
| `logic/` | Die Regeln (neue Buchung, Verlängerung, Storno, Bestätigen, Fristen) mit Tests |
| `worker/` | Server: Smoobu-Abgleich, API, Push, Web-App (`public/`) |
| `pages/` | Nur die Weiterleitung, damit die eigene Subdomain funktioniert |

## Funktionen

**Rollen**
- **Admin** (Apartments Strauss): alles sehen, manuelle Reinigungen anlegen/verschieben/absagen, Hinweise + Fotos an Reinigungen,
  Meldungen als behoben markieren, Team verwalten (Reinigungsleitung + Mitarbeiterinnen)
- **Reinigungsleitung**: bekommt alle neuen Reinigungen, bestätigt den Erhalt und **weist sie einer Mitarbeiterin zu**
  (oder sich selbst); legt eigene Mitarbeiterinnen mit Code an
- **Mitarbeiterin**: sieht nur die ihr zugewiesenen Reinigungen, bestätigt, erfasst Beginn (optional) und Ende

**Anmeldung**: auf der Startseite 6-stelliger Code (geht nach der 6. Ziffer automatisch weiter); nach 3 falschen Codes 1 Minute gesperrt.
Admin-Code unter „Team → Mein Admin-Code“; Notzugang `/admin` mit `ADMIN_PASSWORD`.

**Fristen und Erinnerungen** (deutsche Zeit, Prüfung alle 5 Minuten, Push über ntfy)
- 6 Std. nach Eintragung/Verschiebung nicht von Leitung **und** Mitarbeiterin bestätigt → Alarm an Admin
- Reinigungstag ab **12:00 nicht begonnen** → „überfällig“; Erinnerung „Reinigung muss heute noch gestartet werden“
- Reinigungstag ab **15:00 nicht beendet** → „überfällig“; Erinnerung „Reinigung bitte beenden“ (bzw. „immer noch nicht begonnen“)
- Erinnerungen gehen an das Reinigungsteam (Leitung + zugewiesene Mitarbeiterin; noch nicht zugewiesen: alle Mitarbeiterinnen)
  **und den Admin**; um 12:00 und um 15:00 sofort, danach **alle 30 Minuten wiederholt**, solange überfällig
  (bis 22 Uhr); gilt auch für Reinigungen, die erst nach 12 bzw. 15 Uhr für heute eingetragen oder auf heute verschoben
  werden – dann kommt die Erinnerung sofort
- Vortag nicht erledigt → einmalige Meldung
- Viele gleichartige Nachrichten werden zu einer Sammelnachricht gebündelt
- Zeiten und Abstand einstellbar in `worker/src/config.js` (`startBy`, `finishBy`, `repeatMinutes`, `quietFrom`)

**Weiteres**
- „Neuigkeiten“ oben: was sich geändert hat (neu, zugewiesen, verlängert/verkürzt, verschoben, abgesagt, Hinweise)
- Telefonnummer des Gastes aus Smoobu als Anruf-Knopf (`showGuestPhone` in `config.js`)
- Hinweise/Meldungen mit bis zu 5 Fotos (Kamera oder Galerie, Vorschau mit Entfernen, eigene Fotos löschbar, Galerie-Ansicht)
- Beginn und Ende der Reinigung mit Dauer
- **Belegungskalender** (Admin, Leitung): alle Wohnungen durchnummeriert, Tage fortlaufend, Buchungen mit Gastname und
  Telefonnummer (nur Admin), blockierte Zeiträume aus Smoobu; Reinigungen als großes Symbol (Kreis = Check-out,
  Quadrat = manuell; orange offen, grün bestätigt/erledigt, rot überfällig), antippen zeigt alle Details
- **Push einrichten**: Schritt-für-Schritt-Anleitung mit direktem Link zu ntfy im App Store / bei Google Play; oben nur, solange
  das jeweilige Benutzerkonto „Test-Nachricht angekommen“ noch nicht bestätigt hat (gilt geräteübergreifend), sonst unten
- **Anmeldecodes** sind in der Team-Liste jederzeit sichtbar (Admin: alle, Leitung: ihre Mitarbeiterinnen), verschlüsselt gespeichert
- Testphase: „Alles zurücksetzen“ (Team bleibt). Danach `allowReset: false` in `worker/src/config.js`.

## Design / Logo

Logo-Dateien in `worker/public/`: `logo.png` (Anmeldung), `logo-house.png` + `logo-wordmark.png` (Kopfzeile),
`icon-512.png` / `apple-touch-icon.png` (App-Symbol). Farben oben in `worker/public/index.html` (Block „MARKE“).
Es werden bewusst keine Google Fonts geladen (Datenschutz).

## Einstellungen ändern

In `worker/src/config.js`: Fristen und Uhrzeiten, Gastnamen/Telefonnummer ein/aus. Team und Codes werden in der App verwaltet.
Person sperren: in der App „Neuen Code erzeugen“ oder „Entfernen“.

## Einrichtung (einmalig, ca. 45 Minuten)

> Geheimnisse (Smoobu-API-Schlüssel, APP_SECRET) nur bei Cloudflare eintragen – nie in Dateien oder Chats.
> Die Menünamen bei Cloudflare, goneo und Smoobu können leicht abweichen.

**1. Datenbank anlegen**
Cloudflare-Dashboard → *Storage & Databases → D1* → *Create* → Name `apartment-strauss-team` (erledigt).
Die Database ID steht bereits in `worker/wrangler.toml`.

**2. Worker anlegen**
*Workers & Pages → Create → Import a repository* → dieses Repository wählen →
Name `strauss-team`, **Root directory: `worker`**, Deploy-Befehl `npx wrangler deploy` → *Deploy*.

**3. Geheimnisse eintragen**
Worker `strauss-team` → *Settings → Variables and Secrets* → *Add* → Typ **Secret**:
- `SMOOBU_API_KEY` – der **API-Key** aus Smoobu (*Einstellungen → API Keys*)
- `SMOOBU_API_SECRET` – das zugehörige **Secret** (wird in Smoobu nur einmal beim Erstellen angezeigt)
  Smoobu verlangt seit 25.09.2026 signierte Anfragen (HMAC); ohne Secret wird das alte Verfahren versucht.
- `APP_SECRET` – ein langes Zufallspasswort (40+ Zeichen, im Passwortmanager speichern)
- `ADMIN_PASSWORD` – Passwort für /admin (ohne dieses gilt APP_SECRET)
- `NTFY_TOKEN` – Zugangstoken eines kostenlosen ntfy.sh-Kontos (ntfy.sh → Konto anlegen → *Account → Access tokens*).
  Ohne Token zählt ntfy.sh die Nachrichten pro Server-Adresse; Cloudflare teilt sich Adressen mit vielen anderen,
  deshalb kommt sonst oft „429 zu viele Nachrichten“.

> Immer Typ **Secret** wählen: einfache Variablen löscht Cloudflare bei neuen Versionen
> (zusätzlich abgesichert durch `keep_vars = true` in `wrangler.toml`).

**4. Erster Test (noch ohne eigene Adresse)**
`https://strauss-team.<euer-konto>.workers.dev/admin` öffnen → ADMIN_PASSWORD → „Jetzt abgleichen“ (unter „System & Smoobu“).
Unter „Team“ Reinigungskräfte anlegen und die Codes weitergeben.

**5. Pages für die eigene Adresse**
*Workers & Pages → Create → Pages → Import a Git repository* → dasselbe Repository →
Name z. B. `strauss-team-web`, **Root directory: `pages`**, Build-Befehl leer, **Output directory: `public`** → *Deploy*.
Danach *Settings → Bindings → Add → Service binding*: Name **`APP`**, Service **`strauss-team`** → neu deployen.

**6. Subdomain verbinden**
Pages-Projekt → *Custom domains → Set up a custom domain* → `team.apartments-strauss.de`.
Cloudflare zeigt einen CNAME-Eintrag an (Ziel: `strauss-team-web.pages.dev`).
Bei **goneo**: Kundencenter → *Domains* → `apartments-strauss.de` → *DNS-Einstellungen* →
neuer Eintrag: Name `team`, Typ **CNAME**, Ziel `strauss-team-web.pages.dev`.
Nach einigen Minuten bis Stunden zeigt Cloudflare „Active“; dann funktioniert https://team.apartments-strauss.de.

**7. Reinigungskräfte einladen**
Admin → „Team“ → Reinigungskraft anlegen → Code persönlich weitergeben. Die Reinigungskraft öffnet
https://team.apartments-strauss.de, gibt den Code ein, legt die Seite auf den Home-Bildschirm und richtet unter
„Push-Nachrichten einrichten“ die App **ntfy** ein.

**8. Optional: sofortige Aktualisierung**
Die Webhook-Adresse aus „System & Smoobu“ in Smoobu unter *Einstellungen → API → Webhook-URL* eintragen.
Ohne Webhook kommen Änderungen spätestens nach 5 Minuten an.

## Entwicklung

```bash
cd worker
node --test test/worker.test.js ../logic/logic.test.js   # alle Tests
cp .dev.vars.example .dev.vars && npx wrangler dev --test-scheduled
# Abgleich lokal auslösen: http://localhost:8787/__scheduled
```

## Hinweise

- Die Smoobu-Anbindung ist gegen die öffentliche API-Beschreibung gebaut (`/api/reservations` mit `departureFrom`/`departureTo`,
  `showCancellation`). Beim ersten echten Abgleich prüfen, ob alle Buchungen erscheinen.
- ntfy.sh ist ein öffentlicher Dienst: Die Kanalnamen sind zufällig und geheim, die Nachrichten enthalten nur Wohnung und Datum.
- Gästenamen werden den Reinigungskräften standardmäßig nicht angezeigt (`showGuestNames` in `config.js`).
