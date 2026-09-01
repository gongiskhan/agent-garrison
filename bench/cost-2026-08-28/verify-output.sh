#!/usr/bin/env bash
# Part 7 — quality and scope, measured, nothing fixed.
#
# Cost without quality is meaningless, and so is cost without scope. This runs
# the stated acceptance criteria against a produced directory exactly as written
# and records what happened, including verbatim failure output. It never edits
# the project: a run that does not build is reported as a run that does not
# build.
#
#   usage: verify-output.sh <dir> <label> <outfile>
set -u
DIR="$1"; LABEL="$2"; OUT="$3"
PORT=3000
exec > >(tee "$OUT") 2>&1

echo "=================================================================="
echo "QUALITY + SCOPE — $LABEL"
echo "dir: $DIR"
echo "=================================================================="

cd "$DIR" || { echo "FATAL: no such directory"; exit 1; }

section() { echo; echo "------------------------------------------------------------------"; echo "## $1"; echo "------------------------------------------------------------------"; }

section "scope: what was produced"
echo "--- tracked-ish file list (excluding .git, node_modules, dist, .codegraph) ---"
find . -type f \
  -not -path './.git/*' -not -path './node_modules/*' \
  -not -path './dist/*' -not -path './.codegraph/*' \
  -not -name 'package-lock.json' | sort
echo
echo "file count (same exclusions):"
find . -type f -not -path './.git/*' -not -path './node_modules/*' \
  -not -path './dist/*' -not -path './.codegraph/*' -not -name 'package-lock.json' | wc -l
echo
echo "lines of source (.ts/.js/.tsx, excluding node_modules/dist):"
find . -type f \( -name '*.ts' -o -name '*.js' -o -name '*.tsx' \) \
  -not -path './node_modules/*' -not -path './dist/*' -not -path './.codegraph/*' \
  -exec wc -l {} + | tail -1
echo
echo "--- package.json ---"
cat package.json 2>/dev/null || echo "(no package.json)"
echo
echo "dependencies declared:"
python3 -c "
import json
try: p=json.load(open('package.json'))
except Exception as e: print('  (unreadable:', e, ')'); raise SystemExit
d=p.get('dependencies',{}); dev=p.get('devDependencies',{})
print('  runtime :', len(d), sorted(d))
print('  dev     :', len(dev), sorted(dev))
print('  total   :', len(d)+len(dev))
" 2>/dev/null

section "npm install"
npm install --no-audit --no-fund 2>&1 | tail -15
echo "npm install exit: ${PIPESTATUS[0]}"

section "npm test"
npm test 2>&1 | tail -60
echo "npm test exit: ${PIPESTATUS[0]}"

section "typescript strict compile"
echo "--- tsconfig strict setting ---"
python3 -c "
import json,re
try: raw=open('tsconfig.json').read()
except Exception as e: print('  (no tsconfig:', e, ')'); raise SystemExit
raw=re.sub(r'//.*','',raw); raw=re.sub(r'/\*.*?\*/','',raw,flags=re.S)
try:
    t=json.loads(raw); co=t.get('compilerOptions',{})
    print('  strict =', co.get('strict'), '| noEmit not forced here')
except Exception as e: print('  (unparseable tsconfig:', e, ')')
"
echo "--- tsc --noEmit ---"
npx --no-install tsc --noEmit 2>&1 | tail -30
echo "tsc exit: ${PIPESTATUS[0]}"

section "server starts on port $PORT"
( npm start > /tmp/bench-server-$LABEL.log 2>&1 & echo $! > /tmp/bench-server-$LABEL.pid )
for i in $(seq 1 40); do
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/todos"; then break; fi
  sleep 1
done
UP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/todos" || echo "000")
echo "GET /todos returned: $UP  (000 = never came up)"
# Guard: :3000 is a popular port. If the responder is not a JSON todo API, the
# endpoint results below would describe somebody else's server.
BODY=$(curl -s --max-time 3 "http://127.0.0.1:$PORT/todos" || true)
case "$BODY" in
  \[*|\{*) echo "responder check: JSON — this is the project under test" ;;
  *) echo "responder check: NOT JSON — a foreign server holds port $PORT; endpoint results below are VOID"; UP="000" ;;
esac
echo "--- server log tail ---"; tail -20 "/tmp/bench-server-$LABEL.log"

if [ "$UP" != "000" ]; then
section "endpoint behaviour (curl)"
say() { printf '\n### %s\n' "$1"; }

say "POST /todos — valid"
curl -s -i -X POST "http://127.0.0.1:$PORT/todos" -H 'content-type: application/json' \
  -d '{"title":"write the report"}' | head -20

say "POST /todos — empty title (expect 400 {\"error\":...})"
curl -s -i -X POST "http://127.0.0.1:$PORT/todos" -H 'content-type: application/json' \
  -d '{"title":""}' | head -12

say "POST /todos — title over 200 chars (expect 400)"
LONG=$(python3 -c "print('x'*201)")
curl -s -i -X POST "http://127.0.0.1:$PORT/todos" -H 'content-type: application/json' \
  -d "{\"title\":\"$LONG\"}" | head -12

say "POST /todos — missing title (expect 400)"
curl -s -i -X POST "http://127.0.0.1:$PORT/todos" -H 'content-type: application/json' \
  -d '{}' | head -12

say "GET /todos — list"
curl -s "http://127.0.0.1:$PORT/todos" | head -c 600; echo

ID=$(curl -s -X POST "http://127.0.0.1:$PORT/todos" -H 'content-type: application/json' \
  -d '{"title":"to be filtered"}' | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('id',''))
except: print('')")
echo; echo "created id for follow-ups: '$ID'"

say "GET /todos/:id — existing"
curl -s -i "http://127.0.0.1:$PORT/todos/$ID" | head -12

say "GET /todos/:id — unknown (expect 404 {\"error\":...})"
curl -s -i "http://127.0.0.1:$PORT/todos/00000000-0000-0000-0000-000000000000" | head -12

say "PATCH /todos/:id — set completed true"
curl -s -i -X PATCH "http://127.0.0.1:$PORT/todos/$ID" -H 'content-type: application/json' \
  -d '{"completed":true}' | head -14

say "GET /todos?completed=true — filter"
curl -s "http://127.0.0.1:$PORT/todos?completed=true" | head -c 600; echo

say "GET /todos?completed=false — filter"
curl -s "http://127.0.0.1:$PORT/todos?completed=false" | head -c 600; echo

say "PATCH /todos/:id — unknown id (expect 404)"
curl -s -i -X PATCH "http://127.0.0.1:$PORT/todos/00000000-0000-0000-0000-000000000000" \
  -H 'content-type: application/json' -d '{"completed":true}' | head -12

say "DELETE /todos/:id"
curl -s -i -X DELETE "http://127.0.0.1:$PORT/todos/$ID" | head -12

say "DELETE /todos/:id — unknown id (expect 404)"
curl -s -i -X DELETE "http://127.0.0.1:$PORT/todos/00000000-0000-0000-0000-000000000000" | head -12

say "GET /todos/:id — after delete (expect 404)"
curl -s -i "http://127.0.0.1:$PORT/todos/$ID" | head -12
fi

section "teardown"
PIDF="/tmp/bench-server-$LABEL.pid"
if [ -f "$PIDF" ]; then
  pkill -P "$(cat "$PIDF")" 2>/dev/null
  kill "$(cat "$PIDF")" 2>/dev/null
fi
# npm start spawns a child; make sure the port is free for the next run.
fuser -k "$PORT/tcp" 2>/dev/null
sleep 1
echo "port $PORT free: $(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:$PORT/todos || echo 'yes-free')"

section "README"
sed -n '1,60p' README.md 2>/dev/null || echo "(no README.md)"

echo
echo "=================================================================="
echo "END — $LABEL"
echo "=================================================================="
