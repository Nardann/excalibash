#!/bin/sh
# Bout en bout : serveur jetable + agent réel + deux utilisateurs (voir tests/e2e.mts),
# puis HTTPS par défaut : certificat auto-signé, redirection, épinglage (voir tests/tls.mts).
# Prérequis : `make -C agent dist` (le client MCP est construit ici), `npm install` dans server/ et web/.
set -eu
cd "$(dirname "$0")/.."
(cd web && npm run build:mcp >/dev/null)
DATA=$(mktemp -d)
PORT=${PORT:-6797}
PROXY_PORT=${PROXY_PORT:-6799}
TLS=off SMTP_TRANSPORT=log DATA_DIR="$DATA" PORT=$PORT PROXY_PORT=$PROXY_PORT node --disable-warning=ExperimentalWarning server/src/index.ts >"$DATA/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true; rm -rf "$DATA"' EXIT
sleep 1.5
BASE="http://127.0.0.1:$PORT" PROXY="http://127.0.0.1:$PROXY_PORT" DB="$DATA/excalibash.db" npx --yes tsx@4 tests/e2e.mts
kill $SERVER 2>/dev/null || true

# Export de topologie (fonctions pures, sans serveur).
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/board/topology.test.ts
TLS_PORT=${TLS_PORT:-6791} TLS_PROXY_PORT=${TLS_PROXY_PORT:-6792} node --disable-warning=ExperimentalWarning tests/tls.mts
