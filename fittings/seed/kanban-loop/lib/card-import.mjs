// Portable card-import adapters.
//
// The Kanban server writes only one trusted internal shape: a fresh Garrison card.
// External formats are normalised into that small content-only shape first, then the
// server applies its ordinary allow-list and createCard normalisers. Keeping this
// adapter pure means a future Trello connector can feed the exact same path as the
// local JSON-file importer without teaching the board about credentials or APIs.

export const NATIVE_CARD_BUNDLE_KIND = "garrison.kanban.cards";
export const NATIVE_CARD_BUNDLE_VERSION = 1;
export const MAX_IMPORT_CARDS = 2_000;

export class CardImportError extends Error {
  constructor(message, code = "invalid-import") {
    super(message);
    this.name = "CardImportError";
    this.code = code;
  }
}

function stringValue(value, max = null) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return max && text.length > max ? text.slice(0, max) : text;
}

function safeTrelloUrl(value) {
  const text = stringValue(value, 2_000);
  if (!text) return "";
  try {
    const parsed = new URL(text);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && (host === "trello.com" || host === "www.trello.com") ? parsed.href : "";
  } catch {
    return "";
  }
}

function stripAttachmentMarker(value) {
  return String(value ?? "").replace(/\n{2,}Attached files?:\n(?:- [^\n]*(?:\n|$))+\s*$/i, "").trimEnd();
}

function sourceListRows(board) {
  const cards = Array.isArray(board?.cards) ? board.cards : [];
  return (Array.isArray(board?.lists) ? board.lists : [])
    .filter((list) => list && typeof list.id === "string")
    .slice()
    .sort((a, b) => {
      const ap = Number.isFinite(a?.pos) ? a.pos : Number.MAX_SAFE_INTEGER;
      const bp = Number.isFinite(b?.pos) ? b.pos : Number.MAX_SAFE_INTEGER;
      return ap - bp;
    })
    .map((list) => ({
      id: list.id,
      title: stringValue(list.name, 200) || list.id,
      archived: list.closed === true,
      count: cards.filter((card) => card?.idList === list.id && card?.closed !== true).length,
      archivedCount: cards.filter((card) => card?.idList === list.id && card?.closed === true).length
    }));
}

function isTrelloBoard(raw) {
  return Boolean(
    raw && typeof raw === "object" &&
    Array.isArray(raw.cards) && Array.isArray(raw.lists) &&
    raw.lists.some((list) => list && typeof list.id === "string" && typeof list.name === "string") &&
    raw.cards.every((card) => !card || typeof card !== "object" || typeof card.idList === "string")
  );
}

function checklistIndex(board) {
  const byCard = new Map();
  for (const checklist of Array.isArray(board?.checklists) ? board.checklists : []) {
    if (!checklist || typeof checklist !== "object" || typeof checklist.idCard !== "string") continue;
    const current = byCard.get(checklist.idCard) || [];
    current.push(checklist);
    byCard.set(checklist.idCard, current);
  }
  return byCard;
}

function checklistItemsFor(card, byCard) {
  const groups = [];
  const seen = new Set();
  const add = (checklist) => {
    if (!checklist || typeof checklist !== "object") return;
    const key = typeof checklist.id === "string" ? checklist.id : checklist;
    if (seen.has(key)) return;
    seen.add(key);
    groups.push(checklist);
  };
  for (const checklist of byCard.get(card.id) || []) add(checklist);
  for (const checklist of Array.isArray(card.checklists) ? card.checklists : []) add(checklist);

  const items = [];
  for (const checklist of groups) {
    const groupName = stringValue(checklist.name, 500);
    const rows = (Array.isArray(checklist.checkItems) ? checklist.checkItems : [])
      .slice()
      .sort((a, b) => {
        const ap = Number.isFinite(a?.pos) ? a.pos : Number.MAX_SAFE_INTEGER;
        const bp = Number.isFinite(b?.pos) ? b.pos : Number.MAX_SAFE_INTEGER;
        return ap - bp;
      });
    for (const row of rows) {
      const body = stringValue(row?.name);
      if (!body) continue;
      const text = groupName ? `${groupName}\n\n${body}` : body;
      // Never preserve Trello identity. normaliseChecklist mints a fresh item id
      // during prevalidation, just as createCard mints a fresh card ULID.
      items.push({ text, done: row?.state === "complete" });
    }
  }
  return items;
}

function trelloDescription(card, listTitle) {
  const description = typeof card?.desc === "string" ? stripAttachmentMarker(card.desc) : "";
  const labels = (Array.isArray(card?.labels) ? card.labels : [])
    .map((label) => stringValue(label?.name || label?.color, 200))
    .filter(Boolean);
  const url = safeTrelloUrl(card?.shortUrl || card?.url);
  const source = [
    `Imported from Trello${listTitle ? ` (${listTitle})` : ""}.`,
    url ? `Source: ${url}` : null,
    labels.length ? `Labels: ${labels.join(", ")}` : null
  ].filter(Boolean).join("\n");
  return [description, source].filter(Boolean).join("\n\n");
}

function normaliseTrelloBoard(board, { sourceList = null, includeArchived = false } = {}) {
  const sourceLists = sourceListRows(board);
  if (sourceList && !sourceLists.some((list) => list.id === sourceList)) {
    throw new CardImportError(`unknown Trello list: ${sourceList}`, "unknown-source-list");
  }
  const listById = new Map(sourceLists.map((list) => [list.id, list]));
  const byCard = checklistIndex(board);
  const warnings = [];
  const cards = [];
  const seenCardIds = new Set();
  let excludedArchived = 0;

  const listRank = new Map(sourceLists.map((list, index) => [list.id, index]));
  const ordered = board.cards.slice().sort((a, b) => {
    const al = listRank.get(a?.idList) ?? Number.MAX_SAFE_INTEGER;
    const bl = listRank.get(b?.idList) ?? Number.MAX_SAFE_INTEGER;
    if (al !== bl) return al - bl;
    const ap = Number.isFinite(a?.pos) ? a.pos : Number.MAX_SAFE_INTEGER;
    const bp = Number.isFinite(b?.pos) ? b.pos : Number.MAX_SAFE_INTEGER;
    return ap - bp;
  });
  for (const card of ordered) {
    if (!card || typeof card !== "object") continue;
    if (typeof card.id === "string" && card.id) {
      if (seenCardIds.has(card.id)) {
        warnings.push(`skipped duplicate Trello card id ${card.id}`);
        continue;
      }
      seenCardIds.add(card.id);
    }
    const list = listById.get(card.idList);
    if (!list) {
      warnings.push(`skipped Trello card "${stringValue(card.name, 80) || "(untitled)"}" because its list is missing`);
      continue;
    }
    if (sourceList && card.idList !== sourceList) continue;
    if (!includeArchived && (card.closed === true || list.archived)) {
      excludedArchived += 1;
      continue;
    }
    const title = stringValue(card.name, 500);
    const description = trelloDescription(card, list.title);
    if (!title && !description) {
      warnings.push("skipped an empty Trello card");
      continue;
    }
    const due = typeof card.due === "string" && Number.isFinite(Date.parse(card.due)) && card.dueComplete !== true
      ? card.due
      : null;
    if (card.due && !due && card.dueComplete !== true) {
      warnings.push(`Trello card "${title || "(untitled)"}": ignored an unparseable due date`);
    }
    cards.push({
      title,
      description,
      checklist: checklistItemsFor(card, byCard),
      scheduledFor: due,
      scheduleAction: due ? "notify" : null,
      sourceList: card.idList,
      created: typeof card.dateLastActivity === "string" ? card.dateLastActivity : null
    });
  }

  if (cards.length > MAX_IMPORT_CARDS) {
    throw new CardImportError(`the import contains ${cards.length} cards; the maximum is ${MAX_IMPORT_CARDS}`, "too-many-cards");
  }
  if (excludedArchived > 0) warnings.push(`excluded ${excludedArchived} archived Trello card${excludedArchived === 1 ? "" : "s"}`);
  return {
    format: "trello",
    sourceName: stringValue(board.name, 300) || "Trello board",
    sourceLists,
    cards,
    warnings,
    excludedArchived
  };
}

function normaliseNativeBundle(bundle) {
  if (bundle.version !== NATIVE_CARD_BUNDLE_VERSION) {
    throw new CardImportError(
      `unsupported bundle version ${bundle.version} (expected ${NATIVE_CARD_BUNDLE_VERSION})`,
      "unsupported-version"
    );
  }
  const cards = Array.isArray(bundle.cards) ? bundle.cards : [];
  if (cards.length > MAX_IMPORT_CARDS) {
    throw new CardImportError(`the import contains ${cards.length} cards; the maximum is ${MAX_IMPORT_CARDS}`, "too-many-cards");
  }
  return {
    format: "garrison",
    sourceName: "Garrison card bundle",
    sourceLists: Array.isArray(bundle.sourceLists) ? bundle.sourceLists : [],
    cards,
    warnings: [],
    excludedArchived: 0
  };
}

/** Normalise a native Garrison card bundle or a raw Trello board JSON export. */
export function normaliseCardImport(raw, options = {}) {
  if (!raw || typeof raw !== "object") throw new CardImportError("the import file must contain a JSON object");
  if (raw.kind === NATIVE_CARD_BUNDLE_KIND) return normaliseNativeBundle(raw);
  if (isTrelloBoard(raw)) return normaliseTrelloBoard(raw, options);
  throw new CardImportError("not a Garrison card bundle or Trello board JSON export", "unsupported-format");
}
