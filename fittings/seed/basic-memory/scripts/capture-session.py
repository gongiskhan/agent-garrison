#!/usr/bin/env python3
"""Basic Memory session-capture hook (SessionEnd / PreCompact).

Writes a lightweight checkpoint note into the vault's memory_dir so the
session's context survives into future sessions. NO LLM call - just metadata
plus a short, secret-redacted tail of the transcript. Basic Memory's file
watcher indexes the note on its next sync.

Contract: reads the hook payload as JSON on stdin (Claude Code passes
session_id / transcript_path / cwd / hook_event_name). ALWAYS exits 0 - a
capture failure must never break the session.

Optional spool (opt-in, backend-agnostic): when BASIC_MEMORY_SPOOL_ENABLED is
truthy, the same markdown is ALSO written as one spool file under
BASIC_MEMORY_SPOOL_DIR (default ~/.garrison/memory-spool), named after
a stable idempotency key `capture-<session_id>-<ts>-<pid>` (the pid keeps a
SessionEnd and a PreCompact landing in the same second from overwriting each
other - each hook invocation is its own process). A scheduled drain
(flush-spool.mjs) later pushes spool files to a remote memory CLI - the hook itself
NEVER touches the network. The spool dir is capped (default 50MB,
BASIC_MEMORY_SPOOL_CAP_BYTES override): oldest captures are evicted first with
one loud stderr line. Every spool failure is swallowed; local vault behavior
is byte-identical whether the spool is on, off, or broken.

THE SPOOL FILENAME IS A QUEUE KEY, NOT A NOTE IDENTITY. Conflating the two was
the G4 review's F1: the drain shipped each capture under the bare queue key,
while the comparator - which lists ONE remote folder and maps every vault file
to `<folder>/<slug>` - looked somewhere else entirely. A PERFECTLY working
shadow could therefore never show parity, a broken drain was indistinguishable
from a working one, and a later re-import stored the same bytes twice under two
identities.

So each capture is spooled with a SIDECAR, `<key>.permalink`, holding the
permalink the note would get if it were imported from its vault path. The drain
prefers the sidecar and falls back to the bare key only for a spool file written
before this existed. `_remote_permalink` below is a line-for-line
re-implementation of `slugSegment` / `permalinkForRelPath` in
scripts/lib/memory-vault.mjs: change one and you MUST change the other, or the
shadow and the comparator stop agreeing about what a note is.
"""
import sys, os, json, re, datetime, unicodedata

SPOOL_CAP_DEFAULT = 50 * 1024 * 1024  # 50MB
# Only files THIS hook produces (finished captures + its own write-then-rename
# leftovers). spool_dir is user config - a mispointed dir must never have
# foreign files deleted by a session-end hook, so eviction candidates and the
# cap accounting are both restricted to this shape (mirrors flush-spool.mjs's
# /^capture-.+\.md$/ drain filter).
SPOOL_FILE_RE = re.compile(r"^capture-.+\.md(\.tmp)?$")
# The identity sidecar that travels with a capture. Tiny, so it is deliberately
# NOT counted against the spool cap; it is removed with the capture it belongs
# to (on eviction here, on a successful drain in flush-spool.mjs).
SPOOL_SIDECAR_SUFFIX = ".permalink"

def _truthy(v):
    return str(v or "").strip().lower() in ("1", "true", "yes", "on")

def _slug_segment(text):
    """Mirror of slugSegment() in scripts/lib/memory-vault.mjs. Keep in step."""
    decomposed = unicodedata.normalize("NFKD", str(text)).lower()
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", decomposed))

def _remote_permalink(rel_path, folder):
    """Mirror of permalinkForRelPath(). `Memory/session-x.md` -> `vault/memory-session-x`."""
    without_ext = re.sub(r"\.md$", "", str(rel_path), flags=re.IGNORECASE)
    slug = _slug_segment(without_ext.replace(os.sep, "/")) or "note"
    return "%s/%s" % (_slug_segment(folder) or "vault", slug)

def _spool_evict_over_cap(spool_dir, cap, incoming):
    """Evict oldest CAPTURES until existing + incoming fits under cap."""
    entries, total = [], 0
    for name in os.listdir(spool_dir):
        if not SPOOL_FILE_RE.match(name):
            continue  # foreign file: never counted, never evicted
        p = os.path.join(spool_dir, name)
        try:
            if not os.path.isfile(p):
                continue
            st = os.stat(p)
        except OSError:
            continue
        entries.append((st.st_mtime, name, p, st.st_size))
        total += st.st_size
    if total + incoming <= cap:
        return
    evicted = 0
    for _, name, p, size in sorted(entries):
        try:
            os.remove(p)
        except OSError:
            continue
        # The identity sidecar has no life of its own - it goes with its capture.
        if name.endswith(".md"):
            try:
                os.remove(p[: -len(".md")] + SPOOL_SIDECAR_SUFFIX)
            except OSError:
                pass
        evicted += 1
        total -= size
        if total + incoming <= cap:
            break
    if evicted:
        print(f"[basic-memory] spool cap: evicted {evicted} oldest captures",
              file=sys.stderr)

def _spool_write(session_id, now, payload_text, permalink):
    """Write the capture into the spool. Any failure is swallowed upstream."""
    spool_dir = os.path.expanduser(
        os.environ.get("BASIC_MEMORY_SPOOL_DIR") or "~/.garrison/memory-spool")
    try:
        cap = int(os.environ.get("BASIC_MEMORY_SPOOL_CAP_BYTES") or SPOOL_CAP_DEFAULT)
    except ValueError:
        cap = SPOOL_CAP_DEFAULT
    data = payload_text.encode("utf-8", errors="replace")
    if len(data) > cap:
        # A capture that alone exceeds the cap would evict everything and
        # still land over cap - refuse it instead, loudly.
        print("[basic-memory] spool cap: capture exceeds the cap; skipped spool write",
              file=sys.stderr)
        return
    os.makedirs(spool_dir, exist_ok=True)
    _spool_evict_over_cap(spool_dir, cap, len(data))
    sid = re.sub(r"[^A-Za-z0-9]+", "-", session_id).strip("-") or "unknown"
    # Stable idempotency key; the pid disambiguates same-second events
    # (SessionEnd + PreCompact are distinct hook processes).
    key = f"capture-{sid}-{now.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}"
    final = os.path.join(spool_dir, key + ".md")
    # The identity sidecar lands BEFORE the capture it describes: the drain
    # picks up `.md` files, so a capture must never be visible without the
    # permalink that says what it is - a drain that fell back to the queue key
    # would ship the note under an identity nothing else can find.
    side = os.path.join(spool_dir, key + SPOOL_SIDECAR_SUFFIX)
    side_tmp = side + ".writing"
    with open(side_tmp, "w") as f:
        f.write(permalink + "\n")
    os.replace(side_tmp, side)
    tmp = final + ".tmp"  # write-then-rename so the flusher never sees a partial file
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, final)
    except Exception:
        # No capture means the sidecar describes nothing: take it back out
        # rather than leave an orphan behind.
        for stale in (tmp, side):
            try:
                os.remove(stale)
            except OSError:
                pass
        raise

def _spawn_detached_flush():
    """Fire-and-forget spool drain: fully detached, never waited on, never fatal."""
    try:
        if not _truthy(os.environ.get("BASIC_MEMORY_SPOOL_AUTOFLUSH", "1")):
            return
        import shutil, subprocess
        node = shutil.which("node")
        flush = os.path.join(os.path.dirname(os.path.abspath(__file__)), "flush-spool.mjs")
        if not node or not os.path.isfile(flush):
            return
        subprocess.Popen(
            [node, flush],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
    except Exception:
        pass  # the hook must stay fast and always exit 0

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
        f"title: Session checkpoint - {now.strftime('%Y-%m-%d %H:%M')} {proj}",
        "type: note",
        f"tags: [session, checkpoint, {slug}]",
        "---",
        f"# Session checkpoint - {iso}",
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

    # The vault-relative path is computed OUTSIDE the write, because it is also
    # the note's remote identity: the spool copy has to claim the same permalink
    # the comparator will derive from this very path.
    fname = f"session-{now.strftime('%Y%m%d-%H%M%S')}-{session_id[:8]}.md"
    rel_path = os.path.join(mem_dir, fname)
    try:
        out_dir = os.path.join(vault, mem_dir)
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, fname), "w") as f:
            f.write("\n".join(body))
    except Exception:
        pass  # never fail the session

    # Optional spool copy (opt-in; same markdown, idempotency-keyed filename,
    # plus the sidecar naming the note's remote identity). No network here,
    # ever - a scheduled drain ships it later. Any failure is swallowed so the
    # hook stays sub-second and always exits 0.
    if _truthy(os.environ.get("BASIC_MEMORY_SPOOL_ENABLED")):
        try:
            folder = os.environ.get("BASIC_MEMORY_REMOTE_FOLDER") or "vault"
            _spool_write(session_id, now, "\n".join(body),
                         _remote_permalink(rel_path, folder))
        except Exception:
            pass
        _spawn_detached_flush()

    sys.exit(0)

if __name__ == "__main__":
    main()
