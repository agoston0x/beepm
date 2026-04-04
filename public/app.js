// beepm app — camera + OCR + encryption (v0.1)

const $ = id => document.getElementById(id);
const logEl = $('log');
let stream = null;

function log(msg) {
  logEl.style.display = 'block';
  const div = document.createElement('div');
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  console.log('[beepm]', msg);
}

// ===== User ID (Telegram or anonymous) =====
let userId = 'anon-' + (localStorage.getItem('beepm_uid') || Math.random().toString(36).slice(2, 10));
if (!localStorage.getItem('beepm_uid')) {
  localStorage.setItem('beepm_uid', userId.slice(5));
}
if (window.Telegram?.WebApp?.initDataUnsafe?.user) {
  const tgUser = window.Telegram.WebApp.initDataUnsafe.user;
  userId = 'tg-' + tgUser.id;
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
}
$('userChip').textContent = userId.slice(0, 16) + (userId.length > 16 ? '...' : '');

// ===== Camera =====
$('startCamBtn').addEventListener('click', async () => {
  try {
    log('requesting camera...');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } }
    });
    const video = document.createElement('video');
    video.srcObject = stream;
    video.playsInline = true;
    video.autoplay = true;
    $('cameraBox').innerHTML = '';
    $('cameraBox').appendChild(video);
    $('captureBtn').disabled = false;
    $('startCamBtn').textContent = 'Camera on';
    $('startCamBtn').disabled = true;
    log('camera started');
  } catch (e) {
    log('camera error: ' + e.message);
    alert('Camera access denied or unavailable. Enter values manually.');
  }
});

let capturedCanvas = null;
let cropPoints = [];

// ===== Upload photo =====
$('uploadBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  log('loading uploaded image...');
  const img = new Image();
  img.onload = () => {
    capturedCanvas = document.createElement('canvas');
    // downscale huge images (speeds OCR)
    const maxW = 1600;
    const scale = Math.min(1, maxW / img.width);
    capturedCanvas.width = img.width * scale;
    capturedCanvas.height = img.height * scale;
    capturedCanvas.getContext('2d').drawImage(img, 0, 0, capturedCanvas.width, capturedCanvas.height);
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    $('startCamBtn').disabled = false;
    $('startCamBtn').textContent = 'Retake';
    showCropStep();
  };
  img.src = URL.createObjectURL(file);
});

// ===== Capture & OCR =====
$('captureBtn').addEventListener('click', async () => {
  const video = $('cameraBox').querySelector('video');
  if (!video) return;
  capturedCanvas = document.createElement('canvas');
  capturedCanvas.width = video.videoWidth;
  capturedCanvas.height = video.videoHeight;
  capturedCanvas.getContext('2d').drawImage(video, 0, 0);

  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('captureBtn').disabled = true;
  $('startCamBtn').disabled = false;
  $('startCamBtn').textContent = 'Retake';

  showCropStep();
});

function showCropStep() {
  cropPoints = [];
  $('cameraBox').innerHTML = '';
  $('cameraBox').appendChild(capturedCanvas);
  capturedCanvas.style.cursor = 'crosshair';

  // overlay for drawing selection
  const overlay = document.createElement('canvas');
  overlay.width = capturedCanvas.width;
  overlay.height = capturedCanvas.height;
  overlay.style.position = 'absolute';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.cursor = 'crosshair';
  $('cameraBox').style.position = 'relative';
  $('cameraBox').appendChild(overlay);

  log('tap TWO corners of the LCD display (top-left, then bottom-right)');

  overlay.addEventListener('click', (e) => {
    const rect = overlay.getBoundingClientRect();
    const scaleX = overlay.width / rect.width;
    const scaleY = overlay.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    cropPoints.push({ x, y });
    const ctx = overlay.getContext('2d');
    ctx.fillStyle = '#00C9AE';
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
    if (cropPoints.length === 2) {
      ctx.strokeStyle = '#00C9AE';
      ctx.lineWidth = 4;
      const [p1, p2] = cropPoints;
      ctx.strokeRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y),
                     Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
      log('running OCR on selected region...');
      setTimeout(() => runOCR(), 300);
    }
  });
}

async function runOCR() {
  const [p1, p2] = cropPoints;
  const x = Math.min(p1.x, p2.x);
  const y = Math.min(p1.y, p2.y);
  const w = Math.abs(p2.x - p1.x);
  const h = Math.abs(p2.y - p1.y);

  // Crop + preprocess: grayscale + invert (dark segments on light bg) + threshold + scale up 3x
  const cropped = document.createElement('canvas');
  cropped.width = w * 3;
  cropped.height = h * 3;
  const cctx = cropped.getContext('2d');
  cctx.imageSmoothingEnabled = true;
  cctx.imageSmoothingQuality = 'high';
  cctx.drawImage(capturedCanvas, x, y, w, h, 0, 0, cropped.width, cropped.height);

  // Grayscale + Otsu threshold (find optimal threshold automatically)
  const imgData = cctx.getImageData(0, 0, cropped.width, cropped.height);
  const d = imgData.data;
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round((d[i] + d[i+1] + d[i+2]) / 3);
    hist[g]++;
  }
  // Otsu
  const total = d.length / 4;
  let sumB = 0, wB = 0, max = 0, sum1 = 0, threshold = 127;
  for (let i = 0; i < 256; i++) sum1 += i * hist[i];
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (wB === 0) continue;
    const wF = total - wB; if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum1 - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > max) { max = between; threshold = t; }
  }
  log('otsu threshold: ' + threshold);
  // Determine polarity: LCD digits typically DARK on light bg
  let darkCount = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] + d[i+1] + d[i+2]) / 3;
    if (g < threshold) darkCount++;
  }
  const darkRatio = darkCount / total;
  // If digits are the minority (typical LCD), keep as is. Invert if most pixels are dark.
  const invert = darkRatio > 0.5;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] + d[i+1] + d[i+2]) / 3;
    let v = g < threshold ? 0 : 255;
    if (invert) v = 255 - v;
    d[i] = d[i+1] = d[i+2] = v;
  }
  cctx.putImageData(imgData, 0, 0);
  log('preprocessed (invert=' + invert + ', dark ratio=' + darkRatio.toFixed(2) + ')');

  // show preprocessed image
  $('cameraBox').innerHTML = '';
  $('cameraBox').appendChild(cropped);

  // Send to server-side ssocr (specialized for 7-segment)
  const t0 = performance.now();
  log('sending to nanoclaw ssocr...');
  try {
    const dataUrl = cropped.toDataURL('image/png');
    const res = await fetch('/api/ocr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl: dataUrl })
    });
    const data = await res.json();
    log(`ocr done (${Math.round(performance.now() - t0)}ms)`);
    if (data.ok && data.text) {
      log('ssocr result: "' + data.text + '"');
      parseBP(data.text);
    } else {
      log('ssocr failed, trying tesseract fallback...');
      const result = await Tesseract.recognize(cropped, 'eng', {
        tessedit_char_whitelist: '0123456789',
        tessedit_pageseg_mode: '11',
      });
      log('tesseract: "' + result.data.text.replace(/\n/g, ' ').trim() + '"');
      parseBP(result.data.text);
    }
  } catch (e) {
    log('ocr error: ' + e.message);
  }
}

function parseBP(text) {
  // Extract numbers from OCR text; BP monitors typically show SYS (top), DIA (mid), PULSE (bottom)
  const nums = text.match(/\d{2,3}/g) || [];
  log('extracted numbers: [' + nums.join(', ') + ']');
  // Heuristic: first 3 numbers that fit typical ranges
  let sys = null, dia = null, pulse = null;
  for (const n of nums) {
    const v = parseInt(n);
    if (sys === null && v >= 70 && v <= 220) { sys = v; continue; }
    if (dia === null && v >= 40 && v <= 140) { dia = v; continue; }
    if (pulse === null && v >= 30 && v <= 200) { pulse = v; continue; }
  }
  if (sys) $('sysInput').value = sys;
  if (dia) $('diaInput').value = dia;
  if (pulse) $('pulseInput').value = pulse;
  if (sys || dia || pulse) {
    log(`parsed: sys=${sys} dia=${dia} pulse=${pulse}`);
    validateInputs();
  } else {
    log('could not parse — enter manually');
  }
}

// ===== Input validation =====
function validateInputs() {
  const sys = parseInt($('sysInput').value);
  const dia = parseInt($('diaInput').value);
  const ok = sys >= 50 && sys <= 250 && dia >= 30 && dia <= 150;
  $('saveBtn').disabled = !ok;
}
['sysInput', 'diaInput', 'pulseInput'].forEach(id => {
  $(id).addEventListener('input', validateInputs);
});

// ===== Client-side encryption =====
async function deriveKey(userId) {
  // v0.1: derive from userId. v0.2: derive from wallet signature.
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.digest('SHA-256', enc.encode('beepm-v1-' + userId));
  return await crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptReading(reading) {
  const key = await deriveKey(userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(reading));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return {
    iv: Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join(''),
    ct: Array.from(new Uint8Array(ct)).map(b => b.toString(16).padStart(2, '0')).join('')
  };
}

async function decryptReading(encrypted) {
  const key = await deriveKey(userId);
  const iv = new Uint8Array(encrypted.iv.match(/.{2}/g).map(h => parseInt(h, 16)));
  const ct = new Uint8Array(encrypted.ct.match(/.{2}/g).map(h => parseInt(h, 16)));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

// ===== Save & analyze =====
$('saveBtn').addEventListener('click', async () => {
  const reading = {
    systolic: parseInt($('sysInput').value),
    diastolic: parseInt($('diaInput').value),
    pulse: parseInt($('pulseInput').value) || null,
    timestamp: Date.now()
  };
  log(`saving: ${reading.systolic}/${reading.diastolic} pulse=${reading.pulse}`);

  // Analyze
  const analyzeRes = await fetch('/api/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reading)
  });
  const analysis = await analyzeRes.json();
  showStatus(analysis);

  // Encrypt & store
  const encrypted = await encryptReading(reading);
  const saveRes = await fetch('/api/reading', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, encrypted, timestamp: reading.timestamp })
  });
  const saveData = await saveRes.json();
  log(`stored (${saveData.count} total)`);
  await loadHistory();
});

function showStatus(analysis) {
  const box = $('statusBox');
  const val = $('statusValue');
  const adv = $('statusAdvice');
  box.style.display = 'block';
  val.textContent = analysis.status.toUpperCase();
  val.className = 'status-value status-' + analysis.status;
  adv.textContent = analysis.advice;
}

// ===== History =====
async function loadHistory() {
  const res = await fetch('/api/readings/' + userId);
  const { readings } = await res.json();
  const list = $('historyList');
  if (!readings.length) {
    list.innerHTML = '<div style="color: var(--dim); font-size: 14px;">No readings yet.</div>';
    return;
  }
  list.innerHTML = '';
  for (const r of readings.slice().reverse().slice(0, 20)) {
    try {
      const decrypted = await decryptReading(r.encrypted);
      const div = document.createElement('div');
      div.className = 'reading-item';
      div.innerHTML = `
        <div class="values">${decrypted.systolic}/${decrypted.diastolic}${decrypted.pulse ? ' · ' + decrypted.pulse + ' bpm' : ''}</div>
        <div class="time">${new Date(r.timestamp).toLocaleString()}</div>
      `;
      list.appendChild(div);
    } catch (e) { console.error('decrypt failed', e); }
  }
}

loadHistory();
log('beepm ready · userId=' + userId.slice(0, 20));
