import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

// Vocabulary guard for the 2026-08-24 mesh rename.
//
// "Operative" named a single composed agent on a single box. On a mesh of peer
// nodes it names nothing: what a user watches is a SESSION, what they configure
// is a COMPOSITION, and what runs it is a NODE. A one-time sweep drifts back
// within a month, so the rename is enforced here instead.
//
// SCOPE IS DELIBERATE, and narrower than "every file":
//
//   • src/**/*.tsx + their CSS modules — the words a user actually reads.
//   • fittings/**/apm.yml `summary` and `for_consumers` — these are INJECTED
//     INTO THE RUNNING PROMPT by the runner (see CLAUDE.md, "for_consumers over
//     Orchestrator hardcoding"), so they are how the model learns the
//     vocabulary. Stale prose here teaches the wrong word every turn.
//
// Explicitly NOT swept: internal identifiers in gateway-pty.mjs /
// gateway-routing.mjs / runner.ts (`standingOperative` and `directOperative`
// are wire fields on the gateway's hints object, consumed across several
// fittings — renaming them is a coordinated multi-fitting change with a
// compatibility window, for zero user-visible gain), test names, and
// docs/decisions/**, which are historical records that a rename would falsify.

const ROOT = path.resolve(__dirname, "..");

// `\b` on both sides so "cooperatively" and similar substrings are not hits;
// the plural is caught because the test is about the word, not one spelling.
const BANNED = /\boperatives?\b/i;

// Empty on purpose. An entry here is a debt, not a decision — it must name the
// file and say why the word cannot leave yet.
const ALLOWLIST: ReadonlyArray<{ file: string; why: string }> = [];

const allowed = new Set(ALLOWLIST.map((entry) => entry.file));

function walk(dir: string, match: (file: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "apm_modules" || entry === ".git") continue;
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, match, out);
    else if (match(entry)) out.push(full);
  }
  return out;
}

function offendingLines(file: string, text: string): string[] {
  return text
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => BANNED.test(line))
    .map(({ line, index }) => `${path.relative(ROOT, file)}:${index + 1}  ${line.trim()}`);
}

describe("vocabulary — 'Operative' left the user-facing surface", () => {
  it("no user-visible string in src/**/*.tsx says it", () => {
    const files = walk(path.join(ROOT, "src"), (name) => name.endsWith(".tsx") || name.endsWith(".css"));
    expect(files.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const file of files) {
      if (allowed.has(path.relative(ROOT, file))) continue;
      hits.push(...offendingLines(file, readFileSync(file, "utf8")));
    }
    expect(
      hits,
      `"Operative" is retired vocabulary — a session runs on a node, configured by a composition.\n${hits.join("\n")}`
    ).toEqual([]);
  });

  it("no fitting manifest teaches it to the model", () => {
    const manifests = walk(path.join(ROOT, "fittings"), (name) => name === "apm.yml");
    expect(manifests.length).toBeGreaterThan(20);
    const hits: string[] = [];
    for (const file of manifests) {
      if (allowed.has(path.relative(ROOT, file))) continue;
      const doc = yaml.load(readFileSync(file, "utf8")) as Record<string, unknown> | undefined;
      const block = doc?.["x-garrison"] as Record<string, unknown> | undefined;
      if (!block) continue;
      // Only the two prose fields the runner injects. `config_schema`
      // descriptions and comments are swept by hand, not policed here.
      for (const key of ["summary", "for_consumers"] as const) {
        const value = block[key];
        if (typeof value !== "string" || !BANNED.test(value)) continue;
        hits.push(`${path.relative(ROOT, file)} (${key})`);
      }
    }
    expect(
      hits,
      `x-garrison.summary / for_consumers are injected into the running prompt — they must not teach the retired word.\n${hits.join("\n")}`
    ).toEqual([]);
  });

  it("the allowlist stays empty, or every entry explains itself", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.why.trim().length, `${entry.file} needs a reason`).toBeGreaterThan(20);
    }
  });
});

// ---------------------------------------------------------------------------
// Conversations rename (2026-08-26).
//
// The mesh rename retired "Operative" in favour of SESSION. The conversations
// pivot narrows that further: what a user reads, writes into, and comes back to
// is a CONVERSATION (a card's lifetime, the web-channel unit). A model never
// holds it — each model invocation is a short-lived STRETCH, and the runtime
// session it runs in is an implementation detail of that stretch. So on the
// chat surfaces the user-facing noun is "conversation", and "session" survives
// only where it names a real runtime/PTY/tmux session.
//
// NOT renamed, on purpose — none of these are copy:
//   • identifiers: sessionId, SessionEvent, SessionStream, sessionEvents,
//     claudeSessionId, and the wire fields that carry them;
//   • SESSIONS_OPEN_KEY = "wc.sessions.open" — renaming the localStorage key
//     silently resets every user's sidebar state;
//   • filenames (sessions-rail.tsx) and every import specifier;
//   • CSS class names (wc-sidebar, dr-session-tabs, kanban-session-host);
//   • the state service `sessions` table and the session-log substrate;
//   • tmux copy in remote-shell-workbench.tsx / shells-modal.tsx — a tmux
//     session really is a session.
//
// The sweep below only ever looks at USER-VISIBLE STRINGS: string literals and
// JSX text nodes, with comments and identifier-shaped literals dropped. That is
// what keeps the rule from tripping over the identifiers listed above.

/** The trees whose copy a user reads while working in a conversation. */
const CONVERSATION_SURFACES = [
  path.join(ROOT, "src"),
  path.join(ROOT, "packages/talk/ui"),
  path.join(ROOT, "fittings/seed/web-channel-default/ui"),
  path.join(ROOT, "fittings/seed/kanban-loop/ui")
];

// A token reads as code, not copy, when it is lowercase-initial and joined by
// path/dot/kebab/snake/colon punctuation: "sessions", "wc.sessions.open",
// "dr-session-tabs", "/api/session-stream?session=". A literal is dropped only
// when EVERY token is code-shaped — "Session records (sessions/*.json)" is
// prose that happens to contain a path, and stays in the corpus.
const CODE_TOKEN = /^[.#@]*\/?[a-z][a-zA-Z0-9]*(?:[-_:./?=&]+[a-zA-Z0-9*]*)*$/;

function isIdentifierish(value: string): boolean {
  return value.split(/\s+/).every((token) => CODE_TOKEN.test(token));
}

/** Where a `'` starts a literal rather than punctuating prose. */
const VALUE_POSITION = /[([{=,:?&|!+;<>]$/;

// Where a `/` starts a regex rather than dividing. `<` is deliberately absent:
// in `</div>` the slash closes a JSX tag. Regexes must be recognised because
// one of them holds a backtick (kanban-loop's link matcher) — read as code, it
// would open a template literal and swallow the rest of the file.
const REGEX_POSITION = /[([{=,:?&|!+;~^%]$/;

/** Template-literal holes: the text around them is copy, the hole is not. */
const INTERPOLATION = /\$\{[^}]*\}/g;

/**
 * Extract the user-visible strings from a .ts/.tsx source: every string literal
 * (quoted or template, with interpolations blanked) plus every JSX text node.
 *
 * A hand-rolled scanner rather than a regex sweep because both cheap shortcuts
 * are wrong here: stripping block comments with a regex mangles real copy that
 * contains a path ("(sessions/*.json)"), and matching quotes without tracking
 * comments turns every apostrophe in a comment into a fake "string". Comments
 * are blanked in place, so reported line numbers stay honest.
 */
function userVisibleStrings(source: string): Array<{ line: number; value: string }> {
  const found: Array<{ line: number; value: string }> = [];
  // The source with comments and string bodies blanked out — JSX text nodes are
  // read off this, so a ">" inside a literal can never open a fake node.
  let skeleton = "";
  let index = 0;
  let line = 1;
  const blank = (count: number) => { skeleton += " ".repeat(count); };
  const lastCode = () => {
    const trimmed = skeleton.trimEnd();
    return trimmed.length > 0 ? trimmed[trimmed.length - 1] : "";
  };

  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];
    if (ch === "\n") { skeleton += "\n"; line++; index++; continue; }
    if (ch === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") { blank(1); index++; }
      continue;
    }
    if (ch === "/" && next === "*") {
      blank(2);
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") { skeleton += "\n"; line++; } else blank(1);
        index++;
      }
      blank(2);
      index += 2;
      continue;
    }
    if (ch === "/" && (REGEX_POSITION.test(lastCode()) || lastCode() === "")) {
      let cursor = index + 1;
      let inClass = false;
      let closed = false;
      while (cursor < source.length) {
        const c = source[cursor];
        if (c === "\\") { cursor += 2; continue; }
        if (c === "\n") break;            // a regex never spans lines
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) { closed = true; break; }
        cursor++;
      }
      if (closed) { blank(cursor - index + 1); index = cursor + 1; continue; }
    }
    // An apostrophe only opens a literal in value position; in JSX text
    // ("card's runtime transcript") it is punctuation.
    if (ch === '"' || ch === "`" || (ch === "'" && VALUE_POSITION.test(lastCode()))) {
      const quote = ch;
      const startLine = line;
      let cursor = index + 1;
      let value = "";
      let closed = false;
      while (cursor < source.length) {
        const c = source[cursor];
        if (c === "\\") { value += " "; cursor += 2; continue; }
        if (c === quote) { closed = true; break; }
        // A raw newline cannot appear in a quoted literal — so this was not one
        // (a regex such as /['"]/, most often). Back out and read it as code.
        if (c === "\n" && quote !== "`") break;
        value += c;
        cursor++;
      }
      if (!closed) { skeleton += ch; index++; continue; }
      found.push({ line: startLine, value: value.replace(INTERPOLATION, " ").trim() });
      for (let k = index; k <= cursor; k++) {
        if (source[k] === "\n") { skeleton += "\n"; line++; } else blank(1);
      }
      index = cursor + 1;
      continue;
    }
    skeleton += ch;
    index++;
  }

  skeleton.split("\n").forEach((text, offset) => {
    for (const match of text.matchAll(/>([^<>{}]+)</g)) {
      const value = match[1].trim();
      if (value) found.push({ line: offset + 1, value });
    }
  });

  return found.filter(({ value }) => value.length > 0 && !isIdentifierish(value));
}

const SESSION_WORD = /\bsessions?\b/i;

/**
 * Files whose "session" is a real runtime/PTY/tmux session — the mesh word, not
 * the conversation unit. These are decisions, not debts: the word is correct
 * there and renaming it would make the copy lie.
 */
const SESSION_IS_THE_RUNTIME: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: "src/app/mesh/session/[node]/[id]/page.tsx",
    why: "the peer-node viewer for one runtime session on another machine — a mesh session row, never a conversation"
  },
  {
    file: "src/components/compose/FacultyStation.tsx",
    why: "Compose describes what the composition's runtime session may do (cwd, autonomy), which is the session the runner starts"
  },
  {
    file: "src/components/compose/StationGrid.tsx",
    why: "the tier blurb names the everyday runtime session a composition boots, not a conversation held in the store"
  },
  {
    file: "src/components/coordination/CoordinationPanel.tsx",
    why: "coordination counts live Claude Code sessions holding repo leases — a lease is held by a process, not by a conversation"
  },
  {
    file: "src/components/garrison/GarrisonHome.tsx",
    why: "the dashboard's Run/Restart copy is about up()/down() starting one runtime session on this node"
  },
  {
    file: "src/components/garrison/SessionLogPanel.tsx",
    why: "the session log is the append-only per-run substrate; its name is the file format, kept deliberately by the conversations plan"
  },
  {
    file: "src/components/mesh/MeshPanel.tsx",
    why: "the mesh table counts runtime sessions per peer node, the unit the state service's sessions table stores"
  },
  {
    file: "src/components/muster/DecisionsPanel.tsx",
    why: "a decision links back to the runtime session that recorded it, resolved by session id"
  },
  {
    file: "src/components/quarters/ReadOnlyNotePanel.tsx",
    why: "Quarters mirrors the real ~/.claude, where Claude Code's own Session Viewer records live under that name"
  },
  {
    file: "src/components/quarters/ReadOnlyTailPanel.tsx",
    why: "Quarters tails Claude Code's own on-disk session records under ~/.claude, named by their path"
  },
  {
    file: "src/components/run/RunPanel.tsx",
    why: "the runner panel narrates apm install + verify + relaunch of the runtime session, the same lifecycle as the dashboard"
  },
  {
    file: "packages/talk/ui/remote-shell-workbench.tsx",
    why: "remote-shell copy is about tmux sessions on the remote host, which really are sessions and outlive any conversation"
  },
  {
    file: "packages/talk/ui/shells-modal.tsx",
    why: "the shells picker lists tmux sessions per project on a remote host — the tmux vocabulary is the correct one"
  },
  {
    file: "packages/talk/ui/sessions-rail.tsx",
    why: "the rail's Sessions section lists live claude/codex/cursor/gemini/tmux sessions across every mesh node, distinct from the conversation threads above it"
  },
  {
    file: "packages/talk/ui/session-view.tsx",
    why: "the external-session view streams the transcript of one runtime session (Claude, Codex, Cursor, Gemini, or a bare shell) that a conversation has not yet claimed"
  }
];

/**
 * Single literals that keep the word inside a file the sweep otherwise guards.
 * Unlike the list above, an entry here IS a debt: it must say what would have
 * to happen for the word to leave.
 */
const SESSION_LITERALS: ReadonlyArray<{ file: string; literal: string; why: string }> = [
  {
    file: "packages/talk/ui/app.tsx",
    literal: "the gateway is not answering - start the session to pin routing",
    why: "routing options need the RUNTIME session up; the message is about the process being down, not about the conversation"
  },
  {
    file: "packages/talk/ui/app.tsx",
    literal: "could not start a session ( )",
    why: "the remote-shell start path reports a failed tmux session on the remote host, mirroring remote-shell-workbench copy"
  }
];

/**
 * Board words the state-column board does not have. `duty:` was the chip that
 * announced a card's next duty list, which the conversation flow replaced.
 * (Backlog is NOT retired: it returned 2026-08-27 as the human-managed shelf.)
 */
const RETIRED_BOARD_WORDS = /\b(Ice Box|Archived)\b|\bduty:\s/;

const BOARD_LITERALS: ReadonlyArray<{ file: string; literal: string; why: string }> = [
  {
    file: "fittings/seed/kanban-loop/ui/main.tsx",
    literal: "move this card to the Archived column",
    why: "already unreachable — canArchive is a hardcoded false; the button and this title are deleted with the dispatch cut"
  }
];

const sessionFileExcluded = new Set(SESSION_IS_THE_RUNTIME.map((entry) => entry.file));
const literalKey = (file: string, literal: string) => `${file} ${literal}`;
const sessionLiteralExcluded = new Set(SESSION_LITERALS.map((e) => literalKey(e.file, e.literal)));
const boardLiteralExcluded = new Set(BOARD_LITERALS.map((e) => literalKey(e.file, e.literal)));

function sweep(
  roots: string[],
  match: (name: string) => boolean,
  banned: RegExp,
  skip: (file: string, value: string) => boolean
): { files: string[]; hits: string[] } {
  const files = roots.flatMap((root) => walk(root, match));
  const hits: string[] = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    for (const { line, value } of userVisibleStrings(readFileSync(file, "utf8"))) {
      if (!banned.test(value) || skip(rel, value)) continue;
      hits.push(`${rel}:${line}  ${value}`);
    }
  }
  return { files, hits };
}

describe("vocabulary — a conversation is not a session", () => {
  it("no user-visible string on the conversation surfaces calls one a session", () => {
    const { files, hits } = sweep(
      CONVERSATION_SURFACES,
      (name) => name.endsWith(".tsx"),
      SESSION_WORD,
      (file, value) => sessionFileExcluded.has(file) || sessionLiteralExcluded.has(literalKey(file, value))
    );
    expect(files.length).toBeGreaterThan(30);
    expect(
      hits,
      `A user reads and returns to a CONVERSATION; "session" names the runtime a stretch runs in.\nRename the copy, or add the file/literal to SESSION_IS_THE_RUNTIME / SESSION_LITERALS with a reason.\n${hits.join("\n")}`
    ).toEqual([]);
  });

  it("the Kanban UI does not name a column the board no longer has", () => {
    // .ts is included alongside .tsx: user-facing copy lives in plain modules
    // too (run-spec.ts carried a retired word invisibly until this widened).
    const { files, hits } = sweep(
      [path.join(ROOT, "fittings/seed/kanban-loop/ui")],
      (name) => name.endsWith(".tsx") || name.endsWith(".ts"),
      RETIRED_BOARD_WORDS,
      (file, value) => boardLiteralExcluded.has(literalKey(file, value))
    );
    expect(files.length).toBeGreaterThan(0);
    expect(
      hits,
      `The board is six lists — Backlog, To do, Running, Needs input, Scheduled, Done. Ice Box, Archived and the duty chip are gone.\n${hits.join("\n")}`
    ).toEqual([]);
  });

  it("no API route answers with the retired 'Operative'", () => {
    // The .tsx sweep at the top of this file cannot see these: the strings a
    // fetch surfaces to the user live in .ts route handlers.
    const { files, hits } = sweep(
      [path.join(ROOT, "src/app/api")],
      (name) => name.endsWith(".ts"),
      BANNED,
      () => false
    );
    expect(files.length).toBeGreaterThan(30);
    expect(
      hits,
      `An API error string is user-visible copy — a session runs on a node, configured by a composition.\n${hits.join("\n")}`
    ).toEqual([]);
  });

  it("every rename exception explains itself", () => {
    for (const entry of [...SESSION_IS_THE_RUNTIME, ...SESSION_LITERALS, ...BOARD_LITERALS]) {
      expect(entry.why.trim().length, `${entry.file} needs a reason`).toBeGreaterThan(20);
    }
  });
});
