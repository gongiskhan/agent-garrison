#!/bin/sh
# Claude Code status line command
# Format: folder | branch | context% | model@effort | N files in diff | http://localhost:<app.port>

input=$(cat)

# --- directory & branch ---
cwd=$(echo "$input" | jq -r '.workspace.current_dir')
dir=$(basename "$cwd")
branch=$(cd "$cwd" 2>/dev/null && git --no-optional-locks -c core.useBuiltinFSMonitor=false rev-parse --abbrev-ref HEAD 2>/dev/null || true)

# --- context window ---
usage=$(echo "$input" | jq '.context_window.current_usage')
if [ "$usage" != "null" ] && [ -n "$usage" ]; then
  current=$(echo "$usage" | jq '.input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens')
  size=$(echo "$input" | jq '.context_window.context_window_size')
  ctx="$((current * 100 / size))%"
else
  ctx="0%"
fi

# --- model @ effort ---
model=$(echo "$input" | jq -r '.model.display_name')
effort=$(echo "$input" | jq -r '.effort.level // empty')
if [ -n "$effort" ]; then
  model_str="${model}@${effort}"
else
  model_str="${model}"
fi

# --- git diff file count ---
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
RESET='\033[0m'

diff_str=""
if [ -n "$branch" ]; then
  file_count=$(cd "$cwd" 2>/dev/null && git --no-optional-locks -c core.useBuiltinFSMonitor=false diff --name-only HEAD 2>/dev/null | wc -l | tr -d ' ')
  file_count=${file_count:-0}

  # Color file count (green =0, yellow ≤15, red >15)
  if [ "$file_count" -eq 0 ]; then
    fc="${GREEN}${file_count}${RESET}"
  elif [ "$file_count" -le 15 ]; then
    fc="${YELLOW}${file_count}${RESET}"
  else
    fc="${RED}${file_count}${RESET}"
  fi

  diff_str=" | ${fc} files"
fi

# --- app port URL ---
app_port_file="${cwd}/app.port"
url_str=""
if [ -f "$app_port_file" ]; then
  app_port=$(cat "$app_port_file" 2>/dev/null | tr -d '[:space:]')
  if [ -n "$app_port" ]; then
    url_str=" | http://localhost:${app_port}"
  fi
fi

# --- assemble ---
if [ -n "$branch" ]; then
  printf '%b' "${dir} | ${branch} | ${ctx} | ${model_str}${diff_str}${url_str}"
else
  printf '%b' "${dir} | ${ctx} | ${model_str}${diff_str}${url_str}"
fi
