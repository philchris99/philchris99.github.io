// Gästeanfragen: Nachrichten aus Smoobu nach Themen sortieren (Grundlage für automatische Antworten).
// Erkennung über Stichwörter (Deutsch, Englisch und einige Wörter anderer Sprachen) – schnell und
// ohne externe Dienste. Eine Nachricht kann mehrere Themen haben.

export const CATEGORIES = [
  { id: 'checkin', label: 'Anreise-Uhrzeit / früher einchecken',
    re: /check[\s-]?in|einchecken|anreise|ankunft|ankommen|arriv|kommen[^?!\n]{0,30}\ban\b|früher|early|eher da|what time can we|ab wann|érkez|bejelentkez/ },
  { id: 'checkout', label: 'Abreise / später auschecken',
    re: /check[\s-]?out|auschecken|abreise|late check|später raus|länger bleiben|stay longer|\bleav(e|ing)\b|verlassen|until when|bis wann|kijelentkez|távoz/ },
  { id: 'access', label: 'Schlüssel, Schlüsselbox & Zugang',
    re: /schlüssel|schluessel|key|code|box|tresor|zugang|tür |türe|door|reinkommen|get in|klingel|\bbell\b|entrance|eingang|kulcs|ajtó/ },
  { id: 'directions', label: 'Adresse, Anfahrt & Wohnung finden',
    re: /adresse|address|anfahrt|wegbeschreibung|direction|finden|find the|welche(s|r)? (stock|etage|haus|gebäude)|which (floor|building)|stockwerk|etage|floor|haltestelle|bahnhof|station|taxi|flughafen|airport|cím/ },
  { id: 'parking', label: 'Parken',
    re: /park|garage|stellplatz|auto |\bcar\b|fahrzeug|wohnmobil|motorrad|parkol/ },
  { id: 'wifi', label: 'WLAN / Internet',
    re: /wlan|w-lan|wifi|wi-fi|internet|router|passwort|password|netz/ },
  { id: 'luggage', label: 'Gepäck abstellen',
    re: /gepäck|gepaeck|koffer|luggage|baggage|suitcase|bags? |csomag|bőrönd/ },
  { id: 'invoice', label: 'Rechnung / Beleg',
    re: /rechnung|invoice|receipt|quittung|beleg|firmen|company|ust-id|\bvat\b|számla/ },
  { id: 'payment', label: 'Bezahlung, Preis & Kaution',
    re: /bezahl|zahlung|zahlen|pay|überweis|transfer|kaution|deposit|preis|price|kosten|cost|rabatt|discount|kurtaxe|city tax|bettensteuer|tourist tax|fizet/ },
  { id: 'change', label: 'Buchung ändern, verlängern oder stornieren',
    re: /storn|cancel|umbuch|verläng|verlaeng|extend|extra night|weitere nacht|zusätzliche nacht|änder|aender|change|verschieb|datum|\bdates?\b|lemond|módosít/ },
  { id: 'guests', label: 'Personenzahl, Kinderbett & Zusatzbett',
    re: /kinderbett|babybett|reisebett|crib|\bcot\b|hochstuhl|high chair|zustellbett|extra bed|schlafsofa|sofa bed|personen|persons?|people|gäste|guests|\bkind(er)?\b|child|baby|gyerek/ },
  { id: 'pets', label: 'Haustiere',
    re: /\bhund|\bdogs?\b|haustier|\bpets?\b|katze|\bcats?\b|kutya|macska/ },
  { id: 'amenities', label: 'Ausstattung (Handtücher, Küche, Waschmaschine …)',
    re: /handt|towel|bettwäsche|bed linen|sheets|waschmaschine|washing|wäsche|laundry|trockner|dryer|föhn|fön|hair ?dryer|bügel|iron|küche|kitchen|kaffee|coffee|herd|stove|backofen|oven|mikrowelle|microwave|geschirr|dish|\btv\b|fernseh|netflix|balkon|balcony|aufzug|lift|elevator|törölköző|mosógép/ },
  { id: 'problem', label: 'Problem / Defekt / Beschwerde',
    re: /funktioniert nicht|geht nicht|not working|doesn'?t work|does not work|kaputt|broken|defekt|problem|dreckig|schmutzig|dirty|unclean|kein warm|no hot|kalt|cold|heizung|heating|klima|air ?con|lärm|noise|noisy|verstopft|blocked|leak|undicht|schimmel|mould|mold|ungeziefer|bugs|beschwerde|complain|nem működik|piszkos/ },
  { id: 'tips', label: 'Tipps: Restaurants, Einkaufen, Ausflüge',
    re: /restaurant|empfehl|recommend|tipp|tip |einkauf|supermarkt|supermarket|grocery|bäcker|bakery|sehenswürd|sightseeing|ausflug|what to do|essen gehen|ajánl/ },
  { id: 'registration', label: 'Meldeschein / Ausweis / Online-Check-in',
    re: /meldeschein|ausweis|reisepass|passport|id card|personalausweis|formular|\bform\b|registrier|registration|online[\s-]?check|dokument|document/ },
  { id: 'lost', label: 'Vergessene Gegenstände',
    re: /vergessen|liegen gelassen|forgot|left behind|lost|verloren|fundsache|elfelejt/ },
  { id: 'thanks', label: 'Nur Dank / Bestätigung (keine Anfrage)', noise: true,
    re: /^(ok|okay|super|perfekt|perfect|great|danke|vielen dank|thanks?|thank you|merci|köszönöm|top|alles klar|passt|gerne|👍|🙏|😊)[\s!.,:)]*(\S+[\s!.,]*){0,6}$/ },
];

const ORDER = Object.fromEntries(CATEGORIES.map((c, i) => [c.id, i]));

/** Klartext aus einer Smoobu-Nachricht: HTML weg, zitierte Vorgänger-Nachrichten abschneiden */
export function cleanMessage(raw) {
  let t = String(raw || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const cut = t.search(/\n\s*>|\n[^\n]{0,80}(wrote|schrieb|írta)\s*:|-{3,}\s*(original|ursprüngliche)|\n\s*(von|from):\s/i);
  if (cut > 0) t = t.slice(0, cut);
  return t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
}

/** Persönliche Angaben für Beispiele und KI-Auswertung unkenntlich machen */
export function mask(text) {
  return String(text || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[E-Mail]')
    .replace(/https?:\/\/\S+/g, '[Link]')
    .replace(/\+?\d[\d\s/().-]{6,}\d/g, '[Nummer]');
}

/** Strenger für den Export: zusätzlich Zahlen (Codes, Hausnummern) und Wörter nach „Passwort/Code/PIN“ */
export function maskStrict(text) {
  return mask(text)
    .replace(/((?:passwor[dt]|kennwort|pw|code|pin|wlan|wifi|wi-fi|ssid|netzwerk|network|jelszó)\s*[:=]?\s*)[^\s,;.]+/gi, '$1[…]')
    .replace(/\b[A-Za-z]{0,2}\d{3,}[A-Za-z]{0,2}\b/g, '[Zahl]');
}

/** Themen einer Gastnachricht (leer = nicht erkannt) */
export function classify(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ').trim() + ' ';
  const trimmed = t.trim();
  if (!trimmed) return [];
  const hits = CATEGORIES.filter((c) => !c.noise && c.re.test(t)).map((c) => c.id);
  if (!hits.length && CATEGORIES.find((c) => c.id === 'thanks').re.test(trimmed)) return ['thanks'];
  return hits;
}

/** Kurzer Ausschnitt rund um die Fundstelle (für Beispiele) */
export function snippet(text, cat) {
  const clean = mask(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= 180) return clean;
  const c = CATEGORIES.find((x) => x.id === cat);
  const m = c && clean.toLowerCase().match(c.re);
  const at = m ? Math.max(0, m.index - 60) : 0;
  return (at ? '… ' : '') + clean.slice(at, at + 180).trim() + ' …';
}

/** Zeitpunkt der Nachricht relativ zum Aufenthalt */
export function phaseOf(created, arrival, departure) {
  const d = String(created || '').slice(0, 10);
  if (!d || !arrival) return 'unbekannt';
  if (d < arrival) return 'vorher';
  if (!departure || d <= departure) return 'während';
  return 'nachher';
}

/** Richtung: true = vom Gast, false = von uns, null = unbekannt (Smoobu: type 1 = Posteingang, 2 = Postausgang) */
export function inboundOf(m) {
  const t = m && (m.type ?? m.messageType ?? m.direction);
  if (t === 1 || t === '1' || /^(in|inbox|incoming|guest)/i.test(String(t))) return true;
  if (t === 2 || t === '2' || /^(out|outbox|outgoing|host)/i.test(String(t))) return false;
  return null;
}

export const categoryOrder = (id) => (id in ORDER ? ORDER[id] : 99);
export const labelOf = (id) => (CATEGORIES.find((c) => c.id === id) || { label: id === 'other' ? 'Nicht erkannt' : id }).label;
