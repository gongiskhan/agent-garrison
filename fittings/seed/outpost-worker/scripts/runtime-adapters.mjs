// Small Outpost runtime adapter bundle. Remote execution is intentionally
// narrower than the host: a worker advertises only adapters it can prove ready,
// and a job carries the exact resolved phase cell selected by the host.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

export const SUPPORTED_RUNTIME_KEYS = ["agent-sdk:anthropic"];

const resultError = (subtype) => typeof subtype === "string" && subtype.startsWith("error");
const clamp = (value, max = 20_000) => {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text;
};

function journalBlock(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text" && typeof block.text === "string") return { type: "text", text: clamp(block.text) };
  if (block.type === "thinking") return { type: "thinking", text: clamp(block.thinking ?? block.text ?? "") };
  if (block.type === "tool_use") {
    let input = "";
    try { input = clamp(JSON.stringify(block.input ?? {}, null, 2)); }
    catch { input = clamp(block.input); }
    return { type: "tool_use", toolUseId: block.id ?? null, name: String(block.name ?? "tool"), input };
  }
  if (block.type === "tool_result") {
    const content = Array.isArray(block.content)
      ? block.content
      : typeof block.content === "string"
        ? [{ type: "text", text: block.content }]
        : [];
    const texts = [];
    const images = [];
    for (const item of content) {
      if (item?.type === "text" && typeof item.text === "string") texts.push(item.text);
      if (item?.type === "image" && item.source?.type === "base64" && typeof item.source.data === "string") {
        images.push({ mediaType: item.source.media_type || "image/jpeg", data: item.source.data });
      }
    }
    return {
      type: "tool_result",
      toolUseId: block.tool_use_id ?? null,
      isError: block.is_error === true,
      text: clamp(texts.join("\n")),
      images
    };
  }
  return null;
}

function journalEvent(message) {
  if (message?.type !== "assistant" && message?.type !== "user") return null;
  const raw = Array.isArray(message.message?.content)
    ? message.message.content
    : typeof message.message?.content === "string"
      ? [{ type: "text", text: message.message.content }]
      : [];
  const blocks = raw.map(journalBlock).filter(Boolean);
  if (!blocks.length) return null;
  const ts = Date.parse(message.timestamp || "");
  return {
    id: typeof message.uuid === "string" ? message.uuid : null,
    role: message.type,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    ...(blocks.every((block) => block.type === "tool_result") ? { toolResultsOnly: true } : {}),
    blocks
  };
}

export async function probeRuntimeAdapters() {
  try {
    await import("@anthropic-ai/claude-agent-sdk");
    const require = createRequire(import.meta.url);
    const executable = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${process.platform === "win32" ? "claude.exe" : "claude"}`);
    const auth = await new Promise((resolve) => {
      const child = spawn(executable, ["auth", "status", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { if (stdout.length < 16_384) stdout += chunk; });
      child.stderr.on("data", (chunk) => { if (stderr.length < 16_384) stderr += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        let status = {};
        try { status = JSON.parse(stdout); } catch {}
        resolve({ ok: code === 0 && status.loggedIn === true, detail: stderr.trim() || "model login is not active" });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, detail: error.message });
      });
    });
    if (!auth.ok) return { ready: false, runtimes: [], detail: "Sign in to Claude on this Mac", error: auth.detail };
    return { ready: true, runtimes: [...SUPPORTED_RUNTIME_KEYS], detail: "Agent SDK and local Claude subscription login ready" };
  } catch (error) {
    return {
      ready: false,
      runtimes: [],
      detail: "Install/repair the task runner dependencies",
      error: `Agent SDK unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export async function runResolvedTarget(prompt, cwd, target, hooks = {}) {
  if (!target || target.runtime !== "agent-sdk" || target.provider !== "anthropic") {
    throw new Error(`unsupported resolved target: ${target?.runtime || "none"}/${target?.provider || "none"}`);
  }
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const options = {
    cwd,
    model: target.model,
    maxTurns: Number.isInteger(target.maxTurns) && target.maxTurns > 0 ? target.maxTurns : 12,
    permissionMode: "bypassPermissions",
    settingSources: ["user", "project", "local"],
    env: {
      ...process.env,
      ...(hooks.evidenceDir ? { GARRISON_OUTPOST_EVIDENCE_DIR: hooks.evidenceDir } : {})
    },
    systemPrompt: target.promptMode === "coding"
      ? { type: "preset", preset: "claude_code" }
      : undefined,
    ...(typeof target.effort === "string" && target.effort ? { effort: target.effort } : {})
  };
  const client = query({ prompt, options });
  if (typeof hooks.onCancelHandle === "function") {
    hooks.onCancelHandle(async () => {
      try { await client.return(); } catch { /* already settled */ }
    });
  }
  let accumulated = "";
  let finalText = "";
  let failure = "";
  let sessionId = null;
  try {
    for await (const message of client) {
      const activity = journalEvent(message);
      if (activity && typeof hooks.onJournal === "function") await hooks.onJournal(activity);
      if (message?.type === "system" && typeof message.session_id === "string") {
        sessionId = message.session_id;
      } else if (message?.type === "assistant") {
        const envelope = (message.message?.content || [])
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("");
        if (envelope) {
          const separator = accumulated && !accumulated.endsWith("\n") && !envelope.startsWith("\n") ? "\n\n" : "";
          accumulated += separator + envelope;
          if (typeof hooks.onChunk === "function") await hooks.onChunk("stdout", separator + envelope);
        }
      } else if (message?.type === "result") {
        if (typeof message.result === "string" && message.result.trim()) finalText = message.result;
        if (typeof message.session_id === "string") sessionId = message.session_id;
        if (resultError(message.subtype)) failure = message.subtype;
      }
    }
  } catch (error) {
    if (!hooks.isCancelled?.()) throw error;
    failure = "cancelled";
  } finally {
    if (typeof hooks.onCancelHandle === "function") hooks.onCancelHandle(null);
  }
  return {
    exitCode: failure ? -1 : 0,
    stdout: finalText || accumulated,
    stderr: failure,
    sessionId,
    cancelled: failure === "cancelled"
  };
}
