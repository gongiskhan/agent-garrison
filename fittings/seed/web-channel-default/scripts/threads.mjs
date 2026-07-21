// Web-channel conversation THREADS — a server-side transcript organizer.
//
// The operative is one rolling `claude --continue` conversation; "threads" are a
// generic, opaque-keyed organizer ON TOP of it so the web channel can list past
// conversations, show their history, and let the user move between them. The
// channel stays generic: a thread is just { id, title, source, mode, context,
// messages[] }. Kanban/Automations open a thread by passing a STABLE opaque key
// (+ optional title) on the URL; the channel never interprets the key.
//
// One file per thread under <garrison>/web-channel/threads/<id>.json. Listing
// scans the dir (a personal-scale store — a handful of small files). Writes are
// atomic (tmp + rename) so a crash mid-write never corrupts a transcript.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function garrisonDir() {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

const THREADS_DIR = path.join(garrisonDir(), "web-channel", "threads");

// Map any opaque key to a SAFE, stable filename stem. A key with only filesystem-
// unfriendly chars (or an over-long one) still gets a deterministic id via a hash
// suffix, so two distinct keys never collide after sanitising.
export function safeThreadId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const cleaned = s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  // If sanitising changed the key materially, append a short hash of the ORIGINAL
  // so distinct originals stay distinct (e.g. "a:b" vs "a-b").
  if (cleaned !== s) {
    const h = createHash("sha256").update(s).digest("hex").slice(0, 8);
    return `${cleaned || "thread"}-${h}`;
  }
  return cleaned;
}

// A fresh ad-hoc thread id (time-ordered + random tail; not a ULID, just unique).
export function newThreadId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `chat-${t}-${r}`;
}

function threadPath(id) {
  return path.join(THREADS_DIR, `${id}.json`);
}

async function atomicWriteJson(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await rename(tmp, file);
}

function deriveTitle(thread) {
  if (thread.title && String(thread.title).trim()) return String(thread.title).trim();
  const firstUser = (thread.messages ?? []).find((m) => m.role === "user" && m.text?.trim());
  if (firstUser) {
    const firstLine = firstUser.text.split("\n").map((l) => l.trim()).find(Boolean) ?? firstUser.text;
    return firstLine.replace(/^#+\s*/, "").slice(0, 60).trim() || "New conversation";
  }
  return "New conversation";
}

function toMeta(thread) {
  return {
    id: thread.id,
    title: deriveTitle(thread),
    source: thread.source ?? "chat",
    createdAt: thread.createdAt ?? null,
    updatedAt: thread.updatedAt ?? thread.createdAt ?? null,
    messageCount: Array.isArray(thread.messages) ? thread.messages.length : 0,
  };
}

async function readThreadFile(id) {
  try {
    const raw = await readFile(threadPath(id), "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    obj.id = id; // pin to the on-disk filename, never a tampered inner id
    if (!Array.isArray(obj.messages)) obj.messages = [];
    return obj;
  } catch {
    return null;
  }
}

/** List all threads as lightweight metadata, newest activity first. */
export async function listThreads() {
  let names = [];
  try {
    names = (await readdir(THREADS_DIR)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const metas = [];
  for (const name of names) {
    const id = name.slice(0, -".json".length);
    const thread = await readThreadFile(id);
    if (thread) metas.push(toMeta(thread));
  }
  metas.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return metas;
}

/** Full thread (with messages) or null. */
export async function getThread(id) {
  const safe = safeThreadId(id);
  if (!safe) return null;
  return readThreadFile(safe);
}

/**
 * Ensure a thread exists for the given (opaque) id, creating it if absent.
 * Idempotent: re-opening the same key returns the existing thread. A provided
 * title backfills an untitled thread but never overwrites a real one.
 * @returns {Promise<object>} the full thread.
 */
export async function ensureThread({ id, title, source, mode, context, nowIso }) {
  const safe = id ? safeThreadId(id) : newThreadId();
  const existing = await readThreadFile(safe);
  const now = nowIso ?? new Date().toISOString();
  if (existing) {
    let changed = false;
    if (title && !existing.title) { existing.title = String(title).slice(0, 120); changed = true; }
    if (mode && !existing.mode) { existing.mode = String(mode); changed = true; }
    if (context !== undefined && existing.context === undefined) { existing.context = context; changed = true; }
    if (changed) { existing.updatedAt = now; await atomicWriteJson(threadPath(safe), existing); }
    return existing;
  }
  const thread = {
    id: safe,
    title: title ? String(title).slice(0, 120) : "",
    source: source ? String(source) : "chat",
    mode: mode ? String(mode) : null,
    context: context ?? undefined,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  await atomicWriteJson(threadPath(safe), thread);
  return thread;
}

/**
 * Append completed exchanges to a thread (creating it if needed). `messages` is a
 * list of { role: 'user'|'assistant', text }. Stamps each with a timestamp and
 * bumps updatedAt. Returns the updated thread meta.
 */
export async function appendMessages(id, messages, { nowIso } = {}) {
  const safe = safeThreadId(id);
  if (!safe) throw new Error("appendMessages: invalid thread id");
  const now = nowIso ?? new Date().toISOString();
  let thread = await readThreadFile(safe);
  if (!thread) {
    thread = { id: safe, title: "", source: "chat", mode: null, createdAt: now, updatedAt: now, messages: [] };
  }
  const clean = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string")
    .map((m) => ({ role: m.role, text: m.text, ts: m.ts ?? now }));
  if (!clean.length) return toMeta(thread);
  thread.messages.push(...clean);
  thread.updatedAt = now;
  if (!thread.title) thread.title = deriveTitle(thread);
  await atomicWriteJson(threadPath(safe), thread);
  return toMeta(thread);
}

/** Delete a thread. Returns true if a file was removed. */
export async function deleteThread(id) {
  const safe = safeThreadId(id);
  if (!safe) return false;
  try {
    await unlink(threadPath(safe));
    return true;
  } catch {
    return false;
  }
}

// Synchronous existence probe (used only in tests / quick checks).
export function threadExistsSync(id) {
  const safe = safeThreadId(id);
  return safe ? existsSync(threadPath(safe)) : false;
}

export function _threadsDirForTest() {
  return THREADS_DIR;
}

export function _readThreadSync(id) {
  const safe = safeThreadId(id);
  if (!safe) return null;
  try {
    return JSON.parse(readFileSync(threadPath(safe), "utf8"));
  } catch {
    return null;
  }
}
