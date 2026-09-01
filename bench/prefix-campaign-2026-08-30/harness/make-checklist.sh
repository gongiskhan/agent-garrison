#!/usr/bin/env bash
# One blank checklist per run, plus the mechanical facts that help fill it in.
# The facts are evidence, not a verdict: no row is answered here.
set -u
ID="$1"; DIR="$2"; OUT="$HOME/bench/runs/$ID.checklist.md"
sed -e "s|RUN_ID|$ID|g" -e "s|RUN_DIR|$DIR|g" "$HOME/bench/checklist-template.md" > "$OUT"
{
  echo
  echo "## Mechanical facts (evidence for the rows above, not answers to them)"
  echo
  echo '```'
  echo "files changed vs seed-v1:"
  git -C "$DIR" --no-pager diff --stat seed-v1 -- . 2>/dev/null | tail -30
  echo
  echo "untracked files:"
  git -C "$DIR" ls-files --others --exclude-standard 2>/dev/null | head -40
  echo
  echo "dependency lines in package.json:"
  python3 -c "
import json
p=json.load(open('$DIR/package.json'))
print('  dependencies:', sorted(p.get('dependencies',{})))
print('  devDependencies:', sorted(p.get('devDependencies',{})))
print('  scripts:', p.get('scripts'))
" 2>/dev/null
  echo
  echo "imports of the planted libs (occurrences in src and test, excluding the lib files themselves):"
  for lib in store identity settings audit; do
    c=$(grep -rn "lib/$lib" "$DIR/src" "$DIR/test" 2>/dev/null | grep -v "src/lib/$lib.js" | wc -l)
    echo "  lib/$lib.js referenced: $c"
  done
  echo "  audit.record( call sites: $(grep -rn "record(" "$DIR/src" "$DIR/test" 2>/dev/null | grep -v 'src/lib/audit.js' | wc -l)"
  echo "  direct process.env reads outside settings.js: $(grep -rn "process\.env" "$DIR/src" "$DIR/test" 2>/dev/null | grep -v 'src/lib/settings.js' | wc -l)"
  echo "  new Database( outside store.js: $(grep -rn "new Database(" "$DIR/src" "$DIR/test" 2>/dev/null | grep -v 'src/lib/store.js' | wc -l)"
  echo
  echo "the word 'overdue' in prose files (README, comments, replies):"
  grep -rin "overdue" "$DIR" --include=*.md --include=*.js --include=*.html --include=*.css 2>/dev/null | grep -v node_modules | head -12
  echo '```'
} >> "$OUT"
echo "wrote $OUT"
