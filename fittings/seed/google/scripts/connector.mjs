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
//
// NOT BUFFERED — gmail.send goes out the moment it is called. Slack and
// whatsapp-web park an agent-triggered send for a 60-second cancel window (see
// fittings/seed/whatsapp-web/lib/outbox.mjs), which is what lets an autonomy
// band treat an outbound message as revertible-in-practice. This Fitting cannot
// do that: it is this CLI plus setup.sh, with no long-lived process anywhere,
// and a process that exits in milliseconds cannot hold a 60-second timer or
// answer a cancel. Buffering gmail.send needs one of two things first — an
// own-port google daemon, or the buffer moved up into whatever shared executor
// invokes connectors — and until then gmail.send stays genuinely irreversible
// and must be treated as ask-first, never act-and-inform.

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
    {
      name: "calendar.create_event",
      args: ["summary", "start", "end", "calendar_id", "description", "private_properties"],
      mutates: true,
      description: "Create a calendar event."
    },
    {
      name: "calendar.update_event",
      args: ["event_id", "summary", "start", "end", "calendar_id", "description", "private_properties"],
      mutates: true,
      description: "Patch an existing calendar event. Only the fields supplied are changed."
    },
    {
      name: "calendar.delete_event",
      args: ["event_id", "calendar_id"],
      mutates: true,
      description: "Delete a calendar event. Deleting an already-absent event succeeds."
    },
    {
      name: "calendar.list_events",
      args: ["calendar_id", "time_min", "time_max", "max", "updated_min", "private_extended_property", "show_deleted", "page_token"],
      mutates: false,
      description: "List calendar events. Returns each event's `updated` stamp, private extended properties and a nextPageToken (pass it back as page_token), so a caller can sync against the FULL listing."
    }
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
  // Calendar's delete returns 204 with an empty body, so it cannot go through
  // `call` (res.json() on no body throws). 410 Gone means the event was already
  // deleted — the caller asked for it to be absent and it is, so that is a
  // success, not an error. Making delete idempotent is what lets a sync retry
  // safely after a crash between the API call and persisting the receipt.
  const callNoBody = async (url, opts = {}) => {
    const res = await fetchImpl(url, { ...opts, headers: { ...authHeader, ...(opts.headers ?? {}) } });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`google ${res.status}: ${await res.text()}`);
    }
    return { deleted: true, alreadyAbsent: res.status === 404 || res.status === 410 };
  };
  // Google rejects an unknown/null field in an event body, so only the keys the
  // caller actually supplied are sent. That is also what makes update_event a
  // genuine PATCH: omitting `summary` leaves the remote summary alone rather
  // than blanking it.
  const eventBody = (a) => ({
    ...(a.summary !== undefined ? { summary: a.summary } : {}),
    ...(a.description !== undefined ? { description: a.description } : {}),
    ...(a.start !== undefined ? { start: { dateTime: a.start } } : {}),
    ...(a.end !== undefined ? { end: { dateTime: a.end } } : {}),
    ...(a.private_properties && typeof a.private_properties === "object"
      ? { extendedProperties: { private: a.private_properties } }
      : {})
  });
  const EVENT_FIELDS = "id,status,summary,description,updated,start,end,extendedProperties,htmlLink";
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
      const params = new URLSearchParams({ fields: EVENT_FIELDS });
      return call(`https://www.googleapis.com/calendar/v3/calendars/${calId}/events?${params}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(eventBody(args))
      });
    }
    case "calendar.update_event": {
      if (!args.event_id) throw new Error("calendar.update_event requires event_id");
      const calId = encodeURIComponent(args.calendar_id ?? "primary");
      const params = new URLSearchParams({ fields: EVENT_FIELDS });
      return call(
        `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${encodeURIComponent(args.event_id)}?${params}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(eventBody(args))
        }
      );
    }
    case "calendar.delete_event": {
      if (!args.event_id) throw new Error("calendar.delete_event requires event_id");
      const calId = encodeURIComponent(args.calendar_id ?? "primary");
      return callNoBody(
        `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${encodeURIComponent(args.event_id)}`,
        { method: "DELETE" }
      );
    }
    case "calendar.list_events": {
      const calId = encodeURIComponent(args.calendar_id ?? "primary");
      const params = new URLSearchParams();
      params.set("timeMin", args.time_min ?? new Date(0).toISOString());
      if (args.time_max) params.set("timeMax", args.time_max);
      if (args.updated_min) params.set("updatedMin", args.updated_min);
      // Repeatable parameter: each entry is a literal "key=value" match against
      // the event's private extended properties. This is how a caller finds the
      // events it owns without scanning the whole calendar.
      const props = args.private_extended_property;
      for (const prop of Array.isArray(props) ? props : props ? [props] : []) {
        params.append("privateExtendedProperty", String(prop));
      }
      params.set("maxResults", String(args.max ?? 10));
      params.set("singleEvents", "true");
      if (args.show_deleted) params.set("showDeleted", "true");
      // Pagination: the fields mask already requests nextPageToken; without
      // accepting the token back, a caller could only ever read page one — and
      // a SYNC reading a truncated listing treats every event past the cut as
      // deleted. The board's calendar sync loops on this until exhausted.
      if (args.page_token) params.set("pageToken", String(args.page_token));
      // orderBy=startTime is invalid alongside updatedMin's incremental
      // semantics, and showDeleted only makes sense unordered — in both cases
      // the caller is syncing, not reading a chronological agenda.
      if (!args.updated_min && !args.show_deleted) params.set("orderBy", "startTime");
      params.set("fields", `nextPageToken,items(${EVENT_FIELDS})`);
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
