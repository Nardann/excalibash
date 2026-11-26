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
# Historique des tableaux : HISTORY_INTERVAL_MIN=0 = une version à chaque enregistrement (pas de délai minimum),
# HISTORY_KEEP=3 pour tester la rétention.
HISTORY_INTERVAL_MIN=0 HISTORY_KEEP=3 TLS=off SMTP_TRANSPORT=log DATA_DIR="$DATA" PORT=$PORT PROXY_PORT=$PROXY_PORT node --disable-warning=ExperimentalWarning server/src/index.ts >"$DATA/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true; rm -rf "$DATA"' EXIT
sleep 1.5
BASE="http://127.0.0.1:$PORT" PROXY="http://127.0.0.1:$PROXY_PORT" DB="$DATA/excalibash.db" npx --yes tsx@4 tests/e2e.mts
kill $SERVER 2>/dev/null || true

# Navigateur réel (Chrome piloté par Playwright) : serveur neuf (premier compte créé par l'interface), même agent.
# Chrome : CHROME_PATH, sinon google-chrome / chromium du PATH. Absent : ignoré en local, échec en CI (variable CI).
CHROME_PATH=${CHROME_PATH:-$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true)}
if [ -n "$CHROME_PATH" ]; then
  BDATA=$(mktemp -d)
  BPORT=${BROWSER_PORT:-$((PORT + 1))}
  BPROXY_PORT=${BROWSER_PROXY_PORT:-$((PROXY_PORT + 1))}
  HISTORY_INTERVAL_MIN=0 HISTORY_KEEP=3 TLS=off SMTP_TRANSPORT=log DATA_DIR="$BDATA" PORT=$BPORT PROXY_PORT=$BPROXY_PORT node --disable-warning=ExperimentalWarning server/src/index.ts >"$BDATA/server.log" 2>&1 &
  BSERVER=$!
  trap 'kill $SERVER $BSERVER 2>/dev/null || true; rm -rf "$DATA" "$BDATA"' EXIT
  sleep 1.5
  # Captures d'écran en cas d'échec : $BDATA/shots (copiées dans $SHOTS_DIR si défini, pour les artefacts de CI).
  status=0
  CHROME_PATH="$CHROME_PATH" BASE="http://127.0.0.1:$BPORT" DB="$BDATA/excalibash.db" npx --yes tsx@4 tests/browser.mts || status=$?
  if [ "$status" -ne 0 ] && [ -n "${SHOTS_DIR:-}" ] && [ -d "$BDATA/shots" ]; then mkdir -p "$SHOTS_DIR" && cp "$BDATA"/shots/* "$SHOTS_DIR"/; fi
  kill $BSERVER 2>/dev/null || true
  [ "$status" -eq 0 ] || exit "$status"
elif [ -n "${CI:-}" ]; then
  echo "Chrome introuvable : la suite navigateur est obligatoire en CI" >&2
  exit 1
else
  echo "⚠ Chrome introuvable (CHROME_PATH) : suite navigateur ignorée"
fi

# Export de topologie, génération de config, vérification du schéma, protocole du noyau, fenêtres de code et notebooks (fonctions pures, sans serveur).
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/agentCaps.test.ts
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/board/topology.test.ts
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/board/captureManager.test.ts
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/board/configGen.test.ts
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/board/schemaCheck.test.ts
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/board/kernelProtocol.test.ts
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/board/code.test.ts
node --disable-warning=ExperimentalWarning --experimental-transform-types web/src/board/notebook.test.ts
TLS_PORT=${TLS_PORT:-6791} TLS_PROXY_PORT=${TLS_PROXY_PORT:-6792} node --disable-warning=ExperimentalWarning tests/tls.mts
