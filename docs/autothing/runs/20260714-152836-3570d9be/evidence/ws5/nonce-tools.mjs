// WS5 nonce protocol tooling (D10). The nonce NEVER appears in this file, in
// stdout, in the orchestrator's transcript, or in any repo/memory artifact:
// it is generated here, injected directly into the task payload, and later
// verified by sha256 comparison against candidates extracted from evidence.
//
// Usage:
//   node nonce-tools.mjs create <template-file> <project> [<targetList>]
//     Generates WORD-4HEX, substitutes {{NONCE}} in the template, POSTs the
//     card, optionally moves it to targetList (engine header), prints ONLY
//     {cardId, nonceSha256}.
//   node nonce-tools.mjs steer <cardId> <template-file>
//     Substitutes {{NONCE}} (a FRESH nonce) in the template and POSTs it as an
//     absorb steer to the card. Prints ONLY {cardId, nonceSha256}.
//   node nonce-tools.mjs controls <predecessorCardId> <expectedSha256> <outFile>
//     Extracts WORD-4HEX candidates from the predecessor's evidence (runDir +
//     card dir), confirms one hashes to expectedSha256, then greps the repo
//     working tree (must be ABSENT), the memory vault (must be ABSENT), and
//     the predecessor evidence (must be PRESENT). Writes a nonce-free
//     transcript to outFile and prints PASS/FAIL lines.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const BOARD = process.env.GARRISON_BOARD_URL || "http://127.0.0.1:7089";
const REPO = "/home/ggomes/dev/garrison";
const VAULT = path.join(os.homedir(), "ObsidianVault");
const KANBAN = path.join(os.homedir(), ".garrison", "kanban-loop");

const WORDS = ["LANTERN", "GRANITE", "HARBOR", "FALCON", "MERIDIAN", "COBALT", "JUNIPER", "BASTION", "ORCHARD", "SEXTANT", "TUNDRA", "VESSEL", "WHARF", "ZENITH", "CITADEL", "DYNAMO"];

function mintNonce() {
  const word = WORDS[randomBytes(1)[0] % WORDS.length];
  const hex = randomBytes(2).toString("hex").toUpperCase();
  return `${word}-${hex}`;
}
const sha = (s) => createHash("sha256").update(s).digest("hex");

async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function createTask(templateFile, project, targetList) {
  const nonce = mintNonce();
  const template = readFileSync(templateFile, "utf8");
  const description = template.replaceAll("{{NONCE}}", nonce);
  const title = description.split("\n")[0].replace(/^#+\s*/, "").slice(0, 90);
  const doc = await post(`${BOARD}/cards`, { title, description, project, origin_id: "board" });
  const card = doc.card;
  if (targetList) {
    await fetch(`${BOARD}/cards/${card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-garrison-engine": "1" },
      body: JSON.stringify({ list: targetList, rev: card.rev }),
    });
  }
  console.log(JSON.stringify({ cardId: card.id, nonceSha256: sha(nonce) }));
}

async function steerTask(cardId, templateFile) {
  const nonce = mintNonce();
  const template = readFileSync(templateFile, "utf8");
  const message = template.replaceAll("{{NONCE}}", nonce);
  await post(`${BOARD}/cards/${encodeURIComponent(cardId)}/steer`, { message, action: "absorb" });
  console.log(JSON.stringify({ cardId, nonceSha256: sha(nonce) }));
}

// grep -rF for a literal across a root; returns matching file paths (bounded).
function grepPaths(literal, root) {
  if (!existsSync(root)) return [];
  try {
    const out = execFileSync("grep", ["-rFl", literal, root, "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=.next"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return out.trim().split("\n").filter(Boolean);
  } catch (err) {
    if (err.status === 1) return []; // no matches
    throw err;
  }
}

function* walkFiles(root, depth = 6) {
  if (!existsSync(root) || depth < 0) return;
  for (const name of readdirSync(root)) {
    const p = path.join(root, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walkFiles(p, depth - 1);
    else if (st.size < 4 * 1024 * 1024) yield p;
  }
}

async function controls(cardId, expectedSha, outFile) {
  // Locate the predecessor's evidence: card dir + runDir from card.json.
  const cardDir = path.join(KANBAN, "cards", cardId);
  const card = JSON.parse(readFileSync(path.join(cardDir, "card.json"), "utf8"));
  const roots = [cardDir, card.runDir].filter((r) => r && existsSync(r));
  // Extract WORD-4HEX candidates from the evidence and find the one matching
  // the expected hash (the orchestrator never sees the raw value).
  const rx = /\b[A-Z]{3,12}-[0-9A-F]{4}\b/g;
  const candidates = new Set();
  for (const root of roots) {
    for (const f of walkFiles(root)) {
      try {
        const text = readFileSync(f, "utf8");
        for (const m of text.match(rx) ?? []) candidates.add(m);
      } catch { /* binary etc. */ }
    }
  }
  let nonce = null;
  for (const c of candidates) if (sha(c) === expectedSha) nonce = c;
  const lines = [];
  const t = new Date().toISOString();
  lines.push(`# Nonce control greps - ${t}`);
  lines.push(`predecessor card: ${cardId}`);
  lines.push(`evidence roots: ${roots.join(", ")}`);
  lines.push(`nonce sha256: ${expectedSha}`);
  lines.push(`candidates extracted from evidence: ${candidates.size}; hash-match found: ${nonce ? "YES" : "NO"}`);
  let pass = Boolean(nonce);
  if (nonce) {
    const repoHits = grepPaths(nonce, REPO);
    const vaultHits = grepPaths(nonce, VAULT);
    const evidenceHits = roots.flatMap((r) => grepPaths(nonce, r));
    lines.push(`CONTROL repo (${REPO}): grep -rFl <nonce> -> ${repoHits.length} hits ${repoHits.length === 0 ? "[ABSENT - PASS]" : "[PRESENT - FAIL]"}`);
    for (const h of repoHits) lines.push(`  ! ${h}`);
    lines.push(`CONTROL memory vault (${VAULT}): grep -rFl <nonce> -> ${vaultHits.length} hits ${vaultHits.length === 0 ? "[ABSENT - PASS]" : "[PRESENT - FAIL]"}`);
    for (const h of vaultHits) lines.push(`  ! ${h}`);
    lines.push(`CONTROL predecessor evidence: grep -rFl <nonce> -> ${evidenceHits.length} hits ${evidenceHits.length > 0 ? "[PRESENT - PASS]" : "[ABSENT - FAIL]"}`);
    for (const h of evidenceHits) lines.push(`  ${h.replace(nonce, "<nonce>")}`);
    pass = repoHits.length === 0 && vaultHits.length === 0 && evidenceHits.length > 0;
  } else {
    lines.push("FAIL: no evidence candidate matches the expected nonce hash - the plan duty did not record it (or evidence unreadable).");
  }
  lines.push(`RESULT: ${pass ? "PASS" : "FAIL"}`);
  writeFileSync(outFile, lines.join("\n") + "\n");
  console.log(lines[lines.length - 1]);
  for (const l of lines.slice(4)) if (l.startsWith("CONTROL")) console.log(l);
  process.exitCode = pass ? 0 : 1;
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "create") await createTask(args[0], args[1], args[2]);
else if (cmd === "steer") await steerTask(args[0], args[1]);
else if (cmd === "controls") await controls(args[0], args[1], args[2]);
else { console.error("usage: create <template> <project> [list] | steer <cardId> <template> | controls <cardId> <sha256> <out>"); process.exit(2); }
