#!/usr/bin/env bash
# Sets up Transfer Portal's signaling server on this Ubuntu PC and puts it online with Tailscale Funnel.
#   sudo bash setup-ubuntu.sh
# What it does:
#   1. installs Node.js (18 or newer) and curl if they're missing
#   2. copies the server to /opt/transfer-portal-server and runs it as its own locked-down account, only on
#      127.0.0.1:8787 (nothing on your home network can reach it directly)
#   3. starts it at every boot (systemd service "transfer-portal-signal")
#   4. installs Tailscale if needed and signs this PC in (you open a link and sign in once)
#   5. turns on Tailscale Funnel, which gives the server a public, encrypted address (https://<pc>.<tailnet>.ts.net)
#      without opening any port on your router
# Running it again is safe: it updates the server files and leaves everything else as it is.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Run it with sudo:  sudo bash $0"; exit 1; fi
RUN_USER="${SUDO_USER:-}"
if [ -z "$RUN_USER" ] || [ "$RUN_USER" = root ]; then echo "Run it with sudo from your normal account (not as root)."; exit 1; fi
HERE="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/transfer-portal-server
PORT=8787
say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }

say "1/5  Node.js and curl"
export DEBIAN_FRONTEND=noninteractive
need_apt=()
command -v curl >/dev/null || need_apt+=(curl)
node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 18 ]; then need_apt+=(nodejs npm); fi
if [ ${#need_apt[@]} -gt 0 ]; then apt-get update -qq; apt-get install -y -qq "${need_apt[@]}"; fi
if [ "$(node_major)" -lt 18 ]; then
  # older Ubuntu releases ship an old Node: take the current long-term one from the Snap Store instead
  snap install node --classic --channel=22
  hash -r
fi
NODE="$(command -v node)"
echo "Node $("$NODE" -v) at $NODE"

say "2/5  Server files"
id tpsignal >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin tpsignal
mkdir -p "$APP"
cp "$HERE/server.js" "$HERE/mailer.js" "$HERE/mail-logo.png" "$HERE/package.json" "$HERE/package-lock.json" "$APP/"
cd "$APP"
NPM="$(dirname "$NODE")/npm"; [ -x "$NPM" ] || NPM="$(command -v npm)"
"$NPM" ci --omit=dev --no-audit --no-fund --loglevel=error || "$NPM" install --omit=dev --no-audit --no-fund --loglevel=error
chown -R root:root "$APP"   # the service can read its code but not change it

say "3/5  Service (starts at every boot)"
cat > /etc/systemd/system/transfer-portal-signal.service <<EOF
[Unit]
Description=Transfer Portal signaling server
After=network-online.target
Wants=network-online.target

[Service]
User=tpsignal
Group=tpsignal
WorkingDirectory=$APP
Environment=PORT=$PORT HOST=127.0.0.1
ExecStart=$NODE $APP/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=256M
# locked messages for PCs that are away live here; setup-notify.sh adds phone/email settings to the env file
StateDirectory=transfer-portal-signal
StateDirectoryMode=0700
EnvironmentFile=-/etc/transfer-portal-signal.env

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now transfer-portal-signal >/dev/null
systemctl restart transfer-portal-signal
for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/" || { echo "The server didn't start - see: journalctl -u transfer-portal-signal -n 50"; exit 1; }

say "4/5  Tailscale"
if ! command -v tailscale >/dev/null; then curl -fsSL https://tailscale.com/install.sh | sh; fi
systemctl enable --now tailscaled >/dev/null 2>&1 || true
if ! tailscale status >/dev/null 2>&1; then
  echo "Sign this PC in to Tailscale: open the link below on any device, sign in, then come back here."
  tailscale up
fi
tailscale status >/dev/null 2>&1 || { echo "Tailscale isn't signed in yet - run this script again once you've signed in."; exit 1; }

say "5/5  Funnel (the public, encrypted address)"
echo "If a link appears, open it and turn Funnel on for this PC; it continues by itself."
tailscale funnel --bg "$PORT"
NAME="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"

say "Done"
echo "Check it from any device: https://$NAME  (it should say: Transfer Portal signaling OK)"
echo
echo "Your signaling server address for Transfer Portal / Airlock:"
echo "    wss://$NAME"
echo
echo "Useful later:  status  systemctl status transfer-portal-signal   |   logs  journalctl -u transfer-portal-signal -f"
echo "               take it offline  sudo tailscale funnel reset   |   remove  sudo systemctl disable --now transfer-portal-signal"
