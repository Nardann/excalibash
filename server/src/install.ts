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

/**
 * Updates the agent in place: downloads the current binary, replaces it and restarts whatever runs
 * it. The machine identity is untouched: agent.json (pairing) and agent.env (token and key) stay
 * where they are, so the machine keeps its name, its keys and its shells' history in the boards.
 * Nothing secret in it: the same for everyone.
 */
export function updateScript(server: string, pin: string | null): string {
  const download = pin
    ? `curl -k --pinnedpubkey "$PIN" -fsSL "$SERVER/downloads/excalibash-agent-$OS-$ARCH" -o "$BIN.tmp"`
    : `if command -v curl >/dev/null 2>&1; then curl -fsSL "$SERVER/downloads/excalibash-agent-$OS-$ARCH" -o "$BIN.tmp"
else wget -qO "$BIN.tmp" "$SERVER/downloads/excalibash-agent-$OS-$ARCH"; fi`;
  return `#!/bin/sh
# Excalibash : met l'agent de cette machine à jour (garde son identité, ses clés et son service).
set -eu
SERVER='${server.replace(/'/g, "")}'
${pinPreamble(pin)}UNIT=excalibash-agent.service
BIN="$HOME/.local/bin/excalibash-agent"
CONFIG="$HOME/.config/excalibash/agent.json"
[ -e "$BIN" ] || { echo "Aucun agent trouvé dans $BIN : lance cette commande avec le compte (ou sudo) qui a installé l'agent." >&2; exit 1; }
if [ -f "/etc/systemd/system/$UNIT" ] && [ "$(id -u)" != 0 ]; then
  echo "L'agent est un service système : relance cette commande avec « sudo sh »." >&2
  exit 1
fi
case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) echo "OS non supporté : $(uname -s)" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "architecture non supportée : $(uname -m)" >&2; exit 1 ;; esac
echo "→ téléchargement de l'agent $OS/$ARCH"
${download}
chmod +x "$BIN.tmp"
"$BIN.tmp" --version >/dev/null 2>&1 || { rm -f "$BIN.tmp"; echo "Le fichier téléchargé n'est pas un agent valide." >&2; exit 1; }
echo "  version $("$BIN.tmp" --version) (avant : $("$BIN" --version 2>/dev/null || echo inconnue))"
mv "$BIN.tmp" "$BIN"

if [ -f "/etc/systemd/system/$UNIT" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl restart "$UNIT"
  echo "✓ agent mis à jour et service système relancé"
elif [ -f "$HOME/.config/systemd/user/$UNIT" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl --user restart "$UNIT"
  echo "✓ agent mis à jour et service utilisateur relancé"
elif command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -q 'excalibash-agent'; then
  command -v pkill >/dev/null 2>&1 && pkill -f "^$BIN( |\$)" 2>/dev/null || true
  sleep 1
  nohup "$BIN" --config "$CONFIG" >/dev/null 2>&1 &
  echo "✓ agent mis à jour et relancé"
else
  echo "✓ agent mis à jour dans $BIN. Il n'est lancé par aucun service connu : arrête-le et relance-le à la main pour utiliser la nouvelle version."
fi
`;
}

/**
 * Removes the agent from a machine, whichever way it was installed (system service as root, user
 * service, @reboot crontab entry, or started by hand): stops it, then deletes its binary and its
 * configuration (machine key, token, known SSH hosts). Nothing secret in it: the same for everyone.
 */
export function uninstallScript(): string {
  return `#!/bin/sh
# Excalibash : retire l'agent de cette machine (service, binaire, configuration et clés).
set -u
BIN="$HOME/.local/bin/excalibash-agent"
CONF="$HOME/.config/excalibash"
UNIT=excalibash-agent.service

if [ -f "/etc/systemd/system/$UNIT" ]; then
  if [ "$(id -u)" = 0 ]; then
    systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$UNIT"
    systemctl daemon-reload >/dev/null 2>&1 || true
    echo "✓ service système retiré"
  else
    echo "⚠ un service système excalibash-agent existe : relance cette commande avec sudo pour le retirer aussi" >&2
  fi
fi
if [ -f "$HOME/.config/systemd/user/$UNIT" ]; then
  systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
  rm -f "$HOME/.config/systemd/user/$UNIT"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  echo "✓ service utilisateur retiré"
fi
if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -q 'excalibash-agent'; then
  crontab -l 2>/dev/null | grep -v 'excalibash-agent' | crontab -
  echo "✓ démarrage automatique (crontab) retiré"
fi
# Only processes started as this program (the command line begins with its path).
if command -v pkill >/dev/null 2>&1 && pkill -f "^$BIN( |\$)" 2>/dev/null; then
  echo "✓ agent arrêté"
fi
if [ -e "$BIN" ]; then
  rm -f "$BIN" "$BIN.tmp"
  echo "✓ programme supprimé ($BIN)"
fi
if [ -d "$CONF" ]; then
  rm -rf -- "$CONF"
  echo "✓ configuration et clés supprimées ($CONF)"
fi
echo "Agent Excalibash retiré de cette machine."
`;
}
