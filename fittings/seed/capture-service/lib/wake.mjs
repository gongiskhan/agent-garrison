// The wake bus (spec M4): watches the realtime transcript pipe for the wake
// word ("Zeca" + configured variants), assembles the spoken command, and
// dispatches it as an orchestrator command.
//
// Privacy (I5) is the governing invariant: everything here is in-memory.
// Segments that do not belong to a wake capture are NEVER persisted and NEVER
// logged with content - counters only. A wake-hit session persists exactly one
// thing: the assembled command text (as a wake_command capture_event).
//
// Cost (I3): one model call per wake hit - a single combined
// classify-and-handle turn on the gateway's cheap blocking lane; the fitting
// then performs the deterministic action itself (card via board API, note via
// memory writer, answer via notification).

import { atomicWriteJSON, ulid } from "./store.mjs";
import { detectLanguage, isLanguage, t } from "./lang.mjs";
import { awaitConversationReply, DEFAULT_REPLY_DUTIES } from "./conversation-reply.mjs";
import { normalizeTokens } from "./echo-guard.mjs";
import path from "node:path";
import { readFileSync } from "node:fs";

const SESSION_IDLE_GC_MS = 10 * 60 * 1000;

// Word-boundary, case-insensitive, unicode-aware TOKEN match. \b fails on
// accented variants (e.g. "zéca"), so boundaries are explicit letter/number
// lookarounds: "zeca" must match "Zeca,", "zeca?" and never "zecar", "azeca".
// Whitespace inside a variant is a split form ("ze ca"): Deepgram sometimes
// breaks the name across a space or a hyphen, so either separator matches.
//
// The token ANYWHERE in the segment is the whole gate: position is deliberately
// not considered, so "manda ao Zeca a factura" wakes exactly like "Zeca, manda
// a factura". An address-position rule was built and then removed (2026-08-13)
// on the operator's call - in this household the name essentially never occurs
// in ambient speech, so the false-wake risk it defended against is theoretical
// while the missed wakes it caused would be real and daily.
//
// Two things make that safe to rely on rather than lucky:
//   * Garrison's own spoken acks cannot carry the word at all - ack.mjs's
//     assertSpeakable refuses to render one, so a voice sink can never speak the
//     pendant into a capture window.
//   * A capture that turns out to be nothing classifies as `unknown` and is
//     saved as a note rather than acted on.
export function wakeRegex(variants) {
  const escaped = variants
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+"));
  if (escaped.length === 0) return null;
  // Deliberately NOT global: callers use .test() on a long-lived instance, and a
  // sticky lastIndex would make every other call a miss.
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

// Does this segment end a sentence? Omi's transcriber punctuates, so a trailing
// '.', '?' or '!' is a genuine end-of-utterance signal - the one cheap piece of
// evidence available without asking a model whether the user is done talking.
// Ellipsis is excluded: the transcriber emits it mid-thought, not at the end.
export function endsSentence(text) {
  const t = String(text ?? "").trim();
  if (t.endsWith("...") || t.endsWith("…")) return false;
  return /[.?!]["')\]]?$/.test(t);
}

// Titles are compared loosely: the same intent spoken twice yields wording that
// differs in case, accents and punctuation but not in meaning.
export function normalizeTitle(title) {
  return String(title ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// The spoken card reference: the last 4 chars of the ULID, uppercased - the
// exact form a scheduled card's notification quotes back to the wearer.
export function shortRef(id) {
  return String(id ?? "").slice(-4).toUpperCase();
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// The same mixing bug one layer down, and the easiest one to miss: these get
// interpolated straight into "Snoozed ... until Sat 09:00", so an otherwise
// Portuguese confirmation ended in an English weekday.
const DAY_NAMES_PT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const MONTH_NAMES_PT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

// "Sat 09:00" within the coming week, "Thu 20 Aug 09:00" beyond it - a spoken
// confirmation needs a glanceable local time, not an ISO string.
// Defaults to English so every existing caller renders exactly as before.
export function humanTime(iso, now = new Date(), lang = "en") {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const withinWeek = Math.abs(d.getTime() - now.getTime()) < 7 * 24 * 60 * 60 * 1000;
  const days = lang === "pt" ? DAY_NAMES_PT : DAY_NAMES;
  const months = lang === "pt" ? MONTH_NAMES_PT : MONTH_NAMES;
  return withinWeek
    ? `${days[d.getDay()]} ${hm}`
    : `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${hm}`;
}

// Local wall-clock time with the UTC offset, for the classifier prompt: the
// model cannot resolve "tomorrow at 9" without knowing what time it is here.
function localIsoWithOffset(d) {
  const pad = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ---- vague times -----------------------------------------------------------
//
// "mais logo", "a noite", "de manha" are REAL time references - a wearer speaks
// them far more often than a clock time - but they carry arithmetic, and the
// one thing a spoken task has to get right is WHEN it fires. So every vague
// anchor is resolved HERE against the real clock and handed to the classifier
// as a literal timestamp to copy. The model's job is to recognise WHICH phrase
// was spoken; it never computes the moment. That keeps the behaviour testable
// without a model in the loop, and it is the same discipline the handler
// already applies to the model's ISO output (validated, never trusted).
//
// A part-of-day anchor whose clock time has already passed rolls to tomorrow:
// "de manha" said at 10:00 means tomorrow morning, not four hours ago.
const PART_OF_DAY_ANCHORS = [
  { hour: 9, phrases: ['"de manha"', '"pela manha"', '"in the morning"', '"this morning"'] },
  { hour: 13, phrases: ['"ao almoco"', '"a hora de almoco"', '"at lunch"', '"lunchtime"'] },
  { hour: 15, phrases: ['"a tarde"', '"esta tarde"', '"this afternoon"'] },
  { hour: 18, phrases: ['"ao fim do dia"', '"end of the day"'] },
  { hour: 20, phrases: ['"ao jantar"', '"a hora de jantar"', '"at dinner"', '"dinnertime"'] },
  { hour: 21, phrases: ['"a noite"', '"logo a noite"', '"esta noite"', '"tonight"', '"this evening"'] }
];

const SOON_OFFSET_MS = 30 * 60 * 1000;
const LATER_OFFSET_MS = 2 * 60 * 60 * 1000;
// Past this hour, "later" stops meaning "in two hours" and starts meaning a
// notification in the small hours. It is pulled back to the cutoff - but never
// behind "soon", or a "mais logo" spoken at 23:00 would resolve into the past
// and the card would fire the instant it was created.
const LATER_CUTOFF_HOUR = 22;

function atLocal(now, hour, dayOffset = 0) {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function nextLocal(now, hour) {
  const today = atLocal(now, hour);
  return today.getTime() > now.getTime() ? today : atLocal(now, hour, 1);
}

export function vagueTimeAnchors(now = new Date()) {
  const soon = new Date(now.getTime() + SOON_OFFSET_MS);
  let later = new Date(now.getTime() + LATER_OFFSET_MS);
  const cutoff = atLocal(now, LATER_CUTOFF_HOUR);
  if (later.getTime() > cutoff.getTime()) {
    later = new Date(Math.max(cutoff.getTime(), soon.getTime()));
  }
  return [
    { phrases: ['"daqui a pouco"', '"ja a seguir"', '"in a bit"', '"shortly"', '"soon"'], at: soon },
    { phrases: ['"mais logo"', '"mais tarde"', '"logo"', '"later"', '"later on"', '"depois"'], at: later },
    ...PART_OF_DAY_ANCHORS.map((a) => ({ phrases: a.phrases, at: nextLocal(now, a.hour) }))
  ].map((a) => ({ phrases: a.phrases, iso: localIsoWithOffset(a.at) }));
}

function vagueTimeBlock(now) {
  const rows = vagueTimeAnchors(now)
    .map((a) => `- ${a.phrases.join(" / ")} -> ${a.iso}`)
    .join("\n");
  return `A VAGUE TIME IS STILL A TIME. These are already resolved against the clock above - when the user speaks one of them, copy the timestamp VERBATIM into "scheduled_for" instead of computing your own, and never omit the field because the time was imprecise:
${rows}
Accented and unaccented spellings are the same phrase. A part of day named together with a DAY ("amanha a tarde", "tomorrow evening", "Monday morning") keeps the clock time from its row but takes the date the user named.`;
}

function timeContextLine(now) {
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    tz = "";
  }
  return `Current local time: ${WEEKDAYS_LONG[now.getDay()]} ${localIsoWithOffset(now)}${tz ? ` (timezone ${tz})` : ""}. Resolve every relative time ("tomorrow at 9", "in two hours", "tomorrow morning") against this clock, and output absolute ISO 8601 times WITH this UTC offset.`;
}

// ---- dispatch prompt + reply ------------------------------------------------

export function buildWakePrompt(command, projects, context = [], trailing = "", now = new Date(), opts = {}) {
  const projectList = projects.length > 0 ? projects.join(", ") : "(none known)";
  // The transcript is fragmented and speakers are often mis-attributed, so the
  // words that give a command its meaning frequently sit in a NEARBY segment
  // rather than the one carrying the wake word. Show that window explicitly and
  // say what it is for, or the model treats it as part of the command and
  // titles the card with someone else's sentence.
  const contextBlock =
    context.length > 0
      ? `Conversation just BEFORE the wake word (context only - the transcript is
fragmented and speaker labels are unreliable, so the detail the command refers
to is often here):
${context.map((c) => `- [${c.isUser ? "user" : "other"}] ${c.text}`).join("\n")}

`
      : "";
  return `A spoken wake-word command just arrived from the user's wearable (Portuguese or English). Classify it and respond as STRICT JSON only - no prose, no fence.

${contextBlock}Command (spoken right after the wake word): "${command}"
${
  trailing
    ? `
Conversation that CONTINUED afterwards (the mic stays on - this is very often
television, other people, or unrelated talk. Use it ONLY to complete a detail the
command clearly refers to, and ignore it entirely otherwise):
"${trailing}"
`
    : ""
}
${timeContextLine(now)}

${vagueTimeBlock(now)}

Schema:
{
  "intent": "create_task" | "create_event" | "card_command" | "discuss" | "send_message" | "automate" | "delegate" | "query" | "note" | "unknown",
  "title": "short title (create_task/create_event/note)",
  "description": "one-paragraph body in your own words (create_task/create_event)",
  "project": null,
  "scheduled_for": "absolute ISO 8601 time (create_task only, OPTIONAL - only when the user spoke a time)",
  "schedule_action": "notify" | "run" (only alongside scheduled_for),
  "action": "run" | "snooze" (card_command only),
  "card_ref": "the spoken card reference, VERBATIM letters and digits (card_command only)",
  "minutes": 120 (card_command snooze with a relative delay - whole minutes),
  "until": "absolute ISO 8601 time (card_command snooze with an absolute time)",
  "request": "the user's instruction or question, restated in one clear sentence (delegate only)",
  "ack": "one short line telling the user what you are about to do (delegate/discuss/send_message/automate)",
  "topic": "what the user wants to talk through, one clear sentence (discuss only)",
  "medium": "whatsapp" | "email" | "slack" | null (send_message only - null when they did not say),
  "recipient": "the person or channel EXACTLY as the user named them (send_message only)",
  "subject": "email subject line (send_message with medium email, optional)",
  "body": "what should be said, in the user's own words (send_message only)",
  "automation": "the automation the user NAMED, verbatim (automate only)",
  "inputs": {"key": "value"} (automate only - only inputs actually spoken, else {}),
  "answer": "direct answer to the user (query only; concise, no preamble)",
  "note_content": "the fact to remember, in your own words (note/unknown)"${
    opts.screenContext
      ? `,
  "needs_screen": true (only when the instruction CANNOT be carried out without seeing the phone screen)`
      : ""
  }
}

Rules:
- create_task: the user wants something done later (a task for the board). A
  PLAN or an INTENTION counts, not just an order: "vamos comer morangos com
  limão mais logo", "let's call the plumber tomorrow", "tenho de pagar o IMI",
  "preciso de comprar pão", "não te esqueças de regar as plantas". Someone who
  speaks the wake word and then describes something that is going to happen is
  putting it on the board - do NOT demote that to a note.
  Whenever they say WHEN - a clock time ("tomorrow at 9"), a day ("amanhã", "on
  Monday", "next week"), a relative delay ("in two hours"), or one of the VAGUE
  times resolved above ("mais logo", "à noite", "de manhã") - set
  "scheduled_for" to an absolute ISO 8601 time and "schedule_action" to "notify".
  A DAY WITHOUT A CLOCK TIME still schedules: resolve it to that day at 09:00
  local. "Remind me" is itself a request to be reminded, so it always schedules
  when any time reference is present. Use "run" ONLY when they clearly ask the
  task to run ITSELF at that time. Omit both fields only when NO time reference
  was spoken at all.
- create_event: a calendar-shaped ask (a meeting, an appointment). A reminder
  at a time is a create_task with "scheduled_for", not an event.
- card_command: the user addresses an EXISTING card by its reference - "run
  card 7Q2M", "start card 7Q2M", "snooze card 7Q2M for two hours", "snooze
  card 7Q2M until tomorrow morning". "action" is "run" for run/start and
  "snooze" for snooze/postpone/delay. "card_ref" is the spoken reference
  VERBATIM as letters and digits (join spelled-out characters: "7 Q 2 M" ->
  "7Q2M"); never invent, complete or translate it. A relative snooze gives
  "minutes"; an absolute one gives "until" computed from the current local
  time above. Never emit both.
- discuss: the user wants to TALK something through with you rather than have it
  done - "quero discutir X", "vamos falar sobre X", "let's think about X", "o que
  achas de X", "ajuda-me a decidir X". This opens a spoken conversation that
  CONTINUES without the wake word until they end it, so choose it only when they
  are inviting a back-and-forth, never for a single question (that is "query" or
  "delegate"). Put what they want to talk about in "topic", restated clearly,
  self-contained and in the user's own language. Put a one-line spoken opener in
  "ack".
- send_message: the user wants a message SENT to a named person or channel -
  "manda uma mensagem à Marília a dizer que é melhor amanhã", "envia um email ao
  João sobre a proposta", "diz no Slack ao Pedro que já vou". "recipient" is the
  person or channel EXACTLY as they named them - never a guessed address, phone
  number or handle. "body" is what should be said, in the user's own words and
  language. "medium" is "whatsapp", "email" or "slack" only when they SAID which;
  leave it null otherwise - do NOT infer email from the fact that a message
  sounds formal. "subject" only for an email they gave one for. Put a short
  spoken acknowledgement in "ack".
- automate: the user wants an existing NAMED automation run - "corre a automação
  X", "run the X automation", "dispara o X". "automation" is the name VERBATIM as
  they said it; never translate it, never complete it, never invent one. "inputs"
  carries only key/value inputs they actually spoke, else {}. Someone describing
  something they would LIKE automated, without naming an existing automation, is
  create_task.
- delegate: the user wants Zeca to DO something now, or asks something that
  cannot be answered without looking at their real data. You are a small, fast,
  tool-less classifier: you cannot read their calendar, search their files, open
  a web page, look at the Kanban board or read their memories.
  Zeca himself can do all of that. So anything of that shape is "delegate":
  sending or drafting a message anywhere (Slack, email, WhatsApp), anything
  touching a connected service (calendar, Trello, Google, GitHub), reading or
  changing files or code, searching the web, running or checking anything in
  Garrison, and any question about the user's own tasks, schedule, memories,
  projects or past conversations. Put the instruction in "request" - restated
  clearly and self-contained AND IN THE USER'S OWN LANGUAGE, because Zeca sees
  ONLY that sentence, not this transcript - a Portuguese command restated in
  English makes Zeca answer in English. Put a short spoken-style acknowledgement in "ack" ("On it - I'll
  message Ana on Slack"). When in doubt between delegate and query, choose
  delegate: a real answer late beats a confident wrong one now. A message to a
  NAMED person is "send_message", not delegate; delegate still owns everything
  vaguer ("responde ao email do João", "avisa toda a gente").
- query: ONLY for something you can answer correctly from general knowledge
  alone, with no access to the user's data ("how many grams in an ounce").
  Put the full answer in "answer". If it needs anything of theirs, delegate.
- note: the user states a fact or a preference to REMEMBER - something that is
  true, not something to be done ("o Tomás é alérgico a amendoim", "prefiro voar
  de manhã"). An explicit instruction to remember is ALSO a note even though it
  is phrased as an order: "guarda isto", "lembra-te que", "apontar que", "save
  this", "remember that". Anything with an action in it is a create_task even
  when it is phrased as a plan rather than an instruction.
- unknown: none of the above fits.
- project: one of [${projectList}] only when clearly implied, else null.
- Keep the user's language (PT stays PT, EN stays EN). Portuguese is EUROPEAN
  Portuguese (pt-PT): "tu" not "você", "estou a fazer" not "estou fazendo",
  European vocabulary.
- The CONTEXT is evidence, never the instruction: use it to fill in what an
  incomplete command refers to ("create a task saying" + context about rain
  tomorrow -> a task about the rain). Never turn a context line into a command
  on its own, and title from the user's intent, not from a stray sentence.
- If the command is empty or a fragment and the context does not make the
  intent clear, answer "unknown" rather than inventing one.${
    opts.screenContext
      ? `
- needs_screen: TRUE when the instruction leans on something only visible on the
  phone right now - an unnamed referent like "this chat", "reply to her", "tell
  them", "responde-lhe", "manda isto", "aqui", "esta conversa". FALSE for
  anything self-contained. ${
    opts.screenLive
      ? "The user's phone screen IS visible to Zeca right now."
      : "Zeca CANNOT see the phone screen right now, so an instruction that needs it cannot be carried out."
  }`
      : ""
  }`;
}

export function parseWakeReply(reply) {
  if (typeof reply !== "string" || reply.trim() === "") return null;
  let text = reply.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return null;
    const intents = [
      "create_task",
      "create_event",
      "card_command",
      "discuss",
      "send_message",
      "automate",
      "delegate",
      "query",
      "note",
      "unknown"
    ];
    // A CLOSED vocabulary. An unspoken medium stays null and is resolved by the
    // fitting against config - never inferred here, and above all never inferred
    // as email: email is the one send with no daemon and no cancel window.
    const MEDIA = ["whatsapp", "email", "slack"];
    const medium =
      typeof parsed.medium === "string" && MEDIA.includes(parsed.medium.trim().toLowerCase())
        ? parsed.medium.trim().toLowerCase()
        : null;
    // Spoken automation inputs, bounded on every axis: this map reaches a child
    // process argv, so a model that answers with 500 keys, nested objects, or a
    // key full of shell metacharacters yields {} rather than something
    // half-sanitised.
    const inputs = {};
    if (parsed.inputs && typeof parsed.inputs === "object" && !Array.isArray(parsed.inputs)) {
      for (const [k, v] of Object.entries(parsed.inputs).slice(0, 16)) {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) continue;
        if (typeof v !== "string" && typeof v !== "number") continue;
        inputs[k] = String(v).slice(0, 200);
      }
    }
    // Minutes may come back as a number or a numeric string; anything else is
    // dropped here so the handler only ever sees a usable number or null.
    const minutes =
      typeof parsed.minutes === "number" && Number.isFinite(parsed.minutes)
        ? parsed.minutes
        : typeof parsed.minutes === "string" && parsed.minutes.trim() !== "" && Number.isFinite(Number(parsed.minutes))
          ? Number(parsed.minutes)
          : null;
    return {
      intent: intents.includes(parsed.intent) ? parsed.intent : "unknown",
      title: typeof parsed.title === "string" ? parsed.title.trim() : "",
      description: typeof parsed.description === "string" ? parsed.description.trim() : "",
      project: typeof parsed.project === "string" ? parsed.project.trim() : null,
      scheduled_for: typeof parsed.scheduled_for === "string" ? parsed.scheduled_for.trim() : "",
      schedule_action: parsed.schedule_action === "run" ? "run" : "notify",
      action: parsed.action === "run" || parsed.action === "snooze" ? parsed.action : null,
      card_ref: typeof parsed.card_ref === "string" ? parsed.card_ref.trim() : "",
      minutes,
      until: typeof parsed.until === "string" ? parsed.until.trim() : "",
      request: typeof parsed.request === "string" ? parsed.request.trim() : "",
      ack: typeof parsed.ack === "string" ? parsed.ack.trim() : "",
      topic: typeof parsed.topic === "string" ? parsed.topic.trim() : "",
      medium,
      recipient: typeof parsed.recipient === "string" ? parsed.recipient.trim().slice(0, 120) : "",
      subject: typeof parsed.subject === "string" ? parsed.subject.trim().slice(0, 200) : "",
      body: typeof parsed.body === "string" ? parsed.body.trim().slice(0, 2000) : "",
      automation: typeof parsed.automation === "string" ? parsed.automation.trim().slice(0, 160) : "",
      inputs,
      answer: typeof parsed.answer === "string" ? parsed.answer.trim() : "",
      note_content: typeof parsed.note_content === "string" ? parsed.note_content.trim() : "",
      // Strict === true: an absent key, a string "true", or anything else must
      // not quietly claim the command needs the screen.
      needs_screen: parsed.needs_screen === true
    };
  } catch {
    return null;
  }
}

// The reply-language pin. "Keep the user's language" asks the model to infer
// it back out of a possibly-translated restatement; when the bus has already
// RESOLVED the language, say it outright - the difference is exactly the
// "answered me in English" bug.
// "Portuguese" alone is not a pin: models default to pt-BR, and the user hears
// "você está fazendo" from a voice that lives in Portugal. The markers are the
// pin - concrete enough that the instruction cannot be satisfied while writing
// Brazilian.
const PT_PT_RULE =
  'Reply in EUROPEAN Portuguese (pt-PT), never Brazilian: address the user as "tu" (never "você"), ' +
  'use "estou a fazer" (never "estou fazendo"), and European vocabulary ' +
  '(pequeno-almoço, telemóvel, autocarro, casa de banho, ecrã).';

function languageLine(lang) {
  if (lang === "pt") return `${PT_PT_RULE} The user spoke Portuguese.`;
  if (lang === "en") return "Reply in English - the user spoke English.";
  return `Keep the user's language. When it is Portuguese: ${PT_PT_RULE}`;
}

// A follow-up turn inside the SAME gateway session: the user just answered the
// clarifying question the previous reply asked. Deliberately thin - the
// gateway owns the conversation context, and re-sending the preamble would
// drown the answer.
export function buildFollowupPrompt(answer, { lang = null } = {}) {
  return `The user answered: "${answer}"

Continue - same rules: act now, then reply with what you DID (or found), in under 60 words, plain text, no markdown. One more clarifying question (ending in "?") only if you are still genuinely blocked. ${languageLine(lang)}`;
}

// What the OPERATIVE sees for a delegated spoken request. It reaches him with
// no transcript and no wearable context, so the framing has to carry three
// things the text alone does not: that this came from speech (so the phrasing
// may be mangled and the reply will be READ ALOUD or shown on a phone), that he
// should act rather than propose, and that the answer must be short enough to
// survive a notification.
//
// The surfaces are NAMED, and the Kanban board is disambiguated from the
// session to-do list on purpose. This prompt used to say only "using your tools
// and connected services", and a spoken "what is on my board?" came back
// "your board is empty right now - I checked the task list" while the chat lane,
// whose prompt did name the board, correctly reported 10 To Do / 41 Backlog on
// the same operative in the same minute (2026-08-13). The operative had reached
// for its own in-session to-do list, which really was empty, and reported that
// as the user's board. Vocabulary the user shares with an unrelated tool has to
// be pinned to the right one here, because nothing downstream can catch it: the
// answer is confident, well-formed, and wrong.
export function buildDelegatePrompt(request, { boardUrl = null, screen = null, lang = null } = {}) {
  // The board is NOT an MCP server - there is no kanban tool in the operative's
  // toolset - so an operative asked about "my board" has to know to call the
  // fitting's HTTP API, and a fresh session has no way to guess the port. The
  // fitting already resolves that address from the board's status file, so hand
  // it over rather than making the model discover it: without this line the
  // answer is a coin flip between curling the right port and reporting its own
  // empty TaskList as an empty board.
  const boardLine = boardUrl
    ? `The user's Kanban board is the kanban-loop fitting's HTTP API at ${boardUrl} - read it with GET ${boardUrl}/cards (and /lists), for example via curl. That API is the board; there is no kanban MCP tool.`
    : `The user's Kanban board is the kanban-loop fitting's HTTP API on this machine; find its address in ~/.garrison/ui-fittings/kanban-loop.json ("url") and read it with GET <url>/cards. There is no kanban MCP tool.`;
  // ios-thing's framing, kept close to verbatim because that wording is the
  // thing that made it work. The AGE is new and load-bearing: runDelegate reuses
  // one gateway session per capture session, so a follow-up lands in the same
  // conversation with a NEW pinned frame, and without the age the operative
  // happily re-reads the stale path from the previous turn.
  const screenLine = screen
    ? `

A screenshot of the user's phone AT THE MOMENT THEY SPOKE (${Math.round((screen.ageMs ?? 0) / 1000)} seconds ago) is saved at ${screen.file} - they were looking at this screen, often a chat or an app. The instruction may refer to it ("this chat", "reply to her", "tell them", "responde-lhe"). Read it to resolve any such reference, then act on the SAME conversation or target. If the screenshot does not actually show what the instruction refers to, say so rather than guessing at a different one.`
    : "";
  return `This request came from the user speaking to their wearable, so the wording may be garbled by transcription - read it for intent, not literally.

Request: "${request}"${screenLine}

Do it now, using your tools and connected services - their Kanban board, memories, files, calendar and anything else you can reach. Don't ask for confirmation and don't propose a plan - if something is ambiguous, make the reasonable choice and say which one you made. If you genuinely cannot do it (no access, missing credential, service not connected), say exactly what is missing in one sentence - do not pretend it is done.

"My board", "my tasks" and "my cards" ALWAYS mean the user's Kanban board. ${boardLine} They NEVER mean your own session to-do list: TaskList/TaskCreate and any similar in-session task tool are YOUR scratchpad for this turn, they are always empty at the start of one, and their contents are not the user's data. Never answer a question about the user's board from them - read the board itself, and if you genuinely could not reach it say so rather than reporting an empty scratchpad as an empty board.

"Their memories" means the basic-memory tools (search_notes, read_note, recent_activity) over their Obsidian vault - search there BEFORE saying you found nothing, and when you find nothing say exactly what you searched for and where. You can search the web when their own data is not enough. If a connector (Google, Slack, ...) is genuinely not connected, say so in one sentence and still do everything the rest of your tools allow.

If the request is genuinely ambiguous or underspecified, do NOT guess and do NOT answer with generic filler: reply with exactly ONE short clarifying question, ending in "?". The user answers by voice and the conversation continues right here - so ask the one question whose answer unblocks you.

Then reply with what you DID (or found), in under 60 words, plain text, no markdown, no preamble. This reply is READ ALOUD to the user or shown on their phone. ${languageLine(lang)}`;
}

// The revision pass. The card already exists and the user has had time to look
// at it, so the question is not "what did they want" but "did they change it".
// Bias hard toward leaving it alone: most of what follows a command is unrelated
// talk, and silently rewriting a card the user was happy with is worse than
// missing a correction they can make by hand.
export function buildRevisionPrompt({ command, title, description, conversation }) {
  return `A task card was created from a spoken command a few minutes ago. Since then the microphone kept listening. Decide whether the user CORRECTED or ADDED TO that task, and respond as STRICT JSON only - no prose, no fence.

Original spoken command: "${command}"

The card as it stands:
- title: "${title}"
- description: "${description}"

What was said afterwards (mostly unrelated talk, television, or other people -
only some of it, if any, is about the task):
"${conversation}"

Schema:
{ "action": "none" | "revise", "title": "corrected title", "description": "corrected description", "note": "what changed, one line, addressed to the user" }

Rules:
- "none" is the DEFAULT and the common case. Choose it unless the user clearly
  referred back to this task.
- "revise" only for an explicit correction ("no, make that Wednesday", "actually
  it's for the other project") or detail plainly about this same task.
- Never invent detail that was not said. Never fold in an unrelated new task -
  a different request is not a revision of this one.
- Keep the user's language (PT stays PT, EN stays EN); Portuguese is EUROPEAN
  Portuguese (pt-PT), never Brazilian.`;
}

export function parseRevisionReply(reply) {
  if (typeof reply !== "string" || reply.trim() === "") return null;
  let text = reply.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return null;
    // Anything that is not an explicit "revise" means leave the card alone -
    // an unparseable or surprising answer must never rewrite a card.
    const action = parsed.action === "revise" ? "revise" : "none";
    return {
      action,
      title: typeof parsed.title === "string" ? parsed.title.trim() : "",
      description: typeof parsed.description === "string" ? parsed.description.trim() : "",
      note: typeof parsed.note === "string" ? parsed.note.trim() : ""
    };
  } catch {
    return null;
  }
}

// Ends a spoken discussion. ANCHORED exact-match, the same shape the gateway's
// AFFIRMATIVE_GO uses and for the same reason: "pronto, mas o que achas disso"
// is a turn in the conversation, not an instruction to end it. A sentence that
// merely CONTAINS "done" must never close the discussion.
export const DISCUSS_END =
  /^(?:pronto|acabou|chega|ja esta|já está|e tudo|é tudo|obrigado|obrigada|done|that'?s it|thats it|we'?re done|stop|thanks)[.!]?$/i;

// The kickoff for a SPOKEN discussion.
//
// The doctrine is restated from kanban-loop's buildDiscussKickoff rather than
// imported (cross-fitting imports are forbidden, and that one is card-shaped:
// it names a brief path and a checklist that do not exist here).
//
// The voice-only constraints are not style preferences. "Under 55 words" is an
// ENGINEERING limit: tts.mjs refuses to render above MAX_TEXT_CHARS = 600, and
// a discussion that silently drops into the phone's robotic synthesizer voice
// is a different product from the one being built here.
export function buildVoiceDiscussPrompt(topic, { context = [] } = {}) {
  const contextBlock =
    context.length > 0
      ? `\nWhat was said just before, for context only:\n"${context.map((c) => c.text).join(" ")}"\n`
      : "";
  return `The user wants to talk something through with you, out loud, through an earpiece. This is a conversation, not a task.

What they want to discuss: "${topic}"
${contextBlock}
How to be in this conversation:

Argue with me before you agree with me. If I am about to do something daft, say so first and explain why - agreement I did not earn is worth nothing. Hold the engineering and the product view at once. Prefer what you can check over what sounds right, and say plainly when you do not know rather than filling the gap.

Ask ONE real question at a time, not three. Do not summarise what I just said back to me. Answer in the language I speak; when that is Portuguese, it is EUROPEAN Portuguese (pt-PT) - "tu" not "você", "estou a fazer" not "estou fazendo".

How to SPEAK here, which is different from writing:

Everything you say is read aloud into an earpiece. Keep every reply under 55 words - this is a hard limit, not a guideline. Never use markdown, bullet points, headings, code, URLs, or anything you would not say out loud to someone standing next to you. No preamble and no sign-off. Plain spoken sentences.

There is no document to write here and no file to touch. The conversation is the whole of it.

Open the discussion now with your first reply.`;
}

// Every later turn. Deliberately thin: the gateway owns continuity for this
// session id, so re-sending the transcript would pay for it twice and drift.
export function buildVoiceDiscussTurn(utterance) {
  return `${utterance}

(Still speaking out loud. Under 55 words, plain spoken sentences, no markdown, no lists.)`;
}

// A long reply still has to be heard. Split on sentence boundaries so each
// piece renders as its own clip; capped at two, because a third means the
// prompt failed and the fix is the prompt, not more audio.
export function splitForSpeech(text, { maxChars = 500, maxChunks = 2 } = {}) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const sentences = clean.match(/[^.!?]+[.!?]*\s*/g) ?? [clean];
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && (current + sentence).length > maxChars) {
      chunks.push(current.trim());
      current = "";
      if (chunks.length >= maxChunks) break;
    }
    current += sentence;
  }
  if (current.trim() && chunks.length < maxChunks) chunks.push(current.trim());
  const kept = chunks.slice(0, maxChunks);
  const spokenLength = kept.join(" ").length;
  if (spokenLength < clean.length) kept[kept.length - 1] = `${kept[kept.length - 1]} ...`;
  return kept;
}

// ---- the bus ----------------------------------------------------------------

// Default source identity. A sibling channel (the iOS companion) reuses this
// module as a byte-identical copy — cross-fitting imports are forbidden — and
// passes its own bag; every default below preserves omi behaviour exactly.
export const OMI_WAKE_SOURCE = {
  id: "omi",
  label: "Omi",
  originPrefix: "omi",
  originChannel: { channel: "omi", threadId: "omi-reports" },
  sessionProvenanceKey: "omi_session_id",
  logPrefix: "omi-channel"
};

// The active-conversation window (D25). A delegate reply comes back with the
// gateway session that produced it; for a while afterwards the next spoken
// request belongs to THAT conversation, not to a fresh one keyed on whichever
// capture session happened to carry the words - a reconnect, or the same
// person speaking through another source, must not lose the thread. Two
// inputs, one answer:
//
//   - the explicit pin: a client (the app's Conversation screen) names the
//     gateway session the user is looking at; it wins over everything for one
//     window from the moment it was set;
//   - the bus's own last reply {sessionId, at}, resumed while it is younger
//     than the window.
//
// One instance is shared by every bus in the process (the pin is global; each
// bus keeps its own last reply). Process memory only - a restart forgets it,
// which is the honest thing, because the gateway it pointed at restarted too.
export class ActiveConversation {
  constructor({ windowMs = 300000, now = () => Date.now() } = {}) {
    this.windowMs = Math.max(0, Number(windowMs) || 0);
    this.now = now;
    this.pinned = null; // { sessionId, until }
  }

  pin(sessionId) {
    const id = String(sessionId ?? "").trim();
    if (!id) return null;
    this.pinned = { sessionId: id, until: this.now() + this.windowMs };
    return this.current();
  }

  clear() {
    this.pinned = null;
  }

  // The pin as a client sees it: expired pins read as none.
  current() {
    if (this.pinned && this.pinned.until <= this.now()) this.pinned = null;
    return this.pinned
      ? { session_id: this.pinned.sessionId, until: new Date(this.pinned.until).toISOString() }
      : { session_id: null, until: null };
  }

  // Which gateway session a bus should resume, given the bus's own last reply:
  // { sessionId, via: "pin" | "window" } or null for "start from the key".
  resumeFor(last) {
    const pin = this.current();
    if (pin.session_id) return { sessionId: pin.session_id, via: "pin" };
    if (last?.sessionId && this.windowMs > 0 && this.now() - last.at < this.windowMs) {
      return { sessionId: last.sessionId, via: "window" };
    }
    return null;
  }
}

export class WakeBus {
  constructor({ cfg, store, counters, runFn, operativeFn = null, board, memoryWriter, notifier, log = console, now = () => Date.now(), source = OMI_WAKE_SOURCE, onLifecycle = null, language = null, speakFn = null, discussFn = null, connectorFn = null, cortexFn = null, screenContextFn = null, activeConversation = null, conversationFn = null, conversationWaitFn = null, conversationTurnFn = null, screenFramesFn = null, fetchImpl = globalThis.fetch }) {
    this.cfg = cfg;
    this.store = store;
    this.counters = counters;
    this.source = { ...OMI_WAKE_SOURCE, ...source };
    // Optional lifecycle reporter for feedback sinks (additive, inert when
    // absent - omi passes nothing and behaves exactly as before). Receives
    // (name, payload): wake_detected, segment_captured, window_closed,
    // task_created; task_failed is reported from dispatch on a fallback
    // outcome. Never allowed to throw into the pipeline.
    this.onLifecycle = onLifecycle;
    // Which language this channel confirms in. A string pins it; a function is
    // asked per dispatch (the capture-service remembers per session). Null means
    // "read it off what was said", which is what omi passes and what every
    // default below preserves.
    this.language = language;
    // Optional lanes, all null by default so omi-channel - which has no live
    // socket to speak into - keeps behaving exactly as before. `speakFn === null`
    // is also what makes the `discuss` intent degrade to `delegate` there: a
    // spoken conversation on a channel that cannot speak is not a conversation.
    this.speakFn = speakFn;
    this.discussFn = discussFn;
    this.connectorFn = connectorFn;
    this.cortexFn = cortexFn;
    // Resolves the phone screen the user was looking at. Null for omi, which
    // has no broadcast lane - every screen branch below is then unreachable.
    this.screenContextFn = screenContextFn;
    // The conversation a capture session was started FROM (the REC button in
    // a conversation's composer), and the door that posts a user turn into it.
    // Both null for omi and the pendant, whose sessions belong to no
    // conversation - every conversation branch below is then unreachable.
    // `screenFramesFn` widens the single screen still to the moments before it.
    this.conversationFn = conversationFn;
    // The same resolve, allowed to wait one bounded fetch. Used at dispatch
    // only: the wake hit needs its answer synchronously.
    this.conversationWaitFn = conversationWaitFn;
    this.conversationTurnFn = conversationTurnFn;
    this.screenFramesFn = screenFramesFn;
    // The active-conversation window (D25), shared across the buses in a
    // process. Null keeps the deterministic per-capture-session key, which is
    // exactly what omi-channel's copy of this module does.
    this.activeConversation = activeConversation;
    this.lastDelegate = null; // { sessionId, at } of the last reply, this bus only
    this.discussions = new Map(); // sessionId -> discussion state
    // Open clarifying-question windows: Zeca asked something and the NEXT
    // utterance - no wake word - is the answer. sessionId -> window.
    this.answers = new Map();
    // Two lanes, deliberately distinct: `runFn` is the small pinned classifier
    // the wearer waits on; `operativeFn` is the full-toolset turn nobody waits
    // on. Collapsing them is what made every spoken command cost a Sonnet turn.
    this.runFn = runFn;
    this.operativeFn = operativeFn;
    this.board = board;
    this.memoryWriter = memoryWriter;
    this.notifier = notifier;
    this.log = log;
    this.now = now;
    this.sessions = new Map(); // sessionId -> session state (in memory ONLY)
    this.regex = wakeRegex(cfg.wakeVariants);
    this.dispatchChain = Promise.resolve();
    this.recentCards = new Map(); // dedupeKey -> created-at ms (in memory)
    this.revisions = new Map(); // sessionId -> pending revision watch (in memory)
    // D56: the answer to a spoken conversation turn is watched for in the
    // ledger and pushed/spoken back. One watch per turn, independent of the
    // delegate chain (a second wake hit must not wait minutes for the first
    // answer); `announcedReplies` keeps two watches on one conversation from
    // announcing the same stretch twice.
    this.fetchImpl = fetchImpl;
    this.replyWatches = new Set();
    this.announcedReplies = new Map(); // conversationId -> Set<stretchId>
    // conversationId -> { promise, eventIds } - see trackReplyWatch.
    this.replyWatchByConversation = new Map();
  }

  // Tests await this so the deferred reply watch has settled.
  settleReplyWatches() {
    return Promise.all([...this.replyWatches]);
  }

  // One watch per CONVERSATION, not per turn (D62). The standing Zeca
  // conversation takes every spoken sentence, so three sentences used to start
  // three watchers on one ledger; each found the same stretch and each spoke it,
  // and the user heard the same answer three times. A turn that arrives while a
  // watch is already running joins it - it still gets its `reply` block in the
  // wake-result, it just does not open a second mouth.
  trackReplyWatch(args) {
    const key = args?.conversationId ?? null;
    const joined = key ? this.replyWatchByConversation.get(key) : null;
    if (joined) {
      if (args?.eventId) joined.eventIds.add(args.eventId);
      this.counters.bump("wake_reply_watches_joined");
      return joined.promise;
    }
    const eventIds = new Set(args?.eventId ? [args.eventId] : []);
    const watch = this.watchConversationReply({ ...args, eventIds }).catch((err) => {
      this.log.error(`[${this.source.logPrefix}] wake reply watch error: ${err?.message ?? err}`);
      return null;
    });
    this.replyWatches.add(watch);
    if (key) this.replyWatchByConversation.set(key, { promise: watch, eventIds });
    watch.finally(() => {
      this.replyWatches.delete(watch);
      if (key) this.replyWatchByConversation.delete(key);
    });
    return watch;
  }

  // Waits for the operative's answer to the turn posted by conversationTurn and
  // hands it to the notifier as `conversation_reply`: spoken first when a mic or
  // pendant session is live (the speak-first notifier wrapped around this bus),
  // a push otherwise - the phone owner is in another app and the old companion
  // never left them without the answer. The reply is also appended to the
  // wake-results record so the exchange reads back whole.
  async watchConversationReply({ conversationId, eventId, sessionId = null, lang = "en", base, fromIndex, eventIds = null }) {
    const announced = this.announcedReplies.get(conversationId) ?? new Set();
    this.announcedReplies.set(conversationId, announced);
    if (this.announcedReplies.size > 50) this.announcedReplies.delete(this.announcedReplies.keys().next().value);
    const startedAt = this.now();
    const duties = Array.isArray(this.cfg.wakeReplyDuties) && this.cfg.wakeReplyDuties.length > 0 ? this.cfg.wakeReplyDuties : DEFAULT_REPLY_DUTIES;
    const timeoutMs = this.cfg.wakeReplyTimeoutMs ?? 300000;
    const reply = await awaitConversationReply({
      base,
      conversationId,
      fromIndex,
      fetchImpl: this.fetchImpl,
      duties,
      timeoutMs,
      ...(typeof this.cfg.wakeReplyPollMs === "number" ? { pollMs: this.cfg.wakeReplyPollMs } : {}),
      isFresh: (stretchId) => !announced.has(stretchId),
      // Test and take in one tick: an async gap between the two is how three
      // watchers announced one stretch.
      claim: (stretchId) => {
        if (announced.has(stretchId)) return false;
        announced.add(stretchId);
        if (announced.size > 200) announced.delete(announced.values().next().value);
        return true;
      },
      now: this.now
    });
    if (!reply) {
      this.counters.bump("wake_conversation_reply_timeouts");
      this.log.log(`[${this.source.logPrefix}] wake reply ${eventId}: no ${duties.join("/")} answer in ${conversationId} within ${Math.round(timeoutMs / 1000)}s`);
      return null;
    }
    this.counters.bump("wake_conversation_replies");
    this.counters.observe("wake_conversation_reply_ms", this.now() - startedAt);
    const receipts = await this.notifier.send({
      template: "conversation_reply",
      params: {
        text: reply.text,
        path: `/talk/${encodeURIComponent(conversationId)}`,
        lang,
        sessionId,
        eventId,
        conversationId,
        duty: reply.duty ?? null
      }
    });
    const delivery = receipts.some((r) => r?.means === "companion-speech" && r?.ok)
      ? "spoken"
      : receipts.some((r) => r?.means === "companion-push" && r?.ok)
        ? "push"
        : "undelivered";
    this.log.log(`[${this.source.logPrefix}] wake reply ${eventId} -> ${reply.duty ?? "?"} (${reply.text.length} chars, ${delivery})`);
    // Every turn that joined this watch gets the reply on its own record: one
    // answer was spoken, and the trail still says which sentences it answered.
    for (const id of eventIds?.size ? eventIds : [eventId]) {
      const resultFile = path.join(this.store.root, "wake-results", `${id}.json`);
      try {
        const record = JSON.parse(readFileSync(resultFile, "utf8"));
        record.reply = { text: reply.text, duty: reply.duty ?? null, stretchId: reply.stretchId, at: new Date(this.now()).toISOString(), delivery };
        atomicWriteJSON(resultFile, record);
      } catch {
        // The record is written by dispatch after this turn's confirmation; a
        // missing one (tests, a reset store) costs the forensic line, not the push.
      }
    }
    return { ...reply, delivery };
  }

  emitLifecycle(name, payload) {
    if (!this.onLifecycle) return;
    try {
      this.onLifecycle(name, payload);
    } catch (err) {
      this.log.error(`[${this.source.logPrefix}] lifecycle hook error: ${err?.message ?? err}`);
    }
  }

  // The wake cue ("Sim?") plays through the phone speaker while the user is
  // already talking, and the mic sometimes folds its echo into the SAME final
  // as the user's first words - "Sim. Olha, achas que..." - where the
  // exact-match echo lane cannot touch it without eating real speech. A
  // LEADING cue echo is unambiguous though: strip it off the front, never
  // anywhere else. The prefixes are injected by the capture-service (they are
  // its cue texts); omi injects nothing and this is a no-op there.
  stripLeadingCueEcho(command) {
    const prefixes = this.cfg.wakeEchoPrefixes ?? [];
    if (prefixes.length === 0) return command;
    let out = String(command ?? "");
    let strippedAny = false;
    let changed = true;
    while (changed) {
      changed = false;
      for (const prefix of prefixes) {
        const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\s,.:;!?]+`, "iu");
        if (re.test(out)) {
          out = out.replace(re, "").trim();
          changed = true;
          strippedAny = true;
        }
      }
    }
    if (strippedAny) this.counters.bump("wake_cue_echo_stripped");
    return out;
  }

  // Which language to confirm in, decided ONCE per dispatch.
  //
  // The classifier's own output is preferred over the raw transcript: the model
  // is instructed to keep the user's language and its output is well-formed,
  // whereas the ASR text can be garbled in exactly the way that defeats a
  // word-list. Falls through to the injected/configured language, then to
  // whatever the user actually said, and only then to a default.
  resolveLanguage(command, parsed = null) {
    const spoken = [parsed?.title, parsed?.answer, parsed?.ack, parsed?.note_content, parsed?.description]
      .filter((v) => typeof v === "string" && v.trim())
      .join(" ");
    const fromModel = spoken ? detectLanguage(spoken) : null;
    if (isLanguage(fromModel)) return fromModel;
    const injected = typeof this.language === "function" ? this.language() : this.language;
    if (isLanguage(injected)) return injected;
    const fromCommand = detectLanguage(command);
    if (isLanguage(fromCommand)) return fromCommand;
    const configured = this.cfg.wakeLanguage;
    if (isLanguage(configured)) return configured;
    // Last resort: the language the TRANSCRIBER is pinned to. Falling back to
    // English for a Portuguese household - which is what happened overnight
    // once the 6h language memory expired - is the worse guess by far, and the
    // STT pin is the one thing that is always true about this deployment.
    const stt = String(this.cfg.sttLanguage ?? "").slice(0, 2).toLowerCase();
    return isLanguage(stt) ? stt : "en";
  }

  // Remember a just-created card and evict anything past the dedupe window, so
  // the map cannot grow without bound in a long-lived process.
  rememberCard(key) {
    const now = this.now();
    this.recentCards.set(key, now);
    const window = this.cfg.wakeCardDedupeMs ?? 0;
    for (const [k, at] of this.recentCards) {
      if (now - at >= window) this.recentCards.delete(k);
    }
  }

  // Open a revision watch after a card is created: keep the mic's output for
  // this session for a while, then ask ONCE whether the user corrected it.
  scheduleRevision({ sessionId, cardId, command, title, description }) {
    const after = this.cfg.wakeReviseAfterMs ?? 0;
    if (after <= 0 || !sessionId || !cardId) return null;
    // One watch per session: a newer card supersedes an older one rather than
    // accumulating timers on a session that keeps issuing commands.
    const existing = this.revisions.get(sessionId);
    if (existing?.timer) clearTimeout(existing.timer);
    const watch = { cardId, command, title, description, lines: [], timer: null };
    watch.timer = setTimeout(() => {
      this.reviseChain = (this.reviseChain ?? Promise.resolve())
        .then(() => this.runRevision(sessionId))
        .catch((err) => this.log.error(`[${this.source.logPrefix}] wake revision error: ${err?.message ?? err}`));
    }, after);
    if (watch.timer.unref) watch.timer.unref();
    this.revisions.set(sessionId, watch);
    return watch;
  }

  async runRevision(sessionId) {
    const watch = this.revisions.get(sessionId);
    this.revisions.delete(sessionId);
    if (!watch) return null;
    if (watch.timer) clearTimeout(watch.timer);
    // Kill switch honoured here too: flipping wake off must stop the deferred
    // pass, not just new captures.
    if (!this.cfg.wakeEnabled || !this.runFn || !this.cfg.gatewayUrl) return null;
    const conversation = watch.lines.join(" ").replace(/\s+/g, " ").trim();
    if (!conversation) return null;
    this.counters.bump("wake_revisions_checked");
    const { reply } = await this.runFn({
      prompt: buildRevisionPrompt({
        command: watch.command,
        title: watch.title,
        description: watch.description,
        conversation
      })
    });
    const parsed = parseRevisionReply(reply);
    if (!parsed || parsed.action !== "revise") {
      this.counters.bump("wake_revisions_none");
      return { action: "none" };
    }
    const applied = await this.board.reviseCard(watch.cardId, {
      title: parsed.title || null,
      description: parsed.description || null,
      note: parsed.note || null
    });
    if (!applied?.ok) {
      this.counters.bump("wake_revisions_failed");
      return { action: "revise", applied };
    }
    this.counters.bump("wake_revisions_applied");
    this.log.log(`[${this.source.logPrefix}] wake revision ${applied.mode} card ${watch.cardId}`);
    // Tell the user, or a silent rewrite is indistinguishable from a bug.
    await this.notifier
      .send({
        template: "wake_confirmation",
        params: {
          text: parsed.note || t("wake.updated", { title: parsed.title || watch.title }, this.resolveLanguage(watch.command ?? "", parsed)),
          cardUrl: await this.notifier.cardUrl(watch.cardId).catch(() => null)
        }
      })
      .catch(() => []);
    return { action: "revise", applied };
  }

  // ---- clarifying questions (the answer window) ----------------------------
  //
  // The delegate prompt invites the operative to ask ONE question when the
  // request is ambiguous. The wearer answers by just talking - demanding the
  // wake word to answer a question Zeca asked would be absurd. Three rules
  // keep that safe on an always-on microphone:
  //
  //   * the window ARMS only after the question has actually been SPOKEN (the
  //     phone's {spoken, ok} receipt) - so the question's own echo, which the
  //     mic hears a beat later, cannot answer itself;
  //   * it stays open for a few seconds only, and the wake word always wins;
  //   * rounds are capped - a model that keeps asking stops being answered.
  //
  // Registered by the capture-service's speak-first notifier; omi-channel has
  // no speak lane and therefore never opens one - the mirror stays inert.

  expectAnswer(sessionId, ackId, { lang = "en", rounds = 0, eventId = null, reprompt = false, spoken = null } = {}) {
    if (!sessionId || !ackId) return;
    // Only the bus that actually owns this session may open a window. The
    // capture-service runs two (companion + pendant) and registers on both,
    // so without this a pendant question also arms a phantom window on the
    // companion bus - inert today, but it would consume a mic-mode answer
    // meant for the pendant the moment both lanes are live at once.
    if (!this.sessions.has(sessionId)) return;
    if (rounds >= (this.cfg.wakeFollowupMaxRounds ?? 3)) {
      this.counters.bump("wake_followup_rounds_capped");
      return;
    }
    this.answers.set(sessionId, { ackId, lang, rounds, eventId, reprompt, spoken, armed: false, expiresAt: 0 });
  }

  armAnswerWindow(ackId) {
    for (const [sessionId, w] of this.answers) {
      if (w.ackId !== ackId || w.armed) continue;
      w.armed = true;
      // A re-prompt window is wider than a clarification one: the user has to
      // realise they were not understood, think, and say the whole thing again,
      // where answering a question is a reflex.
      w.expiresAt = this.now() + (w.reprompt ? (this.cfg.wakeRepromptWindowMs ?? 20000) : (this.cfg.wakeFollowupWindowMs ?? 12000));
      this.counters.bump("wake_followup_windows_armed");
      return sessionId;
    }
    return null;
  }

  openAnswerWindow(sessionId) {
    const w = this.answers.get(sessionId);
    if (!w || !w.armed) return null;
    if (this.now() > w.expiresAt) {
      this.answers.delete(sessionId);
      this.counters.bump("wake_followup_windows_expired");
      return null;
    }
    return w;
  }

  // -> true when this segment is nothing but words from the line Zeca just
  // spoke. Deliberately strict (every token must appear in the spoken line, and
  // a segment as long as the line itself is not a repeat of it): a wearer who
  // really says "repete" is one token away from being ignored, and eating a
  // real repeat is worse than answering one echo.
  isSpokenEcho(text, spoken) {
    if (!spoken) return false;
    const said = normalizeTokens(text);
    if (said.length === 0) return true;
    const line = new Set(normalizeTokens(spoken));
    if (line.size === 0) return false;
    if (said.length > line.size) return false;
    // Containment, not equality: the microphone hears the line through a
    // speaker and Deepgram re-renders it - "Não percebi - repete?" came back as
    // "Não percebi, repito." and, one token off a strict subset, was dispatched
    // as if the user had said it. Two thirds of a short line is our own voice.
    const hits = said.filter((tok) => line.has(tok)).length;
    return hits / said.length >= 0.6;
  }

  // ---- spoken discussions --------------------------------------------------

  discussion(sessionId) {
    return this.discussions.get(sessionId) ?? null;
  }

  // One fable-class turn per utterance, serialised: two segments arriving while
  // a turn is in flight become ONE next utterance rather than two concurrent
  // conversations answering over each other.
  appendDiscussion(sessionId, text) {
    const d = this.discussion(sessionId);
    if (!d) return;
    d.parts.push(text);
    d.lastActivity = this.now();
    this.armDiscussIdle(sessionId);
    if (d.utteranceTimer) clearTimeout(d.utteranceTimer);
    const settled = endsSentence(text);
    const waitMs = settled ? this.cfg.wakeSilenceCloseMs : this.cfg.wakeSilenceCloseMs * 2;
    d.utteranceTimer = setTimeout(() => this.flushDiscussion(sessionId), waitMs);
    d.utteranceTimer.unref?.();
    this.emitLifecycle("segment_captured", { sessionId, at: this.now() });
  }

  armDiscussIdle(sessionId) {
    const d = this.discussion(sessionId);
    if (!d) return;
    if (d.idleTimer) clearTimeout(d.idleTimer);
    d.idleTimer = setTimeout(() => this.endDiscussion(sessionId, "idle"), this.cfg.discussIdleMs ?? 180000);
    d.idleTimer.unref?.();
  }

  flushDiscussion(sessionId) {
    const d = this.discussion(sessionId);
    if (!d || d.parts.length === 0) return;
    const utterance = d.parts.join(" ").replace(/\s+/g, " ").trim();
    d.parts = [];
    if (!utterance) return;
    d.chain = (d.chain ?? Promise.resolve())
      .then(() => this.runDiscussTurn(sessionId, utterance))
      .catch((err) => this.log.error(`[${this.source.logPrefix}] discuss turn error: ${err?.message ?? err}`));
  }

  async runDiscussTurn(sessionId, utterance) {
    const d = this.discussion(sessionId);
    if (!d) return;
    if ((d.turns ?? 0) >= (this.cfg.discussMaxTurns ?? 40)) {
      this.endDiscussion(sessionId, "max-turns");
      return;
    }
    d.turns = (d.turns ?? 0) + 1;
    this.counters.bump("wake_discuss_turns");
    // The wearer needs to know the discussion is alive well before a fable turn
    // can answer.
    this.emitLifecycle("window_closed", { sessionId, reason: "discuss-thinking", at: this.now() });
    const startedAt = this.now();
    let reply = "";
    try {
      const res = await this.discussFn({ prompt: buildVoiceDiscussTurn(utterance), sessionId: d.threadId });
      reply = String(res?.reply ?? "").trim();
    } catch (err) {
      this.counters.bump("wake_discuss_failed");
      reply = t("wake.delegate_failed", { error: err?.message ?? err }, d.lang);
    }
    this.counters.observe("wake_discuss_ms", this.now() - startedAt);
    await this.speakDiscussion(reply, d);
  }

  async speakDiscussion(text, d) {
    for (const chunk of splitForSpeech(text)) {
      try {
        await this.speakFn?.(chunk, { kind: "discuss", lang: d?.lang ?? null });
      } catch (err) {
        this.log.error(`[${this.source.logPrefix}] discuss speak failed: ${err?.message ?? err}`);
      }
    }
  }

  endDiscussion(sessionId, reason) {
    const d = this.discussion(sessionId);
    if (!d) return null;
    if (d.utteranceTimer) clearTimeout(d.utteranceTimer);
    if (d.idleTimer) clearTimeout(d.idleTimer);
    this.discussions.delete(sessionId);
    const s = this.sessions.get(sessionId);
    if (s && s.state === "discussing") s.state = "armed";
    this.counters.bump("wake_discuss_ended");
    this.log.log(`[${this.source.logPrefix}] discussion ended (${reason}) after ${d.turns ?? 0} turns`);
    // The transcript is the artefact. Written on the way out rather than per
    // turn, so an abandoned discussion still leaves something behind.
    if (d.turns > 0) {
      try {
        this.memoryWriter.write({
          title: `Conversa: ${d.topic.slice(0, 60)}`,
          content: d.topic,
          tags: ["wake", "discuss"],
          provenance: { source: `${this.source.id} voice discussion`, turns: d.turns, ended: reason }
        });
      } catch {
        /* the memory store is optional-one; a lost transcript never breaks the exit */
      }
    }
    return { reason, turns: d.turns ?? 0 };
  }

  session(sessionId) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        id: sessionId,
        state: "armed", // armed | capturing | discussing
        seen: new Set(), // segment fingerprints (dedupe - I6)
        parts: [],
        // Rolling pre-wake context, in memory only and never persisted unless a
        // hit actually fires (I5's "dropped in memory" still holds for a session
        // that never wakes). Bounded by wakeContextSegments and pruned by age.
        recent: [],
        contextUsed: [],
        wakeHitAt: 0,
        // The frame PINNED at the wake hit, not at dispatch: the capture window
        // runs up to 45s, so by dispatch the user has long stopped looking at
        // whatever they meant.
        screen: null,
        silenceTimer: null,
        capTimer: null,
        lastActivity: this.now()
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  gc() {
    const cutoff = this.now() - SESSION_IDLE_GC_MS;
    for (const [id, s] of this.sessions) {
      if (s.lastActivity < cutoff && s.state === "armed") this.sessions.delete(id);
    }
  }

  // Entry point from the realtime webhook. Content stays in memory; only
  // counters escape. Never throws (a webhook must always ack fast).
  handleSegments({ sessionId, segments }) {
    try {
      if (!this.regex || !Array.isArray(segments) || !sessionId) return;
      this.gc();
      const s = this.session(sessionId);
      s.lastActivity = this.now();
      const watch = this.revisions.get(sessionId);
      for (const seg of segments) {
        const text = typeof seg?.text === "string" ? seg.text : "";
        if (!text.trim()) continue;
        // A revision watch listens to everything after its card was created,
        // including the speech that belongs to a later wake capture - a
        // correction is often phrased as a fresh command ("Zeca, no, Wednesday").
        if (watch && watch.lines.length < (this.cfg.wakeReviseMaxSegments ?? 0)) {
          watch.lines.push(text.trim());
        }
        const fingerprint = `${seg?.start ?? ""}|${seg?.end ?? ""}|${text}`;
        if (s.seen.has(fingerprint)) {
          this.counters.bump("wake_segments_deduped");
          continue;
        }
        s.seen.add(fingerprint);

        // An open answer window eats the next utterance: the wearer is
        // ANSWERING Zeca's question, not issuing a command. The wake word
        // still wins - saying the name is always a fresh start.
        const answerWindow = this.openAnswerWindow(sessionId);
        if (answerWindow && !this.regex.test(text)) {
          // Our own "didn't catch that" coming back through the mic must not be
          // read as the repeat. The echo guard's containment lane cannot help
          // here: the line is short and arrives in one- and two-token
          // fragments, under its floor. A segment made only of words the line
          // itself contains is the line, so leave the window open for the
          // wearer, who has not spoken yet.
          if (answerWindow.reprompt && this.isSpokenEcho(text, answerWindow.spoken)) {
            this.counters.bump("wake_reprompt_echo_ignored");
            continue;
          }
          this.answers.delete(sessionId);
          this.counters.bump("wake_followup_answers");
          this.emitLifecycle("segment_captured", { sessionId, at: this.now() });
          const answer = text.trim();
          // Two different windows share this seat. A clarification window was
          // opened by a question the operative asked, so its answer belongs to
          // that turn. A re-prompt window was opened because nothing was
          // understood, so what follows is the ORIGINAL command said again -
          // it goes through the ordinary command lane (classifier, conversation
          // turn, card, note) exactly as if the wake word had preceded it.
          if (answerWindow.reprompt) {
            this.counters.bump("wake_reprompt_answers");
            const s2 = this.sessions.get(sessionId);
            if (s2) s2.repromptRounds = answerWindow.rounds + 1;
            this.dispatchChain = this.dispatchChain
              .then(() =>
                this.dispatch({
                  sessionId,
                  command: answer,
                  wakeHitAt: this.now(),
                  reason: "reprompt",
                  context: [],
                  trailing: "",
                  screen: this.screenContextFn?.({ sessionId, atMs: this.now() }) ?? null,
                  conversationId: this.conversationFn?.(sessionId) ?? null,
                  repromptRounds: answerWindow.rounds + 1
                })
              )
              .catch((err) => this.log.error(`[${this.source.logPrefix}] wake reprompt error: ${err?.message ?? err}`));
            continue;
          }
          this.delegateChain = (this.delegateChain ?? Promise.resolve())
            .then(() =>
              this.runDelegate({
                request: answer,
                eventId: ulid(),
                sessionId,
                lang: answerWindow.lang,
                followupOf: answerWindow.eventId,
                round: answerWindow.rounds + 1
              })
            )
            .catch((err) => this.log.error(`[${this.source.logPrefix}] wake followup error: ${err?.message ?? err}`));
          continue;
        }
        if (answerWindow && this.regex.test(text)) this.answers.delete(sessionId);

        // A live discussion owns the microphone: everything said goes to the
        // thread, with no wake word, until the user ends it.
        if (s.state === "discussing") {
          if (this.regex.test(text)) {
            // Saying the name inside a discussion is a deliberate mode change -
            // the user is already talking to Zeca, so the only reason to say it
            // again is to leave. It is also the one escape a wearer can be
            // taught and will remember under stress. The rest of the segment
            // still runs as an ordinary command, so "Zeca, cria uma tarefa
            // disso" does exactly the right thing.
            this.endDiscussion(sessionId, "wake");
          } else if (DISCUSS_END.test(text.trim())) {
            this.endDiscussion(sessionId, "phrase");
            continue;
          } else {
            this.appendDiscussion(sessionId, text.trim());
            continue;
          }
        }

        if (s.state === "capturing") {
          s.parts.push({ text: text.trim(), at: this.now() });
          this.emitLifecycle("segment_captured", { sessionId, at: this.now() });
          this.armSilenceTimer(s, endsSentence(text));
          continue;
        }

        const m = this.regex.exec(text);
        if (!m) {
          // Non-hit: dropped in memory, counted, never persisted/logged (I5).
          // It is retained ONLY in the bounded in-memory context ring, which is
          // discarded with the session unless a wake hit fires.
          this.counters.bump("wake_segments_dropped");
          this.rememberContext(s, seg, text);
          continue;
        }

        // Wake hit: open the capture window with whatever followed the token.
        this.counters.bump("wake_hits");
        s.state = "capturing";
        s.parts = [];
        // Freeze the pre-wake window now: later segments belong to the command,
        // not to its context, and the ring keeps moving while we capture.
        s.contextUsed = this.contextWindow(s);
        if (s.contextUsed.length > 0) this.counters.bump("wake_context_used");
        s.wakeHitAt = this.now();
        s.screen = this.screenContextFn?.({ sessionId, atMs: s.wakeHitAt }) ?? null;
        // Bound NOW, not at dispatch: the capture window plus the command take
        // long enough that the user has often stopped the broadcast by then,
        // and a stopped session is gone from the ingress. Resolving late made
        // a REC wake hit fall through to the classifier and become a card.
        s.conversationId = this.conversationFn?.(sessionId) ?? null;
        // Saying the name is a fresh start, so the re-prompt cap starts over
        // with it. The cap only exists to stop Zeca and the wearer trading
        // "didn't catch that" forever inside ONE attempt.
        s.repromptRounds = 0;
        this.emitLifecycle("wake_detected", { sessionId, at: s.wakeHitAt, conversationId: s.conversationId });
        const after = text.slice(m.index + m[0].length).replace(/^[\s,.:;!?-]+/u, "").trim();
        if (after) s.parts.push({ text: after, at: s.wakeHitAt });
        // Only a wake segment that itself carries a complete command settles
        // early; a bare "Zeca" waits the full window for what follows it.
        this.armSilenceTimer(s, Boolean(after) && endsSentence(after));
        s.capTimer = setTimeout(() => this.close(sessionId, "max-capture"), this.cfg.wakeMaxCaptureMs);
        if (s.capTimer.unref) s.capTimer.unref();
      }
    } catch (err) {
      this.log.error(`[${this.source.logPrefix}] wake handling error: ${err?.message ?? err}`);
    }
  }

  // Push a non-hit segment into the bounded pre-wake ring. Speaker attribution
  // is kept because Omi switches speakers mid-sentence, and the classifier does
  // better when it can tell "the user said X" from "someone else said X".
  rememberContext(s, seg, text) {
    const cap = this.cfg.wakeContextSegments ?? 0;
    if (cap <= 0) return;
    s.recent.push({
      text: text.trim(),
      isUser: seg?.is_user !== false,
      at: this.now()
    });
    if (s.recent.length > cap) s.recent.splice(0, s.recent.length - cap);
  }

  // The pre-wake segments still fresh enough to be about the same conversation.
  contextWindow(s) {
    const cap = this.cfg.wakeContextSegments ?? 0;
    if (cap <= 0) return [];
    const maxAge = this.cfg.wakeContextMaxAgeMs ?? 0;
    const cutoff = maxAge > 0 ? this.now() - maxAge : 0;
    return s.recent.filter((entry) => entry.at >= cutoff).slice(-cap);
  }

  // A command that has clearly FINISHED does not need the full silence window.
  // That window is sized for the worst case - Omi splits one utterance across
  // bursts with real gaps, so closing early truncates "create a task saying"
  // into nothing - but paying the worst case on every command is what made a
  // spoken request feel dead for the ~15s before Zeca said anything. When the
  // transcript itself signals the end of a sentence, a shorter settle is enough;
  // anything unpunctuated still gets the full window.
  armSilenceTimer(s, settled = false) {
    if (s.silenceTimer) clearTimeout(s.silenceTimer);
    const settleMs = this.cfg.wakeSettledCloseMs ?? 0;
    const waitMs =
      settled && settleMs > 0 && settleMs < this.cfg.wakeSilenceCloseMs
        ? settleMs
        : this.cfg.wakeSilenceCloseMs;
    s.silenceTimer = setTimeout(() => this.close(s.id, "silence"), waitMs);
    if (s.silenceTimer.unref) s.silenceTimer.unref();
  }

  clearTimers(s) {
    if (s.silenceTimer) clearTimeout(s.silenceTimer);
    if (s.capTimer) clearTimeout(s.capTimer);
    s.silenceTimer = null;
    s.capTimer = null;
  }

  // Close the capture window and dispatch. Serialized on a promise chain so
  // overlapping closes never interleave store writes.
  close(sessionId, reason) {
    const s = this.sessions.get(sessionId);
    if (!s || s.state !== "capturing") return this.dispatchChain;

    // A quiet gap mid-sentence is not the end of the command - Omi delivers a
    // single utterance across bursts. Hold the window open until the minimum
    // has elapsed; "max-capture" is the ceiling and always wins.
    const minCapture = this.cfg.wakeMinCaptureMs ?? 0;
    if (reason === "silence" && minCapture > 0) {
      const elapsed = this.now() - s.wakeHitAt;
      if (elapsed < minCapture) {
        if (s.silenceTimer) clearTimeout(s.silenceTimer);
        s.silenceTimer = setTimeout(() => this.close(sessionId, "silence"), minCapture - elapsed);
        if (s.silenceTimer.unref) s.silenceTimer.unref();
        this.counters.bump("wake_capture_held_open");
        return this.dispatchChain;
      }
    }

    this.clearTimers(s);
    s.state = "armed";
    // Speech close to the wake word is the command; everything the mic picked up
    // afterwards is trailing context, not instruction.
    const commandWindow = this.cfg.wakeCommandWindowMs ?? 0;
    const inCommand = (p) => commandWindow <= 0 || p.at - s.wakeHitAt <= commandWindow;
    const join = (parts) => parts.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();
    const command = this.stripLeadingCueEcho(join(s.parts.filter(inCommand)));
    const trailing = join(s.parts.filter((p) => !inCommand(p)));
    if (trailing) this.counters.bump("wake_trailing_context_used");
    const wakeHitAt = s.wakeHitAt;
    const context = s.contextUsed;
    // Pinned at the wake hit and cleared with the rest of the capture state.
    const screen = s.screen;
    const conversationId = s.conversationId ?? null;
    s.parts = [];
    s.contextUsed = [];
    s.screen = null;
    s.conversationId = null;
    // `empty` rides the event so the closing cue can stay honest: promising
    // "Deixa comigo." and then admitting you heard nothing is worse than one
    // clean "Não percebi".
    const nothingUsable = !command && context.length === 0;
    this.emitLifecycle("window_closed", { sessionId, reason, empty: nothingUsable, at: this.now() });
    // Kill switch honored mid-session (I9): flag off between hit and close
    // means nothing dispatches and nothing persists.
    if (!this.cfg.wakeEnabled) {
      this.counters.bump("wake_killed_mid_session");
      return this.dispatchChain;
    }
    // A bare "Zeca" with nothing after it used to dead-end here. With context
    // available the intent is often still recoverable from what surrounded it,
    // which is exactly the fragmented-speech case this is for.
    if (!command && context.length === 0) {
      this.counters.bump("wake_empty_commands");
      // ...but dead-ending SILENTLY is the worst outcome the wearer can get:
      // they said the name, heard "Sim?", heard "Deixa comigo." - and then
      // nothing, ever. Two cues promising work that was never even attempted.
      // Say so instead. Bounded by wake hits (you must have said the name), and
      // speak-only: an unheard capture is not worth a banner.
      if (this.cfg.wakeUnheardEnabled) {
        this.counters.bump("wake_unheard_spoken");
        // ...and keep listening. Telling the wearer you did not catch it and
        // then closing the mic makes them say the name again for no reason:
        // the line IS the invitation to repeat, so it opens a window the way a
        // question does. `reprompt` says so explicitly - the notifier used to
        // infer it from a trailing "?", which this line only has by accident
        // and the unknown-intent line does not have at all.
        void this.notifier
          .send({
            template: "wake_confirmation",
            params: {
              text: t("wake.unheard", {}, this.resolveLanguage("")),
              lang: this.resolveLanguage(""),
              sessionId,
              speakOnly: true,
              reprompt: true,
              followupRounds: s.repromptRounds ?? 0
            }
          })
          .catch(() => []);
      }
      return this.dispatchChain;
    }
    this.dispatchChain = this.dispatchChain
      .then(() => this.dispatch({ sessionId, command, wakeHitAt, reason, context, trailing, screen, conversationId }))
      .catch((err) => this.log.error(`[${this.source.logPrefix}] wake dispatch error: ${err?.message ?? err}`));
    return this.dispatchChain;
  }

  async dispatch({ sessionId, command, wakeHitAt, context = [], trailing = "", screen = null, conversationId = null, repromptRounds = 0 }) {
    this.counters.bump("wake_dispatches");
    // The ONLY persistence from the wake bus: the assembled command text.
    const eventId = ulid();
    const event = {
      id: eventId,
      source: this.source.id,
      uid: this.store.pinnedUid(),
      received_at: new Date().toISOString(),
      occurred_at: new Date().toISOString(),
      kind: "wake_command",
      normalized: { title: command },
      provenance: { [this.source.sessionProvenanceKey]: sessionId },
      status: "triaged",
      triage_result_ref: null
    };

    // Resolved before the handler runs, so the catch below can still confirm in
    // the right language when handleCommand throws.
    let lang = this.resolveLanguage(command);
    let outcome = null;
    // The wearer's felt latency is the sum of three very different things - the
    // capture window, the classifier, and the action plus its notification - and
    // a single end-to-end number cannot say which one regressed. It has already
    // cost one wrong diagnosis, so each leg is counted separately.
    const commandStartedAt = this.now();
    this.counters.observe("wake_capture_ms", commandStartedAt - wakeHitAt);
    try {
      outcome = await this.handleCommand({
        command,
        eventId,
        context,
        trailing,
        sessionId,
        screen,
        wakeHitAt,
        conversationId,
        onLanguage: (l) => {
          lang = l;
        }
      });
    } catch (err) {
      outcome = await this.fallbackNote({
        command,
        eventId,
        key: "wake.unreachable",
        lang,
        reason: `dispatch failed: ${err?.message ?? err}`
      });
    }

    const commandDoneAt = this.now();
    this.counters.observe("wake_command_ms", commandDoneAt - commandStartedAt);
    // A discarded capture is a failed wake as far as the wearer is concerned:
    // they said the name and nothing usable followed, and the buzz is the only
    // signal they get now that the confirmation push is suppressed.
    if (outcome?.result?.intent === "note_fallback" || outcome?.result?.intent === "discarded") {
      this.emitLifecycle("task_failed", {
        sessionId,
        eventId,
        reason: outcome.result.reason ?? null,
        at: this.now()
      });
    }

    // Silent outcomes still leave the full forensic trail below - the
    // capture_event and the wake-results record - they just do not interrupt the
    // user to report that nothing happened.
    //
    // `lang`, `sessionId` and `eventId` ride in params for the speak-first
    // notifier the capture-service wraps around this bus: with a live pendant
    // session the confirmation is SPOKEN (and the push skipped); without one it
    // falls back to the push exactly as before. Omi's notifier ignores them.
    const receipts = outcome.silent
      ? []
      : await this.notifier.send({
          template: "wake_confirmation",
          // `path` is the in-app destination the push opens (the conversation a
          // broadcast wake hit landed in); cardUrl stays the card line.
          params: {
            text: outcome.confirmation,
            cardUrl: outcome.cardUrl ?? null,
            path: outcome.path ?? null,
            lang,
            sessionId,
            eventId,
            // An outcome that admits it did not understand keeps the mic open
            // for the repeat (see close()).
            reprompt: outcome.reprompt === true,
            followupRounds: repromptRounds
          }
        });
    if (!outcome.silent) this.counters.observe("wake_notify_ms", this.now() - commandDoneAt);
    // Persisted AFTER delivery so the record can say HOW it reached the user.
    // This file is the transcript's source of truth: the app's Conversation
    // screen reads it back over /capture/exchanges, so it carries the full
    // untruncated confirmation - text that was already pushed to the phone, so
    // nothing new leaves the machine (I5 still bars raw ambient transcript).
    const delivery = outcome.silent
      ? "silent"
      : receipts.some((r) => r?.means === "companion-speech" && r?.ok)
        ? "spoken"
        : "push";
    const resultRef = path.join("wake-results", `${eventId}.json`);
    atomicWriteJSON(path.join(this.store.root, resultRef), {
      eventId,
      command,
      at: new Date(this.now()).toISOString(),
      lang,
      confirmation: outcome.confirmation ?? null,
      cardUrl: outcome.cardUrl ?? null,
      delivery,
      ...outcome.result
    });
    event.triage_result_ref = resultRef;
    this.store.writeEvent(event);
    const latencyMs = this.now() - wakeHitAt;
    this.counters.observe("wake_hit_to_notification_ms", latencyMs);
    this.log.log(`[${this.source.logPrefix}] wake command dispatched (${outcome.result.intent}) in ${latencyMs}ms`);

    // Deferred follow-up work (today: a delegated operative turn). Chained so
    // two spoken requests cannot interleave their answers, and never allowed to
    // reject into this path - the wearer has been told an answer is coming, so a
    // failure has to reach them as a message, not a silent dead end.
    if (typeof outcome.after === "function") {
      this.delegateChain = (this.delegateChain ?? Promise.resolve())
        .then(outcome.after)
        .catch((err) => this.log.error(`[${this.source.logPrefix}] wake delegate error: ${err?.message ?? err}`));
    }
    return { ...outcome, receipts, latencyMs };
  }

  async handleCommand({ command, eventId, context = [], trailing = "", sessionId = null, screen = null, wakeHitAt = null, conversationId: boundConversationId = null, onLanguage = null }) {
    // Nothing has been classified yet, so the only evidence is the transcript.
    let lang = this.resolveLanguage(command);
    onLanguage?.(lang);
    // A capture started FROM a conversation (the REC button) is that
    // conversation's microphone: the words after the wake word are the user's
    // next turn there, with the screen as it stood when the name was said, and
    // no classifier in between. Cards, notes and delegation are the lanes for
    // a wearer with no conversation open. The id was bound at the wake hit
    // (see handleSegments); the late lookup is only for direct callers.
    let conversationId = boundConversationId ?? this.conversationFn?.(sessionId) ?? null;
    // Nothing bound and nothing cached: ask once, and WAIT this time. A
    // capture-service whose first GET /api/zeca has not landed yet (or landed
    // on a timeout) otherwise sends every spoken command down the classifier
    // lane for the rest of its life, with the user watching an empty
    // conversation and no counter admitting it.
    if (!conversationId && this.conversationWaitFn) {
      conversationId = await this.conversationWaitFn(sessionId).catch(() => null);
    }
    if (!conversationId && this.conversationTurnFn) this.counters.bump("wake_conversation_unresolved");
    if (conversationId && this.conversationTurnFn) {
      return this.conversationTurn({ conversationId, command, eventId, sessionId, screen, wakeHitAt, lang });
    }
    if (!this.cfg.gatewayUrl || !this.runFn) {
      return this.fallbackNote({
        command,
        eventId,
        key: "wake.offline",
        lang,
        reason: "no gateway"
      });
    }
    const projects = await this.board.listProjects().catch(() => []);
    const classifyStartedAt = this.now();
    const { reply } = await this.runFn({
      prompt: buildWakePrompt(command, projects, context, trailing, new Date(this.now()), {
        screenContext: Boolean(this.screenContextFn),
        screenLive: Boolean(screen && !screen.stale)
      })
    });
    this.counters.observe("wake_classify_ms", this.now() - classifyStartedAt);
    const parsed = parseWakeReply(reply);
    if (!parsed) {
      return this.fallbackNote({
        command,
        eventId,
        key: "wake.unparseable",
        lang,
        reason: "unparseable wake reply"
      });
    }
    // Re-resolved now that the classifier has spoken: its output is better
    // evidence than the transcript alone.
    lang = this.resolveLanguage(command, parsed);
    onLanguage?.(lang);

    switch (parsed.intent) {
      case "create_task":
      case "create_event": {
        const isEvent = parsed.intent === "create_event";
        const title = parsed.title || command.slice(0, 80);
        // A spoken command takes ~25s to become a card, so the natural human
        // reaction is to say it again - and the second attempt is different text
        // ("Create a task. Vamos, vamos. Saying that...") so nothing upstream
        // dedupes it. Suppress on the RESOLVED title instead: two utterances
        // meaning the same thing land on the same title even when the raw
        // transcripts differ. Keyed per intent so a task and an event with the
        // same title stay distinct.
        const dedupeKey = `${parsed.intent}:${normalizeTitle(title)}`;
        const dupeAt = this.recentCards.get(dedupeKey);
        const dedupeMs = this.cfg.wakeCardDedupeMs ?? 0;
        if (dedupeMs > 0 && dupeAt && this.now() - dupeAt < dedupeMs) {
          this.counters.bump("wake_duplicate_suppressed");
          return {
            confirmation: t("wake.already", { title }, lang),
            cardUrl: null,
            result: { intent: parsed.intent, cardId: null, title, suppressed: "duplicate" }
          };
        }
        // Spoken schedule: the model's ISO is untrusted output, so it is
        // validated HERE - a bad timestamp must never abort the card creation,
        // it is dropped with an honest confirmation instead.
        let schedule = null;
        let scheduleNote = "";
        if (parsed.scheduled_for) {
          const scheduledMs = Date.parse(parsed.scheduled_for);
          if (Number.isNaN(scheduledMs)) {
            this.counters.bump("wake_schedule_dropped");
            scheduleNote = t("wake.time_dropped", {}, lang);
          } else {
            schedule = {
              scheduledFor: new Date(scheduledMs).toISOString(),
              scheduleAction: parsed.schedule_action === "run" ? "run" : "notify"
            };
          }
        }
        try {
          const card = await this.board.createCard({
            title: isEvent ? `Event: ${title}` : title,
            ...(schedule ?? {}),
            description: [
              parsed.description || command,
              "",
              `Source (${this.source.label} wake command): "${command}"`,
              `Provenance: ${this.source.id} wake session, capture event ${eventId}`
            ].join("\n"),
            ...(parsed.project ? { project: parsed.project } : {}),
            // Travels with the card so the ack layer - which renders in another
            // process and never heard this - confirms in the same language.
            lang,
            origin: this.source.originPrefix,
            origin_id: `${this.source.originPrefix}:wake:${eventId}`,
            originChannel: this.source.originChannel
          });
          this.counters.bump("wake_cards_created");
          this.emitLifecycle("task_created", {
            sessionId,
            eventId,
            cardId: card?.id ?? null,
            title,
            lang,
            at: this.now()
          });
          this.rememberCard(dedupeKey);
          // Keep listening: the user sees the card within ~45s and often
          // corrects it out loud right afterwards.
          this.scheduleRevision({
            sessionId,
            cardId: card?.id ?? null,
            command,
            title,
            description: parsed.description || command
          });
          if (schedule) this.counters.bump("wake_cards_scheduled");
          const cardUrl = await this.notifier.cardUrl(card?.id ?? null);
          const scheduledText = schedule
            ? t("wake.scheduled_for", { when: humanTime(schedule.scheduledFor, new Date(this.now()), lang) }, lang)
            : "";
          return {
            confirmation: `${t(isEvent ? "wake.event_created" : "wake.card_created", { title }, lang)}${scheduledText}${scheduleNote}`,
            cardUrl,
            result: {
              intent: parsed.intent,
              cardId: card?.id ?? null,
              title,
              ...(schedule ?? {}),
              ...(scheduleNote ? { scheduleDropped: true } : {})
            }
          };
        } catch (err) {
          return this.fallbackNote({
            command,
            eventId,
            key: "wake.board_down",
            lang,
            reason: `card create failed: ${err?.message ?? err}`
          });
        }
      }
      case "discuss":
        return this.handleDiscuss({ parsed, command, eventId, sessionId, lang, context });
      case "send_message":
        return this.handleSendMessage({ parsed, command, eventId, sessionId, lang });
      case "automate":
        return this.handleAutomate({ parsed, command, eventId, lang });
      case "card_command":
        return this.handleCardCommand({ parsed, lang });
      case "delegate":
        return this.handleDelegate({ parsed, command, eventId, sessionId, lang, screen });
      case "query": {
        const answer = parsed.answer || t("wake.no_answer", {}, lang);
        this.counters.bump("wake_queries_answered");
        return {
          confirmation: answer.slice(0, 500),
          result: { intent: "query", answered: Boolean(parsed.answer) }
        };
      }
      case "note": {
        const written = this.memoryWriter.write({
          title: parsed.title || `Omi note: ${command.slice(0, 48)}`,
          content: parsed.note_content || command,
          tags: ["wake"],
          provenance: { source: `${this.source.id} wake command`, "capture event": eventId }
        });
        this.counters.bump("wake_notes_saved");
        return {
          confirmation: written.ok
            ? t("wake.noted", { title: parsed.title || command.slice(0, 60) }, lang)
            : t("wake.note_failed", {}, lang),
          result: { intent: "note", saved: written.ok }
        };
      }
      default: {
        // Unknown intent: save a note and SAY SO (spec) - but a ONE-WORD
        // unknown is not a thought worth keeping. "Boa." became a durable
        // memory note with a spoken "guardei como nota", which is noise in the
        // vault and a small lie about what happened. Same spirit as the echo
        // guard's token floor: too short to attribute, so do not.
        const words = String(command ?? "")
          .replace(/[^\p{L}\p{N}\s]/gu, " ")
          .split(/\s+/u)
          .filter(Boolean);
        // Zero words is an unrecoverable capture and keeps its existing
        // contract below (fallbackNote counts it and discards it). Only the
        // ONE-word case is new.
        if (words.length === 1) {
          this.counters.bump("wake_unknown_too_short");
          return {
            confirmation: this.cfg.wakeUnheardEnabled ? t("wake.unheard", {}, lang) : null,
            silent: !this.cfg.wakeUnheardEnabled,
            reprompt: true,
            result: { intent: "discarded", reason: "unknown intent, too short to keep" }
          };
        }
        return this.fallbackNote({
          command,
          eventId,
          key: "wake.unknown_intent",
          lang,
          reason: "unknown intent"
        });
      }
    }
  }

  // Open a spoken discussion: the session stops being a wake gate and becomes a
  // conversation until the user ends it.
  //
  // Degrades to `delegate` wherever there is no speak lane. omi-channel has no
  // live socket, and a "discussion" whose replies arrive as push notifications
  // is not the thing the user asked for - it is a delegate turn with extra
  // steps, so it may as well be one honestly.
  async handleDiscuss({ parsed, command, eventId, sessionId, lang, context = [] }) {
    if (!this.cfg.discussEnabled || !this.discussFn || !this.speakFn || !sessionId) {
      this.counters.bump("wake_discuss_unavailable");
      return this.handleDelegate({ parsed, command, eventId, sessionId, lang });
    }
    const topic = parsed.topic || parsed.request || command;
    const threadId = `${this.source.originPrefix}:discuss:${sessionId}:${ulid()}`;
    const s = this.session(sessionId);
    s.state = "discussing";
    this.discussions.set(sessionId, {
      threadId,
      topic,
      lang,
      parts: [],
      turns: 0,
      chain: Promise.resolve(),
      utteranceTimer: null,
      idleTimer: null,
      openedAt: this.now(),
      lastActivity: this.now()
    });
    this.armDiscussIdle(sessionId);
    this.counters.bump("wake_discuss_opened");
    // The opener runs as deferred work for the same reason a delegate answer
    // does: the acknowledgement has to reach the wearer before the turn that
    // answers it, or they hear the reply and then the "on it".
    return {
      confirmation: parsed.ack || topic,
      result: { intent: "discuss", topic, threadId },
      // Queued on the DISCUSSION's chain, not just awaited here. The opener
      // runs as deferred work while the wearer may already be replying, so if
      // it ran on its own the opener and the first answer would be two
      // concurrent turns speaking over each other.
      after: () => {
        const d = this.discussion(sessionId);
        if (!d) return Promise.resolve();
        d.chain = d.chain.then(async () => {
          this.counters.bump("wake_discuss_turns");
          let reply = "";
          try {
            const res = await this.discussFn({
              prompt: buildVoiceDiscussPrompt(topic, { context }),
              sessionId: threadId
            });
            reply = String(res?.reply ?? "").trim();
          } catch (err) {
            this.counters.bump("wake_discuss_failed");
            reply = t("wake.delegate_failed", { error: err?.message ?? err }, lang);
          }
          await this.speakDiscussion(reply, d);
        });
        return d.chain;
      }
    };
  }

  // A message to a NAMED person. Promoted out of `delegate` for the safety
  // gate, not for speed: a delegated send is an unattended operative turn that
  // reaches a connector with no window the wearer can HEAR.
  async handleSendMessage({ parsed, command, eventId, sessionId, lang }) {
    if (!this.cfg.sendEnabled || !this.connectorFn) {
      this.counters.bump("wake_send_unavailable");
      return this.handleDelegate({ parsed, command, eventId, sessionId, lang });
    }
    const recipient = parsed.recipient;
    const body = parsed.body || command;
    // An unspoken medium NEVER resolves to email: email is the one send with no
    // daemon and no cancel window of its own, so defaulting into it is how you
    // mail the wrong person irreversibly.
    const medium = parsed.medium ?? this.cfg.sendDefaultMedium ?? "whatsapp";
    if (!recipient || !body) {
      this.counters.bump("wake_send_incomplete");
      return this.handleDelegate({ parsed, command, eventId, sessionId, lang });
    }
    if (medium !== "whatsapp") {
      // Slack and email have no parked-send lane here yet. Handing them to the
      // operative is honest; pretending to gate them would not be.
      this.counters.bump(`wake_send_delegated_${medium}`);
      return this.handleDelegate({
        parsed: { ...parsed, request: parsed.request || command },
        command,
        eventId,
        sessionId,
        lang
      });
    }
    let candidates = [];
    try {
      const res = await this.connectorFn("whatsapp-web", "resolve_contact", { name: recipient });
      candidates = Array.isArray(res?.result?.contacts) ? res.result.contacts : (res?.result ?? []);
    } catch (err) {
      this.counters.bump("wake_send_resolve_failed");
      return this.handleDelegate({ parsed, command, eventId, sessionId, lang });
    }
    // Never guess among candidates - the same doctrine handleCardCommand
    // applies to an ambiguous card reference, and the stakes here are higher.
    if (!Array.isArray(candidates) || candidates.length === 0) {
      this.counters.bump("wake_send_no_contact");
      return this.handleDelegate({ parsed, command, eventId, sessionId, lang });
    }
    if (candidates.length > 1) {
      this.counters.bump("wake_send_ambiguous");
      const names = candidates.slice(0, 3).map((c) => c?.name ?? c?.id ?? "?").join(", ");
      return {
        confirmation: t("send.ambiguous", { recipient, names }, lang),
        result: { intent: "send_message", ok: false, reason: "ambiguous recipient" }
      };
    }
    const contact = candidates[0];
    try {
      // Parked, not sent: the connector's own outbox holds it for its cancel
      // window, and the ConfirmBus announces it out loud.
      const res = await this.connectorFn("whatsapp-web", "send_text", { to: contact?.id ?? contact?.jid, body });
      this.counters.bump("wake_sends_queued");
      return {
        confirmation: t("send.queued", { recipient: contact?.name ?? recipient, body }, lang),
        result: {
          intent: "send_message",
          ok: true,
          medium,
          queued: res?.result?.queued !== false,
          outboxId: res?.result?.id ?? null
        }
      };
    } catch (err) {
      this.counters.bump("wake_sends_failed");
      return this.handleDelegate({ parsed, command, eventId, sessionId, lang });
    }
  }

  // Run an existing NAMED automation on Cortex. Promoted because the fitting
  // can resolve a spoken name against a real catalog in ~2s, and because only
  // it will reliably supply --idempotency-key, which is the at-most-once
  // guarantee a spoken command badly needs.
  async handleAutomate({ parsed, command, eventId, lang }) {
    if (!this.cfg.automateEnabled || !this.cortexFn) {
      this.counters.bump("wake_automate_unavailable");
      return this.handleDelegate({ parsed, command, eventId, sessionId: null, lang });
    }
    const spoken = parsed.automation;
    if (!spoken) return this.handleDelegate({ parsed, command, eventId, sessionId: null, lang });
    let match;
    try {
      match = await this.cortexFn.resolve(spoken);
    } catch (err) {
      this.counters.bump("wake_automate_catalog_failed");
      return { confirmation: t("automate.unavailable", {}, lang), result: { intent: "automate", ok: false } };
    }
    if (match?.status === "unavailable") {
      // Not an error to debug: shipping without Cortex installed is the default.
      this.counters.bump("wake_automate_unavailable");
      return { confirmation: t("automate.unavailable", {}, lang), result: { intent: "automate", ok: false } };
    }
    if (match?.status === "none") {
      this.counters.bump("wake_automate_no_match");
      // The local automations engine is reachable from the operative, and a
      // voice path that silently picks between two runners is how you run the
      // wrong thing.
      return this.handleDelegate({ parsed, command, eventId, sessionId: null, lang });
    }
    if (match?.status === "ambiguous") {
      this.counters.bump("wake_automate_ambiguous");
      return {
        confirmation: t("automate.ambiguous", { names: (match.candidates ?? []).slice(0, 3).join(", ") }, lang),
        result: { intent: "automate", ok: false, reason: "ambiguous" }
      };
    }
    try {
      const run = await this.cortexFn.run(match.id, parsed.inputs ?? {}, `voice-${eventId}`);
      this.counters.bump("wake_automations_run");
      return {
        confirmation: run?.created === false
          ? t("automate.replay", { name: match.name }, lang)
          : t("automate.started", { name: match.name }, lang),
        result: { intent: "automate", ok: true, automationId: match.id, runId: run?.runId ?? null }
      };
    } catch (err) {
      this.counters.bump("wake_automations_failed");
      return {
        confirmation: t("automate.failed", { name: match.name, error: err?.message ?? err }, lang),
        result: { intent: "automate", ok: false }
      };
    }
  }

  // The spoken command needs Zeca himself - his tools, his connectors, his view
  // of the user's data. Two notifications by design: the wearer hears "on it"
  // within seconds, and the real answer arrives when the work is actually done.
  // Blocking the wearer on a turn that routinely runs a minute or more is what
  // made spoken requests feel broken, and a fast wrong answer from the
  // classifier's own head is worse than a slow right one.
  async handleDelegate({ parsed, command, eventId, sessionId, lang = "en", screen = null }) {
    const request = parsed.request || command;
    // A command that leans on the screen, with no usable screen, must NOT be
    // delegated on a guess. Refusing in two seconds is far better for a wearable
    // than the wrong message two minutes later.
    // The screen is pinned at the WAKE HIT so a 45-second capture window
    // cannot fuse a screen the user stopped looking at. But that also misses
    // the two commonest real cases: starting the broadcast and immediately
    // speaking (its first frame lands a beat after the wake word), and turning
    // sharing on DURING the window because Zeca just asked for it. So when the
    // pin found nothing, look again now - still bounded by the same freshness
    // window, so a stale screen is still refused.
    let effectiveScreen = screen;
    if (parsed.needs_screen && (!screen || screen.stale) && this.screenContextFn) {
      const late = this.screenContextFn({ sessionId, atMs: this.now() });
      if (late && !late.stale) {
        this.counters.bump("wake_screen_late_bind");
        effectiveScreen = late;
      }
    }
    screen = effectiveScreen;
    if (parsed.needs_screen && (!screen || screen.stale)) {
      this.counters.bump("wake_screen_blocked");
      const seconds = screen?.ageMs ? Math.round(screen.ageMs / 1000) : 0;
      return {
        confirmation: screen?.stale
          ? t("screen.stale", { seconds }, lang)
          : t("screen.absent", {}, lang),
        result: {
          intent: "delegate_blocked",
          reason: screen?.stale ? "screen_context_stale" : "screen_context_missing"
        }
      };
    }
    if (screen && !screen.stale) this.counters.bump("wake_screen_fused");
    if (!this.cfg.delegateEnabled || !this.operativeFn) {
      this.counters.bump("wake_delegate_unavailable");
      return this.fallbackNote({
        command,
        eventId,
        key: "wake.no_delegate",
        lang,
        reason: this.cfg.delegateEnabled ? "no operative lane" : "delegation disabled"
      });
    }
    this.counters.bump("wake_delegates");
    // The model's own ack already follows the user's language; the fallback is
    // the only part that needs translating.
    const ack = parsed.ack || t("wake.on_it", {}, lang);

    // Handed back as `after` rather than started here, so the work cannot begin
    // until the acknowledgement has actually been sent. Started here, a fast
    // answer races the ack and the wearer reads "Sent it to Ana" followed by
    // "On it - messaging Ana" - the caller controls the ordering because only
    // the caller knows when the first notification left.
    return {
      confirmation: ack,
      result: { intent: "delegate", request, delivered: "pending" },
      after: () => this.runDelegate({ request, eventId, sessionId, lang, screen })
    };
  }

  // The gateway appends routing metadata to replies ("[route: cc-opus | ...]",
  // "[orchestrator-active]"). Fine in a terminal; read ALOUD it is absurd - the
  // user hears bracket soup after every answer. Stripped before the reply is
  // spoken, pushed or recorded.
  static stripRoutingFooter(text) {
    const lines = String(text ?? "").trimEnd().split("\n");
    while (lines.length > 0) {
      const last = lines[lines.length - 1].trim();
      if (last === "" || /^\[[^\]]*\]$/.test(last)) lines.pop();
      else break;
    }
    return lines.join("\n").trim();
  }

  async runDelegate({ request, eventId, sessionId, lang = "en", screen = null, followupOf = null, round = 0 }) {
    const startedAt = this.now();
    let text = "";
    let ok = false;
    // "Ainda estou a tratar disso." every minute while the operative works. A
    // turn routinely runs 20-90 seconds, and the wearer's silence-reading is
    // binary: no sound means it died. The line is SPOKEN ONLY (params.progress
    // makes the capture-service wrapper skip the push entirely) - a banner per
    // minute would be spam, a voice per minute is presence.
    const progressEveryMs = this.cfg.wakeProgressIntervalMs ?? 60000;
    let progressTimer = null;
    if (progressEveryMs > 0) {
      progressTimer = setInterval(() => {
        this.counters.bump("wake_progress_spoken");
        void this.notifier
          .send({
            template: "wake_confirmation",
            params: { text: t("wake.still_working", {}, lang), lang, sessionId, progress: true }
          })
          .catch(() => []);
      }, progressEveryMs);
      progressTimer.unref?.();
    }
    // Which gateway session this turn joins. The deterministic per-capture
    // key ("<prefix>-wake:<capture session>") is the floor: one gateway
    // session per capture session keeps a follow-up ("send that to Ana too")
    // attached to the context that produced it. The active-conversation window
    // sits above it: while the last reply is fresh, or a client pinned a
    // conversation, the turn resumes THAT gateway session instead, so a
    // reconnect does not start Zeca over. A follow-up round rides whichever of
    // the two its parent used, because the parent's reply is what refreshed
    // the window.
    const deterministicKey = sessionId ? `${this.source.originPrefix}-wake:${sessionId}` : null;
    const resume = this.activeConversation?.resumeFor(this.lastDelegate) ?? null;
    const gatewaySessionId = resume?.sessionId ?? deterministicKey;
    if (resume) this.counters.bump(resume.via === "pin" ? "wake_delegate_resumed_pin" : "wake_delegate_resumed_window");
    try {
      const { reply, sessionId: replySessionId = null } = await this.operativeFn({
        // Resolved at call time from the board's status file, exactly like every
        // other board call here - never a baked port. A follow-up rides the SAME
        // gateway session (the sessionId below), so the thin continuation prompt
        // lands with the whole prior turn's context intact.
        prompt: followupOf
          ? buildFollowupPrompt(request, { lang })
          : buildDelegatePrompt(request, {
              boardUrl: this.board?.base?.() ?? null,
              screen: screen && !screen.stale ? screen : null,
              lang
            }),
        sessionId: gatewaySessionId,
        sessionTitle: "Omi spoken request"
      });
      // The gateway names the session that answered; that is what the window
      // resumes next time. A gateway that returns none leaves the last reply
      // alone, and the deterministic key keeps doing its job.
      if (typeof replySessionId === "string" && replySessionId.trim()) {
        this.lastDelegate = { sessionId: replySessionId.trim(), at: this.now() };
      }
      text = WakeBus.stripRoutingFooter(reply);
      ok = text.length > 0;
    } catch (err) {
      text = t("wake.delegate_failed", { error: err?.message ?? err }, lang);
    }
    if (!text) text = t("wake.nothing_to_report", {}, lang);
    if (progressTimer) clearInterval(progressTimer);
    const elapsed = this.now() - startedAt;
    this.counters.observe("wake_delegate_ms", elapsed);
    this.counters.bump(ok ? "wake_delegates_answered" : "wake_delegates_failed");
    // A follow-up round files under its PARENT exchange, so the transcript
    // threads the whole clarification dialogue as one conversation.
    const resultFile = followupOf
      ? `${followupOf}.followup.${round}.json`
      : `${eventId}.delegate.json`;
    atomicWriteJSON(path.join(this.store.root, "wake-results", resultFile), {
      eventId,
      ...(followupOf ? { followupOf, round } : {}),
      request,
      reply: text,
      ok,
      at: new Date(this.now()).toISOString(),
      elapsedMs: elapsed
    });
    this.log.log(`[${this.source.logPrefix}] wake delegate ${ok ? "answered" : "failed"} in ${elapsed}ms`);
    await this.notifier
      .send({
        template: "wake_confirmation",
        params: {
          text: text.slice(0, 800),
          lang,
          sessionId,
          eventId: followupOf ?? eventId,
          followupRounds: round
        }
      })
      .catch(() => []);
    return { ok, reply: text };
  }

  // A spoken command addressed to an EXISTING card ("run card 7Q2M", "snooze
  // card 7Q2M for two hours") - the reply half of the scheduled-card
  // notification, which quotes the card's 4-char ULID suffix at the wearer.
  // The board resolves the reference; ambiguity is read back as a short list
  // of candidates and NEVER guessed among. Failures here answer with an honest
  // notification, not a note fallback - a note cannot start or snooze a card.
  async handleCardCommand({ parsed, lang = "en" }) {
    this.counters.bump("wake_card_commands");
    const ref = parsed.card_ref;
    if (!parsed.action || !ref) {
      return {
        confirmation: t("card.which", {}, lang),
        result: { intent: "card_command", ok: false, reason: "missing action or card_ref" }
      };
    }
    let resolved;
    try {
      resolved = await this.board.resolveCard(ref);
    } catch (err) {
      resolved = { status: 0, error: err?.message ?? String(err) };
    }
    if (resolved?.status === 404) {
      this.counters.bump("wake_card_command_no_match");
      return {
        confirmation: t("card.no_match", { ref }, lang),
        result: { intent: "card_command", action: parsed.action, ok: false, reason: "no-match", ref }
      };
    }
    if (resolved?.status === 409) {
      this.counters.bump("wake_card_command_ambiguous");
      const candidates = (Array.isArray(resolved.candidates) ? resolved.candidates : []).slice(0, 3);
      const listed = candidates
        .map((c) => `${shortRef(c?.id)} "${c?.title ?? "(untitled)"}"${c?.list ? ` (${c.list})` : ""}`)
        .join(", ");
      return {
        confirmation: t("card.ambiguous", { ref, listed: listed || t("card.candidates_unavailable", {}, lang) }, lang),
        result: {
          intent: "card_command",
          action: parsed.action,
          ok: false,
          reason: "ambiguous",
          ref,
          candidates: candidates.map((c) => c?.id ?? null)
        }
      };
    }
    if (resolved?.status !== 200 || !resolved.card) {
      return {
        confirmation: t("card.board_down", { action: parsed.action, ref }, lang),
        result: {
          intent: "card_command",
          action: parsed.action,
          ok: false,
          reason: resolved?.error ?? `status ${resolved?.status}`,
          ref
        }
      };
    }

    const card = resolved.card;
    const refOut = shortRef(card.id) || ref;
    const title = card.title ?? "(untitled)";
    const cardUrl = await this.notifier.cardUrl(card.id ?? null).catch(() => null);

    if (parsed.action === "run") {
      try {
        await this.board.startCard(card.id);
      } catch (err) {
        return {
          confirmation: t("card.start_failed", { title, ref: refOut }, lang),
          cardUrl,
          result: {
            intent: "card_command",
            action: "run",
            cardId: card.id ?? null,
            ok: false,
            reason: `start failed: ${err?.message ?? err}`
          }
        };
      }
      this.counters.bump("wake_card_commands_run");
      return {
        confirmation: t("card.started", { title, ref: refOut }, lang),
        cardUrl,
        result: { intent: "card_command", action: "run", cardId: card.id ?? null, ok: true }
      };
    }

    // snooze - exactly one of minutes/until, both validated HERE because the
    // model's numbers and timestamps are untrusted output. An unusable time
    // refuses to act rather than snoozing to a default the user never asked for.
    const minutes = Number.isFinite(parsed.minutes) && parsed.minutes > 0 ? Math.round(parsed.minutes) : null;
    const untilMs = parsed.until ? Date.parse(parsed.until) : NaN;
    const until = Number.isNaN(untilMs) ? null : new Date(untilMs).toISOString();
    if (!minutes && !until) {
      return {
        confirmation: t("card.snooze_time", { ref: refOut }, lang),
        cardUrl,
        result: {
          intent: "card_command",
          action: "snooze",
          cardId: card.id ?? null,
          ok: false,
          reason: "unusable snooze time"
        }
      };
    }
    let snoozed = null;
    try {
      snoozed = await this.board.snoozeCard(card.id, minutes ? { minutes } : { until });
    } catch (err) {
      return {
        confirmation: t("card.snooze_failed", { title, ref: refOut }, lang),
        cardUrl,
        result: {
          intent: "card_command",
          action: "snooze",
          cardId: card.id ?? null,
          ok: false,
          reason: `snooze failed: ${err?.message ?? err}`
        }
      };
    }
    this.counters.bump("wake_card_commands_snoozed");
    const nowDate = new Date(this.now());
    const effectiveUntil =
      (typeof snoozed?.scheduledFor === "string" && snoozed.scheduledFor) ||
      until ||
      new Date(this.now() + minutes * 60_000).toISOString();
    return {
      confirmation: t("card.snoozed", { title, ref: refOut, when: humanTime(effectiveUntil, nowDate, lang) }, lang),
      cardUrl,
      result: { intent: "card_command", action: "snooze", cardId: card.id ?? null, ok: true, until: effectiveUntil }
    };
  }

  // Takes a message KEY, never a rendered sentence: every caller reaches here
  // from a failure path, and translating an English string back afterwards is
  // not a thing that works.
  // Is this "command" only the wake word said again, or a bare interjection?
  // "Zeca. Zeca." and "Boa." were both filed as durable memory notes with a
  // spoken "I saved it as a note" - which is untrue in spirit: nothing was
  // asked, and the vault now holds noise. Treated as unheard instead.
  isNothingSaid(command) {
    const text = String(command ?? "").trim();
    if (!text) return true;
    const stripped = this.regex ? text.replace(new RegExp(this.regex.source, "giu"), " ") : text;
    const words = stripped.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/u).filter(Boolean);
    return words.length === 0;
  }

  // Post the spoken command as a USER turn in the conversation the session was
  // started from, carrying up to three recent screen stills as attachments
  // (the same "Attached file" convention the composer's paperclip uses, so
  // the operative reads them with the tools it already has). Frames are
  // anchored on the wake hit: what the user was looking at when they said
  // the name, not whatever is on screen by the time the command finishes.
  async conversationTurn({ conversationId, command, eventId, sessionId, screen = null, wakeHitAt = null, lang = "en" }) {
    if (this.isNothingSaid(command)) {
      this.counters.bump("wake_unrecoverable_captures");
      return {
        confirmation: this.cfg.wakeUnheardEnabled ? t("wake.unheard", {}, lang) : null,
        silent: !this.cfg.wakeUnheardEnabled,
        reprompt: true,
        result: { intent: "discarded", reason: "nothing said (conversation)", conversation_id: conversationId }
      };
    }
    const anchor = typeof wakeHitAt === "number" ? wakeHitAt : this.now();
    let frames = [];
    try {
      const recent = this.screenFramesFn?.({ sessionId, atMs: anchor, max: 3 }) ?? null;
      if (recent && !recent.stale) frames = recent.frames;
      else if (screen && !screen.stale) frames = [{ seq: screen.seq, file: screen.file, ageMs: screen.ageMs }];
    } catch (err) {
      this.log.error(`[${this.source.logPrefix}] screen frames lookup failed: ${err?.message ?? err}`);
    }
    let posted;
    try {
      posted = await this.conversationTurnFn({ conversationId, command, eventId, sessionId, frames, lang });
    } catch (err) {
      posted = { ok: false, reason: err?.message ?? String(err) };
    }
    // One retry: the app restarting under a redeploy is the common case, and
    // turning a spoken sentence into a memory note because of a 502 loses it
    // from the one place the user is looking.
    if (!posted?.ok) {
      this.counters.bump("wake_conversation_turn_retried");
      try {
        posted = await this.conversationTurnFn({ conversationId, command, eventId, sessionId, frames, lang });
      } catch (err) {
        posted = { ok: false, reason: err?.message ?? String(err) };
      }
    }
    if (!posted?.ok) {
      this.counters.bump("wake_conversation_turn_failed");
      return this.fallbackNote({
        command,
        eventId,
        key: "wake.conversation_failed",
        lang,
        reason: `conversation turn failed: ${posted?.reason ?? "unknown"}`
      });
    }
    this.counters.bump("wake_conversation_turns");
    const shown = command.length > 80 ? `${command.slice(0, 77)}...` : command;
    // The answer comes later, in the conversation; watch for it and push/speak
    // it back (D56). Runs after the confirmation went out, off the delegate
    // chain, and never blocks the next wake hit.
    const canWatch = typeof posted.base === "string" && posted.base && typeof posted.fromIndex === "number";
    const after = canWatch
      ? () => {
          this.trackReplyWatch({ conversationId, eventId, sessionId, lang, base: posted.base, fromIndex: posted.fromIndex });
        }
      : null;
    return {
      confirmation: t("wake.conversation_sent", { text: shown }, lang),
      // The push opens the conversation itself; no card was made.
      path: `/talk/${encodeURIComponent(conversationId)}`,
      ...(after ? { after } : {}),
      result: {
        intent: "conversation_turn",
        conversation_id: conversationId,
        frames: frames.map((f) => f.file),
        input_id: posted.inputId ?? null
      }
    };
  }

  fallbackNote({ command, eventId, key, lang = "en", reason }) {
    // An empty capture that nothing could be made of is not a note - it is
    // nothing. The note here IS the command ("content: command"), so an empty
    // command wrote a zero-content file into the user's durable memory vault,
    // reported `saved: true`, and pushed "I saved it as a note" to their phone -
    // a statement that was not true. Two of those landed in 20 seconds on
    // 2026-08-22.
    //
    // This does NOT close the door close() deliberately left open: a bare "Zeca"
    // whose intent the pre-wake context DOES recover comes back as create_task /
    // note / delegate and never reaches a fallback at all. What reaches here with
    // no command is a capture that recovered nothing. A non-empty command still
    // becomes a note - there the words are worth keeping even when the intent is
    // not - which is the case the suite pins.
    //
    // Guarded here rather than in the unknown-intent branch so it also covers the
    // gateway-offline, unparseable-reply, board-unreachable and delegation-off
    // callers: every one of them writes the command as the whole note.
    if (this.isNothingSaid(command)) {
      this.counters.bump("wake_unrecoverable_captures");
      // Not silent any more: the wearer said the name and deserves to know it
      // landed on nothing, rather than being told a note was saved.
      return {
        confirmation: this.cfg.wakeUnheardEnabled ? t("wake.unheard", {}, lang) : null,
        silent: !this.cfg.wakeUnheardEnabled,
        reprompt: true,
        result: { intent: "discarded", reason: `nothing said (${reason})` }
      };
    }
    const written = this.memoryWriter.write({
      title: `Omi note: ${command.slice(0, 48)}`,
      content: command,
      tags: ["wake", "unclassified"],
      provenance: { source: `${this.source.id} wake command`, "capture event": eventId, reason }
    });
    this.counters.bump("wake_notes_saved");
    return {
      confirmation: written.ok
        ? t(key, {}, lang)
        : t("wake.not_saved", { text: t(key, {}, lang) }, lang),
      // Saving a note is what Zeca does when it did not understand - so it too
      // keeps the mic open for a rephrase. The unreachable/not-saved keys are
      // NOT re-prompts: repeating yourself at a gateway that is down only
      // wastes the wearer's breath.
      reprompt: key === "wake.unknown_intent" || key === "wake.unparseable",
      result: { intent: "note_fallback", saved: written.ok, reason }
    };
  }
}
