// Kanban Loop — the Discuss (interactive) plumbing. PURE + unit-tested.
//
// The Discuss list is interactive: the engine NEVER auto-dispatches it
// (engine.isInteractive / processCard skip it). It advances only by a manual
// Move. This module is the PLUMBING for that hand-off — it does NOT advance the
// card and writes no brief itself:
//
//   buildDiscussUrl — the Discuss-duty web-channel URL carrying the card as an
//     OPAQUE context blob the GENERIC web channel forwards verbatim to the
//     gateway. The Operative decodes it and writes the brief to disk.
//   briefSlug       — a clean kebab filename stem from the card title.
//   recordBrief     — CAS-link the resulting brief PATH onto the card (a
//     pointer, never the brief body — FINDING 10), validated for traversal.
//
// The web channel stays generic: it never learns about kanban. It un-wraps a
// base64 TRANSPORT layer (iff it round-trips) and forwards the JSON string
// verbatim; the Operative interprets it. We therefore base64-wrap the JSON so the
// channel's decodeContext hands the gateway exactly our JSON string back, and
// url-encode the base64 so it survives the query string.

// No top-level node imports: the pure URL builders (buildDiscussUrl, briefSlug)
// are bundled into the browser UI, so path-safety is checked with string logic
// and board.mjs (node:fs/os) is imported LAZILY inside recordBrief (server-only).

// A card id MUST be a ULID (26 Crockford base32 chars, excludes I/L/O/U) — same
// guard the server uses before a card id touches the filesystem.
export function isValidCardId(id) {
  return typeof id === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);
}

// Kebab a card title into a safe filename stem for the brief: lowercase, ASCII
// word runs joined by '-', leading/trailing dashes trimmed, capped so a long
// title can't make an unwieldy filename. Falls back to "brief" for an
// empty/symbol-only title.
export function briefSlug(card) {
  const title = typeof card?.title === "string" ? card.title : "";
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")   // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")        // non-alphanumeric → dash
    .replace(/^-+|-+$/g, "")            // trim edge dashes
    .slice(0, 60)
    .replace(/-+$/g, "");               // re-trim if the slice cut mid-dash
  return slug || "brief";
}

// The CARD-UNIQUE filename stem for a card's Discuss brief: `<cardId>-<slug>`.
// The cardId (a ULID) makes it unique even when two cards' titles kebab to the
// same slug — so the auto-link can never attach another card's brief. briefSlug
// keeps it human-readable. Falls back to the bare slug only if a card has no id
// (defensive; real cards always carry a ULID).
export function briefStem(card) {
  const slug = briefSlug(card);
  const id = typeof card?.id === "string" && card.id ? card.id : null;
  return id ? `${id}-${slug}` : slug;
}

// The conventional relative path where a card's Discuss brief lives — the SAME
// (briefsPath, suggestedSlug = briefStem) buildDiscussUrl hands the channel. The
// board looks here on Move-out-of-Discuss to auto-link the brief onto the card, so
// a brief the Discuss duty wrote shows up without a manual POST. Pure (no node imports) so
// the UI bundle + tests can call it.
export function briefRelPath(card, { briefsPath = "./briefs/" } = {}) {
  const dir = String(briefsPath).replace(/^\.\/+/, "").replace(/\/+$/, "");
  const stem = `${briefStem(card)}.md`;
  return dir ? `${dir}/${stem}` : stem;
}

// Base64-encode a raw string (the TRANSPORT layer the web channel un-wraps with the
// same round-trip check). Buffer in Node, btoa in the browser — usable from the UI
// bundle and a test.
function encodeString(s) {
  const str = String(s ?? "");
  if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(str)));
  return Buffer.from(str, "utf8").toString("base64");
}

// Base64-encode the JSON context (the TRANSPORT layer the web channel un-wraps).
// The channel's decodeContext does the inverse: atob(raw) iff btoa(atob(raw)) === raw.
function encodeContext(obj) {
  return encodeString(JSON.stringify(obj));
}

// The opening message the Discuss session AUTO-SENDS to start the conversation.
// The host thread pins the explicit Discuss duty; the message carries the card
// title + description and tells the Operative to write the brief to the SAME path
// the board auto-links on Move-out-of-Discuss (briefRelPath), so the discussion result
// becomes the card's downstream context. Pure (no node imports) → bundles into the UI.
//
// It is also the BEHAVIOUR SPEC a discuss turn receives on the human path — voice,
// stance, research doctrine, when a document is the right form — so it is the live
// source for that doctrine whenever the duty-discuss fitting is not equipped. `level`
// (or the card's own) sets the depth: 1 is the conversation itself, 2+ makes research
// expected and the written brief the exit criterion.
/** The card's checklist rendered for the kickoff, or "" when it has none.
 *
 *  A card's substance often lives in its ITEMS rather than its description -
 *  this one had an empty description and six checklist items, and the Discuss
 *  session opened saying "the card is just a title, with nothing to read".
 *  Done state travels too: a half-finished list is a different conversation
 *  from an untouched one. */
export function checklistBlock(card) {
  const items = Array.isArray(card?.checklist) ? card.checklist : [];
  const lines = items
    .map((item) => (typeof item?.text === "string" ? item.text.trim() : ""))
    .map((text, index) => ({ text, done: items[index]?.done === true }))
    .filter((item) => item.text);
  if (!lines.length) return "";
  const done = lines.filter((item) => item.done).length;
  const header = done
    ? `## Checklist (${lines.length} items, ${done} done)`
    : `## Checklist (${lines.length} items)`;
  return [header, ...lines.map((item) => `- [${item.done ? "x" : " "}] ${item.text}`)].join("\n");
}

export function buildDiscussKickoff(card, { briefAbsPath, level } = {}) {
  const title = (typeof card?.title === "string" && card.title.trim()) ? card.title.trim() : "(untitled)";
  const project = card?.project ? String(card.project) : "(none assigned yet)";
  const checklist = checklistBlock(card);
  const written = (typeof card?.description === "string" && card.description.trim())
    ? card.description.trim()
    : "";
  // Only claim nothing was provided when nothing WAS: a card whose content is a
  // checklist has plenty to read, and telling the Operative otherwise sent it
  // back to ask a question the board had already answered.
  const desc = written
    ? written
    : checklist
      ? "(no prose description — the checklist below is what this card says)"
      : "(no description was provided — ask Goncalo what this card is about before going further)";
  // The exact card-owned brief path the Operative must write to — absolute when the board
  // supplies it (so his working dir is irrelevant), else a card-relative fallback.
  const briefPath = briefAbsPath || (card?.id ? `cards/${card.id}/brief.md` : "brief.md");
  // How DEEP this discussion is. An explicit option wins (a non-board call site — the
  // engine's clarity-gated discuss — can pass the level it resolved), else the card's own
  // level, else 1. A level 1 discussion IS the conversation: research is welcome and a
  // document is written only when one of the triggers below fires. From level 2 up,
  // research stops being optional and the written brief becomes the exit criterion.
  const explicit = Number.isInteger(level) ? level : null;
  const onCard = Number.isInteger(card?.level) ? card.level : null;
  const depth = Math.max(1, explicit ?? onCard ?? 1);
  return [
    `Let's talk this work item through before it goes to planning. Match your effort to the work: a small change needs a light touch, not an interrogation.`,
    ``,
    `# Card: ${title}`,
    `Project: ${project}`,
    ``,
    desc,
    ``,
    ...(checklist ? [checklist, ``] : []),
    // How to TALK. This is a conversation, not a report, and it is frequently read
    // aloud on a phone or through the voice channel, so the shape of the prose
    // matters as much as its content.
    `How to talk to me here. Write in plain prose, in full sentences, the way you would say it out loud. No bullet lists, no headings, no tables while we are still talking. Never use an em dash. Keep it short and direct, a few sentences rather than an essay, and do not narrate what you are looking at or what you are about to do. Answer in the language I write in, and switch when I switch.`,
    ``,
    `No flattery. Do not open by telling me the question is good or the idea is interesting. Say the thing. And do not lean on "genuinely", "honestly" or "straightforward" to make a claim sound truer than it is: if a point needs one of those words to land, it is not carrying its own weight.`,
    ``,
    // The stance. This is what makes a discussion worth having rather than a
    // yes-machine that agrees and then builds the wrong thing.
    `Argue with me before you agree with me. On anything touching product or architecture, take the other side properly first: name what would have to be true for this to be a mistake, what it costs, and what the simpler or the more ambitious version would be. Converge only after that, and say plainly which way you would go and why. If you think the card is not worth doing, say so.`,
    ``,
    `Hold a CTO and a CPO in your head at once. The CTO cares what this does to the system a year from now. The CPO cares whether anyone actually wants it. When those two disagree, tell me they disagree rather than splitting the difference quietly.`,
    ``,
    // Research doctrine. The failure mode is asserting a stale fact confidently;
    // the fix is to go and check before the claim leaves your mouth, and to be
    // explicit when you could not.
    `Look it up before you assert it. If a claim turns on something that may have changed, on a number you are not sure of, or on anything after your training cutoff, search the web first and then tell me what you found rather than that you went looking. Do not narrate the search. If you cannot search in this turn, say the claim is unverified instead of stating it as fact. Same mid-argument: if a fact would settle a disagreement between us, go and get it instead of speculating.`,
    ``,
    `Give me your read of it in a sentence or two, then ask me at least one real, clarifying question before we call it settled. Even for a small, clear change there is usually something worth confirming: the exact wording, the scope, where it applies, or how we will know it is done. Ask only what really matters and do not manufacture a checklist. For an ambiguous or bigger item, surface the key decision and ask the few clarifying questions that actually block the build.`,
    ``,
    // WHEN a document is the right form. The default is that it is not: the
    // conversation is the deliverable, and a document that nobody asked for is a
    // way of ending a discussion early.
    `The conversation is the deliverable here, not a document. Write one only when I ask for it, when a decision has settled and writing it down stops us re-litigating it next week, or when the material has outgrown talking. When that moment comes the document is the brief below, one document per decision, and you keep talking to me in prose either way.`,
    ``,
    // Level-aware depth. Level 1 leaves research and the brief to the triggers
    // above; from level 2 up both are expected of the discussion itself.
    ...(depth >= 2 ? [
      `This is a level ${depth} discussion, so research is expected rather than optional: look up what the decision actually turns on before you take a position on it. And the written brief below is the exit criterion here - we are not finished until it exists.`,
      ``
    ] : []),
    `IMPORTANT: do not write the brief on your first message. Always give me a chance to answer first.`,
    ``,
    `Once we have talked it through and it is settled, write the brief to exactly this path \`${briefPath}\` (that absolute path, not a copy in the project) using the template (what this is, decisions, approach, open questions, acceptance), kept proportional to the work. That brief is the handoff the build reads. Begin with your read and your question(s).`
  ].join("\n");
}

// Build the Discuss-duty web-channel URL for a card. The card is encoded as an
// opaque context blob; the channel stores it alongside a duty-pinned thread.
// { source, cardId, title, project, level, briefsPath, suggestedSlug } and writes the
// brief under briefsPath. We pass briefsPath + a suggested slug so the brief
// the Discuss duty writes lands where recordBrief can later link it, and the card's
// level (when it has one) so the channel pins the discussion at its real depth.
//
// webChannelBase defaults to Garrison's embed route for the seed web channel —
// the fitting id is `web-channel-default` (NOT `web-channel`), so the embed route
// is /embed/web-channel-default. The board is opened embedded in Garrison
// (/embed/kanban-loop), so this relative URL + target="_top" navigates Garrison
// to the web channel. Override webChannelBase for a non-default web channel.
export function buildDiscussUrl(card, { webChannelBase = "/embed/web-channel-default", cardsAbsDir = null } = {}) {
  const stem = briefStem(card);
  // The card-owned brief's ABSOLUTE path: <cardsAbsDir>/<cardId>/brief.md. cardsAbsDir
  // is the board's kanban-store cards dir (from /board/runtime). Deterministic + shared
  // by the Discuss duty's write, the Brief editor, and the engine's build read.
  const briefAbsPath = (cardsAbsDir && card?.id)
    ? `${String(cardsAbsDir).replace(/\/+$/, "")}/${card.id}/brief.md`
    : null;
  // The card's DISCUSS LEVEL, when it carries one. A card that reached Discuss
  // through the clarity gate can be level 2+, and both the kickoff's depth and the
  // channel's routing pin must respect that instead of assuming a level 1 chat.
  // Absent on an ordinary board card, which is a level 1 conversation.
  const level = Number.isInteger(card?.level) && card.level >= 1 ? card.level : null;
  const context = {
    source: "kanban",
    cardId: card?.id ?? null,
    title: card?.title ?? null,
    project: card?.project ?? null,
    ...(level ? { level } : {}),
    // The description so a context-honoring channel/operative has it too (the kickoff
    // message carries it as well, for the gateway path that ignores body.context).
    description: card?.description ?? null,
    // The checklist items are frequently the REAL content of a card; a channel
    // that reads context must see them for the same reason the kickoff prints them.
    ...(Array.isArray(card?.checklist) && card.checklist.length ? { checklist: card.checklist } : {}),
    // Kept for backward-compat with any consumer reading a suggested stem.
    suggestedSlug: stem,
    // ABSOLUTE brief path for the web channel's Brief editor. Absent → no Brief editor.
    ...(briefAbsPath ? { briefAbsPath } : {})
  };
  const encoded = encodeURIComponent(encodeContext(context));
  // The auto-sent opening message (carries the description + the EXACT brief path). base64
  // + url-encoded so a long description survives the query string; the channel decodes it
  // and hands it to the chat as initialMessage.
  const kickoff = encodeURIComponent(encodeString(buildDiscussKickoff(card, { briefAbsPath, level })));
  const base = webChannelBase.replace(/\/+$/, "");
  // A STABLE thread key per card (`kanban-<cardId>`) + a human title, so the web
  // channel persists this Discuss as its own session and REOPENING the card returns
  // to the same conversation + history instead of starting blank. base64 + url-encoded
  // so they survive the query string and the channel's round-trip decode unwraps them.
  const parts = [`source=discuss`, `context=${encoded}`, `kickoff=${kickoff}`];
  // The channel pins {duty: discuss, level} on the thread. A bare integer, not
  // base64: there is nothing in a small number for the transport layer to protect,
  // and a readable `level=2` is worth more in a URL than a consistent wrapper.
  // Omitted for a level-less card, which the channel reads as level 1.
  if (level) parts.push(`level=${level}`);
  if (card?.id) parts.push(`thread=${encodeURIComponent(encodeString(`kanban-${card.id}`))}`);
  if (card?.title) parts.push(`title=${encodeURIComponent(encodeString(String(card.title)))}`);
  // A prominent "Back to the board" target: the Garrison embed route for the kanban
  // fitting. The web channel shows a Back button that navigates the TOP window here,
  // so after settling the Discuss (and writing the brief) the user returns to the board
  // in one click. base64 + url-encoded like the other params so the channel decodes it.
  parts.push(`returnUrl=${encodeURIComponent(encodeString("/embed/kanban-loop"))}`);
  parts.push(`returnLabel=${encodeURIComponent(encodeString("Board"))}`);
  return `${base}?${parts.join("&")}`;
}

// Is `briefPath` a SAFE relative path CONTAINED UNDER briefsPath? It must be
// relative (no absolute, no drive root), must not escape via `..`, AND must
// actually live under the configured briefsPath — not just anywhere in the
// project. This is the link-never-duplicate write side: we only record a pointer
// to a brief the operative wrote under the configured dir, never an arbitrary
// project file (e.g. package.json, docs/x.md) the card could steer a later read
// to. A pure string check keeps this module node-free so it bundles into the UI.
export function isSafeBriefPath(briefPath, briefsPath = "./briefs/") {
  if (typeof briefPath !== "string" || !briefPath.trim()) return false;
  // Absolute (posix `/…`, windows `C:\…` or `\…`) is rejected outright.
  if (/^(?:\/|[A-Za-z]:[\\/]|\\)/.test(briefPath)) return false;
  const segs = (p) => p.split(/[\\/]+/).filter((s) => s && s !== ".");
  const bp = segs(briefPath);
  // Reject any `..` segment (covers `../x`, `a/../../x`, a leading `..`, etc.).
  if (bp.some((s) => s === "..")) return false;
  if (bp.length === 0) return false;
  // Containment: the briefPath segments must START WITH the briefsPath segments
  // and name a FILE under it (strictly longer than the base). A base of "." (no
  // configured dir) imposes no narrowing beyond the relative + no-`..` checks.
  const base = segs(briefsPath);
  if (base.length === 0) return true;
  if (bp.length <= base.length) return false;
  for (let i = 0; i < base.length; i++) if (bp[i] !== base[i]) return false;
  return true;
}

// CAS-link the brief PATH onto the card (card.briefPath), so the card LINKS the
// brief — never inlines it. Validates the card id (ULID) and that briefPath is a
// safe relative path under briefsPath before the write. Returns the updated card.
// Throws on a bad id / unsafe path / a CAS conflict so the caller surfaces it.
export async function recordBrief(root, cardId, briefPath, { briefsPath = "./briefs/" } = {}) {
  if (!isValidCardId(cardId)) throw new Error(`recordBrief: invalid card id: ${cardId}`);
  if (!isSafeBriefPath(briefPath, briefsPath)) {
    throw new Error(`recordBrief: unsafe brief path (must be relative + under ${briefsPath}): ${briefPath}`);
  }
  // Computed specifier so a UI bundler (esbuild) does NOT statically follow this
  // node-only module into the browser bundle — recordBrief is server-only.
  const boardMod = "../lib/board.mjs";
  const { loadCard, saveCardCAS } = await import(/* @vite-ignore */ boardMod);
  const card = await loadCard(root, cardId);
  card.id = cardId; // pin to the validated id — never trust a tampered on-disk id
  const next = { ...card, briefPath };
  const result = await saveCardCAS(root, next, card.rev ?? 0);
  if (!result.ok) {
    const err = new Error("recordBrief: card changed under you (CAS conflict)");
    err.conflict = true;
    err.card = result.card;
    throw err;
  }
  return result.card;
}
