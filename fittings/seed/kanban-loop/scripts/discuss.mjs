// Kanban Loop — the Discuss (interactive) plumbing. PURE + unit-tested.
//
// The Discuss list is interactive: the engine NEVER auto-dispatches it
// (engine.isInteractive / processCard skip it). It advances only by a manual
// Move. This module is the PLUMBING for that hand-off — it does NOT advance the
// card and writes no brief itself:
//
//   buildDiscussUrl — the James-mode web-channel URL carrying the card as an
//     OPAQUE context blob the GENERIC web channel forwards verbatim to the
//     gateway. James (the operative) decodes it and writes the brief to disk.
//   briefSlug       — a clean kebab filename stem from the card title.
//   recordBrief     — CAS-link the resulting brief PATH onto the card (a
//     pointer, never the brief body — FINDING 10), validated for traversal.
//
// The web channel stays generic: it never learns about kanban. It un-wraps a
// base64 TRANSPORT layer (iff it round-trips) and forwards the JSON string
// verbatim; James interprets it. We therefore base64-wrap the JSON so the
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
// a brief James wrote shows up without a manual POST. Pure (no node imports) so
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

// The opening message the Discuss session AUTO-SENDS to start the conversation. It
// LEADS WITH "James," so the gateway's parseLeadingMode switches the operative to the
// James face (the gateway resolves the mode from the message text, not body.mode), and
// it carries the card title + description IN THE MESSAGE (the gateway does not inject
// body.context, so the description must be in the text James actually reads). It tells
// James to analyse + ask clarifying questions, then write the brief to the SAME path
// the board auto-links on Move-out-of-Discuss (briefRelPath), so the discussion result
// becomes the card's downstream context. Pure (no node imports) → bundles into the UI.
export function buildDiscussKickoff(card, { briefsPath = "./briefs/" } = {}) {
  const title = (typeof card?.title === "string" && card.title.trim()) ? card.title.trim() : "(untitled)";
  const project = card?.project ? String(card.project) : "(none assigned yet)";
  const desc = (typeof card?.description === "string" && card.description.trim())
    ? card.description.trim()
    : "(no description was provided — ask Goncalo what this card is about before going further)";
  const briefPath = briefRelPath(card, { briefsPath });
  return [
    `James, let's talk this work item through before it goes to planning.`,
    ``,
    `# Card: ${title}`,
    `Project: ${project}`,
    ``,
    desc,
    ``,
    `Start the discussion now: think it through out loud, surface the key decisions, tradeoffs and risks, and ask me the clarifying questions you need answered before this is ready to build. Don't jump to code.`,
    ``,
    `When the thinking has settled, write the brief to \`${briefPath}\` using the brief template (what this is, decisions, approach, open questions, acceptance) — that brief is the handoff the build reads, so capture what we decided. Begin with your analysis and your first questions.`
  ].join("\n");
}

// Build the James-mode web-channel URL for a Discuss card. The card is encoded
// as an OPAQUE context blob — the channel forwards it untouched; James reads
// { source, cardId, title, project, briefsPath, suggestedSlug } and writes the
// brief under briefsPath. We pass briefsPath + a suggested slug so the brief
// James writes lands where recordBrief can later link it.
//
// webChannelBase defaults to Garrison's embed route for the seed web channel —
// the fitting id is `web-channel-default` (NOT `web-channel`), so the embed route
// is /embed/web-channel-default. The board is opened embedded in Garrison
// (/embed/kanban-loop), so this relative URL + target="_top" navigates Garrison
// to the web channel. Override webChannelBase for a non-default web channel.
export function buildDiscussUrl(card, { webChannelBase = "/embed/web-channel-default", briefsPath = "./briefs/" } = {}) {
  const context = {
    source: "kanban",
    cardId: card?.id ?? null,
    title: card?.title ?? null,
    project: card?.project ?? null,
    // The description so a context-honoring channel/operative has it too (the kickoff
    // message carries it as well, for the gateway path that ignores body.context).
    description: card?.description ?? null,
    briefsPath,
    // CARD-UNIQUE stem (<cardId>-<slug>) so James writes briefs/<stem>.md and the
    // board's Move-out-of-Discuss auto-link finds THIS card's brief, never another
    // card's whose title kebabs to the same slug.
    suggestedSlug: briefStem(card)
  };
  const encoded = encodeURIComponent(encodeContext(context));
  // The auto-sent opening message (carries the description + the brief path). base64 +
  // url-encoded so a long description survives the query string; the channel decodes it
  // and hands it to the chat as initialMessage.
  const kickoff = encodeURIComponent(encodeString(buildDiscussKickoff(card, { briefsPath })));
  const base = webChannelBase.replace(/\/+$/, "");
  return `${base}?mode=james&context=${encoded}&kickoff=${kickoff}`;
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
