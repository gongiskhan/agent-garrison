#!/usr/bin/env bash
# Projects-index verify. Probes that projects_root exists and is
# readable. The "at least one project" check is a Phase 2 done-when
# item documented in PHASE2_VERIFICATION.md, not a verify gate —
# fresh machines and renamed dirs shouldn't fail install.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --probe prints "ok" on success, which matches expect: ok in apm.yml.
exec python3 "$SCRIPT_DIR/projects.py" --probe
