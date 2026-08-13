#!/usr/bin/env node
// whatsapp-web connector — the uniform Garrison connector executor contract
// (see fittings/seed/whatsapp/scripts/connector.mjs for the reference shape
// every connector Fitting implements):
//
//   node connector.mjs --probe                    -> "connectorOk" (verify; no daemon required)
//   node connector.mjs catalog                    -> JSON { service, auth, actions[] }
//   node connector.mjs call <action> [argsJson]   -> JSON { ok, result }
//                                                    | { ok:false, error, awaiting_connector }
//
// Unlike a stateless HTTP connector (whatsapp, slack), whatsapp-web's real
// work happens in a long-lived own-port daemon (scripts/server.mjs) that owns
// the Baileys WebSocket session. This CLI is a thin, stateless client: it
// discovers the running daemon via its status file
// (~/.garrison/ui-fittings/whatsapp-web.json, same discovery pattern every
// own-port Fitting uses) and proxies each call over loopback HTTP. It never
// opens a Baileys socket itself.
//
// send_text is gated at THREE independent points, all enforced here in code
// (not just documented):
//   1. `to` must be an exact WhatsApp JID (see lib/jid.mjs) — a bare name is
//      rejected outright. Get a jid from resolve_contact + a human's
//      confirmation first.
//   2. A caller running inside the Automations engine is refused outright,
//      unconditionally, before any HTTP call happens — see the
//      GARRISON_AUTOMATION_ENGINE check below. Only a direct call (the
//      Operative acting on an explicit, live request) can reach /send.
//   3. An agent-triggered send does not go out now: it is parked in the
//      daemon's outbox for a cancel window (../lib/outbox.mjs) and only sent
//      when that window elapses uncancelled. A human acting in a UI bypasses
//      the buffer; nothing else does.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertValidJid } from "../lib/jid.mjs";
import { resolveSendContext } from "../lib/outbox.mjs";

export const CATALOG = {
  service: "whatsapp-web",
  auth: "none",
  actions: [
    {
      name: "resolve_contact",
      args: ["name"],
      mutates: false,
      description: "Look up WhatsApp chats/contacts by name; returns a LIST of {name, jid} candidates, never a single guess."
    },
    {
      name: "list_contacts",
      args: ["n"],
      mutates: false,
      description:
        "List known WhatsApp contacts/chats (name + jid), alphabetical, up to n (default 500). Use it to browse who is reachable; still confirm with the human before send_text."
    },
    {
      name: "send_text",
      args: ["to", "body"],
      mutates: true,
      description:
        "Send one text message. `to` must be an exact, already-confirmed WhatsApp JID (from resolve_contact). Not reachable from the Automations engine. An agent-triggered call parks the message for a 60s cancel window and returns {queued:true, executeAt} — it has not been sent yet."
    },
    {
      name: "recent_messages",
      args: ["n"],
      mutates: false,
      description: "The n most recent stored messages across all chats (default 20), newest first."
    },
    {
      name: "last_message",
      args: ["chat"],
      mutates: false,
      description: "The most recent stored message for one chat (exact jid or a resolvable name)."
    }
  ]
};

class NotConnectedError extends Error {
  constructor(message) {
    super(message);
    this.awaiting_connector = true;
  }
}

// The daemon's status file is this Fitting's ONLY discovery mechanism — the
// same contract every own-port Fitting uses (see src/lib/own-port-lifecycle.ts
// and e.g. browser-default/scripts/cli.mjs). WHATSAPP_WEB_STATUS_FILE is a
// test-only override so tests never touch the real ~/.garrison directory.
function statusFilePath(env) {
  if (env.WHATSAPP_WEB_STATUS_FILE) return env.WHATSAPP_WEB_STATUS_FILE;
  const home = env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
  return path.join(home, "ui-fittings", "whatsapp-web.json");
}

function daemonBaseUrl(env) {
  const file = statusFilePath(env);
  if (!existsSync(file)) {
    throw new NotConnectedError(
      "whatsapp-web daemon is not running. Start it from the Views sidebar (or pair the account first — see instructions.md)."
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new NotConnectedError(`whatsapp-web status file unreadable: ${err.message}`);
  }
  if (!parsed || typeof parsed.url !== "string") {
    throw new NotConnectedError("whatsapp-web status file is missing a url");
  }
  return parsed.url.replace(/\/+$/, "");
}

async function daemonCall(env, fetchImpl, method, pathAndQuery, body) {
  const base = daemonBaseUrl(env);
  const res = await fetchImpl(`${base}${pathAndQuery}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`whatsapp-web daemon returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = new Error(json.error || `whatsapp-web daemon ${res.status}`);
    if (json.awaiting_connector) err.awaiting_connector = true;
    throw err;
  }
  return json;
}

export async function runAction({ action, args = {}, env = process.env, fetchImpl = fetch }) {
  switch (action) {
    case "resolve_contact": {
      const name = encodeURIComponent(String(args.name ?? ""));
      const result = await daemonCall(env, fetchImpl, "GET", `/resolve?name=${name}`);
      return result.candidates;
    }
    case "list_contacts": {
      const n = Number.isFinite(Number(args.n)) ? Number(args.n) : 500;
      const result = await daemonCall(env, fetchImpl, "GET", `/contacts?n=${encodeURIComponent(n)}`);
      return result.contacts;
    }
    case "send_text": {
      // Gate 1: unattended-run refusal. The Automations engine marks every
      // connector.mjs child it spawns with this env var (see
      // fittings/seed/automations/lib/engine.mjs defaultRunConnector) — it is
      // present precisely when this call did NOT originate from a live,
      // attended conversation with the user. Checked before ANYTHING else,
      // including argument validation, so there is no code path from a
      // scheduled/automated run to a real send.
      if (env.GARRISON_AUTOMATION_ENGINE) {
        throw new Error(
          "send_text is not reachable from the Automations engine — only a direct call in a live conversation with the user may send a WhatsApp message."
        );
      }
      // Gate 2: exact-jid-only. Never fuzzy-matches, never guesses.
      assertValidJid(args.to);
      // Gate 3: the delay buffer. A send an AGENT triggered is parked for a
      // cancel window instead of going out now (../lib/outbox.mjs); the daemon
      // owns the timer and the drain, because this CLI exits in milliseconds.
      // Only a human acting in a UI sends immediately, and only because that
      // UI's process marked the env — never because a caller typed a flag.
      const context = resolveSendContext(env);
      if (context !== "human") {
        const queued = await daemonCall(env, fetchImpl, "POST", "/outbox", {
          action: "send_text",
          payload: { jid: args.to, body: args.body },
          summary: `WhatsApp to ${args.to}`,
          context
        });
        return {
          sent: false,
          queued: true,
          id: queued.id,
          executeAt: queued.executeAt,
          message: `NOT SENT YET. This WhatsApp message to ${args.to} is parked and goes out at ${queued.executeAt} (${queued.delaySeconds}s cancel window) unless it is cancelled before then.`,
          cancelHint: queued.cancelHint
        };
      }
      const result = await daemonCall(env, fetchImpl, "POST", "/send", { jid: args.to, body: args.body });
      return { id: result.id ?? null };
    }
    case "recent_messages": {
      const n = Number.isFinite(Number(args.n)) ? Number(args.n) : 20;
      const result = await daemonCall(env, fetchImpl, "GET", `/recent?n=${encodeURIComponent(n)}`);
      return result.messages;
    }
    case "last_message": {
      const chat = encodeURIComponent(String(args.chat ?? ""));
      const result = await daemonCall(env, fetchImpl, "GET", `/last?chat=${chat}`);
      return result;
    }
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === "--probe") {
    // Verify must not require the daemon to be running or paired — just
    // confirm the executor + catalog, same discipline as every other
    // connector Fitting's --probe.
    if (!Array.isArray(CATALOG.actions) || CATALOG.actions.length === 0) {
      console.error("catalog empty");
      return 1;
    }
    console.log("connectorOk");
    return 0;
  }
  if (cmd === "catalog") {
    process.stdout.write(JSON.stringify(CATALOG));
    return 0;
  }
  if (cmd === "call") {
    const action = argv[1];
    let args = {};
    if (argv[2]) {
      try {
        args = JSON.parse(argv[2]);
      } catch {
        console.error("args must be JSON");
        return 2;
      }
    }
    try {
      const result = await runAction({ action, args });
      process.stdout.write(JSON.stringify({ ok: true, result }));
      return 0;
    } catch (err) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: err.message, awaiting_connector: Boolean(err.awaiting_connector) })
      );
      return 1;
    }
  }
  console.error("usage: connector.mjs --probe | catalog | call <action> [argsJson]");
  return 2;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => {
      console.error(err.stack ?? err.message);
      process.exit(1);
    }
  );
}
