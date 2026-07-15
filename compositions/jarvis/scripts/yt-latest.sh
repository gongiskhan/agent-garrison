#!/usr/bin/env bash
# Latest videos of a YouTube channel via its public RSS feed (no API key).
# Prints one line per video: <videoId>\t<published>\t<title>, newest first.
# Usage: yt-latest.sh <@handle | channel URL | UC…channel-id> [count=3]
set -euo pipefail
IN="${1:?usage: yt-latest.sh <@handle|url|UC…> [count]}"
N="${2:-3}"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

if [[ "$IN" == UC* ]]; then
  CID="$IN"
else
  case "$IN" in
    http*) URL="$IN" ;;
    @*)    URL="https://www.youtube.com/$IN" ;;
    *)     URL="https://www.youtube.com/@$IN" ;;
  esac
  CID=$(curl -sL --compressed -A "$UA" "$URL" | grep -o '"externalId":"UC[^"]*"' | head -1 | cut -d'"' -f4 || true)
fi

if [ -z "${CID:-}" ]; then
  echo "canal não encontrado: $IN (tenta o @handle exato — pesquisa-o na web primeiro)" >&2
  exit 1
fi

# NB: python reads the XML from the pipe (stdin); the program rides in -c —
# a heredoc here would hijack stdin and the feed would arrive empty.
curl -s --compressed "https://www.youtube.com/feeds/videos.xml?channel_id=$CID" | python3 -c '
import sys, re, html
n = int(sys.argv[1]); xml = sys.stdin.read()
for e in re.findall(r"<entry>(.*?)</entry>", xml, re.S)[:n]:
    vid = re.search(r"<yt:videoId>(.*?)</yt:videoId>", e).group(1)
    title = html.unescape(re.search(r"<title>(.*?)</title>", e).group(1))
    pub = re.search(r"<published>(.*?)</published>", e).group(1)[:10]
    print(f"{vid}\t{pub}\t{title}")
' "$N"
