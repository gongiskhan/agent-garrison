// Deterministic voice-intent parser for the Kanban fast-path (PT + EN).
//
// Jarvis has no client-side command router — every utterance is normally sent as
// natural language to the orchestrator. This is the *hybrid* fast-path: a couple
// of explicit spoken commands are recognised here and handled locally (create a
// card, summarise the board) for speed + reliability; anything that doesn't match
// returns null and falls through to the orchestrator unchanged.
//
// Kept as a pure, dependency-free module so it can be unit-tested without
// importing the React bundle (main.tsx has import-time side effects).

export type KanbanIntent =
  | { kind: "create"; text: string }
  | { kind: "summary" }
  | { kind: "advance"; query: string };

// "cria um card …", "nova tarefa: …", "adiciona uma task …", "new todo …".
// Verb (+ optional article) + a task noun; whatever follows is the card text.
const CREATE_RE =
  /^\W*(?:(?:por favor|faz favor|olha|então|ó?\s*jarvis)[,\s]+)?(cria(?:r)?|adiciona(?:r)?|regista(?:r)?|abre|nov[ao]|add|create|new)(?:-(?:me|nos|lhe))?\b\s*(?:um |uma |o |a |an )?\b(card|cart[aã]o|tarefa|task|to-?do|ticket)\b[\s:,\-–—]*/i;

// Leading connectors to drop from the extracted card text ("cria um card PARA …").
const CREATE_LEAD_RE = /^(para|pra|sobre|to|about|chamad[oa]|called|que diga|a dizer)\s+/i;

// "avança o card <title>", "começa a tarefa <title>", "start the card <title>".
// The remainder is a title fragment matched against the board.
const ADVANCE_RE =
  /^\W*(?:(?:por favor|olha|então)[,\s]+)?(?:avança(?:r)?|começa(?:r)?|inicia(?:r)?|arranca(?:r)?|start|advance)\b\s*(?:o |a |the )?(?:card|cart[aã]o|tarefa|task)\b[\s:,\-–—]*/i;
const ADVANCE_LEAD_RE = /^(o |a |do |da |the )+/i;

// "estado das tarefas", "o que está o sistema a fazer", "que tarefas estão a
// correr", "what's running". Anchored on task/kanban/running keywords so ordinary
// chat ("o que achas do sistema de login") isn't hijacked.
const SUMMARY_RE = new RegExp(
  [
    "estado d[oae]s?\\s+(?:tarefas?|cards?|sistema|kanban|board)",
    "resumo d[oae]s?\\s+(?:tarefas?|sistema|kanban)",
    // Note: bare "que tarefa…" is intentionally NOT here — it hijacked ordinary
    // chat ("não sei que tarefa me deram"). Real status queries about tasks go
    // through the dedicated "que tarefas … correr/curso/abertas" branch below.
    "(?:o que|que)\\b[^?]*\\b(?:kanban|a correr|em curso|em andamento)\\b",
    "o que.*\\bsistema\\b.*\\b(?:faz|fazer|a fazer|acontece|acontecer)\\b",
    "what(?:'s| is)\\s+(?:running|going on|the status)",
    "status of (?:the )?(?:tasks?|board|system|kanban)",
    "que tarefas?\\b[^?]*\\b(?:correr|curso|abertas|ativas)"
  ].join("|"),
  "i"
);

// Enough real word/number characters to be a usable card body (not a stray blip).
function meaningful(s: string): boolean {
  return s.replace(/[^\p{L}\p{N}]+/gu, "").length >= 2;
}

export function parseKanbanIntent(text: string): KanbanIntent | null {
  const t = (text || "").trim();
  if (!t) return null;

  const cm = t.match(CREATE_RE);
  if (cm) {
    let rest = t.slice(cm[0].length).trim();
    rest = rest.replace(CREATE_LEAD_RE, "").trim();
    rest = rest.replace(/[.!?…]+$/u, "").trim();
    // "cria uma tarefa" with no content → let the orchestrator handle it (it can
    // ask what the card should say) rather than creating an empty card.
    return meaningful(rest) ? { kind: "create", text: rest } : null;
  }

  const am = t.match(ADVANCE_RE);
  if (am) {
    let rest = t.slice(am[0].length).trim().replace(ADVANCE_LEAD_RE, "").replace(/[.!?…]+$/u, "").trim();
    return meaningful(rest) ? { kind: "advance", query: rest } : null;
  }

  if (SUMMARY_RE.test(t)) return { kind: "summary" };
  return null;
}
