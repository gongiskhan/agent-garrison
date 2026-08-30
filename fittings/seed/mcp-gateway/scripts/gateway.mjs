#!/usr/bin/env node
/**
 * Garrison MCP gateway — exposes installed Faculties as MCP tools to
 * Claude Code sessions launched in orchestrator-mode compositions.
 *
 * Usage:
 *   node gateway.mjs --probe
 *   node gateway.mjs stdio
 *   node gateway.mjs http --port N --token T [--host H]
 *
 * Environment:
 *   GARRISON_COMPOSITION_DIR   composition working directory (required)
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  checkProbe,
  callClassifyTier,
  callRunTests,
  automationsAvailable,
  callListAutomations,
  callRunAutomation,
  callRecordImproverFeedback,
  kanbanAvailable,
  callFetchEvidence,
  callCreateContinuation,
  callPollOriginEvents,
  callScheduleCard,
  callRunCard,
  callListScheduledCards
} from "./lib/tools.mjs";

// ─────────────────────────────────────────── dynamic tool discovery
async function discoverTools() {
  const tools = [];
  const [tierOk, testingOk] = await Promise.all([
    checkProbe("tier-classifier", "classify_tier.mjs"),
    checkProbe("testing", "run_tests.mjs"),
  ]);
  if (tierOk) {
    tools.push({
      name: "classify_tier",
      description: "Classify a prompt into tier 1-7. Use before committing to a plan.",
      inputSchema: {
        type: "object",
        properties: { prompt: { type: "string", description: "The user prompt to classify." } },
        required: ["prompt"]
      }
    });
  }
  if (testingOk) {
    tools.push({
      name: "run_tests",
      description: "Run the project's native test command (npm/pytest/cargo/go).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Absolute path to the project directory." },
          pattern: { type: "string", description: "Optional test filter/pattern." }
        },
        required: ["cwd"]
      }
    });
  }

  if (automationsAvailable()) {
    tools.push(
      {
        name: "list_automations",
        description: "List saved Garrison automations (id, name, step count, trigger). Use before run_automation.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "run_automation",
        description: "Run a saved automation by id and return its run status + per-step outcomes. Pass inputs for the automation's declared inputs.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "The automation id (from list_automations)." },
            inputs: { type: "object", description: "Values for the automation's declared inputs." }
          },
          required: ["id"]
        }
      }
    );
  }

  // Kanban run-engine tools (WS2 — CARD CHAINING). Gated on the board being live
  // (~/.garrison/ui-fittings/kanban-loop.json). Distinct from the Orchestrator
  // policy's post-task "continuations" (store|ask|route|notify).
  if (kanbanAvailable()) {
    tools.push(
      {
        name: "fetch_evidence",
        description:
          "Pull one artifact from a done/running card by its opaque ref token (from a card's evidence manifest or handoff packet): plan | brief | evidenceIndex | gateMarkers | evidence:<file> | session:<i> | log:<n>. Returns the raw text (capped ~50KB). Pull, not push — fetch only what you need.",
        inputSchema: {
          type: "object",
          properties: {
            card_id: { type: "string", description: "The card ULID that owns the artifact." },
            artifact_ref: { type: "string", description: "The opaque ref token (e.g. 'plan', 'log:2', 'evidence:after.png')." }
          },
          required: ["card_id", "artifact_ref"]
        }
      },
      {
        name: "create_continuation",
        description:
          "Register a CONTINUATION card that continues a predecessor card's work (card chaining). Creates the card with continues=<card_id> and moves it to plan; the successor's prompt is seeded from the predecessor's handoff packet. Returns { id, url }.",
        inputSchema: {
          type: "object",
          properties: {
            card_id: { type: "string", description: "The predecessor card ULID to continue." },
            title: { type: "string", description: "Optional title (default 'Continue: <predecessor title>')." },
            description: { type: "string", description: "Optional description / the next work to do." }
          },
          required: ["card_id"]
        }
      },
      {
        name: "poll_origin_events",
        description:
          "Poll the lifecycle + duty-summary events for a run ORIGIN (skill/terminal parity with a web thread's push feed): created | needs-input | blocked | failed | finished | duty-summary | steering. Pass the origin_id you stamped on the card (e.g. 'skill:<run id>'); poll again with the returned next_since to see only new events. This is the PULL delivery for a session with no push surface.",
        inputSchema: {
          type: "object",
          properties: {
            origin_id: { type: "string", description: "The origin id stamped on the card(s) (e.g. 'skill:<run id>' or 'board')." },
            since: { type: "string", description: "Optional: the previous next_since (a line offset) or an ISO timestamp - only newer events are returned." }
          },
          required: ["origin_id"]
        }
      },
      // Card scheduling (Omi reminder round-trip): the board's reminders say
      // exactly "run card <REF>" / "snooze card <REF> for 2 hours" - these
      // tools make those phrases executable from any session.
      {
        name: "schedule_card",
        description:
          "Schedule, snooze, or un-schedule a kanban card by spoken ref - the executable form of 'snooze card 7Q2M for 2 hours'. Resolves the ref (full ULID, ULID suffix >= 3 chars such as the 4-char short ref in a reminder, or a title fragment), then sets scheduledFor via until or in_minutes (exactly one) and re-arms the reminder; clear=true removes the schedule instead. An ambiguous ref returns the candidate list - relay it and ask the user, never guess.",
        inputSchema: {
          type: "object",
          properties: {
            card: { type: "string", description: "Card ref: full ULID, ULID suffix (>= 3 chars, e.g. the short ref '7Q2M' from a reminder), or a title fragment." },
            until: { type: "string", description: "ISO date-time to schedule for (pass exactly one of until / in_minutes)." },
            in_minutes: { type: "number", description: "Relative schedule: minutes from now (pass exactly one of until / in_minutes)." },
            cron: { type: "string", description: "Five-field cron for a recurring Scheduled template (exclusive with until/in_minutes)." },
            timezone: { type: "string", description: "IANA timezone for cron schedules (default Europe/Lisbon)." },
            target_list: { type: "string", description: "List the one-shot or each recurring occurrence enters when due." },
            action: { type: "string", enum: ["notify", "run"], description: "What happens at the scheduled instant: notify the user (default) or auto-run the card." },
            clear: { type: "boolean", description: "true = clear the card's schedule instead of setting one." },
            pause: { type: "boolean", description: "Pause an existing schedule without deleting it." },
            resume: { type: "boolean", description: "Resume an existing schedule." }
          },
          required: ["card"]
        }
      },
      {
        name: "run_card",
        description:
          "Start or advance a kanban card NOW by spoken ref - the executable form of 'run card 7Q2M'. Resolves the ref, then starts the card (a manual-list card advances to its next list; an agent-list card dispatches through the engine); any schedule on the card is cleared by the start itself. An ambiguous ref returns the candidate list - relay it and ask the user, never guess.",
        inputSchema: {
          type: "object",
          properties: {
            card: { type: "string", description: "Card ref: full ULID, ULID suffix (>= 3 chars, e.g. the short ref '7Q2M' from a reminder), or a title fragment." }
          },
          required: ["card"]
        }
      },
      {
        name: "list_scheduled_cards",
        description:
          "List every kanban card holding a schedule as a compact table: short ref (last 4 of the id - the ref reminders speak), title, scheduled instant, action (notify|run), list. Use to answer 'what is scheduled?' before schedule_card / run_card.",
        inputSchema: { type: "object", properties: {} }
      }
    );
  }

  // Improver Probe capture-fallback (GARRISON-FLOW-V2 S8, D26/E13). Always
  // available: it records straight into the state service's feedback queue, so it
  // does not depend on garrison-control (the http gateway). The PostToolUse
  // AskUserQuestion capture is the primary path; this tool is the belt for surfaces
  // that carry no PostToolUse hook. It needs GARRISON_STATE_URL/_TOKEN (or a
  // readable $GARRISON_HOME/state.json) in this process's env — an MCP server
  // started by Claude Code inherits CLAUDE's env, not a fitting's.
  tools.push({
    name: "record_improver_feedback",
    description:
      "Record one Improver Probe answer as evidence (fallback capture path). Appends a single record to the Improver feedback queue. Only for relaying a probe answer the user gave — never fabricate answers.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The Claude session id the probe was asked in." },
        area: { type: "string", description: "orchestrator | went-well (the probe area)." },
        question: { type: "string", description: "The exact question that was asked." },
        answer: { type: "string", description: "The option label the user selected (or their free-text 'Other')." }
      },
      required: ["area", "question", "answer"]
    }
  });

  // The composition's capability catalogue, on demand. The assembled
  // Orchestrator prompt can carry either every provider's full for_consumers
  // block (28k+ tokens on EVERY stretch, whether it consults them or not) or a
  // one-line index plus this tool. Same text either way - the sidecar is
  // written from the same entries at the same moment the prompt is assembled.
  if (capabilityDocsPath()) {
    tools.push({
      name: "garrison_capability_doc",
      description:
        "Read one installed capability's provider-authored usage guidance. The Orchestrator prompt lists every capability as `kind:name`; pass that, or a fitting id. Call it before using a capability whose interface you would otherwise be guessing at. Omit `capability` to list what has guidance.",
      inputSchema: {
        type: "object",
        properties: {
          capability: {
            type: "string",
            description: "`kind:name` as printed in the capabilities list, or a fitting id. Omit to list the available keys."
          }
        }
      }
    });
  }

  // Layer 3, as an interface rather than a hint. The brief used to say "grep
  // log.jsonl when you need history"; a stretch with no shell in its tool
  // profile cannot, nothing counted whether any stretch ever did, and the file
  // interleaves every event kind with spilled pointers. These read through the
  // gateway, which is what makes each call a recorded `layer3-access` event.
  if (gatewayBaseUrl()) {
    tools.push({
      name: "garrison_conversation_search",
      description:
        "Search this conversation's full record (layer 3) for what actually happened, when the handoff summary you were given is too thin. Filters: q (substring), kind (user-message | session-event | handoff | stretch-started | stretch-ended | usage), duty, stretch. Returns POINTERS with a short preview - fetch the ones you need with garrison_conversation_fetch.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "Substring to match anywhere in the record." },
          kind: { type: "string", description: "Restrict to one event kind." },
          duty: { type: "string", description: "Restrict to one duty." },
          stretch: { type: "string", description: "Restrict to one stretch id." },
          limit: { type: "number", description: "Most recent N matches (default 40, max 200)." },
          conversation: { type: "string", description: "Another conversation's id. Defaults to your own." }
        }
      }
    });
    tools.push({
      name: "garrison_conversation_fetch",
      description:
        "Read from this conversation's full record. `seq` returns one record whole. `digest` returns the conversation as prose plus one line per tool call (name, arguments, a one-line synopsis of the result and its size) and NEVER tool result bodies - that is the cheap way to see what happened across earlier stretches. Use `stretches` to bound the digest to the last N.",
      inputSchema: {
        type: "object",
        properties: {
          seq: { type: "number", description: "Ledger sequence of one record, as returned by search." },
          digest: { type: "boolean", description: "Return the conversation digest instead of a single record." },
          stretches: { type: "number", description: "Digest only: the last N stretches." },
          maxChars: { type: "number", description: "Cap on the returned text." },
          conversation: { type: "string", description: "Another conversation's id. Defaults to your own." }
        }
      }
    });
  }

  // The findings record. A stretch calls this AS IT WORKS, not at the end -
  // the whole point is that nothing has to be reconstructed from a transcript.
  if (gatewayBaseUrl()) {
    tools.push({
      name: "garrison_finding_add",
      description:
        "Record one thing you have ESTABLISHED, as you establish it. This is what the next stretch " +
        "will see instead of re-discovering it, so write it the moment it is true rather than at the " +
        "end. One line, pointers not content: \"mintKey lives in src/lib/identity.js and returns a " +
        "sortable id\" is a finding; pasting identity.js is not, and will be rejected. " +
        "kind=fact for something you verified about the code, change for something you altered " +
        "(both REQUIRE anchorPath, the file the claim is about); decision for a choice you made, " +
        "rejected for an approach you ruled out and why, failure for something that did not work " +
        "(these three take NO anchor). Put ledger addresses, file paths, symbol names and commit " +
        "SHAs in pointers so anything you leave out can still be found.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["fact", "decision", "rejected", "change", "failure"],
            description: "fact | change require anchorPath; decision | rejected | failure take none." },
          claim: { type: "string", description: "One line, at most 200 characters, what was established. No code." },
          pointers: { type: "array", items: { type: "string" },
            description: "Where to look: file paths, symbol names, commit SHAs, ledger addresses like <conversationId>#<seq>." },
          anchorPath: { type: "string", description: "For fact and change: the file this claim is about, so staleness can be detected later." },
          anchorCommit: { type: "string", description: "Alternative anchor for a claim about a commit rather than a working file." },
        },
        required: ["kind", "claim"],
      },
    });
  }

  // A caller may narrow the advertised inventory: every tool schema is paid for
  // in the boot prefix of every session the server is attached to, and a duty
  // that will never call schedule_card should not carry its 997 tokens.
  const allow = String(process.env.GARRISON_MCP_TOOLS ?? "").trim();
  if (allow) {
    const wanted = new Set(allow.split(/[,\s]+/).filter(Boolean));
    return tools.filter((t) => wanted.has(t.name));
  }
  return tools;
}

// ─────────────────────────────────────────── tool dispatcher
function capabilityDocsPath() {
  const dir = String(process.env.GARRISON_COMPOSITION_DIR ?? "").trim();
  if (!dir) return null;
  const p = nodePath.join(dir, ".garrison", "capability-docs.json");
  return nodeFs.existsSync(p) ? p : null;
}

function callCapabilityDoc(input) {
  const p = capabilityDocsPath();
  if (!p) return { error: "no capability-docs.json for this composition" };
  const docs = JSON.parse(nodeFs.readFileSync(p, "utf8"));
  const key = typeof input?.capability === "string" ? input.capability.trim() : "";
  if (!key) return { capabilities: Object.keys(docs).sort() };
  const hit = docs[key];
  if (!hit) {
    return {
      error: `no guidance for "${key}"`,
      capabilities: Object.keys(docs).sort()
    };
  }
  return { capability: key, summary: hit.summary, guidance: hit.guidance };
}

function gatewayBaseUrl() {
  return String(process.env.GARRISON_HTTP_GATEWAY_BASE_URL ?? "").trim().replace(/\/+$/, "");
}

function currentConversationId(input) {
  const named = typeof input?.conversation === "string" ? input.conversation.trim() : "";
  return named || String(process.env.GARRISON_CONVERSATION_ID ?? "").trim();
}

async function callLayer3(op, input) {
  const base = gatewayBaseUrl();
  const id = currentConversationId(input);
  if (!base) return { error: "no gateway base url in this session's environment" };
  if (!id) {
    return { error: "no conversation in scope - pass `conversation` with the id from your brief's first line" };
  }
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(input ?? {})) {
    if (k === "conversation" || v === undefined || v === null) continue;
    params.set(k === "q" ? "q" : k, String(v));
  }
  const url = `${base}/conversation/${encodeURIComponent(id)}/${op}?${params.toString()}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) return { error: `layer 3 ${op} failed: http ${res.status} ${text.slice(0, 200)}` };
  try { return JSON.parse(text); } catch { return { error: "unparseable layer 3 response" }; }
}

async function callFindingAdd(input) {
  const base = gatewayBaseUrl();
  const id = currentConversationId(input);
  if (!base) return { error: "no gateway base url in this session's environment" };
  if (!id) return { error: "no conversation in scope - pass `conversation` with the id from your brief's first line" };
  const res = await fetch(`${base}/conversation/${encodeURIComponent(id)}/finding`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, cwd: process.env.GARRISON_STRETCH_CWD || undefined }),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: `finding_add: http ${res.status} ${text.slice(0, 200)}` }; }
}

async function dispatchTool(name, input) {
  if (name === "garrison_capability_doc") return callCapabilityDoc(input);
  if (name === "garrison_finding_add") return callFindingAdd(input);
  if (name === "garrison_conversation_search") return callLayer3("search", input);
  if (name === "garrison_conversation_fetch") {
    return callLayer3(input?.digest ? "digest" : "record", { ...input, digest: undefined });
  }
  if (name === "classify_tier") return callClassifyTier(input);
  if (name === "run_tests") return callRunTests(input);
  if (name === "record_improver_feedback") return callRecordImproverFeedback(input);
  if (name === "list_automations") return callListAutomations(input);
  if (name === "run_automation") return callRunAutomation(input);
  if (name === "fetch_evidence") return callFetchEvidence(input);
  if (name === "create_continuation") return callCreateContinuation(input);
  if (name === "poll_origin_events") return callPollOriginEvents(input);
  if (name === "schedule_card") return callScheduleCard(input);
  if (name === "run_card") return callRunCard(input);
  if (name === "list_scheduled_cards") return callListScheduledCards(input);
  throw new Error(`unknown tool: ${name}`);
}

// ─────────────────────────────────────────── MCP server builder
async function buildServer(tools) {
  const server = new Server(
    { name: "garrison-mcp-gateway", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await dispatchTool(name, args ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true
      };
    }
  });

  return server;
}

// ─────────────────────────────────────────── subcommand: --probe
async function runProbe({ strict = false } = {}) {
  const [tierOk, testingOk] = await Promise.all([
    checkProbe("tier-classifier", "classify_tier.mjs"),
    checkProbe("testing", "run_tests.mjs"),
  ]);

  if (strict) {
    if (!tierOk || !testingOk) {
      const missing = [
        tierOk ? null : "classify_tier",
        testingOk ? null : "run_tests"
      ].filter(Boolean).join(", ");
      process.stderr.write(
        `mcp-gateway --probe --strict: missing underlying probe(s): ${missing}\n`
      );
      return 1;
    }
    process.stdout.write("ok (strict; classify_tier=ready, run_tests=ready)\n");
    return 0;
  }

  // Lenient default: succeed even if no tools are available yet — gateway
  // itself is healthy. See docs/DECISIONS.md (2026-05-16
  // "`mcp-gateway --probe` stays lenient by default; `--strict` opt-in").
  process.stdout.write(
    `ok (classify_tier=${tierOk ? "ready" : "absent"}, run_tests=${testingOk ? "ready" : "absent"})\n`
  );
  return 0;
}

// ─────────────────────────────────────────── subcommand: stdio
async function runStdio() {
  const tools = await discoverTools();
  const server = await buildServer(tools);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep process alive — stdio transport manages its own lifecycle
}

// ─────────────────────────────────────────── subcommand: http
async function runHttp(argv) {
  const flags = parseFlags(argv);
  const port = Number(flags.port ?? 29876);
  const token = flags.token ?? "";
  const host = flags.host ?? "0.0.0.0";

  if (!token) {
    process.stderr.write("mcp-gateway: --token is required for HTTP mode\n");
    return 1;
  }

  const tools = await discoverTools();
  const server = await buildServer(tools);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
  });

  await server.connect(transport);

  const httpServer = createServer(async (req, res) => {
    // Bearer token auth
    const authHeader = req.headers["authorization"] ?? "";
    if (authHeader !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // Health endpoint
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, tools: tools.map(t => t.name) }));
      return;
    }

    // Collect body for POST
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    try {
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });

  httpServer.listen(port, host, () => {
    process.stdout.write(
      JSON.stringify({ ts: new Date().toISOString(), status: "listening", host, port, tools: tools.map(t => t.name) }) + "\n"
    );
  });

  // Keep alive
  return new Promise(() => { /* never resolves — HTTP server runs until killed */ });
}

// ─────────────────────────────────────────── CLI
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[key] = next; i++; }
      else { out[key] = true; }
    }
  }
  return out;
}

async function main(argv) {
  const cmd = argv[0];

  if (cmd === "--probe") {
    const strict = argv.slice(1).includes("--strict");
    return runProbe({ strict });
  }
  if (cmd === "stdio") return runStdio();
  if (cmd === "http") return runHttp(argv.slice(1));

  process.stderr.write(`mcp-gateway: unknown command "${cmd}". Use: --probe [--strict] | stdio | http\n`);
  return 1;
}

main(process.argv.slice(2)).then((code) => {
  if (typeof code === "number") process.exit(code);
}).catch((err) => {
  process.stderr.write(`mcp-gateway: ${err.message}\n`);
  process.exit(1);
});
