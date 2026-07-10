#!/usr/bin/env bash
# hook-stop-notify.sh

read -r HOOK_JSON

# Parse JSON to get transcript path + cwd
TRANSCRIPT=$(echo "$HOOK_JSON" | jq -r '.transcript_path')
PROJECT=$(echo "$HOOK_JSON" | jq -r '.cwd')

# Extract last assistant message from JSONL transcript
# Structure: each line is JSON with type="assistant" and message.content[] array
# We need to find text blocks inside message.content
SUMMARY=$(grep '"type":"assistant"' "$TRANSCRIPT" 2>/dev/null \
          | tail -n 1 \
          | jq -r '.message.content[] | select(.type == "text") | .text' 2>/dev/null \
          | head -c 200)

if [ -z "$SUMMARY" ]; then
  SUMMARY="Task completed"
fi

# Show macOS notification (no sound - we play our own louder one)
terminal-notifier -title "Claude Done: $(basename "$PROJECT")" \
                  -message "$SUMMARY"

# Play a loud, high-pitched sound that's audible at low volume
# -v 2 = 2x volume multiplier (can go higher if needed)
afplay -v 4 /System/Library/Sounds/Glass.aiff &