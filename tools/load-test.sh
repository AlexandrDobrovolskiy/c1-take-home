#!/usr/bin/env bash
# One-command load test against an ISOLATED stack, with a live Grafana dashboard.
#
#   ./tools/load-test.sh              # full run, peak 3,000 sends/s
#   PEAK=6000 ./tools/load-test.sh    # heavier (hits the 6-replica ceiling)
#   OPEN=0 ./tools/load-test.sh       # don't auto-open the dashboard
#   ./tools/load-test.sh down         # tear the load stack down
#
# What it does: starts a second compose project (relay-load — own DBs/network,
# no port collisions with dev), seeds 50 users / 20 conversations / 10k
# messages, shrinks the api to 2 replicas, starts the CPU autoscaler, opens
# Grafana, and drives real message sends at the requested rate while k6
# streams its metrics onto the same dashboard. See docs/load-testing.md.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -p relay-load -f docker-compose.yml -f docker-compose.loadtest.yml)

if [[ "${1:-}" == "down" ]]; then
  "${COMPOSE[@]}" down
  exit 0
fi

PEAK="${PEAK:-${1:-3000}}"
OPEN="${OPEN:-1}"
DASHBOARD="http://localhost:3101/d/relay"

# Raised send limits so every request exercises the full write path — the
# limiter still runs its Redis check per request, it just never rejects.
# Exported (not inline) so the autoscaler's compose calls interpolate the
# same values into replicas it creates.
export SEND_RATE_CAPACITY=1000000
export SEND_RATE_REFILL_PER_SEC=100000

echo "==> starting isolated load stack (compose project: relay-load)"
"${COMPOSE[@]}" up -d --build

echo "==> waiting for the api to answer"
until [[ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/ || true)" == "200" ]]; do
  sleep 2
done

echo "==> seeding bulk data (50 users, 20 conversations, 10k messages — skips if present)"
"${COMPOSE[@]}" exec -T api npx tsx tests/load/seed.mts

echo "==> shrinking to 2 replicas so the autoscaler has room to react"
"${COMPOSE[@]}" up -d --no-deps --no-recreate --scale api=2 api
sleep 6 # let Envoy's DNS view settle on the new replica set

ASLOG="$(mktemp)"
node tools/autoscaler.mjs >"$ASLOG" 2>&1 &
AS_PID=$!
trap 'kill "$AS_PID" 2>/dev/null || true' EXIT
echo "==> autoscaler running (pid $AS_PID, min 2 / max 6, log: $ASLOG)"

echo "==> dashboard: $DASHBOARD (anonymous access, refreshes every 5s)"
if [[ "$OPEN" == "1" ]]; then
  if command -v open >/dev/null; then open "$DASHBOARD"
  elif command -v xdg-open >/dev/null; then xdg-open "$DASHBOARD"
  fi
fi

echo "==> running k6: write-path throughput, peak ${PEAK} sends/s (~2m40s) — watch the dashboard"
docker run --rm --network relay-load_default \
  -v "$PWD/tests/load:/scripts:ro" \
  -e PEAK="$PEAK" \
  -e K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write \
  grafana/k6 run -o experimental-prometheus-rw /scripts/k6-throughput.js

echo
echo "==> autoscaler decisions during the run:"
grep 'scaling' "$ASLOG" || echo "    (no scale events — try a higher PEAK)"
echo
echo "The stack stays up for exploring: $DASHBOARD"
echo "Tear down with: ./tools/load-test.sh down"
