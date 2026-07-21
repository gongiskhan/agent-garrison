// account-login-pty.mjs — RUNTIME-ACCOUNTS-V1 login helper. Runs a login
// command (default: `claude setup-token`) under node-pty on behalf of the
// Garrison server, which cannot host a native PTY inside the Next bundle.
//
// File protocol under --dir (one directory per login attempt):
//   status.json   written by THIS process: { state, authorizeUrl, outputTail,
//                 exitCode, error, updatedAt } — outputTail is ANSI-stripped
//                 and ALWAYS token-redacted.
//   input.txt     dropped by the server: text to type into the PTY (consumed
//                 then deleted; a trailing Enter is sent).
//   cancel        dropped by the server: kill the PTY and exit.
//   token.txt     written 0600 by THIS process the moment a long-lived token
//                 (sk-ant-oat01-…) appears in the output. The server reads it,
//                 seals it into the vault and DELETES it. Never logged.
//
// Generic mode (--mode generic --command "<cmd>") runs any runtime's native
// login command with the same surface minus token capture (D6 best-effort).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pty = require(path.join(ROOT, "node_modules", "node-pty"));

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : undefined;
}
const dir = arg("dir");
const mode = arg("mode") ?? "setup-token";
const command = arg("command");
if (!dir) {
  console.error("usage: node account-login-pty.mjs --dir <status-dir> [--mode setup-token|generic --command '<cmd>']");
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });

const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;
const ANY_TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{8,}/g;
// The full unbroken URL travels in OSC 8 hyperlink sequences; the visible text
// is wrapped across lines. Prefer OSC 8, fall back to de-wrapped plain text.
const OSC8_URL_RE = /\]8;[^;\x07\x1b]*;(https:\/\/[^\x07\x1b]+)/;
const PLAIN_URL_RE = /https:\/\/[a-z0-9.-]*claude\.(?:com|ai)\/[^\s]*authorize[^\s]*/i;

let raw = "";
let state = "starting";
let authorizeUrl = null;
let exitCode = null;
let error = null;
let tokenCaptured = false;

function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "");
}

function redact(text) {
  return text.replace(ANY_TOKEN_RE, "sk-ant-…redacted…");
}

function writeStatus() {
  const tail = redact(stripAnsi(raw)).slice(-2500);
  const status = {
    state,
    mode,
    authorizeUrl,
    outputTail: tail,
    exitCode,
    error,
    updatedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(path.join(dir, "status.json.tmp"), JSON.stringify(status));
    fs.renameSync(path.join(dir, "status.json.tmp"), path.join(dir, "status.json"));
  } catch {
    /* status writes are best-effort */
  }
}

const spawnSpec =
  mode === "generic"
    ? { file: "bash", args: ["-lc", command ?? "true"] }
    : { file: "claude", args: ["setup-token"] };

let child;
try {
  child = pty.spawn(spawnSpec.file, spawnSpec.args, {
    name: "xterm-256color",
    cols: 200,
    rows: 50,
    cwd: process.env.HOME ?? "/",
    env: process.env
  });
} catch (spawnError) {
  state = "error";
  error = `failed to start ${spawnSpec.file}: ${String(spawnError && spawnError.message)}`;
  writeStatus();
  process.exit(1);
}
state = "running";
writeStatus();

child.onData((chunk) => {
  raw += chunk;
  if (raw.length > 1_000_000) raw = raw.slice(-500_000);

  if (!authorizeUrl) {
    const osc = raw.match(OSC8_URL_RE);
    const plain = osc ? null : stripAnsi(raw).replace(/\n/g, "").match(PLAIN_URL_RE);
    const found = osc?.[1] ?? plain?.[0] ?? null;
    if (found) {
      authorizeUrl = found;
      if (state === "running") state = "awaiting-browser";
    }
  }

  if (mode !== "generic" && !tokenCaptured) {
    const token = stripAnsi(raw).match(TOKEN_RE);
    if (token) {
      tokenCaptured = true;
      try {
        fs.writeFileSync(path.join(dir, "token.txt"), token[0], { mode: 0o600 });
        state = "captured";
      } catch (writeError) {
        state = "error";
        error = `token capture write failed: ${String(writeError && writeError.message)}`;
      }
      writeStatus();
      // The CLI has done its job; give it a moment to finish rendering, then end.
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, 1500);
    }
  }
  writeStatus();
});

child.onExit(({ exitCode: code }) => {
  exitCode = code;
  if (state !== "captured" && state !== "error") {
    if (mode === "generic") {
      state = code === 0 ? "finished" : "error";
      if (code !== 0) error = `login command exited ${code}`;
    } else {
      state = tokenCaptured ? "captured" : "error";
      if (!tokenCaptured) error = error ?? `claude setup-token exited ${code} before a token was printed`;
    }
  }
  writeStatus();
  setTimeout(() => process.exit(0), 200);
});

const poller = setInterval(() => {
  try {
    const inputPath = path.join(dir, "input.txt");
    if (fs.existsSync(inputPath)) {
      const text = fs.readFileSync(inputPath, "utf8");
      fs.unlinkSync(inputPath);
      if (text.length > 0) {
        child.write(text.replace(/\r?\n$/, ""));
        setTimeout(() => child.write("\r"), 250);
      }
    }
    if (fs.existsSync(path.join(dir, "cancel"))) {
      state = "cancelled";
      writeStatus();
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      clearInterval(poller);
    }
  } catch {
    /* poll errors are transient */
  }
}, 400);

// Hard stop: an abandoned login attempt must not hold a PTY forever.
setTimeout(() => {
  if (state === "running" || state === "awaiting-browser" || state === "starting") {
    state = "error";
    error = "login attempt timed out after 15 minutes";
    writeStatus();
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}, 15 * 60 * 1000);
