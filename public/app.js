// beepm mini app - Dynamic JS SDK integration
import { createDynamicClient, sendEmailOTP, verifyOTP, getWalletAccounts, getPrimaryWalletAccount, signMessage } from 'https://esm.sh/@dynamic-labs-sdk/client@0.23.2';
import { addEvmExtension } from 'https://esm.sh/@dynamic-labs-sdk/evm@0.23.2';
import { getChainsMissingWaasWalletAccounts, createWaasWalletAccounts } from 'https://esm.sh/@dynamic-labs-sdk/client@0.23.2/waas';

const DYNAMIC_ENV_ID = '9038e96d-3b30-43e3-877b-56d3d36f2613';
const GATEWAY_URL = 'https://beepm-gateway.claws.page';

// ================== state ==================
const state = {
  screen: 'signin',
  email: null,
  wallet: null,
  otpVerification: null,
  jwt: null,
  zeroclawdUrl: localStorage.getItem('beepm.zcUrl') || '',
  nftBalance: 0,
};

const $ = id => document.getElementById(id);
const log = (panel, msg) => {
  const el = $(panel);
  if (!el) return;
  el.style.display = 'block';
  const div = document.createElement('div');
  div.textContent = msg;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  console.log('[beepm]', msg);
};

function show(screen) {
  ['signin','mint','pair','capture'].forEach(s => {
    const el = $('screen-'+s);
    if (el) el.classList.toggle('hidden', s !== screen);
  });
  state.screen = screen;
}

// ================== Dynamic init ==================
let dynamicClient = null;
async function initDynamic() {
  try {
    dynamicClient = createDynamicClient({
      environmentId: DYNAMIC_ENV_ID,
      metadata: { name: 'beepm', url: location.origin },
    });
    addEvmExtension();
    log('signinLog', 'dynamic initialized');
  } catch (e) {
    log('signinLog', 'dynamic init error: ' + e.message);
    console.error(e);
  }
}

// ================== Sign-in flow ==================
$('sendOtpBtn').onclick = async () => {
  const email = $('emailInput').value.trim();
  if (!email) return;
  state.email = email;
  $('sendOtpBtn').disabled = true;
  log('signinLog', 'sending OTP to ' + email);
  try {
    const r = await sendEmailOTP({ email });
    state.otpVerification = r.otpVerification;
    $('otpStep').classList.remove('hidden');
    $('sendOtpBtn').textContent = 'code sent';
    log('signinLog', 'OTP sent - check your email');
  } catch (e) {
    log('signinLog', 'OTP send failed: ' + e.message);
    $('sendOtpBtn').disabled = false;
  }
};

$('verifyOtpBtn').onclick = async () => {
  const code = $('otpInput').value.trim();
  if (code.length < 4) return;
  $('verifyOtpBtn').disabled = true;
  log('signinLog', 'verifying...');
  try {
    await verifyOTP({ otpVerification: state.otpVerification, verificationToken: code });
    log('signinLog', 'verified · creating wallet');
    const missing = getChainsMissingWaasWalletAccounts();
    if (missing.length > 0) {
      await createWaasWalletAccounts({ chains: missing });
    }
    const wallets = getWalletAccounts();
    log('signinLog', 'accounts: ' + wallets.length);
    const evmWallet = wallets.find(w => w.chain === 'EVM') || wallets[0];
    if (!evmWallet) { log('signinLog','no wallet found'); return; }
    state.walletAccount = evmWallet;
    state.wallet = evmWallet.address;
    log('signinLog', 'wallet: ' + state.wallet);
    updateChip();
    await checkNFT();
  } catch (e) {
    log('signinLog', 'verify failed: ' + e.message);
    console.error(e);
    $('verifyOtpBtn').disabled = false;
  }
};

// ================== NFT check ==================
async function checkNFT() {
  if (!state.wallet) return;
  log('mintLog', 'checking NFT balance...');
  try {
    const r = await fetch(`${GATEWAY_URL}/api/owns/${state.wallet}`).then(r => r.json());
    state.nftBalance = parseInt(r.balance || '0');
    log('mintLog', `balance: ${r.balance} · owns: ${r.owns}`);
    if (r.owns) {
      await authWithGateway();
    } else {
      show('mint');
    }
  } catch (e) {
    log('mintLog', 'check failed: ' + e.message);
  }
}

// ================== Auth with gateway (sign challenge → JWT) ==================
async function authWithGateway() {
  try {
    log('mintLog', 'requesting challenge...');
    const ch = await fetch(`${GATEWAY_URL}/auth/challenge`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ wallet: state.wallet })
    }).then(r => r.json());
    log('mintLog', 'signing challenge...');
    const signature = (await signMessage({ walletAccount: state.walletAccount, message: ch.message })).signature;
    log('mintLog', 'verifying with gateway...');
    const verify = await fetch(`${GATEWAY_URL}/auth/verify`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ wallet: state.wallet, signature })
    }).then(r => r.json());
    if (verify.token) {
      state.jwt = verify.token;
      localStorage.setItem('beepm.jwt', verify.token);
      localStorage.setItem('beepm.wallet', state.wallet);
      log('mintLog', 'JWT issued · 24h');
      if (state.zeroclawdUrl) {
        show('capture');
        initCapture();
      } else {
        show('pair');
      }
    } else {
      log('mintLog', 'verify failed: ' + (verify.error || 'unknown'));
    }
  } catch (e) {
    log('mintLog', 'auth error: ' + e.message);
    console.error(e);
  }
}

// ================== Mint INFT (sponsored - gasless for user) ==================
$('mintBtn').onclick = async () => {
  $('mintBtn').disabled = true;
  log('mintLog', 'requesting mint message...');
  try {
    // 1. Get the message to sign
    const msgRes = await fetch(`${GATEWAY_URL}/api/mint-message/${state.wallet}`).then(r=>r.json());
    log('mintLog', 'signing authorization...');
    // 2. Sign with embedded wallet (just a message, no gas)
    const signature = (await signMessage({ walletAccount: state.walletAccount, message: msgRes.message })).signature;
    log('mintLog', 'gateway sponsoring mint tx...');
    // 3. Gateway pays gas + mints
    const r = await fetch(`${GATEWAY_URL}/api/mint`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ wallet: state.wallet, signature })
    }).then(r=>r.json());
    if (r.ok) {
      log('mintLog', '✓ minted! tx ' + r.txHash.slice(0,10) + '…');
      log('mintLog', 'gas: ' + r.gasUsed + ' (paid by gateway)');
      state.nftBalance = 1;
      await authWithGateway();
    } else {
      log('mintLog', 'mint failed: ' + (r.error || 'unknown'));
      $('mintBtn').disabled = false;
    }
  } catch (e) {
    log('mintLog', 'mint error: ' + e.message);
    console.error(e);
    $('mintBtn').disabled = false;
  }
};

// ================== Pair zeroclawd ==================
$('pairBtn').onclick = async () => {
  const url = $('zcUrlInput').value.trim().replace(/\/$/, '');
  if (!url) return;
  $('pairBtn').disabled = true;
  log('pairLog', 'testing ' + url);
  try {
    const info = await fetch(url + '/info').then(r => r.json());
    log('pairLog', '✓ zeroclawd v' + info.version + ' · instance ' + info.instanceId);
    // Register wallet + JWT with zeroclawd
    const reg = await fetch(url + '/pair/register', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ token: info.pairingToken || 'auto', wallet: state.wallet, jwt: state.jwt })
    }).then(r => r.json());
    if (reg.ok) {
      state.zeroclawdUrl = url;
      localStorage.setItem('beepm.zcUrl', url);
      log('pairLog', '✓ paired!');
      show('capture');
      initCapture();
    } else {
      log('pairLog', 'pair failed: ' + (reg.error || 'unknown'));
      $('pairBtn').disabled = false;
    }
  } catch (e) {
    log('pairLog', 'could not reach: ' + e.message);
    $('pairBtn').disabled = false;
  }
};

// ================== Chip / session ==================
function updateChip() {
  const chip = $('userChip');
  if (state.wallet) {
    chip.textContent = state.wallet.slice(0,6) + '…' + state.wallet.slice(-4);
    chip.classList.add('ok');
  }
}

// ================== Capture flow (simplified) ==================
let mediaStream = null;
let capturedDataUrl = null;

function initCapture() {
  log('log', 'ready · wallet ' + state.wallet.slice(0,10));
  loadHistory();
}

$('startCamBtn')?.addEventListener('click', async () => {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = document.createElement('video');
    video.srcObject = mediaStream; video.autoplay = true; video.playsInline = true;
    $('cameraBox').innerHTML = '';
    $('cameraBox').appendChild(video);
    $('captureBtn').disabled = false;
  } catch (e) {
    log('log', 'camera error: ' + e.message);
  }
});

$('captureBtn')?.addEventListener('click', () => {
  const video = $('cameraBox').querySelector('video');
  if (!video) return;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  capturedDataUrl = canvas.toDataURL('image/png');
  $('cameraBox').innerHTML = '';
  const img = document.createElement('img'); img.src = capturedDataUrl;
  $('cameraBox').appendChild(img);
  if (mediaStream) { mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; }
  runOCR(capturedDataUrl);
});

$('uploadBtn')?.addEventListener('click', () => $('fileInput').click());
$('fileInput')?.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    capturedDataUrl = ev.target.result;
    $('cameraBox').innerHTML = '';
    const img = document.createElement('img'); img.src = capturedDataUrl;
    $('cameraBox').appendChild(img);
    runOCR(capturedDataUrl);
  };
  reader.readAsDataURL(file);
});

async function runOCR(dataUrl) {
  log('log', 'sending to zeroclawd OCR...');
  try {
    const r = await fetch(state.zeroclawdUrl + '/api/ocr', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ imageDataUrl: dataUrl })
    }).then(r => r.json());
    if (r.ok && r.text) {
      log('log', 'ocr: "' + r.text + '"');
      parseBP(r.text);
    } else {
      log('log', 'ocr failed: ' + (r.error || 'no result'));
    }
  } catch (e) {
    log('log', 'ocr error: ' + e.message);
  }
}

function parseBP(text) {
  const digits = text.match(/\d{2,3}/g);
  if (!digits) return;
  if (digits.length >= 3) {
    $('sysInput').value = digits[0]; $('diaInput').value = digits[1]; $('pulseInput').value = digits[2];
  } else if (digits.length === 2) {
    $('sysInput').value = digits[0]; $('diaInput').value = digits[1];
  }
  $('saveBtn').disabled = false;
}

[$('sysInput'),$('diaInput'),$('pulseInput')].forEach(el => el?.addEventListener('input', () => {
  $('saveBtn').disabled = !($('sysInput').value && $('diaInput').value);
}));

$('saveBtn')?.addEventListener('click', async () => {
  $('saveBtn').disabled = true;
  const reading = {
    systolic: parseInt($('sysInput').value),
    diastolic: parseInt($('diaInput').value),
    pulse: parseInt($('pulseInput').value) || null,
    timestamp: Date.now()
  };
  log('log', 'analyzing via 0G...');
  try {
    // Call zeroclawd → gateway → 0G
    const analysis = await fetch(state.zeroclawdUrl + '/api/analyze', {
      method: 'POST',
      headers: {'Content-Type':'application/json', 'Authorization': 'Bearer '+state.jwt},
      body: JSON.stringify({ context: JSON.stringify(reading), question: `My latest BP: ${reading.systolic}/${reading.diastolic}, pulse ${reading.pulse}. Quick assessment in 1 sentence.` })
    }).then(r => r.json());
    if (analysis.reply) {
      showStatus(reading, analysis.reply);
    }
    // Store (unencrypted for now - add AES in phase 2)
    await fetch(state.zeroclawdUrl + '/api/reading', {
      method: 'POST',
      headers: {'Content-Type':'application/json', 'Authorization': 'Bearer '+state.jwt},
      body: JSON.stringify({
        encrypted: JSON.stringify(reading), // placeholder, replace with AES
        timestamp: reading.timestamp,
        ocr: `${reading.systolic}/${reading.diastolic}${reading.pulse?' '+reading.pulse:''}`
      })
    });
    log('log', '✓ saved');
    loadHistory();
  } catch (e) {
    log('log', 'save failed: ' + e.message);
  }
});

function showStatus(reading, advice) {
  const sys = reading.systolic, dia = reading.diastolic;
  let s = 'normal';
  if (sys >= 140 || dia >= 90) s = 'high';
  else if (sys >= 130 || dia >= 85) s = 'elevated';
  else if (sys < 90 || dia < 60) s = 'low';
  $('statusValue').textContent = s;
  $('statusAdvice').textContent = advice;
  $('statusBox').classList.remove('hidden');
}

async function loadHistory() {
  if (!state.zeroclawdUrl) return;
  try {
    const r = await fetch(state.zeroclawdUrl + '/api/readings', {
      headers: {'Authorization': 'Bearer '+state.jwt}
    }).then(r=>r.json());
    const list = $('historyList');
    if (!r.readings?.length) { list.innerHTML = '<div class="history-empty">no readings yet.</div>'; return; }
    list.innerHTML = '';
    for (const it of r.readings.slice().reverse().slice(0,20)) {
      const div = document.createElement('div'); div.className='history-item';
      const when = new Date(it.timestamp).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      div.innerHTML = `<span class="val">${it.ocr||'—'}</span><span class="when">${when}</span>`;
      list.appendChild(div);
    }
  } catch (e) { console.error(e); }
}

// Visible error overlay for debugging in Telegram webview
window.addEventListener('error', e => showErr('ERROR: ' + e.message));
window.addEventListener('unhandledrejection', e => showErr('PROMISE: ' + (e.reason?.message || e.reason)));
function showErr(msg) {
  let box = document.getElementById('__errbox');
  if (!box) {
    box = document.createElement('div');
    box.id = '__errbox';
    box.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#ff3366;color:#fff;padding:0.75rem;font-family:monospace;font-size:0.75rem;z-index:9999;max-height:40vh;overflow:auto;white-space:pre-wrap';
    document.body.appendChild(box);
  }
  box.textContent += msg + '\n';
}

// ================== boot ==================
(async () => {
  try {
  showErr('boot start · ' + new Date().toISOString().slice(11,19));
  showErr('screens found: signin=' + !!$('screen-signin') + ' mint=' + !!$('screen-mint'));
  // Always init Dynamic first (needed for signing even in restored sessions)
  await initDynamic();
  // Wait for init to complete + restore existing Dynamic session if any
  try { const { waitForClientInitialized } = await import('https://esm.sh/@dynamic-labs-sdk/client@0.23.2'); await waitForClientInitialized(); } catch(e) {}

  // If Dynamic restored a session, grab wallet
  const accounts = getWalletAccounts();
  if (accounts.length > 0) {
    const w = accounts.find(a => a.chain === 'EVM') || accounts[0];
    state.walletAccount = w;
    state.wallet = w.address;
    updateChip();
    log('signinLog','restored: ' + w.address.slice(0,10));
    await checkNFT();
    return;
  }
  show('signin');
  } catch(e) { showErr('BOOT: ' + (e.message || e) + '\n' + (e.stack||'').slice(0,400)); }
})();
