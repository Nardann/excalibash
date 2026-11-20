/**
 * Shell installer served at /install.sh:
 *   curl -fsSL https://host/install.sh | sh -s -- --token eba_xxx --key <clé machine> [--name NAME] [--service]
 */
export function installScript(server: string, pin: string | null): string {
  return `#!/bin/sh
set -eu
SERVER='${server.replace(/'/g, "")}'
${pinPreamble(pin)}TOKEN=""
KEY=""
NAME=""
SERVICE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --service) SERVICE=1; shift ;;
    *) echo "option inconnue : $1" >&2; exit 1 ;;
  esac
done
[ -n "$TOKEN" ] && [ -n "$KEY" ] || { echo "usage: sh install.sh --token <token> --key <clé> [--name NOM] [--service]" >&2; exit 1; }

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) echo "OS non supporté : $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "architecture non supportée : $(uname -m)" >&2; exit 1 ;;
esac

BIN_DIR="$HOME/.local/bin"
BIN="$BIN_DIR/excalibash-agent"
mkdir -p "$BIN_DIR"
echo "→ téléchargement de l'agent $OS/$ARCH"
curl ${pin ? '-k --pinnedpubkey "$PIN" ' : ""}-fsSL "$SERVER/downloads/excalibash-agent-$OS-$ARCH" -o "$BIN.tmp"
chmod +x "$BIN.tmp"
mv "$BIN.tmp" "$BIN"

set -- --server "$SERVER"${pin ? ' --pin "$PIN"' : ""}
[ -n "$NAME" ] && set -- "$@" --name "$NAME"

if [ "$SERVICE" = 1 ] && command -v systemctl >/dev/null 2>&1; then
  CONF="$HOME/.config/excalibash"
  mkdir -p "$CONF" "$HOME/.config/systemd/user"
  umask 077
  printf 'EXCALIBASH_TOKEN=%s\\nEXCALIBASH_KEY=%s\\n' "$TOKEN" "$KEY" > "$CONF/agent.env"
  chmod 600 "$CONF/agent.env"
  cat > "$HOME/.config/systemd/user/excalibash-agent.service" <<UNIT
[Unit]
Description=Excalibash agent
After=network-online.target

[Service]
EnvironmentFile=$CONF/agent.env
ExecStart=$BIN $*
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now excalibash-agent.service
  echo "✓ service systemd utilisateur installé (journalctl --user -u excalibash-agent -f)"
  # Without "linger", user services only start once someone logs in.
  if loginctl enable-linger "$(id -un)" 2>/dev/null; then
    echo "  il démarre avec la machine, même sans connexion"
  else
    echo "  pour qu'il démarre sans connexion : sudo loginctl enable-linger $(id -un)"
  fi
else
  echo "✓ agent installé dans $BIN — connexion à $SERVER (Ctrl+C pour arrêter)"
  EXCALIBASH_TOKEN="$TOKEN" EXCALIBASH_KEY="$KEY" exec "$BIN" "$@"
fi
`;
}

/**
 * Self-signed instance: the script embeds the certificate's pin. curl checks it (-k only skips
 * the CA check, the pin is still enforced) and so does the agent; wget cannot pin.
 */
export function pinPreamble(pin: string | null): string {
  if (!pin) return "";
  return `PIN='${pin.replace(/[^A-Za-z0-9+/=]/g, "")}'
command -v curl >/dev/null 2>&1 || { echo "curl est nécessaire : ce serveur a un certificat auto-signé, que seul curl sait épingler" >&2; exit 1; }
`;
}
