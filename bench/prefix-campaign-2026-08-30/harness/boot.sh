#!/usr/bin/env bash
# Boot all eight labelled apps on 3101-3108 plus the review UI on 3110.
# The port comes from settings.js's PORT override, so nothing in the app is
# edited. 3000 is deliberately untouched: it is held by something else.
set -u
R="$HOME/bench/review"
mkdir -p "$R/logs"
i=0
for L in A B C D E F G H; do
  PORT=$((3101+i)); i=$((i+1))
  D="$R/apps/$L"
  if [ ! -d "$D/node_modules" ]; then
    echo "installing $L ..."
    (cd "$D" && npm install --no-audit --no-fund > "$R/logs/$L.install.log" 2>&1)
  fi
  (cd "$D" && PORT=$PORT nohup npm start > "$R/logs/$L.log" 2>&1 &)
  echo "$L -> http://localhost:$PORT"
done
nohup node "$R/server.mjs" > "$R/logs/review.log" 2>&1 &
sleep 4
echo
for L in A B C D E F G H; do
  i=0; case $L in A) P=3101;; B) P=3102;; C) P=3103;; D) P=3104;; E) P=3105;; F) P=3106;; G) P=3107;; H) P=3108;; esac
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$P/" || echo 000)
  echo "  $L :$P -> HTTP $CODE"
done
echo
echo "review UI: http://localhost:3110    (over tailnet, use the machine's address)"
