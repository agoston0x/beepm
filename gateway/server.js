// beepm-gateway — INFT-gated proxy to 0G Compute
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const jwt = require('jsonwebtoken');
const OpenAI = require('openai');
require('dotenv').config();

const PORT = process.env.PORT || 3063;
const JWT_SECRET = process.env.JWT_SECRET || 'beepm-demo-secret-change-in-prod';
const OG_RPC = 'https://evmrpc-testnet.0g.ai';
const INFT_CONTRACT = process.env.INFT_CONTRACT || '0x7fF7f65225e2ee92a4a81d3503308fC8f288E021';
const OG_ENDPOINT = 'https://compute-network-6.integratenetwork.work';
const OG_MODEL = 'qwen/qwen-2.5-7b-instruct';
const OG_API_KEY = process.env.OG_API_KEY;
const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
const REGISTRY_CONTRACT = '0xc95BCe68a26F31F2E3679Abe7c55eC776Ec6aaee';

const provider = new ethers.JsonRpcProvider(OG_RPC);
const INFT_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function mintAgent(address to, string encryptedURI, bytes32 metadataHash) returns (uint256)'
];
const inft = new ethers.Contract(INFT_CONTRACT, INFT_ABI, provider);

// Base Sepolia for profile registry
const baseProvider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC);
const REGISTRY_ABI = [
  'function register(string subdomain, string encryptedData) external',
  'function getProfile(string subdomain) external view returns (address, string, uint256)',
  'function getSubdomainByWallet(address wallet) external view returns (string)'
];
const registryRead = new ethers.Contract(REGISTRY_CONTRACT, REGISTRY_ABI, baseProvider);

// Sponsor wallet for gasless INFT mints
const SPONSOR_PK = process.env.SPONSOR_PRIVATE_KEY;
const sponsorWallet = SPONSOR_PK ? new ethers.Wallet(SPONSOR_PK, provider) : null;
const inftSponsor = sponsorWallet ? new ethers.Contract(INFT_CONTRACT, INFT_ABI, sponsorWallet) : null;

// Sponsor wallet on Base Sepolia for registry
const baseSponsor = SPONSOR_PK ? new ethers.Wallet(SPONSOR_PK, baseProvider) : null;
const registryWrite = baseSponsor ? new ethers.Contract(REGISTRY_CONTRACT, REGISTRY_ABI, baseSponsor) : null;

const ai = new OpenAI({ baseURL: OG_ENDPOINT + '/v1/proxy', apiKey: OG_API_KEY });

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// In-memory challenge store (prod: use Redis)
const challenges = new Map();

app.get('/health', (_, res) => res.json({
  ok: true, service: 'beepm-gateway', version: '0.1.0',
  inft: INFT_CONTRACT, chain: 16602
}));

// Step 1: client requests challenge
app.post('/auth/challenge', (req, res) => {
  const { wallet } = req.body;
  if (!wallet || !ethers.isAddress(wallet)) return res.status(400).json({ error: 'invalid wallet' });
  const nonce = ethers.hexlify(ethers.randomBytes(16));
  const message = `beepm sign-in\n\nWallet: ${wallet.toLowerCase()}\nNonce: ${nonce}\nTime: ${Date.now()}`;
  challenges.set(wallet.toLowerCase(), { message, nonce, createdAt: Date.now() });
  console.log(`[gateway] challenge issued · ${wallet.slice(0,10)}...`);
  res.json({ message });
});

// Step 2: client submits signed challenge → gateway verifies sig + INFT → issues JWT
app.post('/auth/verify', async (req, res) => {
  const { wallet, signature } = req.body;
  if (!wallet || !signature) return res.status(400).json({ error: 'missing fields' });
  const w = wallet.toLowerCase();
  const ch = challenges.get(w);
  if (!ch) return res.status(400).json({ error: 'no challenge; request one first' });
  if (Date.now() - ch.createdAt > 5 * 60 * 1000) {
    challenges.delete(w);
    return res.status(400).json({ error: 'challenge expired' });
  }

  // Verify signature
  let recovered;
  try { recovered = ethers.verifyMessage(ch.message, signature); }
  catch (e) { return res.status(400).json({ error: 'bad signature' }); }
  if (recovered.toLowerCase() !== w) return res.status(401).json({ error: 'signature mismatch' });

  // Verify INFT ownership on-chain
  let balance;
  try { balance = await inft.balanceOf(wallet); }
  catch (e) {
    console.error('[gateway] chain error:', e.message);
    return res.status(500).json({ error: 'chain query failed' });
  }
  const owns = balance > 0n;
  console.log(`[gateway] verify · ${wallet.slice(0,10)}... · balance=${balance} · access=${owns}`);
  if (!owns) return res.status(403).json({ error: 'no INFT; mint one first', wallet, balance: balance.toString() });

  challenges.delete(w);
  const token = jwt.sign({ wallet: w, nfts: balance.toString() }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, wallet: w, nfts: balance.toString(), expiresIn: 86400 });
});

// JWT middleware
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing bearer token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch (e) { return res.status(401).json({ error: 'invalid token' }); }
}

// Gated 0G proxy
app.post('/api/infer', requireAuth, async (req, res) => {
  const { messages, temperature } = req.body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be array' });
  try {
    const t0 = Date.now();
    const completion = await ai.chat.completions.create({
      model: OG_MODEL,
      messages,
      temperature: temperature ?? 0.5
    });
    console.log(`[gateway] infer · ${req.user.wallet.slice(0,10)} · ${Date.now() - t0}ms · ${completion.usage?.total_tokens || '?'} tk`);
    res.json({
      reply: completion.choices[0].message.content,
      model: OG_MODEL,
      tokens: completion.usage,
      tee_verified: true
    });
  } catch (e) {
    console.error('[gateway] 0g error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Sponsored mint: user signs "mint for me" message → gateway pays gas → mints to user
// Rate limited: 1 mint per wallet address (checks balance first)
const mintInFlight = new Set();
app.post('/api/mint', async (req, res) => {
  if (!inftSponsor) return res.status(503).json({ error: 'sponsor wallet not configured' });
  const { wallet, signature } = req.body;
  if (!wallet || !signature) return res.status(400).json({ error: 'missing wallet or signature' });
  if (!ethers.isAddress(wallet)) return res.status(400).json({ error: 'invalid wallet' });
  const w = wallet.toLowerCase();

  // Verify signature on a fixed message tied to the wallet
  const mintMsg = `beepm · mint agent NFT\n\nWallet: ${w}\nContract: ${INFT_CONTRACT}\nChain: 16602`;
  let recovered;
  try { recovered = ethers.verifyMessage(mintMsg, signature); }
  catch (e) { return res.status(400).json({ error: 'bad signature' }); }
  if (recovered.toLowerCase() !== w) return res.status(401).json({ error: 'signature mismatch' });

  // Prevent double-mint
  if (mintInFlight.has(w)) return res.status(429).json({ error: 'mint already in progress' });
  try {
    const existing = await inft.balanceOf(wallet);
    if (existing > 0n) return res.status(400).json({ error: 'already has INFT', balance: existing.toString() });
  } catch (e) {
    return res.status(500).json({ error: 'balance check failed: ' + e.message });
  }

  mintInFlight.add(w);
  try {
    const encryptedURI = `beepm-agent:${w}`;
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(encryptedURI));
    console.log(`[gateway] sponsored mint → ${w}`);
    const tx = await inftSponsor.mintAgent(wallet, encryptedURI, metadataHash);
    console.log(`[gateway] mint tx: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[gateway] mint confirmed · block ${receipt.blockNumber} · gas ${receipt.gasUsed}`);
    res.json({
      ok: true,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      wallet: w,
      explorer: `https://chainscan-newton.0g.ai/tx/${tx.hash}`
    });
  } catch (e) {
    console.error('[gateway] mint failed:', e.message);
    res.status(500).json({ error: 'mint failed: ' + e.message });
  } finally {
    mintInFlight.delete(w);
  }
});

// Public: mint message (so client can sign it deterministically)
app.get('/api/mint-message/:wallet', (req, res) => {
  const w = req.params.wallet;
  if (!ethers.isAddress(w)) return res.status(400).json({ error: 'invalid wallet' });
  const message = `beepm · mint agent NFT\n\nWallet: ${w.toLowerCase()}\nContract: ${INFT_CONTRACT}\nChain: 16602`;
  res.json({ message, wallet: w.toLowerCase() });
});

// Public: verify wallet (used by website sign-in)
app.get('/api/owns/:wallet', async (req, res) => {
  const w = req.params.wallet;
  if (!ethers.isAddress(w)) return res.status(400).json({ error: 'invalid wallet' });
  try {
    const balance = await inft.balanceOf(w);
    res.json({ wallet: w.toLowerCase(), balance: balance.toString(), owns: balance > 0n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Profile registration — creates subdomain on Base Sepolia
function generateSubdomain() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let sub = '';
  for (let i = 0; i < 6; i++) sub += chars[Math.floor(Math.random() * chars.length)];
  return sub;
}

app.post('/api/profile/register', requireAuth, async (req, res) => {
  const { encryptedProfile } = req.body;
  if (!encryptedProfile) return res.status(400).json({ error: 'missing encryptedProfile' });
  
  try {
    // Check if already registered
    const existing = await registryRead.getSubdomainByWallet(req.user.wallet);
    if (existing && existing.length > 0) {
      return res.json({ 
        ok: true, 
        subdomain: existing, 
        fullDomain: `${existing}.beepm.agoston.base.eth`,
        alreadyRegistered: true 
      });
    }

    // Generate unique subdomain
    let subdomain;
    let attempts = 0;
    while (attempts < 10) {
      subdomain = generateSubdomain();
      try {
        const [addr] = await registryRead.getProfile(subdomain);
        if (addr === ethers.ZeroAddress) break; // available
      } catch { break; } // doesn't exist = available
      attempts++;
    }
    if (attempts >= 10) return res.status(500).json({ error: 'subdomain generation failed' });

    // Register on-chain (gasless for user)
    console.log(`[gateway] registering ${subdomain} for ${req.user.wallet.slice(0,10)}...`);
    const tx = await registryWrite.register(subdomain, encryptedProfile);
    await tx.wait();
    
    console.log(`[gateway] profile registered · ${subdomain} · tx: ${tx.hash}`);
    res.json({ 
      ok: true, 
      subdomain, 
      fullDomain: `${subdomain}.beepm.agoston.base.eth`,
      tx: tx.hash,
      explorer: `https://sepolia.basescan.org/tx/${tx.hash}`
    });
  } catch (e) {
    console.error('[gateway] profile register error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get profile by subdomain
app.get('/api/profile/:subdomain', async (req, res) => {
  const { subdomain } = req.params;
  try {
    const [wallet, encryptedData, timestamp] = await registryRead.getProfile(subdomain);
    if (wallet === ethers.ZeroAddress) return res.status(404).json({ error: 'not found' });
    res.json({ 
      subdomain, 
      fullDomain: `${subdomain}.beepm.agoston.base.eth`,
      wallet, 
      encryptedData, 
      timestamp: timestamp.toString() 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`beepm-gateway listening on :${PORT}`);
  console.log(`INFT: ${INFT_CONTRACT} (chain 16602)`);
  console.log(`0G: ${OG_MODEL}`);
});
