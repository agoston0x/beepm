# beepm

**Holistic health data management** — secure tracking, processing, and AI-evaluated insights, all through a simple Telegram mini app.

Your readings. Your keys. Your infrastructure.

---

## The Problem

LLMs can analyze health data, but they can't:
- Encrypt/decrypt it securely
- Store it privately on your infrastructure
- Pull/push to local databases
- Run OCR on photos
- Maintain long-term state

**beepm** solves this by combining **0G's private TEE inference** with **zeroclaw** — a local agent runtime that gives LLMs hands: storage, encryption, OCR, and more.

---

## What It Does

- **Track**: Blood pressure, weight, body composition — manual entry or photo capture
- **Secure**: AES-GCM encryption with keys derived from your Dynamic wallet
- **Evaluate**: Private LLM analysis via 0G's TEE network (qwen-2.5-7b)
- **Store**: Encrypted readings on infrastructure you control (VPS, home server, or laptop)
- **Access**: Simple Telegram mini app — no accounts, no cloud, no surveillance

OCR (tesseract) is included as a demo of what zeroclaw enables, but it's optional. The focus is **secure, private, AI-enhanced health tracking**.

---

## Architecture

```
┌─────────────────────┐
│ Telegram Mini App   │  ← simple UI, Telegram-native
│ (Dynamic WaaS)      │
└──────────┬──────────┘
           │ HTTPS
           ▼
┌─────────────────────┐
│ beepm-node          │  ← YOUR infrastructure
│ (zeroclaw skill)    │     - stores encrypted readings
│                     │     - runs OCR (optional)
│ Port: 3064          │     - calls gateway for inference
└──────────┬──────────┘
           │ HTTPS + JWT
           ▼
┌─────────────────────┐
│ beepm-gateway       │  ← verifies INFT ownership
│ (multi-tenant)      │     sponsors gasless mints
│                     │     gates 0G API access
└──────────┬──────────┘
           │ HTTPS
           ▼
┌─────────────────────┐
│ 0G TEE Compute      │  ← private inference
│ qwen-2.5-7b         │     verifiable execution
└─────────────────────┘
```

**Key insight**: The LLM never sees your raw data. Readings are encrypted client-side. The LLM only sees anonymized summaries you choose to send for analysis.

---

## Tech Stack

### Frontend
- Telegram Mini App SDK
- Dynamic Labs SDK (embedded wallets, email OTP, WaaS)
- Native Web Crypto API (AES-GCM encryption)

### Your Node (zeroclaw + beepm skill)
- Node.js + Express
- Tesseract OCR (optional, for photo capture)
- OpenCV preprocessing (optional, improves OCR accuracy)
- JSON file storage (encrypted blobs)

### Gateway (multi-tenant)
- ethers.js v6 (0G chain reads, gasless INFT minting)
- JWT auth (wallet signature verification)
- 0G Compute proxy (INFT-gated API access)

### Blockchain
- **0G Newton Testnet** (chain 16602) — INFT contract, TEE inference
- **Dynamic WaaS** — embedded wallets, no seed phrases
- **Hardhat + OpenZeppelin** — INFT contract (ERC-721)

---

## Run It Yourself

### Option 1: One-line install (easiest)

```bash
curl -fsSL https://raw.githubusercontent.com/agoston0x/beepm/main/quickstart.sh | bash
```

**What it does:**
- Installs dependencies (tesseract, cloudflared, opencv)
- Clones repo
- Configures beepm-node
- Starts node + cloudflared tunnel
- Prints your public URL + QR code link

**Takes ~2 minutes.** Then open the URL → scan QR → demo.

---

### Option 2: Use the demo node (no setup)
- Open https://t.me/beepm_telegram_bot/beepm_tg_app
- Sign in with email
- Mint your INFT (gasless)
- Start tracking

---

### Option 3: Manual install (5 minutes)

### Prerequisites
- Node.js 18+ ([download](https://nodejs.org))
- macOS or Linux

### Install & Run

```bash
# 1. Install system dependencies
# macOS:
brew install tesseract cloudflared
# Linux:
sudo apt-get install -y tesseract-ocr
# Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# 2. Clone and install
git clone https://github.com/agoston0x/beepm.git
cd beepm/node
npm install

# 3. Start the node
node bin/beepm-node.js
# Listens on http://localhost:3064
# Creates config at ~/.beepm-node/config.json

# 4. In a new terminal, expose via cloudflared tunnel
cloudflared tunnel --url http://localhost:3064
# Copy the printed https://xxx.trycloudflare.com URL

# 5. Update config with your tunnel URL
# Stop node (Ctrl+C), edit ~/.beepm-node/config.json:
{
  "publicUrl": "https://YOUR-TUNNEL-URL.trycloudflare.com",
  "gatewayUrl": "https://beepm-gateway.claws.page",
  "port": 3064
}

# 6. Restart node
node bin/beepm-node.js

# 7. Open your tunnel URL in a browser → scan QR code with your phone
# Opens Telegram mini app → sign in → pair → start tracking
```

### Reset for fresh demo
```bash
curl -X POST http://localhost:3064/pair/unpair
# In mini app: tap "sign out" button (top right)
```

**Want AI help?** Point your AI agent at [`SKILL.md`](SKILL.md) — works with Claude Code, Cursor, GitHub Copilot Workspace, or any CLI agent.

---

## Security Model

1. **Client-side encryption**: readings encrypted in the mini app before leaving your device
2. **Wallet-derived keys**: AES-256-GCM key = SHA-256(wallet.sign("beepm · derive encryption key"))
3. **Your infrastructure**: node runs on a machine you control, not ours
4. **INFT-gated inference**: only NFT holders can call the gateway → prevents abuse
5. **0G TEE**: inference runs in a trusted execution environment, verifiable on-chain

---

## What Makes This Different

### vs. Apple Health / Google Fit
- **They own your data**. You don't.
- **They can't run private AI**. We do (0G TEE).
- **They can't be self-hosted**. beepm can.

### vs. LLM-only health apps
- **LLMs alone can't encrypt**. zeroclaw adds crypto primitives.
- **LLMs alone can't persist state**. zeroclaw adds storage.
- **LLMs alone can't OCR photos**. zeroclaw adds vision tooling.

### vs. blockchain health records
- **Most are just pointers to centralized storage**. beepm stores encrypted blobs on your node.
- **Most require gas fees**. beepm mints are gasless (sponsored).
- **Most have no inference**. beepm integrates 0G TEE for AI analysis.

---

## Roadmap

### v1 (current)
- [x] Telegram mini app
- [x] Dynamic wallet auth
- [x] Client-side encryption
- [x] Manual BP/weight entry
- [x] Photo OCR (tesseract)
- [x] 0G TEE inference
- [x] zeroclaw skill (VPS/tunnel)

### v2 (post-hackathon)
- [ ] ENS subdomains (e.g., `h3x9k2.beepm.agoston.base.eth`) for encrypted profiles
- [ ] Local zeroclaw install via gateway relay (no public HTTPS needed)
- [ ] Export encrypted readings (CSV, JSON)
- [ ] Passkey-first auth (replace email OTP)
- [ ] Multi-device sync via 0G Storage
- [ ] Trend charts + long-term analysis

---

## Built With

- [0G](https://0g.ai) — decentralized AI compute + storage
- [Dynamic](https://dynamic.xyz) — embedded wallets
- [zeroclaw](https://github.com/zeroclaw-labs/zeroclaw) — local agent runtime
- [Telegram](https://core.telegram.org/bots/webapps) — mini app platform

---

**ETHGlobal Cannes 2026** | [Demo](https://beepm.claws.page) | [Install](https://github.com/agoston0x/beepm/blob/main/SKILL.md)
