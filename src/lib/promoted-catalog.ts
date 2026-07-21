// Promoted-primitives catalog (2026-06-24).
//
// The "Claude Code components" Compose group (skills / hooks / agent tools-MCPs /
// plugins) is reversed: every primitive is presented as a first-class **Fitting**
// with a meaningful human description, an explicit contract, and editable setup
// instructions. The primitive type survives ONLY as the internal `componentShape`
// recorded here — it is never a user-facing label.
//
// This module is the AUTHORED sidecar (the baseline). It is joined to the LIVE
// Quarters discovery (`StateModel` from `primitive-state.ts`) so each Fitting
// reflects what is actually installed — we reuse the existing discovery + state
// engine, never a parallel one. The Hybrid scope (confirmed 2026-06-24): most
// units are discovery-driven projections backed by this catalog; a few genuinely
// general units also ship as real `fittings/seed/` packages (`packaged: true`).
//
// Setup instructions are an ordered, editable list. The baseline lives here; user
// edits are persisted to the override store (`promoted-overrides.ts`) and merged
// over the baseline on read — the single source of truth the (projection)
// installer reads, mirroring how a packaged Fitting's installer reads
// `x-garrison.setup`.

import type { FacultyId, SetupStep } from "./types";
import type { PrimitiveSurface, StateModel } from "./primitive-state";
import { getFaculty } from "./faculties";

// A promoted Fitting's contract entry. Free-form `kind` (display-only) because
// promoted Fittings are projected, not resolved through the strict CapabilityKind
// graph: an agent-tool Fitting provides "tools"; a capability Fitting provides a
// named "capability" to the operative; a lifecycle Fitting consumes a
// "lifecycle-event". Where a real kind fits (e.g. memory-store) it is used.
export interface PromotedCapability {
  kind: string;
  name: string;
  cardinality?: "one" | "optional-one" | "any";
}

// The underlying primitive(s) a promoted Fitting represents, recorded ONLY as
// internal metadata. `surface` is the Claude Code primitive type (skill / hook /
// mcp / plugin / command / rule); `name` matches the discovery record's name.
export interface PromotedMember {
  surface: PrimitiveSurface;
  name: string;
}

export interface PromotedFitting {
  id: string;
  title: string;
  // Plain-language, non-technical: what capability this gives the operative, in
  // real-world terms, defining any unavoidable term. The reader must understand
  // it without knowing what a skill or an agent tool is.
  descriptionPlain: string;
  // Precise line for technical readers.
  descriptionTechnical: string;
  faculty: FacultyId;
  // Internal kind(s) only — the primitive type(s) behind this Fitting. Never a
  // user-facing label.
  componentShape: PrimitiveSurface | PrimitiveSurface[];
  provides: PromotedCapability[];
  consumes: PromotedCapability[];
  // Ordered, idempotent-where-possible setup steps (baseline). Editable in the
  // fitting detail UI; the installer runs these when the composition installs.
  setup: SetupStep[];
  members: PromotedMember[];
  // Human-review flags (suspected groupings, duplicate installs, dual-use) — per
  // the migration plan's "record the suspicion rather than merge" rule.
  notes?: string;
  // Hybrid: true when a real fittings/seed/ package also exists for this unit.
  packaged?: boolean;
}

// ── The authored catalog ────────────────────────────────────────────────────
// Grouped per the migration plan §2. Plugin membership is authoritative; strong
// co-reference groups (garrison family, csg family, the coordination stack) are
// single Fittings; weak suspicions are kept separate and noted.

export const PROMOTED_CATALOG: PromotedFitting[] = [
  // ── Knowledge (Agent) ─────────────────────────────────────────────────────
  {
    id: "document-skills",
    title: "Office Documents",
    descriptionPlain:
      "Lets the operative read and write everyday office files — Word documents, PDFs, PowerPoint decks, and Excel spreadsheets — and produce polished documents, brand-consistent designs, and web artifacts on request.",
    descriptionTechnical:
      "The document-skills plugin bundle (docx, pdf, pptx, xlsx + authoring helpers like brand-guidelines, canvas-design, theme-factory, web-artifacts-builder).",
    faculty: "knowledge",
    componentShape: "plugin",
    provides: [{ kind: "capability", name: "office-documents" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [
      {
        command: "claude plugin marketplace add anthropic-agent-skills",
        idempotent: true,
        label: "Register the Anthropic agent-skills marketplace"
      },
      {
        command: "claude plugin install document-skills@anthropic-agent-skills",
        idempotent: true,
        label: "Install the Office Documents capability"
      }
    ],
    members: [{ surface: "plugin", name: "document-skills@anthropic-agent-skills" }],
    notes:
      "Bundles 17 underlying skills. Also bundles its own copies of pdf / frontend-design / skill-creator — duplicate installs to dedupe against the standalone ones."
  },
  {
    id: "obsidian",
    title: "Obsidian Notes",
    descriptionPlain:
      "Lets the operative create and edit notes in an Obsidian vault — the personal knowledge notebook — including its special note, board, and canvas formats.",
    descriptionTechnical:
      "The obsidian plugin bundle (obsidian-cli, obsidian-markdown, obsidian-bases, json-canvas, defuddle).",
    faculty: "knowledge",
    componentShape: "plugin",
    provides: [{ kind: "capability", name: "obsidian-vault" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [
      {
        command: "claude plugin marketplace add obsidian-skills",
        idempotent: true,
        label: "Register the Obsidian skills marketplace"
      },
      {
        command: "claude plugin install obsidian@obsidian-skills",
        idempotent: true,
        label: "Install the Obsidian Notes capability"
      }
    ],
    members: [{ surface: "plugin", name: "obsidian@obsidian-skills" }]
  },
  {
    id: "pdf",
    title: "PDF Toolkit",
    descriptionPlain:
      "Lets the operative work with PDF files — pull out text and tables, build new PDFs, merge or split documents, and fill in PDF forms.",
    descriptionTechnical:
      "The standalone pdf skill (text/table extraction, generation, merge/split, form fill).",
    faculty: "knowledge",
    componentShape: "skill",
    provides: [{ kind: "capability", name: "pdf-toolkit" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [],
    members: [{ surface: "skill", name: "pdf" }],
    notes: "Standalone install; also bundled inside Office Documents — dedupe candidate."
  },

  // ── Research & Media (Agent) ──────────────────────────────────────────────
  {
    id: "watch",
    title: "Video Understanding",
    descriptionPlain:
      "Lets the operative watch a video — from a link or a file on disk — and answer questions about what happens in it, by reading the spoken words and looking at the picture.",
    descriptionTechnical:
      "The watch skill: yt-dlp download, ffmpeg frame extraction, caption/Whisper transcript, then vision Q&A.",
    faculty: "research",
    componentShape: "skill",
    provides: [{ kind: "capability", name: "video-understanding" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [
      {
        command: "brew install yt-dlp ffmpeg",
        idempotent: true,
        label: "Install the video download + frame tools (yt-dlp, ffmpeg)"
      }
    ],
    members: [{ surface: "skill", name: "watch" }],
    notes: "External dependency: needs ffmpeg + yt-dlp on PATH (the skill's setup check confirms this)."
  },
  {
    id: "notebooklm",
    title: "Notebook & Podcast Studio",
    descriptionPlain:
      "Lets the operative turn a pile of source material into a Google NotebookLM notebook and generate study aids and audio overviews (podcast-style summaries) from it.",
    descriptionTechnical:
      "The notebooklm skill: full programmatic NotebookLM API (create notebooks, add sources, generate artifacts, download).",
    faculty: "research",
    componentShape: "skill",
    provides: [{ kind: "capability", name: "notebooklm" }],
    consumes: [
      { kind: "orchestrator", name: "operative", cardinality: "one" },
      { kind: "vault", name: "google-credentials", cardinality: "optional-one" }
    ],
    setup: [],
    members: [{ surface: "skill", name: "notebooklm" }]
  },
  {
    id: "caveman",
    title: "Terse Speaking Style",
    descriptionPlain:
      "Lets the operative answer in a stripped-down, ultra-brief speaking style that uses far fewer words while keeping the technical meaning — useful when you want short answers.",
    descriptionTechnical: "The caveman skill: a token-compressing communication style with intensity levels.",
    faculty: "research",
    componentShape: "skill",
    provides: [{ kind: "capability", name: "terse-style" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [],
    members: [{ surface: "skill", name: "caveman" }],
    notes:
      "Dual-use/odd fit: a communication-style trait, conceptually a persona/modes concern, but the modes faculty is a single system-prompt slot — placed in the nearest Agent home. Flag for review."
  },

  // ── Memory (Agent · essential) ────────────────────────────────────────────
  {
    id: "basic-memory",
    title: "Long-Term Memory",
    descriptionPlain:
      "Gives the operative a long-term memory — a personal notebook it writes facts and decisions into and searches later — so it remembers things across conversations instead of starting fresh each time.",
    descriptionTechnical:
      "The basic-memory agent tool (a knowledge graph over a markdown vault) plus its session-sync lifecycle automations.",
    faculty: "memory",
    componentShape: ["mcp", "hook"],
    provides: [{ kind: "memory-store", name: "basic-memory" }],
    consumes: [{ kind: "lifecycle-event", name: "PreCompact + SessionEnd (sync)" }],
    setup: [
      {
        command: "pipx install basic-memory || uv tool install basic-memory",
        idempotent: true,
        label: "Install the basic-memory tool"
      }
    ],
    members: [
      { surface: "mcp", name: "basic-memory" },
      { surface: "hook", name: "PreCompact" },
      { surface: "hook", name: "SessionEnd" }
    ],
    notes:
      "Grouped: the basic-memory agent tool + its PreCompact/SessionEnd sync hooks (clear co-reference). Provides the memory-store, so it fills the essential Memory faculty rather than a new optional one."
  },

  // ── Software Building (Dev) ───────────────────────────────────────────────
  {
    id: "garrison",
    title: "Autonomous Software Building",
    descriptionPlain:
      "Lets the operative build a real piece of software from start to finish on its own — plan the work, write the code, test it, get a second opinion, and record a video proving it works — then keep going until it's genuinely done.",
    descriptionTechnical:
      "The garrison orchestrator + its 12-step pipeline (plan/implement/test/review/adversarial-review/adversarial-test/ux-qa/walkthrough/report/validate/parallel-work/project-foundation) and the goal-loop hooks.",
    faculty: "building",
    componentShape: ["skill", "hook"],
    provides: [{ kind: "capability", name: "autonomous-build" }],
    consumes: [
      { kind: "gateway", name: "claude-code", cardinality: "one" },
      { kind: "lifecycle-event", name: "Stop + SessionStart (goal loop)" }
    ],
    setup: [],
    members: [
      { surface: "skill", name: "garrison" },
      { surface: "skill", name: "garrison-plan" },
      { surface: "skill", name: "garrison-implement" },
      { surface: "skill", name: "garrison-test" },
      { surface: "skill", name: "garrison-review" },
      { surface: "skill", name: "garrison-adversarial-review" },
      { surface: "skill", name: "garrison-adversarial-test" },
      { surface: "skill", name: "garrison-ux-qa" },
      { surface: "skill", name: "garrison-walkthrough" },
      { surface: "skill", name: "garrison-report" },
      { surface: "skill", name: "garrison-validate" },
      { surface: "skill", name: "garrison-parallel-work" },
      { surface: "skill", name: "garrison-project-foundation" },
      { surface: "hook", name: "Stop" },
      { surface: "hook", name: "SessionStart" }
    ],
    notes:
      "Grouped: the garrison orchestrator invokes its 12 sub-skills (shared name root + documented co-reference), plus the goal-loop Stop/SessionStart hooks it owns."
  },
  {
    id: "walkthrough",
    title: "Proof-of-Work Recording",
    descriptionPlain:
      "Lets the operative record a short narrated video that proves a finished change works and shows how it behaves, then checks the video itself and shares one scrubbable link — so you don't have to retest by hand.",
    descriptionTechnical: "The walkthrough skill: narrated/captioned screen capture, vision self-verification, Tailscale publish.",
    faculty: "building",
    componentShape: "skill",
    provides: [{ kind: "capability", name: "walkthrough-evidence" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [
      {
        command: "brew install asciinema agg",
        idempotent: true,
        label: "Install the terminal-recording tools (for CLI/TUI walkthroughs)"
      }
    ],
    members: [{ surface: "skill", name: "walkthrough" }]
  },
  {
    id: "ekoa-architecture-audit",
    title: "Architecture Audit",
    descriptionPlain:
      "Lets the operative do a careful review of how a codebase is built — checking that its structure and ground rules hold together — and write up what it finds with exact file references.",
    descriptionTechnical: "The ekoa-architecture-audit skill: deliberate invariant/architecture audit producing a cited ARCHITECTURE_AUDIT.md.",
    faculty: "building",
    componentShape: "skill",
    provides: [{ kind: "capability", name: "architecture-audit" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [],
    members: [{ surface: "skill", name: "ekoa-architecture-audit" }]
  },
  {
    id: "csg-workflow",
    title: "Corporate Remote-Dev Workflow",
    descriptionPlain:
      "Lets the operative run a specific corporate development routine — bring up a remote work environment, push changes to a corporate machine for testing, and finish a ticket the sanctioned way.",
    descriptionTechnical: "The csg-setup / csg-sync / csg-complete skills over the shared csg-common library (the pnmui-monorepo remote-dev workflow).",
    faculty: "building",
    componentShape: "skill",
    provides: [{ kind: "capability", name: "csg-remote-dev" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [],
    members: [
      { surface: "skill", name: "csg-setup" },
      { surface: "skill", name: "csg-sync" },
      { surface: "skill", name: "csg-complete" },
      { surface: "skill", name: "csg-common" }
    ],
    notes: "Grouped: csg-common is the explicit shared library the other three depend on (shared name root + shared dependency)."
  },
  {
    id: "agent-sdk-dev",
    title: "Agent SDK Development",
    descriptionPlain:
      "Lets the operative help build apps on top of Claude's Agent SDK — scaffold a new project and check the code against the SDK's expectations.",
    descriptionTechnical: "The agent-sdk-dev plugin: the new-sdk-app command + the py/ts SDK verifier agents.",
    faculty: "building",
    componentShape: "plugin",
    provides: [{ kind: "capability", name: "agent-sdk-dev" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [
      {
        command: "claude plugin install agent-sdk-dev@claude-plugins-official",
        idempotent: true,
        label: "Install the Agent SDK Development capability"
      }
    ],
    members: [{ surface: "plugin", name: "agent-sdk-dev@claude-plugins-official" }]
  },
  {
    id: "skill-creator",
    title: "Capability Authoring",
    descriptionPlain:
      "Lets the operative create new reusable capabilities for itself — packaging a workflow or specialized knowledge so it can be reused later.",
    descriptionTechnical: "The skill-creator skill: a guided authoring workflow for new Claude Code skills.",
    faculty: "building",
    componentShape: "skill",
    provides: [{ kind: "capability", name: "capability-authoring" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [],
    members: [{ surface: "skill", name: "skill-creator" }],
    notes:
      "Shares the 'skill-' name root with Capability Refinement but neither invokes the other and there is no shared dependency — kept separate (weak suspicion only). Also bundled inside Office Documents (dedupe candidate)."
  },
  {
    id: "skill-improver",
    title: "Capability Refinement",
    descriptionPlain:
      "Lets the operative improve its own reusable capabilities over time, by turning feedback about how a capability behaved into concrete fixes — runs on a schedule, in the background.",
    descriptionTechnical: "The skill-improver skill: a nightly batch reviewer that turns feedback into skill edits (explicit/scheduled invocation only).",
    faculty: "building",
    componentShape: "skill",
    provides: [{ kind: "capability", name: "capability-refinement" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [],
    members: [{ surface: "skill", name: "skill-improver" }],
    notes: "Kept separate from Capability Authoring (weak 'skill-' name-root suspicion only)."
  },
  {
    id: "gcp",
    title: "Google Cloud Operations",
    descriptionPlain:
      "Lets the operative work with Google Cloud — run and deploy services, manage storage, and query data — when a project lives on Google's cloud.",
    descriptionTechnical: "The gcp skill: GKE / Cloud Run / Cloud Storage / BigQuery / Pub/Sub operations.",
    faculty: "building",
    componentShape: "skill",
    provides: [{ kind: "capability", name: "gcp-operations" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [
      {
        command: "command -v gcloud >/dev/null || brew install --cask google-cloud-sdk",
        idempotent: true,
        label: "Install the Google Cloud CLI"
      },
      {
        command: "echo 'Run: gcloud auth login (one-time, interactive)'",
        idempotent: true,
        label: "Authenticate with Google Cloud (one-time, run manually)"
      }
    ],
    members: [{ surface: "skill", name: "gcp" }],
    notes: "Dual-use leaning Dev (cloud ops are development/ops); folded into Software Building per the confirmed faculty design."
  },
  {
    id: "claude-docs-consultant",
    title: "Claude Code Reference",
    descriptionPlain:
      "Lets the operative look up the official documentation for building with Claude Code — its features, automations, settings, and developer toolkits — instead of guessing.",
    descriptionTechnical: "The claude-docs-consultant skill: selective fetching of official Claude Code / SDK / API docs.",
    faculty: "building",
    componentShape: "skill",
    provides: [{ kind: "capability", name: "claude-code-reference" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [],
    members: [{ surface: "skill", name: "claude-docs-consultant" }],
    notes: "Development-only reference lookup → Dev (Software Building), not dual-use."
  },

  // ── Code Intelligence (Dev) ───────────────────────────────────────────────
  {
    id: "codegraph",
    title: "Codebase Map",
    descriptionPlain:
      "Gives the operative a fast map of a codebase — it can find where anything is defined and everywhere it's used in one step, instead of reading file after file.",
    descriptionTechnical: "The codegraph agent tool (a SQLite symbol/edge graph) + its session auto-init lifecycle hook.",
    faculty: "code-intelligence",
    componentShape: ["mcp", "hook"],
    provides: [{ kind: "tools", name: "codegraph_explore / codegraph_node / search / callers" }],
    consumes: [{ kind: "lifecycle-event", name: "SessionStart (auto-init)" }],
    setup: [
      {
        command: "command -v codegraph >/dev/null || echo 'Install the codegraph CLI, then run: codegraph index'",
        idempotent: true,
        label: "Install the codegraph CLI"
      },
      { command: "codegraph index || true", idempotent: true, label: "Build the index for the current repo" }
    ],
    members: [
      { surface: "mcp", name: "codegraph" },
      { surface: "hook", name: "SessionStart" }
    ],
    notes: "Grouped: the codegraph agent tool + its codegraph-autoinit SessionStart hook (clear co-reference)."
  },

  // ── Design Studio (Dev) ───────────────────────────────────────────────────
  {
    id: "frontend-design",
    title: "Frontend Design",
    descriptionPlain:
      "Lets the operative design and build good-looking, production-quality web interfaces — pages, components, and layouts — that avoid a generic, templated look.",
    descriptionTechnical: "The frontend-design skill: distinctive production-grade frontend UI generation.",
    faculty: "design",
    componentShape: "skill",
    provides: [{ kind: "capability", name: "frontend-design" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [],
    members: [{ surface: "skill", name: "frontend-design" }],
    notes:
      "Installed three ways — standalone skill, the frontend-design plugin, and bundled in Office Documents. Represented once here; dedupe the duplicate installs."
  },
  {
    id: "huashu-design",
    title: "Prototyping & Design Review",
    descriptionPlain:
      "Lets the operative explore visual directions and build clickable, high-fidelity prototypes (and even short animated demos), then give an expert critique of how the design looks and works.",
    descriptionTechnical: "The huashu-design skill: HTML hi-fi prototyping, design-variant exploration, expert review, video export.",
    faculty: "design",
    componentShape: "skill",
    provides: [{ kind: "capability", name: "prototyping-design-review" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [],
    members: [{ surface: "skill", name: "huashu-design" }]
  },
  {
    id: "ui-ux-pro-max",
    title: "Design Reference Library",
    descriptionPlain:
      "Gives the operative a big reference library of design know-how — curated styles, colour palettes, font pairings, and chart and layout patterns — to draw on when designing an interface.",
    descriptionTechnical: "The ui-ux-pro-max plugin: a UI/UX design-intelligence reference (styles, palettes, font pairings, charts, stacks).",
    faculty: "design",
    componentShape: "plugin",
    provides: [{ kind: "capability", name: "design-reference" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [
      {
        command: "claude plugin install ui-ux-pro-max@ui-ux-pro-max-skill",
        idempotent: true,
        label: "Install the Design Reference Library"
      }
    ],
    members: [{ surface: "plugin", name: "ui-ux-pro-max@ui-ux-pro-max-skill" }]
  },

  // ── Browser & QA (Dev) ────────────────────────────────────────────────────
  {
    id: "playwright-cli",
    title: "Browser Automation",
    descriptionPlain:
      "Lets the operative drive a real web browser — open pages, click, type, and check what happened — to test web pages and walk through a flow the way a person would.",
    descriptionTechnical: "The playwright-cli skill: scripted browser automation and Playwright test authoring/running.",
    faculty: "browser-qa",
    componentShape: "skill",
    provides: [{ kind: "capability", name: "browser-automation" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [
      {
        command: "npm i -g playwright",
        idempotent: true,
        label: "Install the Playwright CLI"
      },
      {
        command: "playwright install chromium",
        idempotent: true,
        label: "Install the Chromium browser Playwright drives"
      }
    ],
    members: [{ surface: "skill", name: "playwright-cli" }],
    notes:
      "Canonical setup-instructions example: the CLI install + the browser install belong in setup, not the payload. Browser-driving sibling of garrison-browser (no shared dependency — kept separate)."
  },
  {
    id: "garrison-browser",
    title: "Live Browser Inspector",
    descriptionPlain:
      "Lets the operative look at the web page you're viewing beside it — take a screenshot, read errors, and see what you pointed at — so you don't have to copy, paste, or describe what's on screen.",
    descriptionTechnical: "The garrison-browser skill: inspects the Garrison Browser Fitting tab (screenshot, console, network, DOM, JS).",
    faculty: "browser-qa",
    componentShape: "skill",
    provides: [{ kind: "capability", name: "live-browser-inspection" }],
    consumes: [{ kind: "orchestrator", name: "operative", cardinality: "one" }],
    setup: [],
    members: [{ surface: "skill", name: "garrison-browser" }]
  },

  // ── Coordination (Dev) ────────────────────────────────────────────────────
  {
    id: "coordination",
    title: "Session Coordination",
    descriptionPlain:
      "Keeps several work sessions from colliding when they run at the same time — they claim the files they're touching, agree before changing shared structure, and pass notes to each other.",
    descriptionTechnical: "The coordination stack: the coord-mcp planning gate + coord-agentmail file leases/mail + the SessionStart/UserPromptSubmit priming hooks.",
    faculty: "coordination",
    componentShape: ["mcp", "hook"],
    provides: [{ kind: "tools", name: "begin_planning / declare_intent / agent-mail leases" }],
    consumes: [{ kind: "lifecycle-event", name: "SessionStart + UserPromptSubmit (priming)" }],
    setup: [],
    members: [
      { surface: "mcp", name: "coord-mcp" },
      { surface: "mcp", name: "coord-agentmail" },
      { surface: "hook", name: "SessionStart" },
      { surface: "hook", name: "UserPromptSubmit" }
    ],
    packaged: true,
    notes:
      "Grouped: the same coordination stack (shared 'coord' root + co-reference). coord-mcp already ships as a real fittings/seed/ package (Hybrid: packaged). Owned by another active session — represented here read-only; the seed itself is not modified by this migration."
  }
];

export const promotedById = new Map(PROMOTED_CATALOG.map((f) => [f.id, f]));

// ── Discovery join ──────────────────────────────────────────────────────────

export interface ResolvedPromotedMember extends PromotedMember {
  present: boolean;
  presence?: "enabled" | "parked";
  state?: string;
}

export interface ResolvedPromotedFitting extends Omit<PromotedFitting, "members"> {
  tier: "agent" | "dev";
  facultyName: string;
  present: boolean; // at least one member discovered on disk
  members: ResolvedPromotedMember[];
  unauthored?: boolean; // a discovered primitive with no authored descriptor
}

export interface PromotedFacultyGroup {
  faculty: FacultyId;
  facultyName: string;
  tier: "agent" | "dev";
  fittings: ResolvedPromotedFitting[];
}

export interface PromotedFittingsView {
  agent: PromotedFacultyGroup[];
  dev: PromotedFacultyGroup[];
  // Flat list too, for callers that don't want the grouping.
  fittings: ResolvedPromotedFitting[];
}

// Build a fast lookup of discovered primitive names by surface. Plugin records
// carry the "<name>@<marketplace>" key as their name; hooks carry an event-based
// name; we match members loosely (exact, then prefix for plugins/hooks).
function indexDiscovery(model: StateModel): Record<PrimitiveSurface, Map<string, { presence?: string; state: string }>> {
  const idx = {} as Record<PrimitiveSurface, Map<string, { presence?: string; state: string }>>;
  for (const surface of Object.keys(model.bySurface) as PrimitiveSurface[]) {
    const map = new Map<string, { presence?: string; state: string }>();
    for (const r of model.bySurface[surface]) {
      map.set(r.name, { presence: r.presence, state: r.state });
    }
    idx[surface] = map;
  }
  return idx;
}

function memberPresent(
  member: PromotedMember,
  idx: Record<PrimitiveSurface, Map<string, { presence?: string; state: string }>>
): { present: boolean; presence?: "enabled" | "parked"; state?: string } {
  const map = idx[member.surface];
  if (!map) return { present: false };
  // Exact match first — the normal case for skills, plugins (the full
  // "<name>@<marketplace>" key), and matcher-less hooks (the bare event name).
  const exact = map.get(member.name);
  if (exact) {
    return { present: true, presence: exact.presence as "enabled" | "parked" | undefined, state: exact.state };
  }
  // Hooks discovered WITH a matcher are named "<Event> (<matcher>)" by
  // primitive-state, so a member that references an event matches any installed
  // hook on that event. (Plugins require the exact key — a same-named plugin from
  // a different marketplace is a different install, not a false-positive match.)
  if (member.surface === "hook") {
    for (const [name, info] of map) {
      if (name.startsWith(`${member.name} (`)) {
        return { present: true, presence: info.presence as "enabled" | "parked" | undefined, state: info.state };
      }
    }
  }
  return { present: false };
}

// Resolve the authored catalog against live discovery + setup overrides. Returns
// the Fittings grouped by faculty under their Agent/Dev tier, plus a flat list.
// `setupOverrides` maps fitting id → edited setup steps (the override store).
export function resolvePromotedFittings(
  model: StateModel,
  setupOverrides: Record<string, SetupStep[]> = {}
): PromotedFittingsView {
  const idx = indexDiscovery(model);

  const resolved: ResolvedPromotedFitting[] = PROMOTED_CATALOG.map((f) => {
    const faculty = getFaculty(f.faculty);
    const members: ResolvedPromotedMember[] = f.members.map((m) => ({ ...m, ...memberPresent(m, idx) }));
    const { members: _omit, ...rest } = f;
    return {
      ...rest,
      tier: faculty.tier ?? "dev",
      facultyName: faculty.name,
      present: members.some((m) => m.present),
      members,
      setup: setupOverrides[f.id] ?? f.setup
    };
  });

  // Group by faculty, ordered by the faculty's display order.
  const byFaculty = new Map<FacultyId, ResolvedPromotedFitting[]>();
  for (const f of resolved) {
    const list = byFaculty.get(f.faculty) ?? [];
    list.push(f);
    byFaculty.set(f.faculty, list);
  }

  const groups: PromotedFacultyGroup[] = [];
  for (const [faculty, fittings] of byFaculty) {
    const def = getFaculty(faculty);
    groups.push({ faculty, facultyName: def.name, tier: def.tier ?? "dev", fittings });
  }
  groups.sort((a, b) => getFaculty(a.faculty).order - getFaculty(b.faculty).order);

  return {
    agent: groups.filter((g) => g.tier === "agent"),
    dev: groups.filter((g) => g.tier === "dev"),
    fittings: resolved
  };
}
