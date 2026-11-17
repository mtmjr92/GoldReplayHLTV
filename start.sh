#!/usr/bin/env bash
# Starts GoldReplayHLTV on a local web server (needed to read the assets/ folder).
cd "$(dirname "$0")"
PORT="${1:-8000}"
URL="http://localhost:$PORT/"
echo "GoldReplayHLTV at $URL  (Ctrl+C to stop)"
( sleep 1; xdg-open "$URL" >/dev/null 2>&1 || open "$URL" >/dev/null 2>&1 ) &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
