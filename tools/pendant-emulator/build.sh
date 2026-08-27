#!/usr/bin/env bash
# Build the emulator. `swift build` works once Xcode is installed; this
# swiftc fallback builds with the Command Line Tools alone (the CLT SwiftPM
# on this machine is broken - see docs/adr-pendant-direct.md D10).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
mkdir -p .build
xcrun swiftc -O Sources/main.swift -o .build/pendant-emulator -framework CoreBluetooth
echo "built .build/pendant-emulator"
