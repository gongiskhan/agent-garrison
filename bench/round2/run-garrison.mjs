#!/usr/bin/env node
// Start ONE Garrison conversation through the same door the board uses
// (POST /cards -> PATCH autonomous -> POST /cards/:id/start -> the gateway's
// /conversation/kick) and wait it out. The card id IS the conversation id.
//
//   usage: run-garrison.mjs --prompt <file> --title <t> [--project <dir>] [--timeout <s>]
import fs from "node:fs";

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const KANBAN = arg("kanban", "http://127.0.0.1:8089");
const promptFile = arg("prompt");
const title = arg("title", "benchmark");
const project = arg("project", null);
const timeoutS = Number(arg("timeout", "3600"));
if (!promptFile) { console.error("--prompt <file> is required"); process.exit(2); }
const description = fs.readFileSync(promptFile, "utf8");

const j = async (method, path, body) => {
  const res = await fetch(`${KANBAN}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, json: parsed, text: text.slice(0, 400) };
};

const started = new Date().toISOString();
// The id is left to the board: a hand-made id passes CREATE but fails the
// 26-char ULID check on PATCH, so the card can never be made autonomous.
const created = await j("POST", "/cards", {
  title,
  description,
  targetList: "todo",
  ...(project ? { project } : {}),
});
if (created.status !== 200 && created.status !== 201) {
  console.error("create failed", created.status, created.text); process.exit(3);
}
const id = created.json?.card?.id ?? created.json?.id;
if (!id) { console.error("no card id in", created.text); process.exit(3); }
console.log(`[gar] card/conversation ${id}`);

// autonomous is not honoured at create; it has to be patched on.
const patched = await j("PATCH", `/cards/${id}`, { autonomous: true });
if (patched.status !== 200) console.error("[gar] WARNING autonomous patch:", patched.status, patched.text);

const start = await j("POST", `/cards/${id}/start`, {});
if (start.status !== 200) { console.error("start failed", start.status, start.text); process.exit(4); }
console.log(`[gar] started at ${started}`);

const t0 = Date.now();
let last = "";
for (;;) {
  await new Promise((r) => setTimeout(r, 10_000));
  const got = await j("GET", `/cards/${id}`);
  const card = got.json?.card ?? got.json;
  const state = `${card?.list}/${card?.status}`;
  if (state !== last) { console.log(`[gar] ${Math.round((Date.now() - t0) / 1000)}s  ${state}`); last = state; }
  if (card?.list === "done" || card?.status === "needs-attention" || card?.status === "parked") break;
  if ((Date.now() - t0) / 1000 > timeoutS) { console.log("[gar] TIMEOUT"); break; }
}
const ended = new Date().toISOString();
const seconds = Math.round((Date.now() - t0) / 1000);
console.log(JSON.stringify({ conversationId: id, started, ended, seconds }, null, 1));
fs.writeFileSync(arg("out", `/tmp/gar-run-${id}.json`), JSON.stringify({ conversationId: id, started, ended, seconds }, null, 1));
