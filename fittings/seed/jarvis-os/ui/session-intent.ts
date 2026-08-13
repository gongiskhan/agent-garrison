// Deterministic voice-intent parser for the dev-session switcher (PT + EN).
//
// Like ./kanban-intent, this is a *hybrid* fast-path: a few explicit spoken
// commands about SESSIONS are recognised here and handled locally (switch to a
// session, create one, go back to the orchestrator) instead of being sent as
// natural language to the orchestrator. Anything that doesn't match returns null
// and falls through unchanged.
//
// Pure, dependency-free module so it can be unit-tested without importing the
// React bundle (main.tsx has import-time side effects).

export type SessionIntent =
  | { kind: "switch"; query: string } // query is an index ("2") or a name fragment
  | { kind: "switch-off" }            // back to the orchestrator (deselect)
  | { kind: "create"; project: string }; // project fragment ("" = current workspace)

// Spoken ordinals / number words → digit, so "muda para a segunda sessão" and
// "sessão dois" both resolve like "sessão 2".
const ORDINALS: Record<string, string> = {
  primeira: "1", primeiro: "1", first: "1", um: "1", uma: "1",
  segunda: "2", segundo: "2", second: "2", dois: "2", duas: "2",
  terceira: "3", terceiro: "3", third: "3", três: "3", tres: "3",
  quarta: "4", quarto: "4", fourth: "4", quatro: "4",
  quinta: "5", quinto: "5", fifth: "5", cinco: "5",
  sexta: "6", sexto: "6", sixth: "6", seis: "6"
};

// A switch verb ("muda para", "switch to", "foca na"…). Combined with a mention
// of a session it means "talk to that session" rather than ordinary chat.
const SWITCH_VERB_RE =
  /\b(?:muda\w*|troca\w*|passa\w*|vai|vá|foca\w*|selec\w*|escolh\w*|switch|change|focus|select|go)\b/i;
const SESSION_WORD_RE = /\bsess/i;

// "sessão" / "sessões" / "session" / "sessions". The regexes here are NOT
// unicode-flagged, so \w excludes accents ("ã", "õ") — spell out the PT vowels so
// the token doesn't truncate at "sess" and leave "ão…" in the remainder.
const SESS = "sess[\\wãáâàéêíóôõúç]*";

// Back to the orchestrator: "volta ao orquestrador", "sai da sessão", "fala com
// o jarvis", "nenhuma sessão", "back to the orchestrator".
const SWITCH_OFF_RE =
  /^\W*(?:(?:volta(?:r)?|sai(?:r)?|deselec\w*|desmarca\w*)\b.*\b(?:sessão|sessao|orquestrador|orchestrator)|nenhuma sess\w*|fala\s+com\s+o\s+jarvis|back to (?:the )?orchestrator|no session)/i;

// "cria uma sessão nova", "abre uma sessão para o projeto X", "nova sessão",
// "new session", "create a session for the docs". Whatever names a project after
// it is the (optional) project fragment.
const CREATE_RE = new RegExp(
  "^\\W*(?:(?:por favor|olha|então|ó?\\s*jarvis)[,\\s]+)?" +
    "(?:cria(?:r)?|abre|abrir|inicia(?:r)?|arranca(?:r)?|nov[ao]|start|open|create|new)\\b(?:-(?:me|nos))?" +
    "(?:\\s+(?:uma|a|an)\\b)?\\s+" + SESS + "\\b(?:\\s+nova\\b)?" +
    "(?:\\s+(?:para|pra|no|na|do|da|de|for|on|in|the|o|a|projeto|project)\\b)*\\s*",
  "i"
);

function stripTail(s: string): string {
  return s.replace(/[.!?…]+$/u, "").trim();
}

function meaningful(s: string): boolean {
  return s.replace(/[^\p{L}\p{N}]+/gu, "").length >= 1;
}

// A number/ordinal address only (for the bare "sessão N" path, which must not
// hijack ordinary chat that merely starts with the word "sessão").
function numericQuery(raw: string): string | null {
  const t = stripTail((raw || "").trim()).replace(/^(a|o|the)\s+/i, "").toLowerCase();
  const first = t.split(/\s+/)[0];
  if (ORDINALS[first]) return ORDINALS[first];
  const n = t.match(/^(\d{1,2})\b/);
  return n ? n[1] : null;
}

// Resolve a switch query from anywhere in the utterance: an ordinal word, a bare
// number, else the name fragment after "sessão/session" (dropping connectives).
function extractSwitchQuery(t: string): string | null {
  const lower = t.toLowerCase();
  for (const w of Object.keys(ORDINALS)) {
    if (new RegExp(`\\b${w}\\b`).test(lower)) return ORDINALS[w];
  }
  const num = t.match(/\b(\d{1,2})\b/);
  if (num) return num[1];
  const m = t.match(new RegExp(SESS + "\\b\\s+(?:do |da |de |n[oa] |the |projeto |project )*(.+?)[.!?…]*$", "i"));
  if (m) {
    const frag = m[1].trim().replace(/^(a|o|the)\s+/i, "").trim();
    if (meaningful(frag)) return frag;
  }
  return null;
}

export function parseSessionIntent(text: string): SessionIntent | null {
  const t = (text || "").trim();
  if (!t) return null;

  // Order matters: "sai da sessão" must beat the create/switch verbs.
  if (SWITCH_OFF_RE.test(t)) return { kind: "switch-off" };

  const cm = t.match(CREATE_RE);
  if (cm) return { kind: "create", project: stripTail(t.slice(cm[0].length)) };

  // Switch with an explicit verb: accept an index OR a name fragment.
  if (SWITCH_VERB_RE.test(t) && SESSION_WORD_RE.test(t)) {
    const q = extractSwitchQuery(t);
    if (q) return { kind: "switch", query: q };
  }

  // Bare "sessão N" (no verb): only a number/ordinal address, so ordinary chat
  // that happens to start with "sessão …" isn't hijacked.
  const bm = t.match(new RegExp("^\\W*(?:a |o |the )?" + SESS + "\\b\\s+(.+?)[.!?…]*$", "i"));
  if (bm) {
    const q = numericQuery(bm[1]);
    if (q) return { kind: "switch", query: q };
  }

  return null;
}
