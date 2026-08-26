// Live drive of the EXEC lane through the RuntimeAdapter the gateway loads.
//
// Not the fitting's HTTP surface (proven separately) but the adapter itself:
// spawn -> sendTurn -> awaitResponse, exactly as runSecondaryTurn drives it, so
// what passes here is what a routing target gets. Two turns, because
// CONTINUITY is the half a one-shot probe never catches: the second must land
// in the same Cursor chat as the first.
import path from "node:path";
import os from "node:os";

const COMPOSITION = process.env.COMPOSITION ?? "default";
const installed = path.join(
  process.env.GARRISON_REPO ?? path.join(os.homedir(), "dev", "garrison"),
  "compositions", COMPOSITION, "apm_modules", "_local", "remote-shell-runtime",
  "lib", "remote-shell-adapter.mjs"
);
const { RemoteShellAdapter } = await import(installed);

const TARGET = process.env.TARGET ?? "csg:gpt-5.3-codex-low";
const CWD = process.env.REMOTE_CWD ?? "~/dev/csg-spec";
const out = [];
const note = (k, v) => { out.push([k, v]); console.log(String(k).padEnd(26), "=", JSON.stringify(v)); };

const adapter = new RemoteShellAdapter();
note("adapterFrom", installed.includes("apm_modules") ? "installed fitting (what the gateway loads)" : installed);

// Turn one: a fact only this conversation will know.
const s1 = await adapter.spawn({ model: TARGET, remoteCwd: CWD });
note("lane", s1.lane);
await adapter.awaitReady(s1);
await adapter.sendTurn(s1, "Remember the word MERIDIAN. Reply with exactly: STORED");
const chunks = [];
const r1 = await adapter.awaitResponse(s1, { onChunk: (text) => chunks.push(text) });
note("firstReply", r1.text.trim());
note("streamedProgress", chunks.length > 0);
note("streamIsReplaceNotAppend", chunks.length < 2 || chunks[chunks.length - 1].startsWith(chunks[0]));
note("usageReported", Boolean(s1.usage?.inputTokens));
note("chatIdMinted", Boolean(s1.chatId));
await adapter.teardown(s1);

// Turn two: a FRESH spawn, as the gateway does for every delegated turn. The
// adapter's own memory of the last chat is what makes this a conversation.
const s2 = await adapter.spawn({ model: TARGET, remoteCwd: CWD });
note("resumesSameChat", s2.chatId === s1.chatId);
await adapter.sendTurn(s2, "What word did I ask you to remember? Reply with just the word.");
const r2 = await adapter.awaitResponse(s2);
note("secondReply", r2.text.trim());
note("continuityHeld", /MERIDIAN/i.test(r2.text));
await adapter.teardown(s2);

const failures = out.filter(([, v]) => v === false);
console.log(failures.length ? `\nFAILED: ${failures.map(([k]) => k).join(", ")}` : "\nALL CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
