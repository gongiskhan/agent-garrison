#!/usr/bin/env bash
# Setup hook - runs in the FITTING dir. Side-effect-free beyond checks: the
# daemon has zero npm dependencies (global fetch) and creates its own state
# dir at boot. Missing runtime prerequisites WARN, never fail (slack-channel
# precedent: connection state is not an install prerequisite).
set -euo pipefail

major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "${major}" -lt 20 ]; then
  echo "email-channel: WARNING node ${major} < 20; the daemon needs global fetch (node >= 20)" >&2
fi
echo "email-channel: setup ok (no dependencies to install)"
