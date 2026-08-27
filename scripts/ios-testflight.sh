#!/usr/bin/env bash
# Build, sign and upload the Garrison companion to TestFlight from a Mac with
# Xcode (npm run ios:testflight). Thin wrapper over the fastlane `beta` lane —
# the SAME lane CI runs — with a fail-fast environment check so a missing
# credential halts with the exact missing item instead of half-building.
#
# Required env (see ios/fastlane/Fastfile):
#   ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8 APPLE_TEAM_ID MATCH_PASSWORD
# Optional: BUNDLE_ID MATCH_GIT_URL MATCH_GIT_BRANCH MATCH_FORCE
# First-ever run: FASTLANE_LANE=bootstrap npm run ios:testflight  (creates the
# App Store Connect app record, once).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../ios"

missing=()
for var in ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8 APPLE_TEAM_ID MATCH_PASSWORD; do
  [ -n "${!var:-}" ] || missing+=("$var")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "ios-testflight: missing required environment: ${missing[*]}" >&2
  echo "See ios/fastlane/Fastfile for what each is and RUNBOOK.md for where they live." >&2
  exit 2
fi

command -v xcodegen >/dev/null || { echo "ios-testflight: xcodegen not installed (brew install xcodegen)" >&2; exit 2; }
command -v bundle >/dev/null || { echo "ios-testflight: ruby bundler not installed" >&2; exit 2; }

bundle check >/dev/null 2>&1 || bundle install
bundle exec fastlane "${FASTLANE_LANE:-beta}"
