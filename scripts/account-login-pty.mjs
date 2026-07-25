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
//
// Device mode (--mode device --command "<cmd>" --home <dir> --home-env <VAR>
// --capture-file <rel>) runs a CLI's DEVICE-CODE login (RUNTIME-ACCOUNTS-V3) in
// an isolated config home: it scrapes the verification URL + one-time code for
// the UI, then waits for the CLI to write its credential file into that home and
// hands the file CONTENT back through the same token.txt protocol. Used for
// `codex login --device-auth`, whose whole point is that the browser completing
// the flow is on a different machine than the CLI.
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
const homeDir = arg("home");
const homeEnv = arg("home-env");
const captureFile = arg("capture-file");
const flow = arg("flow") ?? "device-code";
// Repeatable --env KEY=VALUE (e.g. NO_BROWSER=true for gemini's headless OAuth).
const extraEnv = args.reduce((acc, value, index) => {
  if (value !== "--env") return acc;
  const pair = args[index + 1] ?? "";
  const eq = pair.indexOf("=");
  if (eq > 0) acc[pair.slice(0, eq)] = pair.slice(eq + 1);
  return acc;
}, {});
if (!dir) {
  console.error(
    "usage: node account-login-pty.mjs --dir <status-dir> [--mode setup-token|generic|device --command '<cmd>' --home <dir> --home-env <VAR> --capture-file <rel>]"
  );
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });

const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;
const ANY_TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{8,}/g;
// The full unbroken URL travels in OSC 8 hyperlink sequences; the visible text
// is wrapped across lines. Prefer OSC 8, fall back to de-wrapped plain text.
const OSC8_URL_RE = /\]8;[^;\x07\x1b]*;(https:\/\/[^\x07\x1b]+)/;
const PLAIN_URL_RE = /https:\/\/[a-z0-9.-]*claude\.(?:com|ai)\/[^\s]*authorize[^\s]*/i;
// Device mode: any https URL will do (codex prints auth.openai.com/codex/device),
// plus the one-time code the user types there (observed shape: PHQP-DVSIE).
const DEVICE_URL_RE = /https:\/\/[a-z0-9.-]+\/[^\s]*/i;
const DEVICE_CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/;

let raw = "";
let state = "starting";
let authorizeUrl = null;
let userCode = null;
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
    userCode,
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
  mode === "generic" || mode === "browser"
    ? { file: "bash", args: ["-lc", command ?? "true"] }
    : { file: "claude", args: ["setup-token"] };

// Browser mode runs the CLI against an isolated config home so the capture never
// touches (or clobbers) the box's own login.
const childEnv = { ...process.env, ...extraEnv };
if (mode === "browser" && homeDir && homeEnv) {
  childEnv[homeEnv] = homeDir;
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
}

let child;
try {
  child = pty.spawn(spawnSpec.file, spawnSpec.args, {
    name: "xterm-256color",
    cols: 200,
    rows: 50,
    cwd: process.env.HOME ?? "/",
    env: childEnv
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

  if (mode === "browser") {
    const clean = stripAnsi(raw);
    if (!authorizeUrl) {
      const osc = raw.match(OSC8_URL_RE);
      // A long auth URL wraps across PTY lines; de-wrap before matching, but
      // only inside the URL itself (joining every line would glue words).
      const dewrapped = clean.replace(/(https:\/\/\S+)\n(?=\S)/g, "$1");
      const plain = osc ? null : dewrapped.match(DEVICE_URL_RE);
      const found = osc?.[1] ?? plain?.[0] ?? null;
      // Trim trailing punctuation the CLI may print after the URL.
      if (found) authorizeUrl = found.replace(/[.,)\]]+$/, "");
    }
    // Only the device-code flow shows a code HERE; in paste-code the code comes
    // from the provider's page and is typed back in, so scraping would be noise.
    if (!userCode && flow === "device-code") {
      const code = clean.match(DEVICE_CODE_RE);
      if (code) userCode = code[1];
    }
    // Ready for the user once we have everything they need to act on.
    const ready = flow === "device-code" ? authorizeUrl && userCode : authorizeUrl;
    if (ready && state === "running") state = "awaiting-browser";
  } else if (!authorizeUrl) {
    const osc = raw.match(OSC8_URL_RE);
    const plain = osc ? null : stripAnsi(raw).replace(/\n/g, "").match(PLAIN_URL_RE);
    const found = osc?.[1] ?? plain?.[0] ?? null;
    if (found) {
      authorizeUrl = found;
      if (state === "running") state = "awaiting-browser";
    }
  }

  // setup-token is the only mode whose credential is PRINTED; browser mode
  // captures a file instead (pollCaptureFile).
  if (mode === "setup-token" && !tokenCaptured) {
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
  // The CLI may exit the instant it writes the credential - look once more
  // before calling the attempt a failure.
  pollCaptureFile();
  // "cancelled" is a deliberate user action, not a failure - the exit it causes
  // must not be relabelled as an error.
  if (state !== "captured" && state !== "error" && state !== "cancelled") {
    if (mode === "browser") {
      state = "error";
      error = error ?? `${command} exited ${code} before writing a credential`;
    } else if (mode === "generic") {
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

// Device mode captures a FILE, not a printed token: poll the isolated home for
// the CLI's credential and hand its content back through the same protocol.
function pollCaptureFile() {
  if (mode !== "browser" || tokenCaptured || !homeDir || !captureFile) return;
  const src = path.join(homeDir, captureFile);
  let content;
  try {
    if (!fs.existsSync(src)) return;
    content = fs.readFileSync(src, "utf8");
    JSON.parse(content); // ignore a half-written file; the next tick retries
  } catch {
    return;
  }
  tokenCaptured = true;
  try {
    fs.writeFileSync(path.join(dir, "token.txt"), content, { mode: 0o600 });
    state = "captured";
  } catch (writeError) {
    state = "error";
    error = `credential capture write failed: ${String(writeError && writeError.message)}`;
  }
  writeStatus();
  setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }, 500);
}

const poller = setInterval(() => {
  try {
    pollCaptureFile();
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
