#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { createServer } = require('../lib/server.js');

const CFG_DIR = path.join(os.homedir(), '.beepm-node');
const CFG_FILE = path.join(CFG_DIR, 'config.json');

function load() { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { return null; } }
function save(c) { fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2)); }
function ask(rl, q, d) { return new Promise(r => rl.question(`${q}${d ? ` [${d}]` : ''}: `, a => r(a.trim() || d || ''))); }

async function init() {
  console.log('\n  beepm-node · init\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ex = load() || {};
  const cfg = {
    port: parseInt(await ask(rl, 'port', ex.port || 3064)),
    dataDir: await ask(rl, 'data dir', ex.dataDir || path.join(CFG_DIR, 'data')),
    publicUrl: await ask(rl, 'public url (for pairing QR)', ex.publicUrl || 'http://localhost:3064'),
    gatewayUrl: await ask(rl, 'gateway url', ex.gatewayUrl || 'https://beepm-gateway.claws.page'),
  };
  rl.close();
  save(cfg);
  console.log('\n  config saved to', CFG_FILE);
  console.log('  run:  beepm-node start\n');
}

function start() {
  const cfg = load();
  if (!cfg) { console.error('no config. run: beepm-node init'); process.exit(1); }
  const app = createServer(cfg);
  app.listen(cfg.port, () => {
    console.log(`\n  beepm-node v0.1.0`);
    console.log(`  local    http://localhost:${cfg.port}`);
    console.log(`  public   ${cfg.publicUrl}`);
    console.log(`  gateway  ${cfg.gatewayUrl}`);
    console.log(`  data     ${cfg.dataDir}`);
    console.log(`\n  open the public URL in your browser to pair.\n`);
  });
}

const cmd = process.argv[2];
if (cmd === 'init') init();
else if (cmd === 'start') start();
else console.log(`
  beepm-node · private health daemon

  beepm-node init     configure
  beepm-node start    run server
`);
