#!/usr/bin/env bash
# Transfer Portal - mailbox + notices setup for the Ubuntu signaling server (run once, with sudo):
#   sudo bash setup-notify.sh
# It:
#   1. updates the signaling server (server.js from this folder) and gives it a private folder for the mailbox
#   2. installs ntfy (phone notices) from its official apt repository, on this PC only (127.0.0.1)
#   3. publishes ntfy through Tailscale Funnel on port 8443 (same address, https://<name>.ts.net:8443)
#   4. sets up email notices, which the signaling server sends itself (mailer.js) through a Gmail account using an
#      APP PASSWORD that you type here (it's never shown; it's kept in /etc/transfer-portal-signal.env, root-only)
# Safe to run again: it keeps an existing ntfy token and asks before changing the email setup.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "Run it with sudo:  sudo bash $0"; exit 1; }
for f in server.js mailer.js mail-logo.png; do [ -f "$HERE/$f" ] || { echo "$f must be next to this script"; exit 1; }; done

TS_NAME="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
[ -n "$TS_NAME" ] || { echo "Couldn't read this PC's Tailscale name - is Tailscale running?"; exit 1; }
PUBLIC="https://$TS_NAME:8443"
NODE="$(grep -o '^ExecStart=[^ ]*' /etc/systemd/system/transfer-portal-signal.service | cut -d= -f2)"; [ -x "$NODE" ] || NODE="$(command -v node)"
echo "== Transfer Portal notices setup on $TS_NAME"

# ---- 1. the signaling server: new code + a mailbox folder (/var/lib/transfer-portal-signal) ----
echo "-- updating the signaling server"
for f in server.js mailer.js mail-logo.png; do install -o root -g root -m 644 "$HERE/$f" "/opt/transfer-portal-server/$f"; done
mkdir -p /etc/systemd/system/transfer-portal-signal.service.d
cat > /etc/systemd/system/transfer-portal-signal.service.d/mailbox.conf <<'EOF'
[Service]
# the mailbox's locked messages live here (ProtectSystem=strict leaves the rest read-only)
StateDirectory=transfer-portal-signal
StateDirectoryMode=0700
EnvironmentFile=-/etc/transfer-portal-signal.env
EOF

# ---- 2. ntfy ----
if ! command -v ntfy >/dev/null; then
  echo "-- installing ntfy (official repository)"
  mkdir -p /etc/apt/keyrings
  curl -fsSL -o /etc/apt/keyrings/ntfy.gpg https://archive.ntfy.sh/apt/keyring.gpg
  apt-get install -y apt-transport-https >/dev/null
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/ntfy.gpg] https://archive.ntfy.sh/apt stable main" > /etc/apt/sources.list.d/ntfy.list
  apt-get update -qq
  apt-get install -y ntfy
fi
mkdir -p /var/lib/ntfy /var/cache/ntfy
chown ntfy:ntfy /var/lib/ntfy /var/cache/ntfy 2>/dev/null || true

# email: a Gmail app password (Google account > Security > 2-Step Verification > App passwords)
# The signaling server sends the emails itself, so they arrive as "Transfer Portal", not as a web address.
ENVF=/etc/transfer-portal-signal.env
GMAIL="$(grep -s '^SMTP_USER=' "$ENVF" | cut -d= -f2- || true)"
APPPASS="$(grep -s '^SMTP_PASS=' "$ENVF" | cut -d= -f2- || true)"
ASK=1
if [ -n "$APPPASS" ]; then
  read -r -p "Email is already set up ($GMAIL). Change it? [y/N] " A
  [[ "$A" =~ ^[Yy] ]] || ASK=0
elif [ -f /etc/ntfy/server.yml ] && grep -q '^smtp-sender-pass:' /etc/ntfy/server.yml; then
  echo "Email moves from ntfy to the signaling server now, so it needs the app password once more."
fi
if [ "$ASK" = 1 ]; then
  GMAIL=""; APPPASS=""
  read -r -p "Gmail address to send notices from [alchemy.labs.dg@gmail.com] (or type 'skip'): " GMAIL
  GMAIL="${GMAIL:-alchemy.labs.dg@gmail.com}"
  if [ "$GMAIL" = "skip" ]; then GMAIL=""; else
    read -r -s -p "Its app password (16 letters, typed hidden): " APPPASS; echo
    APPPASS="${APPPASS// /}"
    [ ${#APPPASS} -ge 16 ] || { echo "That doesn't look like an app password (16 letters)."; exit 1; }
  fi
fi

echo "-- writing /etc/ntfy/server.yml"
[ -f /etc/ntfy/server.yml ] && cp /etc/ntfy/server.yml "/etc/ntfy/server.yml.before-transfer-portal.$(date +%s)"
cat > /etc/ntfy/server.yml <<EOF
# ntfy for Transfer Portal notices (written by setup-notify.sh)
base-url: "$PUBLIC"
listen-http: "127.0.0.1:2586"
behind-proxy: true
cache-file: "/var/cache/ntfy/cache.db"
cache-duration: "24h"
auth-file: "/var/lib/ntfy/user.db"
# anyone may SUBSCRIBE to a topic they know (each PC's topic is a long random secret); only our server may publish
auth-default-access: "read-only"
# iPhones: Apple's push service is reached through ntfy.sh (it only gets a message id, never the text)
upstream-base-url: "https://ntfy.sh"
EOF
chown root:ntfy /etc/ntfy/server.yml; chmod 640 /etc/ntfy/server.yml
# email now lives with the signaling server: take the old password out of ntfy's earlier copies too
sed -i '/^smtp-sender-pass:/d' /etc/ntfy/server.yml.before-transfer-portal.* 2>/dev/null || true
systemctl enable ntfy >/dev/null 2>&1
systemctl restart ntfy
sleep 2

# the signaling server's own ntfy account: may only publish, and only to Transfer Portal topics (tp...)
TOKEN="$(grep -s '^NTFY_TOKEN=' "$ENVF" | cut -d= -f2- || true)"
if [ -z "$TOKEN" ]; then
  echo "-- creating the server's ntfy account"
  export NTFY_AUTH_FILE=/var/lib/ntfy/user.db
  if ! sudo -u ntfy env NTFY_AUTH_FILE=$NTFY_AUTH_FILE ntfy user list 2>/dev/null | grep -q 'user tpserver'; then
    sudo -u ntfy env NTFY_AUTH_FILE=$NTFY_AUTH_FILE NTFY_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc A-Za-z0-9)" ntfy user add tpserver >/dev/null
  fi
  sudo -u ntfy env NTFY_AUTH_FILE=$NTFY_AUTH_FILE ntfy access tpserver 'tp*' write-only >/dev/null
  TOKEN="$(sudo -u ntfy env NTFY_AUTH_FILE=$NTFY_AUTH_FILE ntfy token add --label=transfer-portal tpserver | grep -o 'tk_[A-Za-z0-9]*' | head -1)"
  [ -n "$TOKEN" ] || { echo "Couldn't create the ntfy token."; exit 1; }
fi
umask 077
cat > "$ENVF" <<EOF
NTFY_URL=http://127.0.0.1:2586
NTFY_TOKEN=$TOKEN
NTFY_PUBLIC=$PUBLIC
SMTP_USER=$GMAIL
SMTP_PASS=$APPPASS
EOF
chmod 600 "$ENVF"

# ---- 3. publish ntfy on port 8443 (the signaling server stays on 443) ----
echo "-- publishing ntfy through Tailscale Funnel on port 8443"
tailscale funnel --bg --https=8443 http://127.0.0.1:2586 >/dev/null

systemctl daemon-reload
systemctl restart transfer-portal-signal
sleep 2

# ---- checks ----
echo
echo "== Checks"
systemctl is-active --quiet ntfy && echo "ntfy: running" || echo "ntfy: NOT running (journalctl -u ntfy)"
systemctl is-active --quiet transfer-portal-signal && echo "signaling server: running" || echo "signaling server: NOT running (journalctl -u transfer-portal-signal)"
[ -d /var/lib/transfer-portal-signal ] && echo "mailbox folder: ready" || echo "mailbox folder: will appear when the first message is stored"
curl -fsS "http://127.0.0.1:2586/v1/health" >/dev/null && echo "ntfy on this PC: answering" || echo "ntfy on this PC: not answering"
curl -fsS "$PUBLIC/v1/health" >/dev/null && echo "ntfy public ($PUBLIC): answering" || echo "ntfy public: not answering yet (Funnel can take a minute)"
if [ -n "$APPPASS" ]; then
  read -r -p "Send a test email now? Type the address to send it to (or press Enter to skip): " TO
  if [ -n "$TO" ]; then
    (set -a; . "$ENVF"; set +a; cd /opt/transfer-portal-server && "$NODE" mailer.js --test "$TO") || echo "(the password may be wrong - rerun this script and change the email)"
  fi
else
  echo "Email notices: off (rerun this script to set them up)"
fi
echo
echo "Done. Phone notices use: $PUBLIC"
