# Transfer Portal server

The small server behind [Transfer Portal](https://github.com/Alchemy-Labs-Creations/Transfer-Portal-Hub). Files never pass through it. It does three jobs:

1. **Introduces two PCs.** It passes the short connection handshake between two PCs that share a pair code, and then they talk directly, encrypted.
2. **Holds messages for a PC that's away.** A message for a PC that's off is locked on the sender's PC (AES-256-GCM, with a key only the two PCs have) and left here until the other PC collects it. The server can't read it. It's deleted once collected, or after 30 days.
3. **Sends notices when something's waiting** (optional). A phone ping through a self-hosted [ntfy](https://ntfy.sh), and/or a short email. Notices only say who wrote and that something is waiting, never what was said.

## Run it on an Ubuntu PC (recommended)

Tailscale Funnel gives the server a public, encrypted address without opening any port on your router.

1. Copy this folder to the Ubuntu PC.
2. Run `sudo bash setup-ubuntu.sh`. It installs Node.js if needed, runs the server as its own locked-down service on `127.0.0.1:8787`, and puts it online at `https://<pc>.<tailnet>.ts.net` (you sign in to Tailscale once).
3. In Transfer Portal (or Airlock > Transfer > Settings > This PC), set **Signaling server** to `wss://<pc>.<tailnet>.ts.net` and press **Save**.

### Turn on phone and email notices

Run `sudo bash setup-notify.sh`. It:

- installs ntfy from its official repository, on the PC only, and publishes it on port 8443 of the same address, for the phone app
- sets up email, which the server sends itself through a Gmail account. You need a Gmail **app password** (Google Account > Security > 2-Step Verification > App passwords). You type it when the script asks. It is never shown, and it's kept in `/etc/transfer-portal-signal.env`, readable only by root.

Then each person turns notices on in **Settings > Notifications when you're away**.

Both scripts are safe to run again. Running them again is also how you update the server.

## Run it on Koyeb (free, no PC needed)

1. In Koyeb, **Create Service** > **Web Service** > **GitHub**, and pick this repository.
2. Builder: **Buildpack**. Instance: **Free**. Ports: **8000 / HTTP**, path `/` (Koyeb gives it to the server as `PORT`).
3. When it shows **Healthy**, set **Signaling server** in the app to `wss://<service>-<account>.koyeb.app`.

The free instance sleeps after an hour with no one connected and takes a moment to wake; the app keeps retrying by itself. Waiting messages are lost when Koyeb restarts the instance, and notices aren't available there.

## Limits

- **Handshakes:** 256 KB per message, 300 messages per 10 seconds per connection, 32 connections per address, 5000 pair codes at once, and two PCs per pair code.
- **Waiting messages:** 64 KB each, up to 200 items or 5 MB per mailbox, kept for 30 days.
- **Notices:** at most one phone ping a minute and one email an hour per PC.

## Run it locally

Run `npm install`, then `npm start`. It listens on port 8787 (or `PORT`), and waiting messages are kept in `./data` (or `DATA_DIR`). To send a test email, put `SMTP_USER` and `SMTP_PASS` in the environment and run `node mailer.js --test you@example.com`.
