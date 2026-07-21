#!/usr/bin/env bash
read -r HOOK_INPUT

NOTIF_MSG=$(echo "$HOOK_INPUT" | jq -r '.message // "Notification"')
NOTIF_TYPE=$(echo "$HOOK_INPUT" | jq -r '.notification_type // "info"')

# Escape special characters for AppleScript
NOTIF_MSG_ESCAPED=$(echo "$NOTIF_MSG" | sed 's/\\/\\\\/g; s/"/\\"/g')
NOTIF_TYPE_ESCAPED=$(echo "$NOTIF_TYPE" | sed 's/\\/\\\\/g; s/"/\\"/g')

osascript -e "display notification \"${NOTIF_MSG_ESCAPED}\" with title \"Claude Code: ${NOTIF_TYPE_ESCAPED}\" sound name \"Ping\""