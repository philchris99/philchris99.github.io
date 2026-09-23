# Team Strauss – Reinigungsplan mit Smoobu

Web-App unter **team.apartments-strauss.de**:
Buchungen aus Smoobu → Endreinigungen → Bestätigung durch die Reinigungskraft → Push-Nachrichten.

```
Smoobu ──(alle 15 Min. + optional Webhook)──▶ Cloudflare Worker „strauss-team“ ──▶ ntfy-Push aufs Handy
                                               │  D1-Datenbank, Fristen 12/13 Uhr
team.apartments-strauss.de ─(CNAME bei goneo)─▶ Cloudflare Pages ──▶ Worker (Web-App + API)
```

| Ordner | Inhalt |
|---|---|
| `logic/` | Die Regeln (neue Buchung, Verlängerung, Storno, Bestätigen, Fristen) mit Tests |
| `worker/` | Server: Smoobu-Abgleich, API, Push, Web-App (`public/`) |
| `pages/` | Nur die Weiterleitung, damit die eigene Subdomain funktioniert |
| `demo/` | Die Testversion mit simulierter Uhrzeit (ohne Server) |

## Funktionen

- **Anmeldung**
  - Reinigungskräfte: auf https://team.apartments-strauss.de mit persönlichem **6-stelligem Code** (bleibt auf dem Handy angemeldet)
  - Auftraggeber: ebenfalls mit eigenem **6-stelligen Admin-Code** auf der Startseite (einmalig festlegen unter „Team → Mein Admin-Code“);
    Notzugang ohne Code: **https://team.apartments-strauss.de/admin** mit `ADMIN_PASSWORD`
  - Nach 8 Fehlversuchen 15 Minuten Sperre
- **Team** (in der Admin-Ansicht): Reinigungskräfte anlegen, zuständige Wohnungen wählen, Code erzeugen
  (wird nur einmal angezeigt, nur als Hash gespeichert), neuer Code = alte Geräte abgemeldet, entfernen
- **Startseite Auftraggeber**: Kacheln (Check-outs heute, unbestätigt, Meldungen, Alarme), Handlungsbedarf, Heute, Meldungen, Morgen, 14 Tage
- **Startseite Reinigungskraft**: „Neu – bitte bestätigen“ (rot markiert), „Als Nächstes“, Plan nach Tagen; erledigte bleiben grau sichtbar
- Jede Reinigung zeigt, **wann** und **wie** sie eingetragen wurde (automatisch aus Smoobu / manuell) und ggf. Datumsänderung
- **Meldungen** mit Text + bis zu 5 Fotos (Galerie mit Wischen), Push an Auftraggeber, „Als behoben markieren“
- **Manuelle Reinigungen** inkl. Push an die Reinigungskraft, absagbar
- **Testphase**: „Alles zurücksetzen“ (Eingabe ZURÜCKSETZEN); Team bleibt erhalten. Danach `allowReset: false` in `worker/src/config.js`.

## Design / Logo

Farben und Schriften stehen ganz oben in `worker/public/index.html` (Block „MARKE“).
Logo: `worker/public/logo.svg` durch das echte Logo ersetzen (SVG oder PNG; bei PNG den Dateinamen in `index.html` anpassen).
Es werden bewusst keine Google Fonts geladen (Datenschutz).

## Einstellungen ändern

In `worker/src/config.js`: Reinigungskräfte, deren zuständige Wohnungen, Uhrzeiten, Gastnamen ein/aus.
Einen persönlichen Link sperren: bei der Person `version` um 1 erhöhen → neuer Link und neuer Push-Kanal.

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
Ohne Webhook kommen Änderungen spätestens nach 15 Minuten an.

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
