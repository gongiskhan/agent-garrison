// Command-shape consent (ported from ekoa's command-shape.ts). The first use of
// each command SHAPE (the argv normalized so values become <FILE>/<DIR>/<URL>
// placeholders) needs the user's approval. Approval is stored per shape so a
// re-run of the same shape doesn't re-prompt.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export function computeCommandShape(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return "";
  const head = argv[0];
  if ((head === "bash" || head === "sh" || head === "zsh") && argv[1] === "-c") {
    // A shell string is opaque, so a single `<SCRIPT>` shape would let one
    // approval unlock ALL future scripts. Fingerprint the actual script so each
    // distinct command needs its own consent.
    const hash = createHash("sha256").update(argv[2] ?? "").digest("hex").slice(0, 12);
    return `${head} -c <SCRIPT:${hash}>`;
  }
  const parts = [head];
  for (let i = 1; i < argv.length; i++) parts.push(normalizeArg(argv[i]));
  return parts.join(" ");
}

function normalizeArg(arg) {
  if (arg.startsWith("-")) return arg; // flag
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(arg)) return "<URL>"; // URL
  if (arg.includes("/")) {
    if (arg.endsWith("/")) return "<DIR>";
    if (/\.[a-zA-Z0-9]{1,8}$/.test(arg)) return "<FILE>";
    return "<DIR>";
  }
  if (/\.[a-zA-Z0-9]{1,8}$/.test(arg)) return "<FILE>"; // bare filename with ext
  return arg; // subcommand / literal
}

// A local_command step authored as { command: "git status" } or { argv: [...] }.
// Reduce both to an argv for shaping.
export function shapeForStep(step) {
  if (Array.isArray(step.argv)) return computeCommandShape(step.argv);
  if (typeof step.command === "string") {
    // A shell string is a single bash -c <SCRIPT> shape (its content is opaque).
    return computeCommandShape(["bash", "-c", step.command]);
  }
  return "";
}

function approvedPath() {
  const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
  const dir = process.env.GARRISON_AUTOMATIONS_DIR || path.join(home, "automations");
  return path.join(dir, "approved-commands.json");
}

async function loadApproved() {
  try {
    const data = JSON.parse(await fs.readFile(approvedPath(), "utf8"));
    return Array.isArray(data.shapes) ? data.shapes : [];
  } catch {
    return [];
  }
}

export async function isShapeApproved(shape) {
  return (await loadApproved()).includes(shape);
}

export async function approveShape(shape) {
  const shapes = await loadApproved();
  if (!shapes.includes(shape)) shapes.push(shape);
  const file = approvedPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ shapes }, null, 2), "utf8");
}
