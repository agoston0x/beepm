# beepm — install skill

**Purpose:** set up a beepm node (private health tracking) on the user's machine and expose it via HTTPS, then pair it with the beepm Telegram mini app.

Use when: user asks "install beepm", "set up beepm node", or points you at this repo.

## What you are installing

- **beepm-node** — small Express daemon (port 3064). Runs locally, stores the user's encrypted BP/weight readings, runs tesseract OCR on photos, calls the beepm-gateway for 0G TEE inference.
- The node needs a **public HTTPS URL** (Telegram mini app must reach it). Use `cloudflared` (free, no signup) or `ngrok`.

## Steps

### 1. Clone + install

```bash
git clone https://github.com/agoston0x/beepm.git ~/beepm
cd ~/beepm/node
npm install
```

### 2. System deps (OCR)

```bash
# macOS
brew install tesseract cloudflared
pip3 install opencv-python-headless

# Linux (apt)
sudo apt-get install -y tesseract-ocr python3-pip
pip3 install opencv-python-headless
# install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

### 3. Start the node

```bash
node bin/beepm-node.js &
# listens on http://localhost:3064
```

Check: `curl http://localhost:3064/health` → should return `{"ok":true}`.

### 4. Expose via HTTPS tunnel

```bash
cloudflared tunnel --url http://localhost:3064
```

Copy the printed `https://<random>.trycloudflare.com` URL. That is the **public node URL**.

### 5. Configure the node with its public URL + gateway

Edit `~/.beepm-node/config.json` (created on first run):

```json
{
  "port": 3064,
  "publicUrl": "https://<random>.trycloudflare.com",
  "gatewayUrl": "https://beepm-gateway.claws.page",
  "dataDir": "~/.beepm-node/data"
}
```

Restart: `pkill -f beepm-node && node bin/beepm-node.js &`

### 6. Pair with Telegram mini app

1. Open the public URL in a browser — you should see a pairing QR code
2. Scan it with your phone camera — it opens `t.me/beepm_telegram_bot/beepm_tg_app?startapp=pair_<base64>`
3. Sign in with email OTP in the mini app
4. Mint the access INFT (gasless — sponsored by the gateway)
5. The mini app auto-pairs with your node via the QR deep link

### 7. Verify pairing

```bash
curl https://<your-tunnel>.trycloudflare.com/info
# should show "paired":true, "wallet":"0x..."
```

## Architecture recap

```
[Telegram mini app] → HTTPS → [your beepm-node] → HTTPS → [beepm-gateway] → [0G TEE Compute]
                                 (stores encrypted                            (qwen-2.5-7b)
                                  readings locally)                           (INFT-gated)
```

- Readings are **AES-GCM encrypted client-side** with a key derived from a Dynamic wallet signature. The node never sees plaintext.
- Gateway verifies INFT ownership on-chain before allowing 0G calls.
- Gas is sponsored — users pay nothing to mint.

## Troubleshooting

- **tesseract not found**: install it (`brew install tesseract` / `apt-get install tesseract-ocr`)
- **cloudflared URL changes on restart**: that's normal for free tunnels. For a stable URL, set up a named tunnel or use ngrok with an account
- **mini app can't reach node**: check public URL is HTTPS (not http) and CORS is open (node already allows all origins)
- **pairing token expired**: run `curl -X POST <url>/pair/unpair` to rotate
