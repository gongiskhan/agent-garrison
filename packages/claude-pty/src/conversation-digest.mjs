// conversation-digest.mjs — LAYER 2.
//
// Layer 1 is the conversation summary a stretch boots from. Layer 3 is
// log.jsonl, the complete append-only record. Between them there was nothing:
// a stretch could read a 300-character one-liner about what the last stretch
// did, or grep a file that interleaves every event type with spilled payload
// pointers. Neither is "the conversation, without the expensive parts".
//
// That is what this renders. User messages in full, assistant prose in full,
// and every tool call reduced to its name, its arguments, a ONE-LINE synopsis
// of what came back, the size of what came back, and a pointer to fetch it.
// Never the result body: tool results are where a transcript's tokens actually
// go (a single `ls -la` or file read dwarfs the prose around it), and carrying
// them would recreate the problem the digest exists to avoid.
//
// Nothing here pushes itself into a brief. The digest is rendered ON DEMAND -
// by the HTTP route, and by the layer-3 MCP tool a stretch calls when the
// handoff it was given is too thin. Whether a bounded recent window belongs in
// the brief is a measurement, not an assumption.

const DEFAULTS = {
  // Enough to see what an argument was, not enough to inline a written file.
  argChars: 300,
  // One line. A synopsis is a pointer with a hint attached, not a summary.
  synopsisChars: 200,
  proseChars: 4_000,
  maxChars: 60_000,
};

function firstLine(text, cap) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .find((l) => l.trim().length > 0) ?? "";
  const flat = line.trim().replace(/\s+/g, " ");
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

function clamp(text, cap) {
  const s = String(text ?? "");
  return s.length > cap ? `${s.slice(0, cap)}…[${s.length} chars]` : s;
}

/**
 * Fold the ledger into digest entries.
 *
 * `events` is the raw L3 record list (store.range().events). Options:
 *   stretches   - keep only the last N stretches (undefined = all)
 *   fromSeq/toSeq - bound by ledger sequence instead
 *   maxChars    - hard cap on the rendered markdown; truncation is REPORTED
 */
export function buildConversationDigest(events, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const list = Array.isArray(events) ? events : [];

  // A session-event is revised in place as a message streams; the highest
  // revision is the settled one. Keeping every revision would show the same
  // assistant turn three times, each a prefix of the next.
  const settled = new Map();
  const firstSeq = new Map();
  const others = [];
  for (const e of list) {
    if (e.kind !== "session-event") { others.push(e); continue; }
    const id = e.payload?.id;
    if (!id) { others.push(e); continue; }
    if (!firstSeq.has(id)) firstSeq.set(id, e.seq ?? 0);
    const prev = settled.get(id);
    if (!prev || (e.payload?.revision ?? 0) >= (prev.payload?.revision ?? 0)) settled.set(id, e);
  }

  // Sort on the seq the message FIRST appeared at. A settled revision carries a
  // later seq than the turn it belongs to, so sorting on that would print a
  // long streaming reply after everything it actually preceded.
  const timeline = [...others.map((e) => ({ e, at: e.seq ?? 0 })),
                    ...[...settled.entries()].map(([id, e]) => ({ e, at: firstSeq.get(id) ?? e.seq ?? 0 }))]
    .sort((a, b) => a.at - b.at)
    .map(({ e, at }) => ({ ...e, seq: e.seq ?? at, _at: at }));

  // A tool_use block's `input` arrives as a growing prefix of its JSON, so the
  // LONGEST one seen for a tool id is the complete one. Same trap as the usage
  // snapshot: taking the first would record `{"command": "cd /ho`.
  const argsById = new Map();
  const resultById = new Map();
  for (const e of timeline) {
    for (const b of e.payload?.blocks ?? []) {
      if (b?.type === "tool_use" && b.toolUseId) {
        const cur = argsById.get(b.toolUseId) ?? "";
        const next = typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? "");
        if (next.length > cur.length) argsById.set(b.toolUseId, next);
      }
      if (b?.type === "tool_result" && b.toolUseId) {
        resultById.set(b.toolUseId, { text: b.text ?? "", isError: b.isError === true, seq: e.seq ?? null });
      }
    }
  }

  const entries = [];
  let currentStretch = null;
  for (const e of timeline) {
    if (e.kind === "user-message") {
      entries.push({ kind: "user", seq: e.seq ?? null, text: String(e.payload?.text ?? "") });
      continue;
    }
    if (e.kind === "stretch-started") {
      currentStretch = e.stretch ?? null;
      entries.push({
        kind: "stretch", seq: e.seq ?? null, stretch: currentStretch,
        duty: e.payload?.duty ?? e.duty ?? null,
        ordinal: e.payload?.ordinal ?? null,
        model: e.payload?.target?.model ?? null,
      });
      continue;
    }
    if (e.kind === "handoff") {
      entries.push({
        kind: "handoff", seq: e.seq ?? null, stretch: e.stretch ?? null,
        duty: e.payload?.duty ?? e.duty ?? null,
        status: e.payload?.status ?? null,
        summary: String(e.payload?.summary ?? ""),
        next: e.payload?.nextSteps?.next ?? null,
      });
      continue;
    }
    if (e.kind !== "session-event") continue;
    for (const b of e.payload?.blocks ?? []) {
      if (b?.type === "text" && String(b.text ?? "").trim()) {
        entries.push({
          kind: "assistant", seq: e._at ?? e.seq ?? null, stretch: e.stretch ?? null,
          duty: e.duty ?? null, text: String(b.text),
        });
      } else if (b?.type === "tool_use" && b.toolUseId) {
        const res = resultById.get(b.toolUseId);
        const body = res?.text ?? "";
        entries.push({
          kind: "tool", seq: e._at ?? e.seq ?? null, stretch: e.stretch ?? null, duty: e.duty ?? null,
          name: b.name ?? "?", toolUseId: b.toolUseId,
          args: argsById.get(b.toolUseId) ?? "",
          isError: res?.isError ?? null,
          resultBytes: Buffer.byteLength(body, "utf8"),
          resultSynopsis: firstLine(body, o.synopsisChars),
          // Where the full result lives, for a reader that decides it needs it.
          resultPointer: res?.seq != null ? `seq:${res.seq}` : null,
        });
      }
    }
  }

  // Windowing by stretch happens AFTER folding so the boundaries are known.
  let windowed = entries;
  if (Number.isFinite(o.stretches) && o.stretches > 0) {
    const starts = entries.map((e, i) => (e.kind === "stretch" ? i : -1)).filter((i) => i >= 0);
    if (starts.length > o.stretches) windowed = entries.slice(starts[starts.length - o.stretches]);
  }
  if (Number.isFinite(o.fromSeq)) windowed = windowed.filter((e) => (e.seq ?? 0) >= o.fromSeq);
  if (Number.isFinite(o.toSeq)) windowed = windowed.filter((e) => (e.seq ?? 0) <= o.toSeq);

  const lines = [];
  for (const e of windowed) {
    if (e.kind === "stretch") {
      lines.push("", `## stretch ${e.ordinal ?? "?"} — ${e.duty ?? "?"}${e.model ? ` (${e.model})` : ""}`);
    } else if (e.kind === "user") {
      lines.push("", `**user:** ${e.text}`);
    } else if (e.kind === "assistant") {
      lines.push("", clamp(e.text, o.proseChars));
    } else if (e.kind === "tool") {
      const err = e.isError ? " ERROR" : "";
      lines.push(
        `- \`${e.name}\`(${clamp(e.args, o.argChars)}) -> ${e.resultBytes}B${err}` +
        `${e.resultSynopsis ? ` · ${e.resultSynopsis}` : ""}` +
        `${e.resultPointer ? ` · ${e.resultPointer}` : ""}`
      );
    } else if (e.kind === "handoff") {
      lines.push("", `**handoff [${e.duty}/${e.status}] → ${e.next ?? "?"}**`, clamp(e.summary, o.proseChars));
    }
  }
  let markdown = lines.join("\n").trim();
  let truncated = false;
  if (markdown.length > o.maxChars) {
    // Keep the TAIL: the recent end of a conversation is the part a stretch
    // needs, and a silent head-truncation would read as a complete digest.
    markdown = `…[digest truncated: ${markdown.length - o.maxChars} earlier characters dropped]\n${markdown.slice(-o.maxChars)}`;
    truncated = true;
  }
  return {
    entries: windowed,
    markdown,
    truncated,
    counts: {
      total: windowed.length,
      user: windowed.filter((e) => e.kind === "user").length,
      assistant: windowed.filter((e) => e.kind === "assistant").length,
      tool: windowed.filter((e) => e.kind === "tool").length,
      handoff: windowed.filter((e) => e.kind === "handoff").length,
      stretches: windowed.filter((e) => e.kind === "stretch").length,
      // What the digest chose NOT to carry, so its saving is visible rather
      // than claimed.
      toolResultBytesOmitted: windowed
        .filter((e) => e.kind === "tool")
        .reduce((n, e) => n + e.resultBytes, 0),
    },
  };
}
