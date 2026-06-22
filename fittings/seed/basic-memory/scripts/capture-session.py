#!/usr/bin/env python3
"""Basic Memory session-capture hook (SessionEnd / PreCompact).

Writes a lightweight checkpoint note into the vault's memory_dir so the
session's context survives into future sessions. NO LLM call — just metadata
plus a short, secret-redacted tail of the transcript. Basic Memory's file
watcher indexes the note on its next sync.

Contract: reads the hook payload as JSON on stdin (Claude Code passes
session_id / transcript_path / cwd / hook_event_name). ALWAYS exits 0 — a
capture failure must never break the session.
"""
import sys, os, json, re, datetime

def main():
    vault = os.path.expanduser(os.environ.get("BASIC_MEMORY_VAULT_DIR", "~/ObsidianVault"))
    mem_dir = os.environ.get("BASIC_MEMORY_MEMORY_DIR", "Memory")
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        payload = {}

    session_id = str(payload.get("session_id") or "unknown")
    cwd = payload.get("cwd") or os.getcwd()
    event = payload.get("hook_event_name") or "SessionEnd"
    transcript = payload.get("transcript_path") or ""
    now = datetime.datetime.now()
    iso = now.strftime("%Y-%m-%dT%H:%M:%S")
    proj = os.path.basename(cwd.rstrip("/")) or "root"
    slug = re.sub(r"[^a-z0-9]+", "-", proj.lower()).strip("-") or "root"

    secret = re.compile(r"(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|xoxb-[A-Za-z0-9-]{8,})")
    def redact(t): return secret.sub("[REDACTED]", t or "")

    # Extract a short tail from the transcript JSONL (best-effort).
    tail = []
    try:
        if transcript and os.path.exists(transcript):
            with open(transcript, errors="replace") as f:
                lines = f.readlines()[-40:]
            for ln in lines:
                try:
                    ev = json.loads(ln)
                except Exception:
                    continue
                role = ev.get("type") or (ev.get("message") or {}).get("role")
                msg = ev.get("message") or {}
                content = msg.get("content")
                text = ""
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    text = " ".join(
                        c.get("text", "") for c in content
                        if isinstance(c, dict) and c.get("type") == "text"
                    )
                text = re.sub(r"\s+", " ", text).strip()
                if text and role in ("user", "assistant"):
                    tail.append(f"- **{role}**: {redact(text)[:400]}")
            tail = tail[-12:]
    except Exception:
        tail = []

    body = [
        "---",
        f"title: Session checkpoint — {now.strftime('%Y-%m-%d %H:%M')} {proj}",
        "type: note",
        f"tags: [session, checkpoint, {slug}]",
        "---",
        f"# Session checkpoint — {iso}",
        "",
        f"- **when**: {iso}",
        f"- **project**: `{cwd}`",
        f"- **session**: {session_id}",
        f"- **event**: {event}",
        "",
    ]
    if tail:
        body += ["## Recent exchange (tail)", ""] + tail + [""]
    else:
        body += ["_No transcript tail available._", ""]

    try:
        out_dir = os.path.join(vault, mem_dir)
        os.makedirs(out_dir, exist_ok=True)
        fname = f"session-{now.strftime('%Y%m%d-%H%M%S')}-{session_id[:8]}.md"
        with open(os.path.join(out_dir, fname), "w") as f:
            f.write("\n".join(body))
    except Exception:
        pass  # never fail the session

    sys.exit(0)

if __name__ == "__main__":
    main()
