#!/usr/bin/env bash
# Start the standalone server with the given command and check it answers. Used by CI for Node, Bun and Deno.
#   bash scripts/smoke.sh node dist/server.mjs
#   bash scripts/smoke.sh bun dist/server.mjs
#   bash scripts/smoke.sh deno run --allow-net --allow-env --allow-read --allow-write dist/server.mjs
set -euo pipefail

PORT="${PORT:-8799}"
STATE_FILE="$(mktemp -d)/state.json"
export PORT STATE_FILE WEBHOOK_SECRET=whsec_smoke TICK_SECRET=smoke TICK_INTERVAL_S=0
export RULES_JSON='{"web_search":{"price":"0.04","floor":"0.025"}}'
unset FILOBOOK_API_KEY

"$@" > smoke.log 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
	curl -fsS "http://127.0.0.1:$PORT/health" > /dev/null 2>&1 && break
	sleep 0.2
done

check() {
	local want=$1; shift
	local got
	got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
	if [ "$got" != "$want" ]; then
		echo "FAIL: expected $want, got $got for $*"
		cat smoke.log
		exit 1
	fi
	echo "ok $want $*"
}

check 200 "http://127.0.0.1:$PORT/health"
check 401 -X POST -d '{}' "http://127.0.0.1:$PORT/webhook"
check 401 -X POST -H "authorization: Bearer wrong" "http://127.0.0.1:$PORT/tick"
check 503 -X POST -H "authorization: Bearer smoke" "http://127.0.0.1:$PORT/tick"
check 404 "http://127.0.0.1:$PORT/nope"
grep -q '"rules.loaded"' smoke.log || { echo "FAIL: RULES_JSON was not loaded"; cat smoke.log; exit 1; }
echo "ok rules loaded from RULES_JSON"

# A bad rules value must stop the server instead of quoting with wrong prices.
if RULES_JSON='{"web_search":{"price":"0.01","floor":"0.05"}}' PORT=$((PORT + 1)) timeout 15 "$@" > bad.log 2>&1; then
	echo "FAIL: server started with invalid rules"; cat bad.log; exit 1
fi
grep -q '"rules.invalid"' bad.log || { echo "FAIL: no rules.invalid log"; cat bad.log; exit 1; }
echo "ok invalid rules stop the server"

echo "smoke passed: $*"
