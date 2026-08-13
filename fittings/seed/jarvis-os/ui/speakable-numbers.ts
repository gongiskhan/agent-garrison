// Number → European-Portuguese words, for the TTS pipeline. The local voice
// model reads "€100.000" as "cem, zero, zero, zero" — thousands separators and
// currency symbols confuse it. toSpeakable() runs normalizeNumbersPt() over the
// reply text so amounts arrive as words ("cem mil euros") instead of digits.
//
// Deliberately scoped to what actually breaks aloud:
//   - currency amounts (€ / $ / £, symbol before or after, "euros"/"dólares"…)
//   - bare integers WITH thousands separators ("100.000", "1.234.567")
//   - decimal commas attached to either ("2,5", "€19,99")
// Plain digits without separators ("100", "2026", "4.8", "v0.1.0") are left for
// the TTS's own normalizer, which handles them fine.

const UNITS = [
  "zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove",
  "dez", "onze", "doze", "treze", "catorze", "quinze", "dezasseis", "dezassete",
  "dezoito", "dezanove",
];
const TENS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const HUNDREDS = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];

function under1000(n: number): string {
  if (n === 100) return "cem";
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (r) {
    if (r < 20) parts.push(UNITS[r]);
    else {
      const t = Math.floor(r / 10);
      const u = r % 10;
      parts.push(u ? `${TENS[t]} e ${UNITS[u]}` : TENS[t]);
    }
  }
  return parts.join(" e ") || "zero";
}

// Integer → PT-PT words. Covers up to 999 999 999 999 ("mil milhões" scale —
// European Portuguese, not Brazilian "bilhões"). Bigger stays digits.
export function intToWordsPt(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 999_999_999_999) return String(n);
  if (n === 0) return "zero";
  const bi = Math.floor(n / 1e9);
  const mi = Math.floor(n / 1e6) % 1000;
  const th = Math.floor(n / 1e3) % 1000;
  const un = n % 1000;
  const parts: string[] = [];
  if (bi) parts.push(bi === 1 ? "mil milhões" : `${under1000(bi)} mil milhões`);
  if (mi) parts.push(mi === 1 ? "um milhão" : `${under1000(mi)} milhões`);
  if (th) parts.push(th === 1 ? "mil" : `${under1000(th)} mil`);
  if (un) {
    // "e" before a final group under 100 or an exact hundred: "mil e cem",
    // "cem mil e cinco" — but "mil duzentos e trinta e quatro".
    const joiner = parts.length && (un < 100 || un % 100 === 0) ? "e " : "";
    parts.push(joiner + under1000(un));
  }
  return parts.join(" ");
}

// Spoken decimals: digit-by-digit after "vírgula" ("2,53" → "dois vírgula cinco
// três"), matching how PT speakers read decimal expansions.
function decimalDigits(frac: string): string {
  return frac.split("").map((d) => UNITS[Number(d)]).join(" ");
}

type Currency = { one: string; many: string; centOne: string; centMany: string };
const CURRENCIES: Record<string, Currency> = {
  "€": { one: "euro", many: "euros", centOne: "cêntimo", centMany: "cêntimos" },
  "$": { one: "dólar", many: "dólares", centOne: "cêntimo", centMany: "cêntimos" },
  "£": { one: "libra", many: "libras", centOne: "péni", centMany: "pence" },
};

// "1.234.567" | "1234" (+ optional ",dd") → words (+currency). Returns null when
// the integer part fails to parse as a separator-grouped or plain number.
function amountToWords(intPart: string, fracPart: string | undefined, cur: Currency | null): string | null {
  const digits = intPart.replace(/\./g, "");
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  const intWords = intToWordsPt(n);
  if (!cur) {
    return fracPart ? `${intWords} vírgula ${decimalDigits(fracPart)}` : intWords;
  }
  const unit = n === 1 ? cur.one : cur.many;
  if (!fracPart || /^0+$/.test(fracPart)) return `${intWords} ${unit}`;
  const cents = Number(fracPart.length === 1 ? fracPart + "0" : fracPart.slice(0, 2));
  const centUnit = cents === 1 ? cur.centOne : cur.centMany;
  return `${intWords} ${unit} e ${intToWordsPt(cents)} ${centUnit}`;
}

// A number token: either separator-grouped ("1.234.567") or plain digits, with
// an optional decimal-comma tail. Group 1 = integer part, group 2 = fraction.
const NUM = String.raw`(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?`;

// Currency words that may follow a bare amount ("100.000 euros").
const CUR_WORDS: Array<[RegExp, Currency]> = [
  [/^euros?$/i, CURRENCIES["€"]],
  [/^d[óo]lares?$/i, CURRENCIES["$"]],
  [/^libras?$/i, CURRENCIES["£"]],
];

// "1" (or "1,0"/"1.0") picks the singular unit form.
function isOne(n: string): boolean {
  return n === "1" || n === "1,0" || n === "1.0";
}

// Measure units → PT words, digits left in place (the number passes and the
// TTS's own normalizer handle plain digits fine — the symbols are what break).
// Ordered longest-first so "km/h" wins over "km" wins over "m"; \b keeps "m"
// from eating the m of "min"/"ml" (word chars on both sides = no boundary).
// CASE-SENSITIVE on purpose: "5G" (rede) must not become "5 gramas", "5 M"
// (milhões) must not become "5 metros". Lowercase = the measure; bytes accept
// the common upper/lower spellings explicitly.
const MEASURE_UNITS: Array<[string, string, string]> = [
  ["km\\/h", "quilómetro por hora", "quilómetros por hora"],
  ["km²|km2", "quilómetro quadrado", "quilómetros quadrados"],
  ["m²|m2", "metro quadrado", "metros quadrados"],
  ["m³|m3", "metro cúbico", "metros cúbicos"],
  ["km", "quilómetro", "quilómetros"],
  ["cm", "centímetro", "centímetros"],
  ["mm", "milímetro", "milímetros"],
  ["kg|Kg", "quilo", "quilos"],
  ["mg", "miligrama", "miligramas"],
  ["ml|mL", "mililitro", "mililitros"],
  ["cl|cL", "centilitro", "centilitros"],
  ["dl|dL", "decilitro", "decilitros"],
  ["min", "minuto", "minutos"],
  ["seg", "segundo", "segundos"],
  ["TB|tb", "terabyte", "terabytes"],
  ["GB|gb", "gigabyte", "gigabytes"],
  ["MB|mb", "megabyte", "megabytes"],
  ["KB|kb", "kilobyte", "kilobytes"],
  ["g", "grama", "gramas"],
  ["l|L", "litro", "litros"],
  ["m", "metro", "metros"],
];

// Units/temperatures/times → words. Runs BEFORE the number passes, so decimal
// values keep flowing into them ("1,5 km" → "1,5 quilómetros" → "um vírgula
// cinco quilómetros").
function expandUnitsPt(text: string): string {
  let t = text;

  // Temperature. Both ° (degree) and º (ordinal — models mistype it) accepted
  // when the scale letter is present; "-5°C" also speaks the minus.
  t = t.replace(/(-\s*)?(\d+(?:[.,]\d+)*)\s*[°º]\s*C\b/g, (_m, neg, n) =>
    `${neg ? "menos " : ""}${n} ${isOne(n) ? "grau" : "graus"} Celsius`);
  t = t.replace(/(-\s*)?(\d+(?:[.,]\d+)*)\s*[°º]\s*F\b/g, (_m, neg, n) =>
    `${neg ? "menos " : ""}${n} ${isOne(n) ? "grau" : "graus"} Fahrenheit`);
  // Bare degrees: ONLY the true degree sign ° (U+00B0), never the ordinal º
  // (U+00BA) — "1º lugar" must stay an ordinal. No letter may follow.
  t = t.replace(/(-\s*)?(\d+(?:[.,]\d+)*)\s*°(?![A-Za-z])/g, (_m, neg, n) =>
    `${neg ? "menos " : ""}${n} ${isOne(n) ? "grau" : "graus"}`);

  // Clock times: "22h30" → "22 horas e 30"; "22h" / "1h" → "22 horas" / "1 hora".
  t = t.replace(/\b(\d{1,2})h(\d{2})\b/g, "$1 horas e $2");
  t = t.replace(/\b(\d{1,2})\s*h\b/g, (_m, h) => `${h} ${h === "1" ? "hora" : "horas"}`);

  // Measures: number + symbol (attached or spaced), singular on exactly 1.
  // Trailing guard is a lookahead, not \b — \b can't fire after "²"; the
  // lookahead also stops bare "m" from eating the m of "m²"/"m/s".
  for (const [sym, one, many] of MEASURE_UNITS) {
    t = t.replace(new RegExp(String.raw`\b(\d+(?:[.,]\d+)*)\s*(?:${sym})(?![A-Za-z0-9²³/])`, "g"), (_m, n) =>
      `${n} ${isOne(n) ? one : many}`);
  }
  return t;
}

// Normalize every money amount / separator-grouped number in `text` to PT words.
export function normalizeNumbersPt(text: string): string {
  let t = expandUnitsPt(text);

  // 1) symbol-prefixed: "€100.000", "€ 19,99", "$1.500"
  t = t.replace(new RegExp(String.raw`([€$£])\s*${NUM}`, "g"), (m, sym, ip, fp) => {
    return amountToWords(ip, fp, CURRENCIES[sym]) ?? m;
  });

  // 2) symbol/word-suffixed: "100.000€", "19,99 €", "100.000 euros"
  // (\b only guards the word suffixes — it can never match after a symbol like €)
  t = t.replace(new RegExp(String.raw`${NUM}\s*([€$£]|(?:euros?|d[óo]lares?|libras?)\b)`, "gi"), (m, ip, fp, suf) => {
    const cur = CURRENCIES[suf] ?? CUR_WORDS.find(([re]) => re.test(suf))?.[1] ?? null;
    return cur ? (amountToWords(ip, fp, cur) ?? m) : m;
  });

  // 3) bare separator-grouped integers (+ optional decimal comma): "100.000",
  //    "1.234.567", "1.500,75". Plain "100" / "4.8" / dates stay untouched.
  t = t.replace(/(^|[^\d.,])(\d{1,3}(?:\.\d{3})+)(?:,(\d+))?(?![\d.])/g, (m, pre, ip, fp) => {
    const words = amountToWords(ip, fp, null);
    return words ? pre + words : m;
  });

  // 4) decimal-comma numbers left over ("2,5 milhões" → "dois vírgula cinco milhões")
  t = t.replace(/(^|[^\d.,])(\d+),(\d+)(?![\d.])/g, (m, pre, ip, fp) => {
    const words = amountToWords(ip, fp, null);
    return words ? pre + words : m;
  });

  // 5) "%" reads as symbol soup on some voices — spell it out.
  t = t.replace(/(\d|\b)%/g, "$1 por cento");

  return t;
}
