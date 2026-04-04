# beepm

Private blood pressure tracking. Your data, your keys.

- **Client-side OCR** — 7-segment LCD reading via nanoclaw + ssocr
- **Client-side encryption** — AES-GCM, key derived from wallet
- **Private inference** — 0G TEE Compute for analysis
- **Data sovereignty** — run nanoclaw locally or on your own VPS

## Stack

- Frontend: HTML/JS, Tesseract.js fallback, Telegram Mini App SDK
- Backend (nanoclaw): Node.js + Express, ssocr for 7-segment OCR
- Auth: Dynamic wallet (email/passkey/social)
- Storage: 0G Storage (encrypted)
- Compute: 0G TEE inference

## Run locally

```bash
npm install
node server.js
```

App at http://localhost:3061

## Requirements

- `ssocr` binary on server (`apt install ssocr`)
- Node 18+

---

ETHGlobal Cannes 2026
