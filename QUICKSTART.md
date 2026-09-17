# PeerCast Quick-Start Guide

Everything you need to get PeerCast running — from zero to a live, publicly
accessible P2P broadcasting platform.

---

## Table of contents

1. [What is PeerCast?](#1-what-is-peercast)
2. [Choose Your Path](#2-choose-your-path)
3. [Quick Start — Fastest (one command)](#3-quick-start--fastest-one-command)
4. [Option A — Docker / Podman](#4-option-a--docker--podman)
5. [Option B — Native on Raspberry Pi / Linux (no Docker)](#5-option-b--native-on-raspberry-pi--linux-no-docker)
6. [Deploy on a Local Device (Raspberry Pi / old laptop)](#6-deploy-on-a-local-device)
7. [Deploy on Oracle Cloud Free Tier](#7-deploy-on-oracle-cloud-free-tier)
8. [Expose to the Internet — Cloudflare Tunnel](#8-expose-to-the-internet--cloudflare-tunnel)
9. [Set Up a Domain (free options)](#9-set-up-a-domain-free-options)
10. [Post-Install Checklist](#10-post-install-checklist)
11. [Email Setup](#11-email-setup)
12. [TURN Relay](#12-turn-relay)
13. [Chrome Extension (optional)](#13-chrome-extension-optional)
14. [Updates & Maintenance](#14-updates--maintenance)
15. [Troubleshooting](#15-troubleshooting)
16. [Security Checklist](#16-security-checklist)

---

## 1. What is PeerCast?

PeerCast lets you **broadcast your browser tab or screen to anyone, peer-to-peer
over WebRTC**. There is no central media server — the video/audio flows directly
from broadcaster to viewer. Only a tiny signaling handshake touches the server.

The whole stack (API, signaling, database, web app) serves everything on **one
port** (default `8787`) and can run either:

- **As a Docker/Podman container** (recommended, ~50-100 MB RAM)
- **Natively** directly on a Raspberry Pi or Linux machine (~a few hundred MB
  RAM with Node.js + build tools)

---

## 2. Choose Your Path

| Situation                                  | Use this                     |
| ------------------------------------------ | ---------------------------- |
| You just want it to work, fast             | **`curl                      | bash`** one-liner |
| You already have / prefer Docker           | **Option A** (Docker/Podman) |
| Raspberry Pi, no Docker, minimal resources | **Option B** (Native)        |
| Old laptop running Linux                   | Either (native is lighter)   |
| Oracle Cloud free tier VPS                 | Docker (Option A)            |

---

## 3. Quick Start — Fastest (one command)

Everything below is automated. Just paste one line into a terminal.

### Docker / Podman (recommended)

```bash
# Download setup.sh, inspect it, then run it locally.
```

### Native on Linux / Raspberry Pi (no Docker required)

```bash
# Download setup-native.sh, inspect it, then run it locally.
```

> **The scripts will ask you a few questions** (domain, admin username, SMTP
> optional). They then generate secrets, write `.env`, build, and start —
> with auto-start on boot. When they finish, open the printed URL and register
> your admin account using the printed admin bootstrap secret.

> **Check the URL works first:** verify the script exists at:
> `https://raw.githubusercontent.com/luciVuc/peer-cast/master/setup.sh`
> (it should show shell script text in your browser).

---

## 4. Option A — Docker / Podman

### 4.1 Prerequisites

You need Docker or Podman installed:

```bash
# Ubuntu / Debian / Raspberry Pi OS:
sudo apt update && sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER     # then log out & back in

# Podman alternative:
sudo apt install -y podman podman-compose

# macOS / Windows: install Docker Desktop from https://www.docker.com
```

### 4.2 Get the code

```bash
git clone https://github.com/luciVuc/peer-cast.git
cd peer-cast
```

### 4.3 Configure

```bash
cp .env.example .env
```

Edit `.env` and set **at minimum**:

```dotenv
JWT_SECRET=<run: openssl rand -hex 32>
PUBLIC_HOST=your-domain-or-ip
PUBLIC_SECURE=true
APP_URL=https://your-domain-or-ip
ADMIN_USERNAMES=your-admin-handle
```

### 4.4 Build & start

```bash
docker compose up -d --build        # first build: 2-5 min
docker compose --profile turn up -d # also start TURN relay (optional)
```

### 4.5 Verify

```bash
curl http://localhost:8787/api/health   # → {"ok":true}
```

Open `http://localhost:8787` in your browser.

---

## 5. Option B — Native on Raspberry Pi / Linux (no Docker)

Run PeerCast directly on the box — no container, lower overhead. Works on a
Raspberry Pi (Zero 2 can work; Pi 3/4 recommended) or any Linux laptop/VPS.

### 5.1 One-liner (recommended)

```bash
Download `setup-native.sh`, inspect it, then run `bash setup-native.sh`.
```

That's it. The script installs Node.js 22, clones the repo, builds, writes
`.env`, and sets up a **systemd service** that auto-starts on boot.

### 5.2 Manual steps (what the script does)

If you prefer doing it by hand:

```bash
# 1. Install Node.js 22 (NodeSource for Debian/Ubuntu/Raspberry Pi OS)
Install Node.js 20+ from your distribution's signed package repository or
official package instructions; do not execute an unreviewed remote script.
sudo apt install -y nodejs build-essential python3 make g++ git

# 2. Clone
git clone https://github.com/luciVuc/peer-cast.git
cd peer-cast

# 3. Install deps (shared types build first)
npm ci
npm run build:shared

# 4. Create .env
cat > .env <<'EOF'
PORT=8787
HOST=0.0.0.0
NODE_ENV=production
PUBLIC_HOST=<your-domain-or-ip>
PUBLIC_SECURE=true
JWT_SECRET=<run: openssl rand -hex 32>
DATABASE_FILE=./data/peercast.db
ADMIN_USERNAMES=<your-admin-handle>
EOF

# 5. Build everything
npm run build        # shared → web → server

# 6. Create data dir
mkdir -p data

# 7. Run it (Ctrl+C to stop)
node packages/server/dist/index.js
```

### 5.3 Auto-start on boot (systemd)

Create `/etc/systemd/system/peercast.service`:

```ini
[Unit]
Description=PeerCast — P2P broadcasting platform
After=network.target

[Service]
Type=simple
User=<your-linux-user>
WorkingDirectory=/home/<your-linux-user>/peer-cast
EnvironmentFile=/home/<your-linux-user>/peer-cast/.env
ExecStart=/usr/bin/node /home/<your-linux-user>/peer-cast/packages/server/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now peercast
```

### 5.4 Verify

```bash
sudo systemctl status peercast
curl http://localhost:8787/api/health    # → {"ok":true}
```

---

## 6. Deploy on a Local Device

Both the Docker and native options work on the same device. Pick one.

### Raspberry Pi

```bash
# --- NATIVE (no Docker, recommended for Pi) ---
Download `setup-native.sh`, inspect it, then run `bash setup-native.sh`.

# --- or DOCKER ---
Install Docker using the vendor's documented package instructions; do not pipe
an unreviewed script directly to a shell.
sudo usermod -aG docker $USER   # log out & back in
Download `setup.sh`, inspect it, then run `bash setup.sh`.
```

> **Pi note:** The build includes `better-sqlite3` which compiles natively —
> takes ~3-5 minutes on a Pi 3, ~1-2 min on a Pi 4/5. After build, runtime is
> lightweight (~100-150 MB RAM natively, ~50-100 MB in Docker).

### Old Laptop (Ubuntu/Debian)

```bash
# --- NATIVE (lighter on resources, good for old laptops) ---
Download `setup-native.sh`, inspect it, then run `bash setup-native.sh`.

# --- or DOCKER ---
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git
sudo systemctl enable --now docker
sudo usermod -aG docker $USER && exit   # log back in
Download `setup.sh`, inspect it, then run `bash setup.sh`.
```

### Start on boot

- **Native:** the systemd service ships enabled — nothing to do.
- **Docker:** compose already sets `restart: unless-stopped`.

---

## 7. Deploy on Oracle Cloud Free Tier

Oracle Cloud offers a **permanently free** ARM64 VM (1-4 OCPUs, up to 24 GB
RAM) — plenty for PeerCast.

### 7.1 Create the VM

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com) (free tier).
2. Create a **VM.Standard.A1.Flex** instance (ARM64). 1 OCPU / 1 GB RAM is fine.
3. Choose **Ubuntu 22.04** or **Debian 12**.
4. Add a **reserved public IP** (free) or attach an ephemeral one.
5. In **Networking → Security Lists / Ingress Rules**, open:

   | Port | Protocol | Purpose                    |
   | ---- | -------- | -------------------------- |
   | 22   | TCP      | SSH                        |
   | 443  | TCP      | HTTPS (for Cloudflare)     |
   | 3478 | UDP      | TURN (optional)            |
   | 8787 | TCP      | PeerCast direct (optional) |

### 7.2 SSH in & install

```bash
ssh ubuntu@<your-public-ip>

# Docker path:
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git
sudo systemctl enable --now docker
sudo usermod -aG docker $USER && exit    # reconnect afterwards

# Then:
Download `setup.sh`, inspect it, then run `bash setup.sh`.

# Or native path (no Docker needed):
Download `setup-native.sh`, inspect it, then run `bash setup-native.sh`.
```

Enter your public IP or domain when prompted.

### 7.3 Access

- **Before Cloudflare:** `http://<your-public-ip>:8787`
- **After Cloudflare Tunnel:** `https://peercast.yourdomain.com`

> **HTTPS is required** for broadcasting — browsers block camera/screen capture
> and secure WebRTC without a secure context. Cloudflare Tunnel provides free
> HTTPS automatically (Section 8). On Android, choose **Camera and
> microphone**: many mobile browsers do not implement screen sharing.

---

## 8. Expose to the Internet — Cloudflare Tunnel

Cloudflare Tunnel creates a **free, outbound-only** tunnel from your server to
Cloudflare's edge. No open firewall ports needed. You get free HTTPS, DDoS
protection, and a CDN. Works identically for Docker and native installs.

### 8.1 Install cloudflared

```bash
# Debian / Ubuntu / Raspberry Pi OS:
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared

# macOS:  brew install cloudflare/cloudflare/cloudflared
# Manual: https://github.com/cloudflare/cloudflared/releases
```

### 8.2 Authenticate

```bash
cloudflared tunnel login
```

A browser opens — pick your domain. Certificate saved to `~/.cloudflared/`.

### 8.3 Create the tunnel

```bash
cloudflared tunnel create peercast
```

Note the **Tunnel ID** (UUID).

### 8.4 Configure

`~/.cloudflared/config.yml`:

```yaml
tunnel: <YOUR-TUNNEL-ID>
credentials-file: /home/<your-user>/.cloudflared/<YOUR-TUNNEL-ID>.json

ingress:
  - hostname: peercast.yourdomain.com
    service: http://localhost:8787
  - service: http_status:404
```

### 8.5 Route DNS + start

```bash
cloudflared tunnel route dns peercast peercast.yourdomain.com

sudo cloudflared service install    # run as system service
sudo systemctl enable --now cloudflared
```

### 8.6 Point PeerCast at the domain

Edit `.env`:

```dotenv
PUBLIC_HOST=peercast.yourdomain.com
PUBLIC_SECURE=true
APP_URL=https://peercast.yourdomain.com
```

Restart:

```bash
# Docker:
docker compose restart peercast
# Native:
sudo systemctl restart peercast
```

### 8.7 Verify

```bash
curl https://peercast.yourdomain.com/api/health   # → {"ok":true}
```

You're live on the internet with free HTTPS.

---

## 9. Set Up a Domain (free options)

| Option                | Cost    | HTTPS? | Effort |
| --------------------- | ------- | ------ | ------ |
| **Freenom**           | $0      | via CF | Low    |
| **DuckDNS**           | $0      | Manual | Low    |
| **sslip.io / nip.io** | $0      | via CF | Zero   |
| **Own domain + CF**   | ~$10/yr | auto   | Low    |

### Option A — Your own domain + Cloudflare (best)

1. Buy a domain (~$10/yr). Any registrar works (Porkbun, Namecheap, etc.).
2. In your registrar, change nameservers to the two Cloudflare gives you.
3. Add the domain to Cloudflare (free plan).
4. Follow [Section 8](#8-expose-to-the-internet--cloudflare-tunnel).

### Option B — sslip.io (testing, zero config)

```
# Server IP 129.153.42.88 →
PUBLIC_HOST=129-153-42-88.sslip.io
```

No registration. DNS resolves to your IP automatically. Point Cloudflare at it
or use the raw IP for testing.

### Option C — DuckDNS (free subdomain)

1. Sign in at duckdns.org with GitHub/Google.
2. Create a subdomain (e.g. `mycast.duckdns.org`) → your public IP.
3. Use it as `PUBLIC_HOST`.
4. HTTPS: needs Cloudflare Tunnel or Let's Encrypt (`certbot`).

### Option D — Freenom (last resort)

Free `.tk/.ml/.ga/.cf/.gq` domains. Unreliable since 2023. Set its nameservers
to Cloudflare's then add it to your CF account.

---

## 10. Post-Install Checklist

### 10.1 Register the admin account

1. Open `https://your-domain/register`
2. Register the username matching `ADMIN_USERNAMES` and enter the
   `ADMIN_BOOTSTRAP_SECRET` from `.env`
3. The server auto-promotes it to admin — an **Admin** link appears in nav

### 10.2 Verify your email (if SMTP configured)

- Click **Resend email** on the Dashboard
- No SMTP? Links go to the server log:

  ```bash
  # Docker:
  docker compose logs -f peercast | grep verify-email
  # Native:
  journalctl -u peercast | grep verify-email
  ```

### 10.3 Lock registration (optional)

```dotenv
REGISTRATION_MODE=invite     # or "closed"
```

Restart. A new designated admin still requires the bootstrap secret.

### 10.4 Try broadcasting

1. Sign in at `/login`
2. Go to `/broadcast`
3. **Start broadcast** — pick a tab, window, or screen
4. Share `https://your-domain/watch/your-username`
5. Viewer sees your stream — P2P, no media through the server

---

## 11. Email Setup

Email is **optional but recommended** for multi-user deployments. Without it,
verification links are printed to the server log (fine for single-operator).

### Quick: Resend (free 100/day)

Sign up at resend.com, create an API key, add to `.env`:

```dotenv
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=resend
SMTP_PASS=re_your_api_key_here
SMTP_FROM=PeerCast <noreply@yourdomain.com>
APP_URL=https://your-domain
```

Restart (`docker compose restart peercast` or `sudo systemctl restart peercast`).

### Other providers

| Provider     | SMTP host         | Free tier      | Notes                            |
| ------------ | ----------------- | -------------- | -------------------------------- |
| **Resend**   | smtp.resend.com   | 100/day        | Easiest for self-hosted          |
| **Mailgun**  | smtp.mailgun.org  | 1000/day trial | Requires card                    |
| **SendGrid** | smtp.sendgrid.net | 100/day        | `SMTP_USER=apikey`               |
| **Gmail**    | smtp.gmail.com    | 500/day        | Needs App Password, not 2FA pass |
| **Postfix**  | localhost         | unlimited      | `sudo apt install postfix`       |

### Hard verification (blocks unverified login)

```dotenv
REQUIRE_EMAIL_VERIFICATION=true
```

---

## 12. TURN Relay

A TURN relay helps viewers behind symmetric NAT (corporate networks, some
carriers) connect.

### Option A — Bundled coturn (Docker only)

```bash
# Edit turn/turnserver.conf:
#   - external-ip=<your public IP>
#   - Change credentials (replace CHANGE_ME_USERNAME / CHANGE_ME_CREDENTIAL)

# .env:
ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:your-domain:3478","username":"your-user","credential":"your-pass"}]

# Start:
docker compose --profile turn up -d --build
```

Open firewall ports: **UDP 3478** + **UDP 49160-49200**.

### Option B — Native coturn

```bash
sudo apt install -y coturn
# Configure /etc/turnserver.conf, then:
sudo systemctl enable --now coturn
```

Then set `ICE_SERVERS` in `.env` with your coturn host + credentials.

### Option C — External TURN service

Use Open Relay, Twilio TURN, or Cloudflare Calls. Set `ICE_SERVERS` in `.env`.

> **Privacy:** in P2P mode both parties see each other's IP. To hide IPs, force
> `iceTransportPolicy: 'relay'` in the browser (traffic relays through TURN).

---

## 13. Chrome Extension (optional)

### Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `packages/extension/` (from the local repo)
3. Pin the PeerCast icon

### Use

1. Click the PeerCast icon
2. Enter your server URL (e.g. `https://peercast.yourdomain.com`)
3. Sign in with your PeerCast username/password
4. Pick title + access policy, click **Broadcast this tab** or **Broadcast screen…**

### Shortcuts

| Shortcut       | Action                |
| -------------- | --------------------- |
| `Ctrl+Shift+Y` | Broadcast current tab |
| `Ctrl+Shift+K` | Toggle start/stop     |
| `Alt+Shift+P`  | Open popup            |

---

## 14. Updates & Maintenance

### Update with Docker

```bash
cd peer-cast
git pull
docker compose up -d --build
```

### Update native

```bash
cd ~/peer-cast
git pull
npm ci
npm run build
sudo systemctl restart peercast
```

### Logs

```bash
# Docker:
docker compose logs -f peercast
# Native:
journalctl -u peercast -f
```

### Backup database

```bash
# Docker:
docker cp peercast:/data/peercast.db ./backup-$(date +%Y%m%d).db
# Native:
cp ~/peer-cast/data/peercast.db ./backup-$(date +%Y%m%d).db
```

### Full reset (destroys data)

```bash
# Docker:
docker compose down -v && docker compose up -d --build
# Native:
sudo systemctl stop peercast && rm ~/peer-cast/data/peercast.db
sudo systemctl start peercast
```

---

## 15. Troubleshooting

### Container/service won't start

```bash
docker compose logs peercast      # Docker
journalctl -u peercast -e         # Native
```

Common causes:

- **`JWT_SECRET` missing** — generate: `openssl rand -hex 32`, add to `.env`
- **Port 8787 in use** — change `PORT` in `.env`, then restart
- **Native: Node version too old** — need Node 20+ (script installs 22)

### Broadcasting doesn't work (no video)

- **HTTPS required** — camera/screen capture and secure WebRTC fail on plain HTTP.
  Use Cloudflare Tunnel or a TLS reverse proxy.
- **`localhost` exception** — `http://localhost` counts as secure, so local
  testing works without HTTPS.
- **Android screen sharing** — many Android browsers do not expose
  `getDisplayMedia`; use the **Camera and microphone** capture source instead.
  The app detects this automatically and hides unsupported screen-sharing
  choices.

### Viewers can't connect

- **Symmetric NAT** → add a TURN relay (Section 12)
- **Check the browser console** for WebRTC errors
- Ensure `PUBLIC_HOST` / `PUBLIC_SECURE` match your actual setup

### Cloudflare Tunnel shows 521/522

- PeerCast not running: `docker compose up -d` or `sudo systemctl start peercast`
- Wrong port in `config.yml`: must point to `http://localhost:8787`

### Pi runs out of memory

- Native mode uses less than Docker. Use `HOST=0.0.0.0` (already default).
- Close GUI apps; use a headless Lite install for a Pi used only as a server.

---

## 16. Security Checklist

- [ ] `JWT_SECRET` is a strong random value (not the placeholder)
- [ ] `PUBLIC_SECURE=true` and you're serving over HTTPS
- [ ] `.env` is **not** committed to git (it's in `.gitignore`)
- [ ] `ADMIN_USERNAMES` is set to your actual admin handle
- [ ] Registration mode set to `invite` or `closed` after initial setup
- [ ] Firewall only exposes the ports you actually need
- [ ] Cloudflare Tunnel running (HTTPS + DDoS protection)
- [ ] Database backed up somewhere safe

---

## Quick Reference

| What                | Command / URL                                                            |
| ------------------- | ------------------------------------------------------------------------ |
| **Docker**          | Download `setup.sh`, inspect it, then run `bash setup.sh`.               |
| **Native**          | Download `setup-native.sh`, inspect it, then run `bash setup-native.sh`. |
| Docker start        | `docker compose up -d`                                                   |
| Docker start + TURN | `docker compose --profile turn up -d`                                    |
| Native start        | `sudo systemctl start peercast`                                          |
| Native status/logs  | `systemctl status peercast` / `journalctl -u peercast -f`                |
| Health check        | `curl http://localhost:8787/api/health`                                  |
| Backup (Docker)     | `docker cp peercast:/data/peercast.db ./backup.db`                       |
| Backup (native)     | `cp ~/peer-cast/data/peercast.db ./backup.db`                            |
| Generate JWT secret | `openssl rand -hex 32`                                                   |
| Chrome extension    | `chrome://extensions` → Load unpacked → `packages/extension/`            |
