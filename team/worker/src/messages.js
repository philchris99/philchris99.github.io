// Nachrichten an Gäste: Rauschen erkennen, Sprache, Antwortentwürfe nach Vorlagen (DE/EN),
// Hinweise aus dem Reinigungsplan (früher Check-in, später Check-out, Verlängerung) und
// Dokumente (Rechnung, Wohnungsgeberbestätigung) als druckbare Seiten.
import { classify, CATEGORIES } from './inquiries.js';

// ---- Rauschen: Abwesenheitsnotizen, Systemmails, Reaktionen – brauchen keine Antwort ----
const NOISE = [
  /outside (of )?(normal |our )?(working|business|office) hours/i, /out of (the )?office/i, /abwesenheitsnotiz/i,
  /nicht im (haus|büro)|bin (derzeit|aktuell|zurzeit) (nicht erreichbar|abwesend|im urlaub)/i,
  /automatische antwort|automatic reply|auto-?reply|this is an automated|dies ist eine automatische/i,
  /marked as no reply needed/i, /hat mit .{1,6} auf folgende nachricht/i, /reacted .{1,6} to (your|a) message/i,
  /^erinnerung: check-in informationen/i, /we confirm receipt of your invoice/i,
];
export function isNoise(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return NOISE.some((re) => re.test(t));
}

/** Braucht die Nachricht eine Antwort? (nein: Rauschen oder nur Dank/Bestätigung) */
export function needsReply(text, topics) {
  if (isNoise(text)) return false;
  const tp = topics || classify(text);
  if (tp.length === 1 && tp[0] === 'thanks') return false;
  return String(text).trim().length > 1;
}

// ---- Sprache (grob): de / en / other ----
const DE = /\b(und|ich|wir|die|der|das|nicht|bitte|ist|sie|wie|mit|für|danke|hallo|guten|gibt|kann|können|wohnung|schlüssel)\b/gi;
const EN = /\b(the|and|we|you|is|please|thank|thanks|can|hello|hi|would|our|for|could|what|where|key|apartment)\b/gi;
export function language(texts) {
  const t = [].concat(texts).join(' ');
  const de = (t.match(DE) || []).length, en = (t.match(EN) || []).length;
  if (!de && !en) return /[äöüß]/i.test(t) ? 'de' : 'other';
  if (de >= en) return 'de';
  // Spanisch, Französisch usw. enthalten kaum englische Wörter
  return en >= 2 || t.length < 40 ? 'en' : 'other';
}

/** Vorname für die Anrede („Familie Müller“ → ganz, „Anna Schmidt“ → Anna) */
export function greetName(guest) {
  const g = String(guest || '').trim();
  if (!g) return '';
  if (/^(familie|family|herr|frau|mr\.?|mrs\.?|ms\.?|dr\.?)\s/i.test(g) || /gmbh|ag\b|kg\b|ltd|e\.?\s?v\./i.test(g)) return g;
  return g.split(/\s+/)[0];
}

/** Gewünschte Uhrzeit aus dem Text (erste Angabe), als „HH:MM“ */
export function requestedTime(text) {
  const t = String(text || '').toLowerCase();
  let m = t.match(/\b(\d{1,2}):(\d{2})(?:\s*(am|pm)\b)?/) || t.match(/\b(\d{1,2})\.(\d{2})\s*(uhr)\b/) || t.match(/\b(\d{1,2})\s*(uhr|h\b|am\b|pm\b|o'?clock)/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] && /^\d{2}$/.test(m[2]) ? Number(m[2]) : 0;
  const ampm = m[3] || (/am|pm/.test(m[2] || '') ? m[2] : '');
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const REGISTRATION = /wohnungsgeber|landlord confirmation|confirmation (letter )?from (my |the |your )?landlord|landlord('s)? (letter|certificate)|bürgeramt|meldebehörde|resident registration|city registration|anmelde(bestätigung|termin)|registration appointment/i;
/** Themen inkl. Sonderfall Wohnungsgeberbestätigung */
export function topicsOf(text) {
  const tp = classify(text);
  if (REGISTRATION.test(text) && !tp.includes('wgb')) tp.unshift('wgb');
  return tp;
}
export const TOPIC_LABELS = { ...Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label])), wgb: 'Wohnungsgeberbestätigung', other: 'Sonstiges' };

// ---- Hinweise aus Reinigungsplan und Buchungen ----
/**
 * facts: { apartmentId, arrival, departure, today, tasks: [{apartmentId,date,status}], reservations: [{id,apartmentId,arrival,departure}], bookingId }
 * → { sameDayCleaning, cleaningDone, nextArrival, freeUntil, sameDayArrival }
 */
export function planFacts(f) {
  const active = (t) => t.status !== 'storniert' && t.status !== 'cancelled';
  const clean = (f.tasks || []).find((t) => t.apartmentId === f.apartmentId && t.date === f.arrival && active(t) && t.id !== f.bookingId);
  const later = (f.reservations || []).filter((r) => r.apartmentId === f.apartmentId && r.id !== f.bookingId && r.arrival >= f.departure)
    .sort((a, b) => (a.arrival < b.arrival ? -1 : 1));
  const next = later[0] || null;
  return {
    sameDayCleaning: !!clean, cleaningDone: !!(clean && /erledigt|done/.test(String(clean.status))),
    nextArrival: next ? next.arrival : null, sameDayArrival: !!(next && next.arrival === f.departure),
  };
}

// ---- Vorlagen: je Thema ein Absatz in Deutsch und Englisch ----
const fmtDay = (iso, lang) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return lang === 'de' ? `${d}.${m}.${y}` : `${d}/${m}/${y}`;
};
const fee = (v, lang) => (v ? (lang === 'de' ? ` (Aufpreis ${v})` : ` (surcharge ${v})`) : '');

/**
 * Entwurf nach Regeln. ctx: { lang, guest, topics, text (letzte Gastnachricht), phase, s (Einstellungen), plan, guestLink,
 *   arrival, departure }
 */
export function templateDraft(ctx) {
  const lang = ctx.lang === 'de' ? 'de' : 'en';
  const s = ctx.s || {};
  const de = lang === 'de';
  const name = greetName(ctx.guest);
  const p = [];
  const link = ctx.guestLink ? (de ? `\n${ctx.guestLink}` : `\n${ctx.guestLink}`) : '';
  const cin = s.checkin || '15:00', cout = s.checkout || '10:00';
  const plan = ctx.plan || {};
  const want = requestedTime(ctx.text);
  const done = new Set();
  const add = (id, text) => { if (!done.has(id) && text) { done.add(id); p.push(text); } };
  for (const t of ctx.topics || []) {
    if (t === 'checkin' && ctx.phase !== 'nachher') {
      let x;
      if (want && (want >= cin || want < '06:00')) {
        x = de ? `eine Anreise um ${want} Uhr ist kein Problem – die Schlüsselbox ist rund um die Uhr zugänglich.`
          : `arriving at ${want} is no problem – the key box is accessible around the clock.`;
      } else if (want && !plan.sameDayCleaning) {
        x = de ? `ein früherer Check-in ab ${want} Uhr ist möglich, die Wohnung ist an dem Tag bereits frei${fee(s.earlyFee, lang)}.`
          : `an early check-in from ${want} is possible, the apartment is already free that day${fee(s.earlyFee, lang)}.`;
      } else if (want) {
        x = de ? `am Anreisetag wird die Wohnung vorher noch gereinigt. Ein früherer Check-in ist daher erst nach der Reinigung möglich${fee(s.earlyFee, lang)} – wir geben dir am Anreisetag Bescheid, sobald die Wohnung fertig ist. Regulär ist der Check-in ab ${cin} Uhr.`
          : `on your arrival day the apartment is cleaned first, so an early check-in is only possible once cleaning is done${fee(s.earlyFee, lang)} – we will let you know on the day as soon as it is ready. Regular check-in is from ${cin}.`;
      } else {
        x = de ? `der Check-in ist ab ${cin} Uhr möglich, die Schlüsselbox ist rund um die Uhr zugänglich – du kannst also auch später anreisen.`
          : `check-in is possible from ${cin}, and the key box is accessible around the clock – so arriving later is no problem.`;
      }
      add(t, x + (ctx.guestLink ? (de ? ` Alle Infos zur Anreise (Adresse, Schlüsselbox, Parken) findest du hier:${link}` : ` You will find all arrival details (address, key box, parking) here:${link}`) : ''));
    } else if (t === 'access') {
      add(t, (de ? `alle Infos zum Zugang findest du in deinem Gäste-Link – dort ist genau beschrieben, wo die Schlüsselbox ist und wie sie sich öffnen lässt:${link || ' [Gäste-Link]'}`
        : `you will find everything about access in your guest link – it describes exactly where the key box is and how to open it:${link || ' [guest link]'}`)
        + (s.doorTip ? `\n${s.doorTip}` : '')
        + (s.phone ? (de ? `\nWenn es trotzdem nicht klappt, ruf uns bitte an: ${s.phone}` : `\nIf it still doesn't work, please call us: ${s.phone}`) : ''));
    } else if (t === 'checkout') {
      let x = de ? `der Check-out ist bis ${cout} Uhr. ` : `check-out is by ${cout}. `;
      if (plan.sameDayArrival) x += de ? 'Leider reist am selben Tag der nächste Gast an, deshalb ist ein späterer Check-out diesmal nicht möglich.' : 'Unfortunately the next guests arrive the same day, so a late check-out is not possible this time.';
      else x += de ? `Ein späterer Check-out ist möglich${fee(s.lateFee, lang)} – bis wann brauchst du die Wohnung?` : `A late check-out is possible${fee(s.lateFee, lang)} – until what time would you need the apartment?`;
      add(t, x);
    } else if (t === 'luggage') {
      add(t, s.luggage || (de ? 'dein Gepäck kannst du gerne [bitte ergänzen: wo/bis wann] abstellen.' : 'you are welcome to leave your luggage [please add: where/until when].'));
    } else if (t === 'invoice') {
      add(t, de ? 'gerne stellen wir dir eine Rechnung aus. Falls sie auf eine Firma laufen soll, schick uns bitte die vollständige Rechnungsadresse (Firmenname, Straße, PLZ, Ort, ggf. USt-IdNr.). Die Rechnung bekommst du nach deiner Abreise als Link per Nachricht.'
        : 'we are happy to issue an invoice. If it should be made out to a company, please send us the full billing address (company name, street, postcode, city, VAT ID if applicable). You will receive the invoice as a link by message after your departure.');
    } else if (t === 'wgb') {
      add(t, de ? 'gerne stellen wir dir eine Wohnungsgeberbestätigung für das Bürgeramt aus. Bitte schick uns dafür von allen Personen, die sich anmelden, den vollständigen Namen (Vor- und Nachname) und das Geburtsdatum.'
        : 'we are happy to provide the landlord confirmation (Wohnungsgeberbestätigung) for the registration office. Please send us the full name (first and last name) and date of birth of everyone who is registering.');
    } else if (t === 'parking') {
      if (!s.parking && done.has('checkin') && ctx.guestLink) add(t, de ? 'Infos zum Parken stehen ebenfalls im Link oben.' : 'Parking information is also in the link above.');
      else add(t, s.parking || (de ? `Infos zum Parken findest du in deinem Gäste-Link:${link || ' [Gäste-Link]'}` : `You will find parking information in your guest link:${link || ' [guest link]'}`));
    } else if (t === 'wifi') {
      add(t, s.wifi || (de ? `die WLAN-Daten stehen in deinem Gäste-Link:${link || ' [Gäste-Link]'} Wenn das WLAN nicht funktioniert, starte bitte einmal den Router neu (Stecker 10 Sekunden ziehen) und gib uns Bescheid, falls es danach immer noch nicht geht.`
        : `the Wi-Fi details are in your guest link:${link || ' [guest link]'} If the Wi-Fi is not working, please restart the router once (unplug it for 10 seconds) and let us know if it still doesn't work.`));
    } else if (t === 'problem' || t === 'amenities') {
      if (t === 'amenities' && !/nicht|kein|kaputt|defekt|funktion|not |no |broken|doesn|don't|dirty|schmutz|kalt|cold/i.test(ctx.text || '')) {
        add('amenities', de ? 'danke für deine Frage – [bitte ergänzen].' : 'thanks for your question – [please add].');
      } else {
        add('problem', de ? 'das tut uns sehr leid – danke, dass du uns Bescheid gibst! Wir kümmern uns sofort darum und melden uns in Kürze mit einer Lösung.'
          : 'we are very sorry about that – thank you for letting us know! We will take care of it right away and get back to you shortly.');
      }
    } else if (t === 'change') {
      let x = de ? 'danke für deine Nachricht. ' : 'thank you for your message. ';
      if (/verläng|extend|länger|longer|weitere nacht|extra night/i.test(ctx.text || '')) {
        x += plan.nextArrival
          ? (de ? `Eine Verlängerung ist bis zum ${fmtDay(plan.nextArrival, lang)} möglich, danach ist die Wohnung wieder belegt. ` : `An extension is possible until ${fmtDay(plan.nextArrival, lang)}; after that the apartment is booked again. `)
          : (de ? 'Eine Verlängerung ist nach aktuellem Stand möglich. ' : 'An extension should be possible as things stand. ');
        x += de ? 'Wie lange möchtest du verlängern? [bitte ergänzen: Preis/Buchungsweg]' : 'How long would you like to extend? [please add: price/how to book]';
      } else x += de ? '[bitte ergänzen]' : '[please add]';
      add(t, x);
    } else if (t === 'guests') {
      const f = ctx.facts || null;
      const txt = ctx.text || '';
      const parts = [];
      if (/baby|kinderbett|reisebett|crib|\bcot\b|hochstuhl|high ?chair|wickel|changing/i.test(txt)) {
        if (f && f.baby) parts.push(de ? `in der Wohnung gibt es ${f.baby.replace(/, ([^,]+)$/, ' und $1')} – wir stellen alles gerne für euch bereit.`
          : `the apartment has a baby cot, high chair and changing table – we are happy to set everything up for you.`);
        else if (f) parts.push(de ? 'leider gibt es in dieser Wohnung kein Babybett. [bitte ergänzen: Alternative, z. B. Reisebett mitbringen]' : 'unfortunately this apartment has no baby cot. [please add: alternative, e.g. bring a travel cot]');
        else parts.push(s.cot || (de ? 'ein Kinderbett stellen wir gerne bereit – [bitte ergänzen].' : 'we are happy to provide a baby cot – [please add].'));
      }
      if (f && f.beds && /\bbett(en)?\b|\bbeds?\b|schlafpl|schlafsofa|sofa ?bed|sleep|\bdecken?\b|duvet|blanket|wie viele personen|how many (people|persons|guests)/i.test(txt)) {
        parts.push((de ? 'zu den Betten: ' : 'the beds: ') + (de ? f.beds : f.beds.replace(/Schlafzimmer/g, 'bedroom').replace(/Ersatzzimmer/g, 'second room').replace(/Schlafsofa/g, 'sofa bed')
          .replace(/große Decke/g, 'large duvet').replace(/kleine Decken?/g, (m) => (m.endsWith('n') ? 'small duvets' : 'small duvet'))) + '.');
      }
      add(t, parts.map((x, i) => (i ? x.charAt(0).toUpperCase() + x.slice(1) : x)).join('\n') || (de ? 'danke für deine Nachricht – [bitte ergänzen].' : 'thanks for your message – [please add].'));
    } else if (t === 'lost') {
      add(t, de ? 'danke für die Info – wir schauen nach und melden uns bei dir.' : 'thanks for letting us know – we will check and get back to you.');
    } else if (t === 'directions') {
      add(t, de ? `die genaue Anfahrt mit Fotos findest du in deinem Gäste-Link:${link || ' [Gäste-Link]'}` : `the exact directions with photos are in your guest link:${link || ' [guest link]'}`);
    } else if (t === 'tips') {
      add(t, s.tips || (de ? 'ein paar Tipps für die Umgebung findest du auch in deinem Gäste-Link. [bitte ergänzen]' : 'you will also find some tips for the area in your guest link. [please add]'));
    }
  }
  if (!p.length) p.push(de ? 'danke für deine Nachricht! [bitte ergänzen]' : 'thank you for your message! [please add]');
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const hello = de ? `Hallo${name ? ' ' + name : ''},` : `Hi${name ? ' ' + name : ''},`;
  const sig = (de ? s.signatureDe : s.signatureEn) || (de ? 'Liebe Grüße\nLea\nApartments Strauss' : 'Best regards\nLea\nApartments Strauss');
  return `${hello}\n\n${p.map(cap).join('\n\n')}\n\n${sig}`;
}

/** Anweisung für die KI (Workers AI) – Wissen, Fakten, Verlauf, Vorlage und frühere echte Antworten */
export function aiPrompt(ctx) {
  const s = ctx.s || {};
  const langName = { de: 'Deutsch (Du-Form, außer der Gast siezt)', en: 'Englisch' }[ctx.lang] || 'in der Sprache, in der der Gast schreibt';
  const facts = [
    `Wohnung: ${ctx.apartmentName || ''}${ctx.address ? ', ' + ctx.address : ''}`,
    `Gast: ${ctx.guest || ''} · Aufenthalt ${ctx.arrival || '?'} bis ${ctx.departure || '?'} · Zeitpunkt: ${ctx.phase || ''}`,
    `Check-in ab ${s.checkin || '15:00'} Uhr (Schlüsselbox rund um die Uhr), Check-out bis ${s.checkout || '10:00'} Uhr`,
    s.earlyFee ? `Früher Check-in: ${s.earlyFee}` : '', s.lateFee ? `Später Check-out: ${s.lateFee}` : '',
    ctx.plan && ctx.plan.sameDayCleaning ? 'Am Anreisetag wird die Wohnung vorher gereinigt (früher Check-in erst nach der Reinigung).' : 'Am Anreisetag ist keine Reinigung geplant – früher Check-in ist möglich.',
    ctx.plan && ctx.plan.sameDayArrival ? 'Am Abreisetag reist direkt der nächste Gast an – kein später Check-out.' : '',
    ctx.plan && ctx.plan.nextArrival ? `Nächste Anreise in dieser Wohnung: ${ctx.plan.nextArrival}` : '',
    ctx.guestLink ? `Gäste-Link mit allen Infos (Anfahrt, Schlüsselbox, WLAN, Parken): ${ctx.guestLink}` : 'Gäste-Link: [Gäste-Link]',
    s.parking ? `Parken: ${s.parking}` : '', s.wifi ? `WLAN: ${s.wifi}` : '', s.luggage ? `Gepäck: ${s.luggage}` : '', s.cot ? `Kinderbett: ${s.cot}` : '',
    s.phone ? `Telefon für Notfälle: ${s.phone}` : '',
    ctx.facts && ctx.facts.beds ? `Betten/Decken: ${ctx.facts.beds}` : '',
    ctx.facts ? `Babyausstattung: ${ctx.facts.baby || 'keine (kein Babybett, kein Hochstuhl)'}` : '',
  ].filter(Boolean).join('\n');
  const convo = (ctx.history || []).slice(-10).map((m) => `${m.inbound ? 'GAST' : 'WIR'} (${String(m.created || '').slice(0, 16)}): ${m.text.slice(0, 600)}`).join('\n');
  const examples = (ctx.examples || []).slice(0, 3).map((e, i) => `Beispiel ${i + 1}\nGAST: ${e.q}\nWIR: ${e.a}`).join('\n\n');
  return `Du schreibst Antworten für „Apartments Strauss“ (Ferienwohnungen in Braunschweig) an Gäste. Die Antwort wird vor dem Versand von uns geprüft.
${s.knowledge ? `\nUNSER WISSEN UND UNSERE REGELN:\n${s.knowledge}\n` : ''}
FAKTEN ZU DIESER BUCHUNG:
${facts}

VERLAUF (ältere zuerst):
${convo}
${examples ? `\nSO HABEN WIR FRÜHER AUF ÄHNLICHE FRAGEN GEANTWORTET (Ton und Inhalt übernehmen):\n${examples}\n` : ''}
VORSCHLAG NACH UNSEREN VORLAGEN (als Grundlage, gern verbessern):
${ctx.template || ''}

Schreibe jetzt die Antwort auf die letzten Nachrichten des Gastes. Sprache: ${langName}. Freundlich, kurz (höchstens 120 Wörter), konkret.
Erfinde keine Preise, Verfügbarkeiten, Codes oder Zusagen, die nicht oben stehen – schreibe stattdessen [bitte ergänzen].
Unterschreibe mit: ${ctx.lang === 'de' ? (s.signatureDe || 'Liebe Grüße, Lea – Apartments Strauss') : (s.signatureEn || 'Best regards, Lea – Apartments Strauss')}
Gib nur den Nachrichtentext aus, ohne Einleitung.`;
}

/** Fingerabdruck ausgehender Nachrichten: gleiche Texte in vielen Buchungen = Smoobu-Automatik, keine echte Antwort */
export function fingerprint(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const comma = t.indexOf(',');
  const body = comma > 0 && comma < 60 ? t.slice(comma + 1) : t;
  return body.toLowerCase().replace(/[^a-zäöüß]/g, '').slice(0, 60);
}

// ---- Rechnung: Beträge ----
const r2 = (n) => Math.round(n * 100) / 100;
/** lines: [{ text, gross, vat }] → Summen je Steuersatz */
export function invoiceTotals(lines) {
  const by = {};
  let gross = 0;
  for (const l of lines || []) {
    const g = Number(l.gross) || 0, v = Number(l.vat) || 0;
    gross += g;
    by[v] = r2((by[v] || 0) + g);
  }
  const rates = Object.entries(by).map(([rate, g]) => {
    const net = r2(g / (1 + Number(rate) / 100));
    return { rate: Number(rate), gross: g, net, vat: r2(g - net) };
  }).sort((a, b) => a.rate - b.rate);
  return { gross: r2(gross), net: r2(rates.reduce((s, x) => s + x.net, 0)), vat: r2(rates.reduce((s, x) => s + x.vat, 0)), rates };
}

/** Rechnungsnummer aus Format: {prefix} {jahr} {nr} {nr3} {nr4} */
export function invoiceNumber(format, prefix, n, date) {
  return String(format || '{prefix}{jahr}-{nr3}')
    .replace(/\{prefix\}/g, prefix || '').replace(/\{jahr\}/g, String(date || '').slice(0, 4))
    .replace(/\{nr4\}/g, String(n).padStart(4, '0')).replace(/\{nr3\}/g, String(n).padStart(3, '0')).replace(/\{nr\}/g, String(n));
}

// ---- Druckbare Dokumente ----
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euro = (n) => (Number(n) || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const deDate = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '');
const page = (title, body) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>
body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#222;background:#f4f2ee;margin:0;padding:16px}
.doc{max-width:760px;margin:0 auto;background:#fff;padding:40px 44px;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h1{font-size:22px;margin:24px 0 4px} .small{font-size:12px;color:#666} .row{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap}
table{width:100%;border-collapse:collapse;margin:18px 0} th,td{padding:8px 6px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}
td.n,th.n{text-align:right;white-space:nowrap} .sum td{border:0;padding:3px 6px} .total td{font-weight:700;border-top:2px solid #222}
.bar{max-width:760px;margin:0 auto 12px;display:flex;justify-content:flex-end} button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #bbb;background:#fff;cursor:pointer}
.stamp{display:inline-block;border:2px solid #b03535;color:#b03535;padding:2px 10px;font-weight:700;transform:rotate(-3deg)}
@media print{body{background:#fff;padding:0}.doc{box-shadow:none;padding:0}.bar{display:none}}
</style></head><body><div class="bar"><button onclick="print()">🖨️ Drucken / als PDF speichern</button></div><div class="doc">${body}</div></body></html>`;

/** Rechnung als HTML (inv: gespeicherte Rechnung mit issuer-Schnappschuss) – Aufbau wie die bisherigen Smoobu-Rechnungen */
export function invoiceHtml(inv) {
  const d = inv.data || inv, is = d.issuer || {};
  const en = d.lang === 'en';
  const T = en ? { inv: 'Invoice', storno: 'Cancellation invoice', date: 'Issue date', period: 'Service period', host: 'Host', to: 'Invoice recipient', desc: 'Description', qty: 'Qty.',
      price: 'Price', vat: 'VAT', total: 'Total', base: 'Base', rate: 'Rate', amount: 'Amount', sum: 'Sum', incl: 'Included VAT', net: 'Total net', pay: 'Total to pay',
      method: 'Method of payment', notes: 'Payment notes', due: 'Due date', hints: 'Notes', ref: 'Cancels invoice', small: 'According to § 19 UStG (German VAT act) no VAT is charged (small business).' }
    : { inv: 'Rechnung', storno: 'Stornorechnung', date: 'Rechnungsdatum', period: 'Leistungszeitraum', host: 'Gastgeber', to: 'Rechnungsempfänger', desc: 'Beschreibung', qty: 'Menge',
      price: 'Preis', vat: 'USt', total: 'Gesamt', base: 'Netto', rate: 'Satz', amount: 'Betrag', sum: 'Summe', incl: 'Enthaltene USt', net: 'Gesamt netto', pay: 'Zu zahlen',
      method: 'Zahlungsart', notes: 'Zahlungshinweis', due: 'Fällig am', hints: 'Hinweise', ref: 'Storno zur Rechnung', small: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).' };
  const t = invoiceTotals(d.lines);
  const storno = inv.status === 'storno';
  const taxId = is.vatId ? `USt-IdNr.: ${esc(is.vatId)}` : is.taxNo ? `St.-Nr.: ${esc(is.taxNo)}` : '';
  const body = `
  <div class="row"><div><h1 style="margin-top:0">${storno ? T.storno : T.inv}</h1><div style="font-size:18px;font-weight:700">${esc(inv.number)}</div></div>
    <div class="small" style="text-align:right">${T.date}: ${esc(deDate(d.date))}<br>${T.period}: ${esc(deDate(d.arrival))} – ${esc(deDate(d.departure))}${d.bookingRef ? `<br>${en ? 'Booking' : 'Buchung'}: ${esc(d.bookingRef)}` : ''}</div></div>
  ${inv.cancelled ? '<p><span class="stamp">STORNIERT</span></p>' : ''}${storno && d.refNumber ? `<p>${T.ref} ${esc(d.refNumber)}</p>` : ''}
  <div class="row" style="margin-top:22px">
    <div><div class="small">${T.host}</div><b>${esc(is.name)}</b><br><span style="white-space:pre-line">${esc(is.address)}</span>${taxId ? `<br>${taxId}` : ''}</div>
    <div style="min-width:240px"><div class="small">${T.to}</div><div style="white-space:pre-line">${esc(d.recipient)}</div></div></div>
  <table><tr><th>#</th><th>${T.desc}</th><th class="n">${T.qty}</th><th class="n">${T.price}</th><th class="n">${T.vat}</th><th class="n">${T.total}</th></tr>
  ${(d.lines || []).map((l, i) => `<tr><td>${i + 1}</td><td style="white-space:pre-line">${esc(l.text)}</td><td class="n">1</td><td class="n">${euro(l.gross)}</td><td class="n">${Number(l.vat) || 0}%</td><td class="n">${euro(l.gross)}</td></tr>`).join('')}</table>
  <table class="sum"><tr><th>${T.vat}</th><th class="n">${T.base}</th><th class="n">${T.rate}</th><th class="n">${T.amount}</th></tr>
  ${t.rates.map((r) => `<tr><td>${T.vat}</td><td class="n">${euro(r.net)}</td><td class="n">${r.rate}%</td><td class="n">${euro(r.vat)}</td></tr>`).join('')}</table>
  <table class="sum"><tr><td>${T.sum}</td><td class="n">${euro(t.gross)}</td></tr><tr><td>${T.incl}</td><td class="n">${euro(t.vat)}</td></tr>
    ${t.vat ? `<tr><td>${T.net}</td><td class="n">${euro(t.net)}</td></tr>` : ''}<tr class="total"><td>${T.pay}</td><td class="n">${euro(t.gross)}</td></tr></table>
  ${is.smallBusiness ? `<p>${T.small}</p>` : ''}
  <div class="row"><div>${d.method ? `<div class="small">${T.method}</div><div>${esc(d.method)}</div>` : ''}
    ${d.payment ? `<div class="small" style="margin-top:8px">${T.notes}</div><div style="white-space:pre-line">${esc(d.payment)}</div>` : ''}</div>
    ${d.due && !storno ? `<div style="text-align:right"><div class="small">${T.due}</div><b>${esc(deDate(d.due))}</b><div>${euro(t.gross)}</div></div>` : ''}</div>
  ${d.note ? `<p style="white-space:pre-line;margin-top:12px">${esc(d.note)}</p>` : ''}
  <div class="small" style="margin-top:26px"><b>${T.hints}</b><br>${is.bank ? `${esc(is.bank)}<br>` : ''}${is.footer ? esc(is.footer) : ''}</div>`;
  return page(`${T.inv} ${inv.number}`, body);
}

/** Personenzeile „Name, Vorname – 01.01.1991“ → { name, birth } */
export function parsePerson(line) {
  const t = String(line || '').trim();
  const m = t.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/) || t.match(/(\d{4})-(\d{2})-(\d{2})\s*$/);
  if (!m) return { name: t.replace(/[\s,;–-]+$/, ''), birth: '' };
  const birth = m[0].includes('-') ? `${m[3]}.${m[2]}.${m[1]}` : `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${m[3]}`;
  return { name: t.slice(0, m.index).replace(/[\s,;–(-]+$/, '').trim(), birth };
}
/** „Lea und Philipp Strauss“ → { last: 'Strauss', first: 'Lea und Philipp' } */
export function splitName(full) {
  const w = String(full || '').trim().split(/\s+/);
  return w.length > 1 ? { last: w[w.length - 1], first: w.slice(0, -1).join(' ') } : { last: w[0] || '', first: '' };
}

/** Wohnungsgeberbestätigung nach § 19 BMG – Aufbau wie das Formular der Stadt Braunschweig (32.41-019) */
export function wgbHtml(doc) {
  const d = doc.data || doc;
  const persons = (d.persons || (d.names || []).map((n) => parsePerson(n)));
  const ll = d.landlord || {};
  const box = (on) => `<span style="display:inline-block;width:14px;height:14px;border:1.5px solid #222;margin-right:8px;text-align:center;line-height:13px;font-size:12px">${on ? '✕' : ''}</span>`;
  const f = (label, value) => `<tr><th style="width:42%">${label}</th><td style="white-space:pre-line">${esc(value || '')}</td></tr>`;
  const body = `
  <div class="row"><div class="small" style="white-space:pre-line">Absender:\n${esc([ll.first, ll.last].filter(Boolean).join(' '))}\n${esc(ll.street)}\n${esc(ll.city)}</div>
    <div class="small" style="white-space:pre-line">${esc(d.authority || 'Stadt Braunschweig\nAbt. Bürgerangelegenheiten\nPlatz der Deutschen Einheit 1\n38100 Braunschweig')}</div></div>
  <h1>Wohnungsgeberbestätigung</h1><p class="small">Wohnungsgeberbescheinigung nach § 19 des Bundesmeldegesetzes (BMG)</p>
  <h3 style="margin-top:18px">Bestätigung des Einzugs</h3>
  <p>Hiermit wird der meldepflichtigen Person / den meldepflichtigen Personen ein Einzug in folgende Wohnung bestätigt:</p>
  <table>${f('Postleitzahl, Ort', `${d.zip || ''} ${d.city || 'Braunschweig'}`.trim())}${f('Straße und Hausnummer mit Zusatz', d.street)}
    ${f('Stockwerk, Wohnungsnummer bzw. Lagebeschreibung der Wohnung im Haus', d.floor)}${f('Einzugsdatum', deDate(d.moveIn))}</table>
  <h3>Angaben zur eingezogenen Person / zu den eingezogenen Personen</h3>
  <table><tr><th style="width:8%">Nr.</th><th>Name, Vorname</th><th style="width:28%">Geburtsdatum</th></tr>
    ${persons.map((p, i) => `<tr><td>${i + 1}.</td><td>${esc(p.name)}</td><td>${esc(p.birth)}</td></tr>`).join('')}</table>
  <h3>Angaben der Wohnungsgeberin / des Wohnungsgebers</h3>
  <table>${f('Name', ll.last)}${f('Vorname', ll.first)}${f('Straße und Hausnummer', ll.street)}${f('Postleitzahl und Ort', ll.city)}</table>
  <h3>Angaben der Eigentümerin / des Eigentümers</h3>
  <p>${box(!d.owner)}Die Wohnungsgeberin / der Wohnungsgeber ist gleichzeitig Eigentümerin / Eigentümer der Wohnung.</p>
  <p>${box(!!d.owner)}Die Wohnungsgeberin / der Wohnungsgeber ist nicht Eigentümerin / Eigentümer der Wohnung.${d.owner ? `<br><span style="white-space:pre-line;margin-left:22px;display:inline-block">Name und Anschrift der Eigentümerin / des Eigentümers: ${esc(d.owner)}</span>` : ''}</p>
  <h3>Erklärung</h3>
  <p class="small">Mir ist bekannt, dass es verboten ist, eine Wohnanschrift für eine Anmeldung einem Dritten anzubieten oder zur Verfügung zu stellen,
    obwohl ein tatsächlicher Bezug der Wohnung durch diesen weder stattfindet noch beabsichtigt ist. Ein Verstoß gegen das Verbot stellt ebenso eine
    Ordnungswidrigkeit dar wie die Ausstellung dieser Bestätigung ohne dazu als Wohnungsgeberin/Wohnungsgeber oder deren Beauftragte/dessen
    Beauftragter berechtigt zu sein (§ 54 i. V. m. § 19 BMG).</p>
  <div class="row" style="margin-top:48px"><div>${esc(d.place || 'Braunschweig')}, ${esc(deDate(d.date))}</div>
    <div style="min-width:280px;border-top:1px solid #222;padding-top:4px;text-align:center" class="small">Unterschrift Wohnungsgeberin/-geber oder beauftragte Person<br><span style="font-size:14px;color:#222">${esc(d.signer || '')}</span></div></div>`;
  return page('Wohnungsgeberbestätigung', body);
}
