#!/usr/bin/env bash
# Open the Relay Grafana dashboard.
#
#   ./tools/open-dashboard.sh        # dev stack   (docker compose up)
#   ./tools/open-dashboard.sh load   # load stack  (./tools/load-test.sh)
set -euo pipefail

case "${1:-dev}" in
  dev)  URL="http://localhost:3001/d/relay" ;;
  load) URL="http://localhost:3101/d/relay" ;;
  *) echo "usage: $0 [dev|load]" >&2; exit 1 ;;
esac

echo "$URL"
if command -v open >/dev/null; then open "$URL"
elif command -v xdg-open >/dev/null; then xdg-open "$URL"
fi
