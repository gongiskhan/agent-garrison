// Which language is Zeca speaking? (2026-08-28)
//
// The pipeline had exactly one language signal - looksPortuguese in tts.mjs -
// and it only ever chose ElevenLabs CONDITIONING. Every fixed sentence in the
// product was an English literal, so a Portuguese command produced a
// half-English acknowledgement: "Task created: Comprar comando para a
// televisão." The classifier is already told to keep the user's language (see
// buildWakePrompt), so the model-generated half was always right; it was the
// frames around it that were monolingual.
//
// This module is the one place that answers "which language", plus the fixed
// message catalog for the wake path. It is a byte-identical mirror across
// omi-channel, capture-service and kanban-loop (cross-fitting imports are
// forbidden - the ack.mjs wakeRegex copy is the same precedent).
//
// Why not just reuse looksPortuguese: it returns true on the FIRST accent or
// Portuguese stopword, so "Buy a remote for the TV amanhã" reads as Portuguese
// and "Comprar comando" - no accents, and `comprar` was not in its list - reads
// as English. Scoring both sides and taking the winner fixes both directions.

// Accented characters are near-proof of Portuguese, so they outweigh any single
// stopword. One "ã" decides a sentence that has nothing else to go on.
const ACCENTS = /[ãõáâàéêíóôúüçÃÕÁÂÀÉÊÍÓÔÚÜÇ]/g;
const ACCENT_WEIGHT = 3;

// The OVERLAP IS DELETED FROM BOTH LISTS, and that is the whole trick. Every
// token below can only be one language. Words like `a`, `o`, `e`, `no`, `so`,
// `me`, `um`, `as`, `ok` and `logo` are common in BOTH (English "a remote",
// "no", "so", "me", "um", "as", "logo") and scored the wrong way round often
// enough to be worse than nothing, so none of them appear here.
const PT_TOKENS = new Set([
  "de", "do", "dos", "das", "da", "para", "com", "sem", "por", "pelo", "pela",
  "nao", "uma", "isso", "isto", "aquilo", "que", "mais", "muito", "tambem",
  "tenho", "preciso", "quero", "vou", "vamos", "esta", "estao", "foi", "sao",
  "ja", "agora", "depois", "antes", "hoje", "ontem", "amanha", "manha",
  "noite", "tarde", "almoco", "jantar", "sempre", "nunca",
  "comprar", "ligar", "marcar", "fazer", "ficar", "dizer", "enviar", "manda",
  "envia", "diz", "guarda", "lembra", "apontar", "criar", "cria",
  "obrigado", "obrigada", "favor", "bom", "boa", "dia", "sim", "nada",
  "meu", "minha", "teu", "tua", "seu", "sua", "dele", "dela", "lhe", "nos",
  "ser", "ter", "dar", "ver", "saber", "poder", "quando", "onde", "porque",
  "qual", "quem", "entao", "porem", "mas", "ate", "desde", "sobre",
  "tarefa", "cartao", "recado"
]);

const EN_TOKENS = new Set([
  "the", "and", "of", "for", "with", "without", "is", "are", "was", "were",
  "this", "that", "these", "those", "there", "here", "then", "than",
  "remind", "reminder", "buy", "call", "tomorrow", "morning", "evening",
  "tonight", "today", "yesterday", "tonite", "later", "soon", "always",
  "never", "task", "card", "need", "needs", "want", "wants", "make", "get",
  "send", "email", "message", "please", "thanks", "thank",
  "what", "when", "where", "who", "why", "how", "which",
  "can", "could", "should", "would", "will", "shall", "must",
  "about", "from", "have", "has", "had", "did", "does", "doing",
  "be", "been", "being", "you", "your", "we", "they", "he", "she", "his",
  "her", "their", "our", "not", "just", "let", "lets",
  "remember", "save", "note", "write", "create", "start", "stop", "finish"
]);

function tokenize(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
}

// -> "pt" | "en" | null. NULL is a real answer and an important one: "ok",
// "Zeca" and "9ZZZ" carry no evidence at all, and guessing on them is what
// makes a remembered language or a configured default worthless.
export function detectLanguage(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return null;
  let pt = (raw.match(ACCENTS) ?? []).length * ACCENT_WEIGHT;
  let en = 0;
  let scored = pt > 0 ? 1 : 0;
  for (const token of tokenize(raw)) {
    if (PT_TOKENS.has(token)) {
      pt += 1;
      scored += 1;
    } else if (EN_TOKENS.has(token)) {
      en += 1;
      scored += 1;
    }
  }
  if (scored === 0) return null;
  // One side silent and the other speaking is enough - "Buy a remote" scores a
  // single English token and nothing Portuguese, and calling that undetermined
  // would send an English sentence to the Portuguese catalog. When BOTH sides
  // score, the margin has to be real: a Portuguese sentence carrying an English
  // product name must not flip.
  if (en === 0 && pt > 0) return "pt";
  if (pt === 0 && en > 0) return "en";
  if (pt - en >= 2) return "pt";
  if (en - pt >= 2) return "en";
  return null;
}

export const LANGUAGES = ["pt", "en"];

export function isLanguage(value) {
  return typeof value === "string" && LANGUAGES.includes(value);
}

// The precedence, written once so every call site agrees. `explicit` is a human
// or a config decision and always wins; `remembered` beats detection because a
// conversation does not change language halfway through a three-word title.
export function pickLanguage({ explicit = null, remembered = null, sample = null, fallback = null } = {}) {
  if (isLanguage(explicit)) return explicit;
  if (isLanguage(remembered)) return remembered;
  const detected = sample === null || sample === undefined ? null : detectLanguage(sample);
  if (isLanguage(detected)) return detected;
  if (isLanguage(fallback)) return fallback;
  return "pt";
}

// ---- the fixed message catalog ---------------------------------------------
//
// These are the wake path's own sentences: confirmations that reach the wearer
// as a push notification, not through the ack layer. English was authored
// first, so `en` is the source and a missing `pt` key degrades to it rather
// than to the key name.
//
// Portuguese is European and informal (tu) - Zeca addresses one person who
// owns the machine.
export const MESSAGES = {
  en: {
    "wake.unreachable": "Couldn't reach Zeca - saved your command as a note.",
    "wake.offline": "Zeca is offline - saved your command as a note.",
    "wake.unparseable": "I couldn't parse that - saved it as a note.",
    "wake.board_down": "The board is unreachable - saved your command as a note.",
    "wake.unknown_intent": "I wasn't sure what to do with that, so I saved it as a note.",
    "wake.no_delegate": "I can't reach Zeca for that right now - saved it as a note.",
    "wake.not_saved": "{text} (memory store unavailable - not saved)",
    "wake.card_created": "Card created: {title}",
    "wake.event_created": "Event card created: {title}",
    "wake.scheduled_for": ", scheduled for {when}",
    "wake.time_dropped": " (I couldn't make out the time, so it is not scheduled)",
    "wake.already": "Already created: {title}",
    "wake.updated": "Updated: {title}",
    "wake.noted": "Noted: {title}",
    "wake.note_failed": "Couldn't save the note (memory store unavailable).",
    "wake.no_answer": "I don't have an answer for that right now.",
    "wake.on_it": "On it - I'll come back to you.",
    "wake.delegate_failed": "I couldn't finish that: {error}",
    "wake.nothing_to_report": "I finished, but had nothing to report back.",
    "card.which": 'I couldn\'t tell which card or what to do with it - say e.g. "run card 7Q2M".',
    "card.no_match": "No card matches {ref}.",
    "card.ambiguous": "More than one card matches {ref}: {listed}. Say the 4-character ref of the one you mean.",
    "card.candidates_unavailable": "(candidates unavailable)",
    "card.board_down": "The board is unreachable right now - couldn't {action} card {ref}.",
    "card.start_failed": 'Couldn\'t start "{title}" (card {ref}) - the board refused.',
    "card.started": 'Started "{title}" (card {ref})',
    "card.snooze_time": 'I couldn\'t make out the snooze time for card {ref} - try "snooze card {ref} for 2 hours".',
    "card.snooze_failed": 'Couldn\'t snooze "{title}" (card {ref}) - the board refused.',
    "card.snoozed": 'Snoozed "{title}" until {when} (card {ref})',
    "send.ambiguous": "I know more than one {recipient}: {names}. Which one?",
    "send.queued": "Sending to {recipient}: {body}. Say cancel to stop it.",
    "send.cancelled": "Cancelled.",
    "send.already_sent": "That one had already gone out.",
    "automate.unavailable": "Cortex is not set up on this machine.",
    "automate.ambiguous": "I found more than one: {names}. Which one?",
    "automate.started": "Started the {name} automation.",
    "automate.replay": "That run of {name} was already going.",
    "automate.failed": "Couldn't run {name}: {error}",
    "wake.still_working": "Still working on it.",
    "screen.absent": "I can't see your screen. Turn on screen sharing, or tell me the name.",
    "screen.stale": "I haven't seen your screen for {seconds} seconds - tell me who you mean."
  },
  pt: {
    "wake.unreachable": "Não consegui falar com o Zeca - guardei o teu comando como nota.",
    "wake.offline": "O Zeca está offline - guardei o teu comando como nota.",
    "wake.unparseable": "Não percebi isso - guardei como nota.",
    "wake.board_down": "O quadro está inacessível - guardei o teu comando como nota.",
    "wake.unknown_intent": "Não soube o que fazer com isso, por isso guardei como nota.",
    "wake.no_delegate": "Não consigo falar com o Zeca para isso agora - guardei como nota.",
    "wake.not_saved": "{text} (memória indisponível - não foi guardado)",
    "wake.card_created": "Cartão criado: {title}",
    "wake.event_created": "Evento criado: {title}",
    "wake.scheduled_for": ", agendado para {when}",
    "wake.time_dropped": " (não percebi a hora, por isso não ficou agendado)",
    "wake.already": "Já tinha criado: {title}",
    "wake.updated": "Actualizado: {title}",
    "wake.noted": "Apontei: {title}",
    "wake.note_failed": "Não consegui guardar a nota (memória indisponível).",
    "wake.no_answer": "Não tenho resposta para isso agora.",
    "wake.on_it": "Vou tratar disso - já te digo.",
    "wake.delegate_failed": "Não consegui terminar isso: {error}",
    "wake.nothing_to_report": "Terminei, mas não tenho nada para te dizer.",
    "card.which": 'Não percebi qual o cartão nem o que fazer com ele - diz por exemplo "corre o cartão 7Q2M".',
    "card.no_match": "Nenhum cartão corresponde a {ref}.",
    "card.ambiguous": "Há mais do que um cartão para {ref}: {listed}. Diz os 4 caracteres do que queres.",
    "card.candidates_unavailable": "(candidatos indisponíveis)",
    "card.board_down": "O quadro está inacessível agora - não consegui {action} o cartão {ref}.",
    "card.start_failed": 'Não consegui começar "{title}" (cartão {ref}) - o quadro recusou.',
    "card.started": 'Comecei "{title}" (cartão {ref})',
    "card.snooze_time": 'Não percebi por quanto tempo adiar o cartão {ref} - tenta "adia o cartão {ref} duas horas".',
    "card.snooze_failed": 'Não consegui adiar "{title}" (cartão {ref}) - o quadro recusou.',
    "card.snoozed": 'Adiei "{title}" até {when} (cartão {ref})',
    "send.ambiguous": "Conheço mais do que um {recipient}: {names}. Qual deles?",
    "send.queued": "Vou enviar a {recipient}: {body}. Diz cancela para parar.",
    "send.cancelled": "Cancelado.",
    "send.already_sent": "Essa já tinha sido enviada.",
    "automate.unavailable": "O Cortex não está instalado nesta máquina.",
    "automate.ambiguous": "Encontrei mais do que uma: {names}. Qual delas?",
    "automate.started": "Comecei a automação {name}.",
    "automate.replay": "Essa execução do {name} já estava a correr.",
    "automate.failed": "Não consegui correr {name}: {error}",
    "wake.still_working": "Ainda estou a tratar disso.",
    "screen.absent": "Não estou a ver o teu ecrã. Liga a partilha de ecrã, ou diz-me o nome.",
    "screen.stale": "Não vejo o teu ecrã há {seconds} segundos - diz-me a quem queres responder."
  }
};

const SLOT_RE = /\{([a-z_][a-z0-9_]*)\}/gi;

// NEVER throws. This is the deliberate difference from ack.mjs's renderAck,
// which must throw on a missing slot because an ack that fails to name its
// referent is useless. A push notification missing a slot is merely worse than
// it should be, and taking out the dispatch that produced it would be far
// worse than sending a slightly awkward sentence.
export function t(key, params = {}, lang = "pt") {
  const table = MESSAGES[isLanguage(lang) ? lang : "en"] ?? MESSAGES.en;
  const template = table[key] ?? MESSAGES.en[key] ?? key;
  return String(template)
    .replace(SLOT_RE, (_, name) => {
      const value = params?.[name];
      return value === undefined || value === null ? "" : String(value);
    })
    .replace(/\s+/g, " ")
    .trim();
}
