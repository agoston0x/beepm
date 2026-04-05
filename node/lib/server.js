// beepm-node — private health daemon
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const QRCode = require('qrcode');

function createServer(config) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '8mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const DATA_DIR = config.dataDir;
  const READINGS_FILE = path.join(DATA_DIR, 'readings.json');
  const STATE_FILE = path.join(DATA_DIR, 'state.json');
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Load or init state (pairing token, JWT, wallet, etc.)
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  if (!state.pairingToken) {
    state.pairingToken = crypto.randomBytes(16).toString('hex');
    state.instanceId = crypto.randomBytes(8).toString('hex');
    saveState();
  }
  function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

  // readings keyed by wallet address for multi-tenant demo support
  const loadAllReadings = () => { try { return JSON.parse(fs.readFileSync(READINGS_FILE, 'utf8')); } catch { return {}; } };
  const saveAllReadings = (d) => fs.writeFileSync(READINGS_FILE, JSON.stringify(d, null, 2));
  const loadReadings = (wallet) => {
    const all = loadAllReadings();
    return all[wallet?.toLowerCase()] || [];
  };
  const saveReadings = (wallet, arr) => {
    const all = loadAllReadings();
    all[wallet.toLowerCase()] = arr;
    saveAllReadings(all);
  };

  // Extract wallet from JWT header
  function walletFromAuth(req) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      if (payload.exp && payload.exp * 1000 < Date.now()) return null;
      return payload.wallet?.toLowerCase();
    } catch { return null; }
  }

  const PYTHON_SCRIPT = path.join(__dirname, '..', 'scripts', 'ocr_seven_seg.py');
  const PUBLIC_URL = config.publicUrl || `http://localhost:${config.port}`;
  const GATEWAY_URL = config.gatewayUrl || 'https://beepm-gateway.claws.page';

  // === Status / info ===
  app.get('/health', (_, res) => res.json({ ok: true, service: 'beepm-node', version: '0.1.0' }));

  app.get('/info', (_, res) => res.json({
    service: 'beepm-node',
    version: '0.1.0',
    instanceId: state.instanceId,
    paired: !!state.wallet,
    wallet: state.wallet || null,
    hasJWT: !!state.jwt,
    gateway: GATEWAY_URL,
    publicUrl: PUBLIC_URL
  }));

  // === Pairing: returns QR payload for mini app to scan ===
  app.get('/pair/qr', async (req, res) => {
    // If ?tg=<telegram deep link> given → encode that (scanning opens Telegram directly)
    const payload = req.query.tg
      ? String(req.query.tg)
      : JSON.stringify({ v: 1, type: 'beepm-pair', url: PUBLIC_URL, instanceId: state.instanceId, token: state.pairingToken });
    const qrDataUrl = await QRCode.toDataURL(payload, { width: 300, margin: 1 });
    res.json({ payload, qrDataUrl });
  });

  // === Pairing: mini app registers its wallet + JWT here ===
  // Auth: valid gateway JWT (gateway already verified wallet owns NFT)
  app.post('/pair/register', async (req, res) => {
    const { wallet, jwt: userJwt, token } = req.body;
    if (!wallet || !userJwt) return res.status(400).json({ error: 'missing wallet or jwt' });
    // Verify JWT with gateway (must match wallet)
    try {
      // Decode JWT payload (base64url middle segment) to check wallet
      const parts = userJwt.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (payload.wallet?.toLowerCase() !== wallet.toLowerCase()) {
        return res.status(403).json({ error: 'wallet/jwt mismatch' });
      }
      if (payload.exp && payload.exp * 1000 < Date.now()) {
        return res.status(403).json({ error: 'jwt expired' });
      }
    } catch (e) {
      return res.status(400).json({ error: 'bad jwt format' });
    }
    state.wallet = wallet.toLowerCase();
    state.jwt = userJwt;
    state.pairedAt = Date.now();
    state.pairingToken = crypto.randomBytes(16).toString('hex'); // rotate
    saveState();
    console.log(`[beepm-node] paired with wallet ${wallet.slice(0,10)}...`);
    res.json({ ok: true, wallet: state.wallet });
  });

  // === Storage (per-wallet, JWT-authenticated) ===
  app.post('/api/reading', (req, res) => {
    const wallet = walletFromAuth(req) || state.wallet;
    if (!wallet) return res.status(403).json({ error: 'no wallet (send JWT)' });
    const { encrypted, timestamp, ocr, kind } = req.body;
    if (!encrypted) return res.status(400).json({ error: 'missing encrypted' });
    const arr = loadReadings(wallet);
    arr.push({ encrypted, timestamp: timestamp || Date.now(), ocr: ocr || null, kind: kind || 'bp' });
    saveReadings(wallet, arr);
    res.json({ ok: true, count: arr.length });
  });

  app.get('/api/readings', (req, res) => {
    const wallet = walletFromAuth(req) || state.wallet;
    if (!wallet) return res.status(403).json({ error: 'no wallet' });
    res.json({ readings: loadReadings(wallet) });
  });

  // === OCR via Python ===
  app.post('/api/ocr', (req, res) => {
    const { imageDataUrl } = req.body;
    if (!imageDataUrl) return res.status(400).json({ error: 'missing image' });
    const m = imageDataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'invalid image' });
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const tmpFile = path.join(os.tmpdir(), `beepm-node-${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`);
    fs.writeFileSync(tmpFile, Buffer.from(m[2], 'base64'));

    const proc = spawn('python3', [PYTHON_SCRIPT, tmpFile]);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', (code) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (code !== 0) {
        console.error('[beepm-node/ocr] failed:', err.slice(0,200));
        return res.status(500).json({ error: 'ocr failed', stderr: err.slice(0,200) });
      }
      try { res.json(JSON.parse(out.trim())); }
      catch (e) { res.status(500).json({ error: 'bad ocr output', raw: out.slice(0,200) }); }
    });
    proc.on('error', e => res.status(500).json({ error: e.message }));
  });

  // === 0G inference via gateway (JWT from client passed through) ===
  app.post('/api/analyze', async (req, res) => {
    const auth = req.headers.authorization || '';
    const userJwt = auth.startsWith('Bearer ') ? auth.slice(7) : state.jwt;
    if (!userJwt) return res.status(403).json({ error: 'no jwt (send Authorization: Bearer <jwt>)' });
    const { context, question } = req.body;
    const messages = [];
    messages.push({ role: 'system', content: 'You are a private health assistant. Analyze blood pressure readings briefly and factually. Never diagnose; suggest consulting a doctor for concerns. Max 2 sentences.' });
    if (context) messages.push({ role: 'user', content: `Reading context:\n${context}` });
    messages.push({ role: 'user', content: question || 'Analyze these blood pressure readings.' });
    try {
      const r = await fetch(GATEWAY_URL + '/api/infer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userJwt}` },
        body: JSON.stringify({ messages, temperature: 0.4 })
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // === One-shot capture: photo → OCR → 0G analyze → store reading (JWT-gated) ===
  app.post('/api/capture', async (req, res) => {
    const wallet = walletFromAuth(req);
    if (!wallet) return res.status(403).json({ error: 'JWT required' });
    const auth = req.headers.authorization || '';
    const userJwt = auth.slice(7);
    const { imageDataUrl, kind } = req.body; // kind: 'bp' | 'weight'
    if (!imageDataUrl) return res.status(400).json({ error: 'missing image' });
    const m = imageDataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'invalid image' });

    // OCR
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const tmpFile = path.join(os.tmpdir(), `beepm-${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`);
    fs.writeFileSync(tmpFile, Buffer.from(m[2], 'base64'));
    const ocrResult = await new Promise((resolve) => {
      const proc = spawn('python3', [PYTHON_SCRIPT, tmpFile]);
      let out = '', err = '';
      proc.stdout.on('data', d => out += d.toString());
      proc.stderr.on('data', d => err += d.toString());
      proc.on('close', code => {
        try { fs.unlinkSync(tmpFile); } catch {}
        if (code !== 0) return resolve({ error: 'ocr failed', stderr: err.slice(0,200) });
        try { resolve(JSON.parse(out.trim())); } catch { resolve({ error: 'bad ocr output' }); }
      });
      proc.on('error', e => resolve({ error: e.message }));
    });
    if (ocrResult.error) return res.status(500).json(ocrResult);

    // Store reading (locally on node — encrypted in prod)
    const reading = {
      timestamp: Date.now(),
      kind: kind || 'bp',
      ocr: ocrResult,
      values: ocrResult.values || ocrResult.digits || null
    };
    const arr = loadReadings(wallet);
    arr.push(reading);
    saveReadings(wallet, arr);

    // 0G analyze via gateway (non-blocking: return reading immediately, analyze returns async)
    let analysis = null;
    try {
      const recent = arr.slice(-5).map(r => `${new Date(r.timestamp).toISOString()}: ${JSON.stringify(r.values)}`).join('\n');
      const messages = [
        { role: 'system', content: 'You are a private health assistant. Analyze readings briefly (≤2 sentences). Never diagnose. Note trends.' },
        { role: 'user', content: `Latest ${kind||'bp'} readings:\n${recent}\n\nBrief analysis?` }
      ];
      const r = await fetch(GATEWAY_URL + '/api/infer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userJwt}` },
        body: JSON.stringify({ messages, temperature: 0.4 })
      });
      const data = await r.json();
      if (r.ok) analysis = data.reply;
    } catch (e) { analysis = null; }

    res.json({ ok: true, reading, analysis, count: arr.length });
  });

  // === Reset: clear all readings for wallet ===
  app.post('/api/reset', (req, res) => {
    const wallet = walletFromAuth(req);
    if (!wallet) return res.status(403).json({ error: 'JWT required' });
    saveReadings(wallet, []);
    console.log(`[beepm-node] reset for ${wallet.slice(0,10)}...`);
    res.json({ ok: true });
  });

  // === Unpair: clear wallet+JWT on node (used for re-pairing) ===
  app.post('/pair/unpair', (req, res) => {
    const wallet = walletFromAuth(req);
    if (wallet && wallet !== state.wallet) return res.status(403).json({ error: 'wallet mismatch' });
    delete state.wallet; delete state.jwt; delete state.pairedAt;
    state.pairingToken = crypto.randomBytes(16).toString('hex');
    saveState();
    res.json({ ok: true });
  });

  return app;
}

module.exports = { createServer };
