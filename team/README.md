# Apartments Strauss – Reinigungsplan mit Smoobu

Web-App unter **team.apartments-strauss.de**:
Buchungen aus Smoobu → Endreinigungen → Bestätigung durch die Reinigungskraft → Push-Nachrichten.

```
Smoobu ──(alle 5 Min. + optional Webhook)──▶ Cloudflare Worker „apartment-strauss-team“ ──▶ ntfy-Push aufs Handy
                                               │  D1-Datenbank, Fristen 6 Std. / überfällig ab 12 / 15 Uhr
team.apartments-strauss.de ─(CNAME bei goneo)─▶ Cloudflare Pages ──▶ Worker (Web-App + API)
```

| Ordner | Inhalt |
|---|---|
| `logic/` | Die Regeln (neue Buchung, Verlängerung, Storno, Bestätigen, Fristen) mit Tests |
| `worker/` | Server: Smoobu-Abgleich, API, Push, Web-App (`public/`); Baustellenassistent in `src/bau.js` + `public/bau.html` |
| `pages/` | Nur die Weiterleitung, damit die eigene Subdomain funktioniert |

## Funktionen

**Bedienung**: Jede Reinigung zeigt Wohnung, Lage, **einen klaren Status mit Icon** und **einen großen Knopf** für den
nächsten Schritt (✅ Annehmen → ▶️ Reinigung starten → 🏁 Fertig melden). Alles Weitere (🔑 Codes, 📞 Gast anrufen,
📷 Problem melden, 🛒 Etwas fehlt, 📅 Später reinigen, Admin: Anderer Tag, Hinweis zur Wohnung …) liegt unter „⋯ Mehr“.

**Aufbau (Admin)**: Seiten **Reinigungen** (Hauptseite: Handlungsbedarf, Anträge, Heute, Routen, Morgen, 14 Tage, Später,
manuelle Reinigung) · **Kalender** · **Meldungen** (offene Meldungen, Einkaufsliste) · **Statistik** · **Team** (Reinigungsteam
mit Anmeldecodes, gesperrte Anmeldungen) · **Einstellungen** (Zugangscodes, Admin-Code, Push, verschickte Nachrichten,
System & Smoobu, Testphase). Leitung: Reinigungen · Kalender · Team & Meldungen. Abschnitte ohne Inhalt werden nicht angezeigt.

**Rollen** (genau **eine** Reinigungsleitung)
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
- **Doch früher**: Reinigungskraft/Leitung kann einen genehmigten späteren Tag wieder aufheben („Doch früher – Zeitraum
  aufheben“) bzw. einen offenen Antrag zurückziehen. Admin bekommt sofort eine Push-Nachricht mit „Blockierung in Smoobu
  aufheben: … – …“; der Hinweis steht unter „Handlungsbedarf“, bis die Sperrzeit in Smoobu weg ist oder „Blockierung
  aufgehoben ✓“ getippt wird
- **Zeitraum statt fester Tag** (z. B. Check-out 01.10., Reinigung am 01. oder 02.10.): Reinigungsleitung/Mitarbeiterin tippt
  „Späteren Tag beantragen“, wählt den letzten möglichen Tag und schreibt eine kurze Begründung → Admin bekommt den Antrag
  (Push + oben „Anträge“) und genehmigt oder lehnt ab. Der Admin kann den Zeitraum auch direkt festlegen, ändern oder aufheben
  (für Smoobu- und manuelle Reinigungen). Auch am späteren Tag gilt: bis 15 Uhr erledigt (steht im Formular und in den
  Nachrichten). Erinnerungen 12/15 Uhr gelten dann erst am letzten Tag. Grenzen: höchstens
  `maxPeriodDays` (7) Tage und **nur Tage, an denen die Wohnung laut Smoobu frei ist** (in der Nacht davor kein anderer
  Gast). Sperrzeiten zählen nicht – sie werden oft extra für die Reinigung eingetragen. Der Anreisetag des nächsten Gastes ist noch möglich (bis 15 Uhr, vor dem Check-in). Bei
  Wechseltag (Anreise am Check-out-Tag) ist kein Antrag möglich; die App zeigt den Grund. Kommt später eine Buchung in einen genehmigten Zeitraum, wird er sofort verkürzt/aufgehoben und
  Team + Admin bekommen eine Push-Nachricht; offene Anträge, die nicht mehr passen, entfallen. Ändert Smoobu den Check-out,
  entfällt der Zeitraum (neu beantragen/festlegen). Im Kalender als gestrichelte Linie, offener Antrag mit „?“.
- Viele gleichartige Nachrichten werden zu einer Sammelnachricht gebündelt
- Zeiten und Abstand einstellbar in `worker/src/config.js` (`startBy`, `finishBy`, `repeatMinutes`, `quietFrom`)

**Weiteres**
- „Neuigkeiten“ oben: was sich geändert hat (neu, zugewiesen, verlängert/verkürzt, verschoben, abgesagt, Hinweise)
- Telefonnummer des Gastes aus Smoobu als Anruf-Knopf (`showGuestPhone` in `config.js`)
- Hinweise/Meldungen mit bis zu 5 Fotos (Kamera oder Galerie, Vorschau mit Entfernen, eigene Fotos löschbar, Galerie-Ansicht)
- Beginn und Ende der Reinigung mit Dauer
- **Reinigung abschließen** als eigener Vollbild-Ablauf (man landet nicht versehentlich bei einer anderen Reinigung):
  1. Checkliste (Pflicht) 2. Fotos/Videos 3. Was ist knapp 4. Was wurde gemacht 5. Gästeschlüssel (Pflicht).
  Fotos/Videos/Text werden als „Abschlussbericht“ gespeichert (kein offenes Problem). Admin bekommt
  **„Wohnung fertig: … – Fertig um 11:40 Uhr“** mit nächster Anreise und Gästezahl
- **Videos** bei Meldungen und beim Abschluss (max. 2 je Meldung, je 40 MB ≈ 30 Sek.), in der D1-Datenbank in Stücken
  gespeichert und mit „Range“ abspielbar (iPhone); werden wie Fotos nach 45 Tagen gelöscht
- **Admin verschiebt jede Reinigung** („📅 Verschieben“, auch aus Smoobu, z. B. eine Woche nach Check-out; nicht nach der
  nächsten Anreise). Hinweis „⚠ In Smoobu blockieren: … – …“, bis dort eine passende Sperrzeit angekommen ist
- **Alle Datumsänderungen** (Admin verschiebt, Check-out früher/später in Smoobu) gehen als **wichtige** Push-Nachricht mit
  Anzahl Tage an Reinigungsleitung und zugewiesene Mitarbeiterin; auf der Karte „⚠ Datum geändert – vorher …“ bis zur
  neuen Bestätigung. Hat der Admin die Reinigung auf einen späteren Tag gelegt, bleibt dieser, solange er nach dem neuen
  Check-out liegt
- **Statistik (Admin)** – gezählt werden nur die 13 nummerierten Wohnungen (#EINS–#DREIZEHN); weitere Einheiten in Smoobu
  werden als „nicht mitgezählt“ angezeigt. Verlauf standardmäßig 3 Monate, per Knopf je 3 Monate weiter zurück.
  Läuft automatisch (jeder Abgleich hält den heutigen Wert fest); „Rückwirkend berechnen“ nur einmalig bzw. nach
  nachträglichen Änderungen in Smoobu. Zwei Kennzahlen getrennt: **Tatsächliche Belegung** je Nacht (rückblickend, Ø letzte 30 Nächte,
  aus dem endgültigen Buchungsstand) und den **Vorausblick** – Kern-KPI **Auslastung der nächsten 30 Nächte inkl. Blockierungen** (gebuchte + blockierte Nächte ÷
  Wohnungen × 30), Veränderung ggü. vor 7/30 Tagen, Verlauf als Diagramm (Tooltip), je Wohnung, Tabelle. Wird bei jedem
  Abgleich für den heutigen Tag festgehalten. **Rückwirkend** („Rückwirkend berechnen“): holt die Buchungen der letzten
  Monate aus Smoobu (bis 1,5 Jahre, in Abschnitten zu 60 Tagen wegen der Rechenzeit-Grenze) und rechnet mit dem
  Eintragungsdatum (`created-at`) je Tag nach, was damals schon gebucht/blockiert war;
  stornierte Buchungen zählen bis zum Storno (Änderungsdatum), Einträge ohne Eintragungsdatum (z. B. Sperrzeiten) zählen als
  schon vorhanden. Echte Tageswerte des Vorausblicks werden nie überschrieben; die tatsächliche Belegung wird immer neu berechnet
- **Auswertung nach Wohnungsgröße** (Statistik): Auslastung der nächsten 30 Nächte je Größe – Balken = gebucht (Nachfrage),
  daneben inkl. Blockierungen, Strich = Durchschnitt; „läuft gut/schwach“ (±10 Punkte) und Wohnungen deutlich unter dem
  Schnitt ihrer Gruppe. Größe: fest hinterlegt in `worker/src/config.js` (`sizeByNumber`: 1 Zimmer = Wohnungen 1, 2, 4, 7, 8,
  10, 11, 12; 3 Zimmer = 3, 5, 6, 9, 13), sonst aus Smoobu; unter „Kategorien festlegen“ in der App überschreibbar
- **Empfohlene Route je Tag** (heute + morgen): Mitarbeiterin sieht ihre Route, Admin/Leitung je Person. Reihenfolge:
  1. Wohnungen mit Anreise am selben Tag (nach Check-in-Zeit) 2. übrige Pflicht-Reinigungen nach kürzestem Weg
  (gleiches Haus direkt hintereinander) 3. Reinigungen mit Zeitraum („kann auch bis …“) zum Schluss. Mit Entfernungen und
  Knopf „Route in Google Maps öffnen“. Koordinaten der Adressen (aus `access-codes.js`) holt der Server einmalig über
  OpenStreetMap (max. 2 je Lauf) und speichert sie; Ort in `worker/src/config.js` (`routeCity`)
- **Wohnungs-Details** (nur Admin): Wohnungsnamen (ⓘ) bei der Reinigung oder links im Kalender antippen → öffentlicher Name, Adresse und
  Link zur Website mit „📋 Link kopieren“ / „🌐 Öffnen“ (`apartmentDetails` in `worker/src/config.js`)
- **Hinweis zur Wohnung** („📌“, Admin): individueller Übergabe-Hinweis je Wohnung, steht bei jeder Reinigung dieser Wohnung
  und im Abschluss-Ablauf
- **Checkliste** vor dem Beenden: derzeit abgeschaltet; bei Bedarf Punkte in `logic/logic.js` (`checklist`) eintragen
- **Zu früh gestartet?** Wer vor dem Reinigungstag oder vor der Check-out-Uhrzeit (aus Smoobu, sonst `checkoutTime` 10:00)
  auf „Reinigung starten“ tippt, bekommt die Sicherheitsfrage „Trotzdem jetzt starten?“
- **„🛒 Knapp melden“**: Artikel antippen (Toilettenpapier, Küchenrolle, Handseife, Spülmittel, Schwämme, Müllbeutel, Kaffee,
  Bettwäsche, Handtücher, Batterien, Glühbirnen; `supplies` in `logic/logic.js`) oder unter „✏️ Sonstiges“ frei eintragen
  (mehrere mit Komma getrennt), auch beim
  Beenden. Admin bekommt eine Push-Nachricht und die **Einkaufsliste** (je Artikel die Wohnungen; „aufgefüllt“ antippen)
- **Ungarisch**: Knopf „🇭🇺 HU“ oben (bzw. auf der Anmeldeseite) – je Person gespeichert. Übersetzungen in
  `worker/public/i18n-hu.js`; Push-Überschriften für diese Personen ebenfalls ungarisch (Text der Nachricht bleibt deutsch)
- **Offline**: App-Seite wird im Gerät gespeichert (`sw.js`), letzter Stand bleibt sichtbar. Bestätigen, Beginn, Beenden
  (inkl. Checkliste/Schlüssel) und „knapp“ werden ohne Netz gemerkt und automatisch gesendet, sobald wieder Netz da ist –
  mit der Uhrzeit vom Gerät. Fotos, Anträge und Zugangscodes brauchen Netz
- **Checkpunkt Schlüssel (Pflicht)**: Beim Beenden muss angegeben werden, ob die Gästeschlüssel in der Box sind (Ja/Nein,
  optional mit Hinweis). Bei „Nein“ sofort dringende Push an den Admin; oben unter „Handlungsbedarf“, bis der Admin
  „Schlüssel geklärt“ tippt
- **Zugangscodes** (Gäste-Code, Service-Schlüsselbox, Lage) je Wohnung: Admin trägt sie unter „Zugangscodes der Wohnungen“
  ein (Tabelle aus Excel/Word einfügen oder von Hand), gespeichert **verschlüsselt in der Datenbank**. Zusätzlich fest
  hinterlegt in `worker/src/access-codes.js` (Zuordnung über das Kürzel „#EINS“ … „#DREIZEHN“ im Smoobu-Namen, sonst
  Adresse); in der App geänderte Codes haben Vorrang. **Diese Datei nur in privaten Repositories führen.**
  Die Lage (Adresse, Stockwerk/Seite) steht direkt auf jeder Reinigungskarte, die Codes nur per Knopf.
  Abruf per Knopf „🔑 Zugangscodes“ bei der Reinigung: Admin, Leitung und die zugewiesene Mitarbeiterin (nur solange die
  Reinigung ansteht bzw. am Tag der Erledigung); jeder Abruf steht im Verlauf, Anzeige verschwindet nach 3 Minuten
- **Schutz der Anmeldung** (je IP-Adresse, auf dem Server gespeichert – Neuladen hilft nicht): 3 Fehlversuche → 1 Min.
  gesperrt, danach je 1 Versuch → 5 Min. → 30 Min. → 60 Min., dann **dauerhaft gesperrt** (Push an Admin). Während einer
  Sperre zeigt die Startseite kein Eingabefeld, nur den Countdown. Admin → „Gesperrte Anmeldungen“ → „Freischalten“ gibt
  sofort wieder 3 Versuche; nach 24 Std. ohne Fehlversuch beginnt die Zählung neu (außer bei dauerhafter Sperre).
  Zusätzlich systemweit: 30 Fehlversuche pro Stunde → Code-Anmeldung 1 Std. gesperrt (Admin kommt über /admin hinein)
- **Gästezahl** aus Smoobu (Erwachsene/Kinder): im Kalender an jeder Buchung (z. B. „2+1 P.“) und bei jeder offenen Reinigung
  als „Nächste Anreise: Fr, 25.09. ab 16:00 Uhr · 2 Erwachsene, 1 Kind“ zur Vorbereitung (Smoobu-Felder `adults`,
  `children`, `check-in`; „Diagnose“ zeigt, bei wie vielen Buchungen die Gästezahl hinterlegt ist)
- **Belegungskalender** (Admin, Leitung): Wohnungen in Reihenfolge 1–13 (Nummer aus dem Namen: „#EINS“ = 1 … „#DREIZEHN“ = 13), Tage fortlaufend, Buchungen mit Gastname und
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
Name `apartment-strauss-team`, **Root directory: `worker`**, Deploy-Befehl `npx wrangler deploy` → *Deploy*.

**3. Geheimnisse eintragen**
Worker `apartment-strauss-team` → *Settings → Variables and Secrets* → *Add* → Typ **Secret**:
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
`https://apartment-strauss-team.<euer-konto>.workers.dev/admin` öffnen → ADMIN_PASSWORD → „Jetzt abgleichen“ (unter „System & Smoobu“).
Unter „Team“ Reinigungskräfte anlegen und die Codes weitergeben.

**5. Pages für die eigene Adresse**
*Workers & Pages → Create → Pages → Import a Git repository* → dasselbe Repository →
Name z. B. `strauss-team-web`, **Root directory: `pages`**, Build-Befehl leer, **Output directory: `public`** → *Deploy*.
Danach *Settings → Bindings → Add → Service binding*: Name **`APP`**, Service **`apartment-strauss-team`** → neu deployen.

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
node --test test/worker.test.js test/bau.test.js ../logic/logic.test.js   # alle Tests
cp .dev.vars.example .dev.vars && npx wrangler dev --test-scheduled
# Abgleich lokal auslösen: http://localhost:8787/__scheduled
```

## Hinweise

- Die Smoobu-Anbindung ist gegen die öffentliche API-Beschreibung gebaut (`/api/reservations` mit `departureFrom`/`departureTo`,
  `showCancellation`). Beim ersten echten Abgleich prüfen, ob alle Buchungen erscheinen.
- ntfy.sh ist ein öffentlicher Dienst: Die Kanalnamen sind zufällig und geheim, die Nachrichten enthalten nur Wohnung und Datum.
- Gästenamen werden den Reinigungskräften standardmäßig nicht angezeigt (`showGuestNames` in `config.js`).
