#!/bin/sh
# Bout en bout : serveur jetable + agent réel + deux utilisateurs (voir tests/e2e.mts).
# Prérequis : `make -C agent dist`, `npm install` dans server/ et web/.
set -eu
cd "$(dirname "$0")/.."
DATA=$(mktemp -d)
PORT=${PORT:-6797}
PROXY_PORT=${PROXY_PORT:-6799}
DATA_DIR="$DATA" PORT=$PORT PROXY_PORT=$PROXY_PORT node --disable-warning=ExperimentalWarning server/src/index.ts >"$DATA/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -rf "$DATA"' EXIT
sleep 1.5
BASE="http://127.0.0.1:$PORT" PROXY="http://127.0.0.1:$PROXY_PORT" DB="$DATA/excalibash.db" npx --yes tsx@4 tests/e2e.mts
