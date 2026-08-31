// CLI for the email channel. `--probe` is the read-only verify hook: it proves
// the modules link (a real `node` child process is the only honest link check
// for .mjs), the config parses, and the pure mapping works - then prints the
// sentinel. It runs in the COMPOSITION dir with an empty vault and no daemon,
// so it must touch no network and no state.

import { loadConfig } from "../lib/config.mjs";
import { buildCardPayload, parseSenderList, senderAllowed } from "../lib/ingest.mjs";
import { MailTm } from "../lib/mailtm.mjs";
import { BoardClient } from "../lib/board-client.mjs";
import { ChannelState } from "../lib/state.mjs";

function probe() {
  const cfg = loadConfig({ GARRISON_HOME: "/tmp/email-channel-probe" });
  if (!Number.isInteger(cfg.port) || cfg.enabled !== false) {
    throw new Error(`unexpected default config: ${JSON.stringify(cfg)}`);
  }
  const allowed = parseSenderList("a@b.c, D@E.F");
  if (!senderAllowed("d@e.f", allowed) || senderAllowed("x@y.z", allowed)) {
    throw new Error("sender allow-list logic failed");
  }
  const { payload } = buildCardPayload(
    {
      id: "probe1",
      msgid: "<probe@local>",
      from: { address: "a@b.c", name: "Probe" },
      subject: "Probe subject",
      text: "Probe body",
      attachments: [],
      createdAt: "2026-01-01T00:00:00+00:00"
    },
    { inboxAddress: "inbox@example.test", targetList: cfg.targetList, defaultProject: cfg.defaultProject }
  );
  if (payload.title !== "Probe subject" || payload.origin_id !== "email:probe1") {
    throw new Error(`unexpected card payload: ${JSON.stringify(payload)}`);
  }
  // Constructors link (no IO).
  void new MailTm();
  void new BoardClient({ baseUrl: "http://127.0.0.1:1" });
  void new ChannelState(cfg.stateDir);
  console.log("EMAIL-OK");
}

const arg = process.argv[2] ?? "";
if (arg === "--probe") {
  try {
    probe();
  } catch (err) {
    console.error(`email-channel probe failed: ${err?.stack || err}`);
    process.exit(1);
  }
} else {
  console.error("usage: email.mjs --probe");
  process.exit(2);
}
