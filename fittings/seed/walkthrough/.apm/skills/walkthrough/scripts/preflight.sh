#!/usr/bin/env bash
# preflight.sh — one-time dependency + environment check for the walkthrough skill.
# Verifies tooling, offers to install what's missing (macOS/brew), and reports the
# Tailscale IP the gallery server will bind to. Safe to re-run.
set -uo pipefail

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; }
miss() { printf '  \033[31mMISS\033[0m %s\n' "$1"; }

FAIL=0
echo "walkthrough preflight"
echo "---------------------"

# node
if command -v node >/dev/null 2>&1; then ok "node $(node -v)"; else miss "node not found (need >=18)"; FAIL=1; fi

# ffmpeg + ffprobe
if command -v ffmpeg >/dev/null 2>&1; then ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"; else miss "ffmpeg not found"; FAIL=1; fi
command -v ffprobe >/dev/null 2>&1 && ok "ffprobe present" || { miss "ffprobe not found"; FAIL=1; }

# playwright-cli + a browser
if command -v playwright-cli >/dev/null 2>&1; then
  ok "playwright-cli $(playwright-cli --version 2>/dev/null | head -1)"
else
  miss "playwright-cli not found — install with: npm i -g @playwright/cli"; FAIL=1
fi

# NOTE: vhs/ttyd are no longer used. Evidence panels (file / API response / log /
# output) render via playwright + ffmpeg — there is no terminal recording.

# claude-video (REQUIRED — the holistic "does the video show the real thing
# end-to-end?" review gate). Look where it installs (manual clone, codex, or a
# Claude Code plugin), or honor WALKTHROUGH_WATCH_PY.
WATCH_PY=""
if [ -n "${WALKTHROUGH_WATCH_PY:-}" ] && [ -f "${WALKTHROUGH_WATCH_PY}" ]; then
  WATCH_PY="$WALKTHROUGH_WATCH_PY"
else
  for c in "$HOME/.claude/skills/watch/scripts/watch.py" "$HOME/.codex/skills/watch/scripts/watch.py"; do
    [ -f "$c" ] && WATCH_PY="$c" && break
  done
  if [ -z "$WATCH_PY" ]; then
    WATCH_PY="$(find "$HOME/.claude/plugins" "$HOME/.claude/skills" -maxdepth 6 -name watch.py 2>/dev/null | grep -i watch | head -1)"
  fi
fi
if [ -n "$WATCH_PY" ]; then
  ok "claude-video present ($WATCH_PY)"
  command -v python3 >/dev/null 2>&1 && ok "python3 present (claude-video backend)" || { miss "python3 not found (claude-video needs it)"; FAIL=1; }
else
  miss "claude-video not found — the holistic video-review gate is REQUIRED. Install once:"
  printf '         /plugin marketplace add bradautomates/claude-video\n'
  printf '         /plugin install watch@claude-video\n'
  printf '       (or set WALKTHROUGH_WATCH_PY to an existing watch.py)\n'
  FAIL=1
fi

# tailscale (distribution)
if command -v tailscale >/dev/null 2>&1; then
  IP="$(tailscale ip -4 2>/dev/null | head -1)"
  if [ -n "$IP" ]; then ok "tailscale up — gallery will bind to $IP"; else warn "tailscale installed but no IP (run: tailscale up)"; fi
else
  warn "tailscale not found — local serving only (no phone link)"
fi

echo "---------------------"
if [ "$FAIL" -eq 0 ]; then echo "preflight: ready"; else echo "preflight: missing required tools (see MISS above)"; fi
exit "$FAIL"
