# Transfer Portal signaling server

A tiny WebRTC signaling server for Transfer Portal. It only passes the short connection handshake between two PCs that share a pair code; the files themselves travel directly from one PC to the other and never pass through here. Nothing is stored.

## Run it on Koyeb (free)

1. In Koyeb, **Create Service** > **Web Service** > **GitHub**, and pick this repository (Koyeb asks to be allowed to read it).
2. Builder: **Buildpack** (it finds Node by itself). Instance: **Free**. Region: **Washington, D.C.** (or Frankfurt).
3. Ports: leave **8000 / HTTP**, path `/`. Koyeb hands that port to the server as `PORT`. If the deploy log says `listening on :8787` instead, change the port to 8787.
4. When it shows **Healthy**, open its address (`https://<service>-<account>.koyeb.app`) and you should see `Transfer Portal signaling OK`.
5. In Transfer Portal (or Airlock > Transfer > Settings > This PC), set **Signaling server** to `wss://<service>-<account>.koyeb.app` and press Save.

The free instance goes to sleep after an hour with no one connected; the first connection after that takes a little while to wake it. Transfer Portal keeps retrying by itself.

Render works the same way (Web Service, `npm install`, `npm start`, Free), but some routers' security filters block Render's addresses - check the address opens on your network first.

## Limits

256 KB per message, 300 messages per 10 seconds per connection, 32 connections per address, 5000 pair codes at once, and at most two PCs per pair code.

## Run it locally

`npm install`, then `npm start` (listens on port 8787, or `PORT` if set).
