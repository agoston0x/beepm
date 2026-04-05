// beepm mini app — SPA
import { createDynamicClient, sendEmailOTP, verifyOTP, getWalletAccounts, signMessage, waitForClientInitialized } from 'https://esm.sh/@dynamic-labs-sdk/client@0.23.2';
import { addEvmExtension } from 'https://esm.sh/@dynamic-labs-sdk/evm@0.23.2';
import { getChainsMissingWaasWalletAccounts, createWaasWalletAccounts } from 'https://esm.sh/@dynamic-labs-sdk/client@0.23.2/waas';

const DYNAMIC_ENV_ID = '9038e96d-3b30-43e3-877b-56d3d36f2613';
const GATEWAY_URL = 'https://beepm-gateway.claws.page';

const $ = id => document.getElementById(id);

const state = {
  wallet: null, walletAccount: null, jwt: null,
  zeroclawdUrl: localStorage.getItem('beepm.zcUrl') || '',
  kind: 'bp',
  encKey: null,
};

// ============ UI helpers ============
function show(screen) {
  ['signin','mint','pair','profile','main'].forEach(s => {
    const el = $('screen-'+s);
    if (el) el.classList.toggle('hidden', s !== screen);
  });
}
function toast(msg, cls='') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + cls;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.className = 'toast ' + cls, 3500);
}
function updateChip() {
  if (state.wallet) {
    const c = $('userChip');
    c.textContent = state.wallet.slice(0,6)+'…'+state.wallet.slice(-4);
    c.classList.add('ok');
  }
}

// ============ Encryption (AES-GCM with wallet-derived key) ============
async function deriveEncKey() {
  if (state.encKey) return state.encKey;
  // Derive deterministic key from wallet signature
  const derMsg = `beepm · derive encryption key\n\nWallet: ${state.wallet.toLowerCase()}`;
  const sig = (await signMessage({ walletAccount: state.walletAccount, message: derMsg })).signature;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sig));
  state.encKey = await crypto.subtle.importKey('raw', hash, { name:'AES-GCM' }, false, ['encrypt','decrypt']);
  return state.encKey;
}
async function encrypt(obj) {
  const key = await deriveEncKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, plain));
  // Return base64 of iv||ct
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv,0); combined.set(ct, iv.length);
  return btoa(String.fromCharCode(...combined));
}
async function decrypt(b64) {
  try {
    const key = await deriveEncKey();
    const raw = Uint8Array.from(atob(b64), c=>c.charCodeAt(0));
    const iv = raw.slice(0,12); const ct = raw.slice(12);
    const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { return null; }
}

// ============ Dynamic + sign-in ============
async function initDynamic() {
  createDynamicClient({ environmentId: DYNAMIC_ENV_ID, metadata: { name: 'beepm', url: location.origin } });
  addEvmExtension();
  try { await waitForClientInitialized(); } catch {}
}

let otpVerification = null;
$('sendOtpBtn').onclick = async () => {
  const email = $('emailInput').value.trim();
  if (!email) return;
  $('sendOtpBtn').disabled = true;
  $('sendOtpBtn').textContent = 'sending…';
  try {
    const r = await sendEmailOTP({ email });
    otpVerification = r?.otpVerification || (r?.verificationUUID ? r : r);
    $('otpStep').classList.remove('hidden');
    $('sendOtpBtn').textContent = 'code sent';
    toast('check your email for the code','ok');
  } catch (e) {
    toast('send failed: '+e.message,'err');
    $('sendOtpBtn').disabled = false; $('sendOtpBtn').textContent = 'send code';
  }
};
$('verifyOtpBtn').onclick = async () => {
  const code = $('otpInput').value.trim();
  if (code.length<4) return;
  $('verifyOtpBtn').disabled = true;
  $('verifyOtpBtn').textContent = 'verifying…';
  try {
    await verifyOTP({ otpVerification, verificationToken: code });
    const missing = getChainsMissingWaasWalletAccounts();
    if (missing.length>0) await createWaasWalletAccounts({ chains: missing });
    const wallets = getWalletAccounts();
    const w = wallets.find(a=>a.chain==='EVM') || wallets[0];
    if (!w) throw new Error('no wallet created');
    state.walletAccount = w;
    state.wallet = w.address;
    updateChip();
    await checkAndProceed();
  } catch (e) {
    toast('verify failed: '+e.message,'err');
    $('verifyOtpBtn').disabled = false; $('verifyOtpBtn').textContent = 'verify';
  }
};

// ============ NFT + JWT ============
async function checkAndProceed() {
  const r = await fetch(`${GATEWAY_URL}/api/owns/${state.wallet}`).then(r=>r.json()).catch(()=>({owns:false}));
  if (!r.owns) { show('mint'); return; }
  await authWithGateway();
}
async function authWithGateway() {
  try {
    const ch = await fetch(`${GATEWAY_URL}/auth/challenge`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:state.wallet})}).then(r=>r.json());
    const sig = (await signMessage({ walletAccount: state.walletAccount, message: ch.message })).signature;
    const v = await fetch(`${GATEWAY_URL}/auth/verify`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:state.wallet,signature:sig})}).then(r=>r.json());
    if (!v.token) { toast('auth failed: '+(v.error||''),'err'); return; }
    state.jwt = v.token;
    localStorage.setItem('beepm.jwt', v.token);
    localStorage.setItem('beepm.wallet', state.wallet);
    if (state.zeroclawdUrl) {
      try { await fetch(state.zeroclawdUrl+'/pair/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:state.wallet,jwt:state.jwt})}); } catch {}
      show('profile');
    } else {
      show('pair');
    }
  } catch (e) { toast('auth error: '+e.message,'err'); }
}
$('mintBtn').onclick = async () => {
  $('mintBtn').disabled = true; $('mintBtn').textContent = 'signing…';
  try {
    const msgRes = await fetch(`${GATEWAY_URL}/api/mint-message/${state.wallet}`).then(r=>r.json());
    const sig = (await signMessage({ walletAccount: state.walletAccount, message: msgRes.message })).signature;
    $('mintBtn').textContent = 'minting…';
    const r = await fetch(`${GATEWAY_URL}/api/mint`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:state.wallet,signature:sig})}).then(r=>r.json());
    if (!r.ok) throw new Error(r.error||'mint failed');
    toast('✓ INFT minted · gasless','ok');
    await authWithGateway();
  } catch (e) {
    toast('mint: '+e.message,'err');
    $('mintBtn').disabled = false; $('mintBtn').textContent = 'mint agent NFT';
  }
};
$('pairBtn').onclick = async () => {
  const url = $('zcUrlInput').value.trim().replace(/\/$/,'');
  if (!url) return;
  $('pairBtn').disabled = true; $('pairBtn').textContent = 'pairing…';
  try {
    await fetch(url+'/info').then(r=>r.json());
    const reg = await fetch(url+'/pair/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:state.wallet,jwt:state.jwt})}).then(r=>r.json());
    if (!reg.ok) throw new Error(reg.error||'register failed');
    state.zeroclawdUrl = url;
    localStorage.setItem('beepm.zcUrl', url);
    toast('✓ paired','ok');
    show('profile');
  } catch (e) {
    toast('pair: '+e.message,'err');
    $('pairBtn').disabled = false; $('pairBtn').textContent = 'pair';
  }
};

// ============ Profile ============
$('skipProfileBtn').onclick = () => { enterMain(); };

$('createProfileBtn').onclick = async () => {
  const name = $('profileName').value.trim();
  const age = $('profileAge').value.trim();
  const gender = $('profileGender').value;
  
  const profile = { name: name || null, age: age ? parseInt(age) : null, gender: gender || null };
  
  $('createProfileBtn').disabled = true;
  $('createProfileBtn').textContent = 'encrypting…';
  
  try {
    // Encrypt profile
    const encrypted = await encrypt(profile);
    
    $('createProfileBtn').textContent = 'registering…';
    
    // Register on-chain
    const res = await fetch(`${GATEWAY_URL}/api/profile/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.jwt },
      body: JSON.stringify({ encryptedProfile: encrypted })
    }).then(r => r.json());
    
    if (!res.ok) throw new Error(res.error || 'registration failed');
    
    // Show result
    const fullDomain = res.fullDomain;
    $('profileResult').innerHTML = `<div style="color:var(--ok);font-weight:600;margin-bottom:0.3rem">✓ Health ID created</div><div style="font-family:'DM Mono',monospace;font-size:0.78rem">${fullDomain}</div><div style="margin-top:0.4rem;font-size:0.72rem;color:var(--dim)">Your profile is encrypted with your wallet key. <a href="https://sepolia.basescan.org/tx/${res.tx}" target="_blank" style="color:var(--accent)">View tx →</a></div>`;
    $('profileResult').classList.remove('hidden');
    
    toast('✓ Health ID registered on Base','ok');
    
    $('createProfileBtn').textContent = 'done';
    setTimeout(() => enterMain(), 2000);
    
  } catch (e) {
    toast('profile: ' + e.message, 'err');
    $('createProfileBtn').disabled = false;
    $('createProfileBtn').textContent = 'create health ID';
  }
};

// ============ Main app ============
async function enterMain() {
  show('main');
  await loadHistory();
}

// Tabs
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x===t));
  state.kind = t.dataset.kind;
  $('form-bp').classList.toggle('hidden', state.kind !== 'bp');
  $('form-weight').classList.toggle('hidden', state.kind !== 'weight');
  $('analysisBox').classList.add('hidden');
});

// Enable save buttons as inputs fill
function wireEnable(inputs, btnId){
  const fn = () => { $(btnId).disabled = !inputs.every(id => $(id).value); };
  inputs.forEach(id => $(id).addEventListener('input', fn));
}
wireEnable(['bpSys','bpDia'], 'saveBpBtn');
wireEnable(['wtKg'], 'saveWtBtn');

// Save BP
$('saveBpBtn').onclick = async () => {
  const reading = {
    kind:'bp',
    systolic: parseInt($('bpSys').value),
    diastolic: parseInt($('bpDia').value),
    pulse: parseInt($('bpPulse').value)||null,
    timestamp: Date.now()
  };
  await saveReading(reading);
};

// Save Weight
$('saveWtBtn').onclick = async () => {
  const reading = {
    kind:'weight',
    kg: parseFloat($('wtKg').value),
    body_fat: parseFloat($('wtFat').value)||null,
    timestamp: Date.now()
  };
  await saveReading(reading);
};

async function saveReading(reading) {
  const btn = reading.kind==='bp' ? $('saveBpBtn') : $('saveWtBtn');
  btn.disabled = true; btn.textContent = 'encrypting…';
  try {
    const encrypted = await encrypt(reading);
    btn.textContent = 'saving…';
    await fetch(state.zeroclawdUrl+'/api/reading',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+state.jwt},
      body: JSON.stringify({ encrypted, timestamp: reading.timestamp, ocr: null, kind: reading.kind })
    });
    toast('✓ encrypted & stored','ok');
    btn.textContent = 'analyzing…';
    await runAnalysis(reading);
    // Clear inputs
    if (reading.kind==='bp') { $('bpSys').value=''; $('bpDia').value=''; $('bpPulse').value=''; }
    else { $('wtKg').value=''; $('wtFat').value=''; }
    btn.textContent = 'save reading';
    await loadHistory();
  } catch (e) {
    toast('save: '+e.message,'err');
    btn.disabled = false; btn.textContent = 'save reading';
  }
}

async function runAnalysis(reading) {
  try {
    const ctx = reading.kind==='bp'
      ? `BP: ${reading.systolic}/${reading.diastolic}${reading.pulse?' pulse '+reading.pulse:''}`
      : `Weight: ${reading.kg}kg${reading.body_fat?' · body fat '+reading.body_fat+'%':''}`;
    const messages = [
      { role:'system', content:'You are a private health assistant. Analyze readings briefly (≤2 sentences). Never diagnose. Be factual.' },
      { role:'user', content:`Latest reading — ${ctx}. Brief assessment?` }
    ];
    const r = await fetch(GATEWAY_URL+'/api/infer',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+state.jwt},
      body: JSON.stringify({ messages, temperature: 0.4 })
    }).then(r=>r.json());
    if (r.reply) {
      $('analysisText').textContent = r.reply;
      $('analysisBox').classList.remove('hidden');
    }
  } catch {}
}

// Photo capture (file input)
$('photoBpBtn').onclick = () => $('bpFile').click();
$('photoWtBtn').onclick = () => $('wtFile').click();
$('bpFile').onchange = e => handlePhoto(e, 'bp');
$('wtFile').onchange = e => handlePhoto(e, 'weight');

async function handlePhoto(e, kind) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    const dataUrl = ev.target.result;
    toast('sending photo to your node…');
    try {
      const r = await fetch(state.zeroclawdUrl+'/api/capture',{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+state.jwt},
        body: JSON.stringify({ imageDataUrl: dataUrl, kind })
      }).then(r=>r.json());
      if (!r.ok) { toast('OCR failed — enter manually','err'); return; }
      const v = r.reading?.values || {};
      if (kind==='bp') {
        if (v.systolic) $('bpSys').value = v.systolic;
        if (v.diastolic) $('bpDia').value = v.diastolic;
        if (v.pulse) $('bpPulse').value = v.pulse;
        $('saveBpBtn').disabled = !($('bpSys').value && $('bpDia').value);
        toast('OCR done · review and save','ok');
      } else {
        if (v.kg || v.systolic) $('wtKg').value = v.kg || v.systolic;
        $('saveWtBtn').disabled = !$('wtKg').value;
        toast('OCR done · review and save','ok');
      }
    } catch (err) { toast('capture: '+err.message,'err'); }
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

// History
async function loadHistory() {
  try {
    const r = await fetch(state.zeroclawdUrl+'/api/readings',{headers:{'Authorization':'Bearer '+state.jwt}}).then(r=>r.json());
    const list = $('historyList');
    const rows = r.readings || [];
    if (!rows.length) { list.innerHTML = '<div class="empty">no readings yet.</div>'; return; }
    list.innerHTML = '';
    const decrypted = [];
    for (const it of rows.slice(-30).reverse()) {
      const rec = await decrypt(it.encrypted) || { kind: it.kind || 'bp', fallback:true };
      decrypted.push({ ...rec, timestamp: it.timestamp });
    }
    for (const d of decrypted) {
      const when = new Date(d.timestamp).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      let val = '—', badge = 'BP';
      if (d.fallback) val = '<span style="opacity:0.5">encrypted</span>';
      else if (d.kind === 'weight') { badge = 'WT'; val = `${d.kg} kg${d.body_fat?' · '+d.body_fat+'%':''}`; }
      else val = `${d.systolic}/${d.diastolic}${d.pulse?' · '+d.pulse:''}`;
      const kindCls = d.kind === 'weight' ? 'weight' : '';
      list.insertAdjacentHTML('beforeend', `<div class="entry"><span class="val"><span class="kind-badge ${kindCls}">${badge}</span>${val}</span><span class="meta"><span class="when">${when}</span><span class="lock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>encrypted</span></span></div>`);
    }
  } catch {}
}

// ============ startapp + boot ============
function parseStartapp() {
  try {
    const p = window.Telegram?.WebApp?.initDataUnsafe?.start_param || '';
    if (!p.startsWith('pair_')) return;
    const b64 = p.slice(5).replace(/-/g,'+').replace(/_/g,'/');
    const pad = b64.length % 4 ? '='.repeat(4-(b64.length%4)) : '';
    const j = JSON.parse(atob(b64+pad));
    if (j.url) { state.zeroclawdUrl = j.url; localStorage.setItem('beepm.zcUrl', j.url); }
  } catch {}
}

(async () => {
  parseStartapp();
  await initDynamic();
  const accounts = getWalletAccounts();
  if (accounts.length > 0) {
    const w = accounts.find(a=>a.chain==='EVM') || accounts[0];
    state.walletAccount = w;
    state.wallet = w.address;
    updateChip();
    await checkAndProceed();
    return;
  }
  show('signin');
})();
