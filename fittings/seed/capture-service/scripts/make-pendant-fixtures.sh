#!/usr/bin/env bash
# Generate the ADDITIONAL pendant-path audio fixtures. Additive on purpose:
# the four original fixtures from make-fixtures.sh are left byte-identical so
# nothing depending on them shifts. Same pipeline and format as
# make-fixtures.sh: macOS `say` -> ffmpeg libopus 16 kHz mono 20 ms frames
# (the consumer pendant's Opus shape, codec id 21) -> ogg-to-packets.py ->
# fixtures/audio-<name>.jsonl with one raw Opus packet per line
# {"seq": n, "ts": ms, "bytes": "<base64>"}.
#
# Deliberately bash + python3, not node - on macOS this repo's node is never
# run (house rule); fixture generation is a system-tool job.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p fixtures
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

encode() {
  local name="$1" src="$2"
  ffmpeg -y -loglevel error -i "$src" -ar 16000 -ac 1 -c:a libopus -b:a 24k \
    -frame_duration 20 "$tmp/$name.ogg"
  python3 scripts/ogg-to-packets.py "$tmp/$name.ogg" > "fixtures/audio-$name.jsonl"
  echo "fixtures/audio-$name.jsonl: $(wc -l < "fixtures/audio-$name.jsonl" | tr -d ' ') packets"
}

gen() {
  local name="$1" voice="$2" text="$3"
  say -v "$voice" -o "$tmp/$name.aiff" "$text"
  encode "$name" "$tmp/$name.aiff"
}

# say output is 22050 Hz mono AIFF; silence gaps must match before concat.
speak_wav() {
  local out="$1" voice="$2" text="$3"
  say -v "$voice" -o "$tmp/say-tmp.aiff" "$text"
  ffmpeg -y -loglevel error -i "$tmp/say-tmp.aiff" -ar 16000 -ac 1 "$out"
}

silence_wav() {
  local out="$1" seconds="$2"
  ffmpeg -y -loglevel error -f lavfi -i "anullsrc=r=16000:cl=mono" -t "$seconds" "$out"
}

# The real-device smoke phrase from the run script, in both languages.
gen pt-hellogarrison Joana "Zeca, cria uma tarefa de teste chamada olá garrison."
gen en-hellogarrison Samantha "Zeca, create a test task called hello garrison."

# A true near-miss under the token-anywhere gate: similar-sounding words that
# must NOT match the wake regex (biblioteca, seca, Rebeca).
gen pt-truemiss Joana "A biblioteca estava seca e a Rebeca ficou em casa."

# The bare wake word: a hit with an empty command. Exercises the
# empty-command dead end and the wake_detected-without-card feedback case.
gen pt-barewake Joana "Zeca."

# Multi-utterance window sequence: wake plus command, a 2 s pause (inside the
# silence-close window at the live 15 s setting, past the 4 s default - the
# e2e pins its own config), a second phrase, then 8 s of trailing silence past
# any close threshold.
speak_wav "$tmp/w1.wav" Joana "Zeca, cria uma tarefa de teste chamada olá garrison."
silence_wav "$tmp/s1.wav" 2.0
speak_wav "$tmp/w2.wav" Joana "Adiciona uma nota sobre a reunião de amanhã."
silence_wav "$tmp/s2.wav" 8.0
cat > "$tmp/concat.txt" <<EOF
file '$tmp/w1.wav'
file '$tmp/s1.wav'
file '$tmp/w2.wav'
file '$tmp/s2.wav'
EOF
ffmpeg -y -loglevel error -f concat -safe 0 -i "$tmp/concat.txt" "$tmp/window.wav"
encode pt-window "$tmp/window.wav"

echo "done"
