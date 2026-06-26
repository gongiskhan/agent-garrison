#!/usr/bin/env node
// Google Workspace connector — uniform Garrison connector executor contract:
//   node connector.mjs --probe                   -> "connectorOk" (verify; no secrets)
//   node connector.mjs catalog                   -> JSON { service, auth, actions[] }
//   node connector.mjs call <action> [argsJson]  -> JSON { ok, result } | { ok:false, error, awaiting_connector }
//
// Auth is OAuth2: the Automations engine resolves a FRESH access token from the
// keychain Vault (vault.getAccessToken("google"), auto-refreshing) and injects it
// as GOOGLE_ACCESS_TOKEN into this call's env. The token never touches the
// manifest or the logs (it is redacted). This is the Vault-sealed credential
// story end to end — no plaintext token.json on disk.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CATALOG = {
  service: "google",
  auth: "oauth2",
  actions: [
    {
      name: "gmail.send",
      args: ["to", "subject", "body", "cc", "attachments"],
      mutates: true,
      description: "Send an email (optionally with attachments) via Gmail."
    },
    { name: "drive.list", args: ["query", "page_size"], mutates: false, description: "List Drive files (most-recently-modified first)." },
    { name: "calendar.create_event", args: ["summary", "start", "end", "calendar_id"], mutates: true, description: "Create a calendar event." },
    { name: "calendar.list_events", args: ["calendar_id", "time_min", "max"], mutates: false, description: "List upcoming calendar events." }
  ]
};

class NotConnectedError extends Error {
  constructor(message) {
    super(message);
    this.awaiting_connector = true;
  }
}

function token(env) {
  const t = env.GOOGLE_ACCESS_TOKEN;
  if (!t) throw new NotConnectedError("Google not connected (connect via OAuth so the Vault holds a grant)");
  return t;
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Strip CR/LF from a header-derived value to prevent RFC822 header injection
// (a `to`/`cc`/`subject` containing a newline could inject arbitrary headers or
// a second message). Header values are single-line by definition.
function header(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

// Build an RFC822 message (multipart/mixed when there are attachments). An
// attachment is { filename, mime_type?, content_base64 } or { filename, path }.
function buildMime({ to, subject, body, cc, attachments }) {
  const cleanTo = header(to);
  const cleanCc = cc ? header(cc) : "";
  const cleanSubject = header(subject);
  if (!attachments || attachments.length === 0) {
    const lines = [`To: ${cleanTo}`, cleanCc ? `Cc: ${cleanCc}` : null, `Subject: ${cleanSubject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", body ?? ""].filter((l) => l !== null);
    return lines.join("\r\n");
  }
  const boundary = "garrison_boundary_0xCAFE";
  const parts = [];
  parts.push(`To: ${cleanTo}`);
  if (cleanCc) parts.push(`Cc: ${cleanCc}`);
  parts.push(`Subject: ${cleanSubject}`);
  parts.push("MIME-Version: 1.0");
  parts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  parts.push("");
  parts.push(`--${boundary}`);
  parts.push("Content-Type: text/plain; charset=UTF-8");
  parts.push("");
  parts.push(body ?? "");
  for (const att of attachments) {
    const data = att.content_base64 ?? Buffer.from(readFileSync(att.path)).toString("base64");
    const filename = header(att.filename).replace(/"/g, "");
    const mimeType = header(att.mime_type ?? "application/octet-stream");
    parts.push(`--${boundary}`);
    parts.push(`Content-Type: ${mimeType}; name="${filename}"`);
    parts.push("Content-Transfer-Encoding: base64");
    parts.push(`Content-Disposition: attachment; filename="${filename}"`);
    parts.push("");
    // base64 body, wrapped at 76 cols per RFC
    parts.push(data.replace(/(.{76})/g, "$1\r\n"));
  }
  parts.push(`--${boundary}--`);
  return parts.join("\r\n");
}

export async function runAction({ action, args = {}, env = process.env, fetchImpl = fetch }) {
  const access = token(env);
  const authHeader = { Authorization: `Bearer ${access}` };
  const call = async (url, opts = {}) => {
    const res = await fetchImpl(url, { ...opts, headers: { ...authHeader, ...(opts.headers ?? {}) } });
    if (!res.ok) throw new Error(`google ${res.status}: ${await res.text()}`);
    return res.json();
  };
  switch (action) {
    case "gmail.send": {
      const raw = base64url(buildMime(args));
      return call("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw })
      });
    }
    case "drive.list": {
      const params = new URLSearchParams();
      if (args.query) params.set("q", args.query);
      params.set("orderBy", "modifiedTime desc");
      params.set("pageSize", String(args.page_size ?? 20));
      params.set("fields", "files(id,name,mimeType,modifiedTime,webViewLink)");
      return call(`https://www.googleapis.com/drive/v3/files?${params}`);
    }
    case "calendar.create_event": {
      const calId = encodeURIComponent(args.calendar_id ?? "primary");
      return call(`https://www.googleapis.com/calendar/v3/calendars/${calId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          summary: args.summary,
          start: { dateTime: args.start },
          end: { dateTime: args.end }
        })
      });
    }
    case "calendar.list_events": {
      const calId = encodeURIComponent(args.calendar_id ?? "primary");
      const params = new URLSearchParams();
      params.set("timeMin", args.time_min ?? new Date(0).toISOString());
      params.set("maxResults", String(args.max ?? 10));
      params.set("singleEvents", "true");
      params.set("orderBy", "startTime");
      return call(`https://www.googleapis.com/calendar/v3/calendars/${calId}/events?${params}`);
    }
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === "--probe") {
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
      try { args = JSON.parse(argv[2]); }
      catch { console.error("args must be JSON"); return 2; }
    }
    try {
      const result = await runAction({ action, args });
      process.stdout.write(JSON.stringify({ ok: true, result }));
      return 0;
    } catch (err) {
      process.stdout.write(JSON.stringify({ ok: false, error: err.message, awaiting_connector: Boolean(err.awaiting_connector) }));
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
    (err) => { console.error(err.stack ?? err.message); process.exit(1); }
  );
}
