const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');
require('dotenv').config();

const PORT = process.env.PORT || 3061;
const DATA_FILE = path.join(__dirname, 'readings.json');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

function loadReadings() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function saveReadings(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// POST /api/reading - store encrypted reading
app.post('/api/reading', (req, res) => {
  const { userId, encrypted, timestamp } = req.body;
  if (!userId || !encrypted) return res.status(400).json({ error: 'missing fields' });
  const readings = loadReadings();
  if (!readings[userId]) readings[userId] = [];
  readings[userId].push({ encrypted, timestamp: timestamp || Date.now() });
  saveReadings(readings);
  console.log(`[beepm] stored reading for ${userId.slice(0,10)}... (${readings[userId].length} total)`);
  res.json({ ok: true, count: readings[userId].length });
});

// GET /api/readings/:userId - fetch encrypted readings
app.get('/api/readings/:userId', (req, res) => {
  const readings = loadReadings();
  res.json({ readings: readings[req.params.userId] || [] });
});

// POST /api/analyze - placeholder for 0G Compute analysis
app.post('/api/analyze', async (req, res) => {
  const { systolic, diastolic, pulse } = req.body;
  let status = 'normal', advice = 'Within normal range.';
  if (systolic >= 140 || diastolic >= 90) { status = 'high'; advice = 'Elevated. Consider consulting a doctor.'; }
  else if (systolic < 90 || diastolic < 60) { status = 'low'; advice = 'Below normal range.'; }
  else if (systolic >= 130 || diastolic >= 85) { status = 'elevated'; advice = 'Slightly elevated. Monitor closely.'; }
  res.json({ status, advice, systolic, diastolic, pulse });
});

// POST /api/ocr - 7-segment OCR via ssocr
function runSsocr(tmpFile, argsPreset) {
  return new Promise((resolve) => {
    const args = [...argsPreset, tmpFile];
    execFile('ssocr', args, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ err, stdout: (stdout || '').trim(), stderr: (stderr || '').slice(0, 200) });
    });
  });
}

app.post('/api/ocr', async (req, res) => {
  const { imageDataUrl } = req.body;
  if (!imageDataUrl) return res.status(400).json({ error: 'missing imageDataUrl' });
  const match = imageDataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'invalid image' });
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buf = Buffer.from(match[2], 'base64');
  const tmpFile = path.join(os.tmpdir(), `beepm-${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`);
  fs.writeFileSync(tmpFile, buf);

  // Try multiple ssocr preset configurations
  const presets = [
    // dark-on-light (typical LCD: dark digits on white/grey background)
    ['-d', '-1', '-T', '-s', 'gray_stretch', '10', '240', 'dynamic_threshold', '10', '10'],
    // with inversion (white segments on dark)
    ['-d', '-1', '-T', '-s', 'invert', 'gray_stretch', '10', '240'],
    // Otsu-style adaptive
    ['-d', '-1', '-T', '-s', 'dynamic_threshold', '5', '5'],
    // Simpler: iterative threshold
    ['-d', '-1', '-T', '-s'],
    ['-d', '-1', '-T', '-s', 'invert'],
  ];

  let best = { text: '', err: true };
  for (const preset of presets) {
    const r = await runSsocr(tmpFile, preset);
    console.log('[beepm/ocr] preset', JSON.stringify(preset.slice(0,5)), '→', JSON.stringify(r.stdout), r.err ? 'ERR' : 'OK');
    if (!r.err && r.stdout && /\d/.test(r.stdout)) {
      best = { text: r.stdout, err: false };
      break;
    }
  }
  try { fs.unlinkSync(tmpFile); } catch {}

  if (best.err) return res.json({ ok: false, error: 'ocr failed' });
  res.json({ ok: true, text: best.text });
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'beepm' }));

app.listen(PORT, () => console.log(`[beepm] listening on http://localhost:${PORT}`));
