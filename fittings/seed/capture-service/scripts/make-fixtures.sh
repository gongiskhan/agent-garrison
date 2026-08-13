#!/usr/bin/env bash
# Regenerate the committed audio fixtures. macOS-only by design: speech comes
# from `say` (Joana pt_PT / Samantha en_US) and encoding from ffmpeg's libopus.
# Deliberately bash + python3, not node — on macOS this repo's node is never
# run (house rule); fixture generation is a system-tool job.
#
# Output: fixtures/audio-<name>.jsonl — one raw Opus packet per line as
# {"seq": n, "ts": ms, "bytes": "<base64>"}, 16 kHz mono, ~20 ms packets,
# exactly what the wire protocol carries and what Deepgram's encoding=opus
# expects. The OpusHead/OpusTags header packets are stripped.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p fixtures
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

gen() {
  local name="$1" voice="$2" text="$3"
  say -v "$voice" -o "$tmp/$name.aiff" "$text"
  ffmpeg -y -loglevel error -i "$tmp/$name.aiff" -ar 16000 -ac 1 -c:a libopus -b:a 24k \
    -frame_duration 20 "$tmp/$name.ogg"
  python3 scripts/ogg-to-packets.py "$tmp/$name.ogg" > "fixtures/audio-$name.jsonl"
  echo "fixtures/audio-$name.jsonl: $(wc -l < "fixtures/audio-$name.jsonl" | tr -d ' ') packets"
}

# The spoken smoke-test command, in both languages the operator uses.
gen pt-command Joana "Zeca, cria uma tarefa de teste chamada olá companion."
gen en-command Samantha "Zeca, create a test task called hello companion."
# Ambient speech that must NOT wake: no name at all, and the name in
# object position (the address-position gate must reject it).
gen pt-ambient Joana "Amanhã vamos ao mercado comprar peixe fresco para o jantar."
gen en-nearmiss Samantha "I already told Zeca about the meeting yesterday."

echo "done"
