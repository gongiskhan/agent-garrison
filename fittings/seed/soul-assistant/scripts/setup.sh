#!/usr/bin/env bash
set -euo pipefail
mkdir -p ~/.garrison/assistant

# Seed context files if they don't exist yet
if [ ! -f ~/.garrison/assistant/context.md ]; then
  cat > ~/.garrison/assistant/context.md << 'EOF'
# Personal Context

Add key facts about yourself here. The assistant reads this at the start of every session.

Examples: family members' names and ages, dietary preferences, routines, recurring tasks.
EOF
fi

if [ ! -f ~/.garrison/assistant/dishes.md ]; then
  cat > ~/.garrison/assistant/dishes.md << 'EOF'
# Dishes

A list of meals the household eats regularly. Add your favorites here.
The assistant uses this file for weekly meal planning.
EOF
fi

if [ ! -f ~/.garrison/assistant/todos.md ]; then
  cat > ~/.garrison/assistant/todos.md << 'EOF'
# Todos

Running personal task list. Format: - [ ] task description
EOF
fi
