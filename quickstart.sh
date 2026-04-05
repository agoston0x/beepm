#!/bin/bash
set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  beepm quickstart"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Install from https://nodejs.org"
  exit 1
fi
echo "✅ Node.js $(node -v)"

# Check/install cloudflared
if ! command -v cloudflared &> /dev/null; then
  echo ""
  echo "Installing cloudflared..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    if ! command -v brew &> /dev/null; then
      echo "❌ Homebrew not found. Install from https://brew.sh"
      echo "   Or install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
      exit 1
    fi
    brew install cloudflared
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
    sudo dpkg -i cloudflared-linux-amd64.deb
    rm cloudflared-linux-amd64.deb
  fi
fi
echo "✅ cloudflared"

# Clone or update repo
echo ""
INSTALL_DIR="$HOME/beepm"
if [ -d "$INSTALL_DIR" ]; then
  echo "📂 $INSTALL_DIR exists — pulling latest..."
  cd "$INSTALL_DIR"
  git pull origin main -q
else
  echo "📥 Cloning repo..."
  git clone -q https://github.com/agoston0x/beepm.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
echo "✅ Repo ready"

# Install deps
echo ""
echo "📦 Installing dependencies..."
cd "$INSTALL_DIR/node"
npm install --silent
echo "✅ Dependencies installed"

# Configure (wipe any old state for fresh install)
echo ""
echo "⚙️  Configuring..."
rm -rf ~/.beepm-node
mkdir -p ~/.beepm-node/data
cat > ~/.beepm-node/config.json <<EOF
{
  "port": 3064,
  "gatewayUrl": "https://beepm-gateway.claws.page",
  "publicUrl": "",
  "dataDir": "$HOME/.beepm-node/data"
}
EOF
echo "✅ Config created"

# Start node
echo ""
echo "🚀 Starting beepm-node..."
node bin/beepm-node.js start > /tmp/beepm-node.log 2>&1 &
NODE_PID=$!
sleep 2

if ! kill -0 $NODE_PID 2>/dev/null; then
  echo "❌ Node failed to start. Check /tmp/beepm-node.log"
  cat /tmp/beepm-node.log
  exit 1
fi
echo "✅ Node running (PID $NODE_PID)"

# Start tunnel
echo ""
echo "🌐 Starting tunnel..."
cloudflared tunnel --url http://localhost:3064 > /tmp/beepm-tunnel.log 2>&1 &
TUNNEL_PID=$!
sleep 4

TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/beepm-tunnel.log | head -1)

if [ -z "$TUNNEL_URL" ]; then
  sleep 3
  TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/beepm-tunnel.log | head -1)
fi

if [ -z "$TUNNEL_URL" ]; then
  echo "❌ No tunnel URL. Check /tmp/beepm-tunnel.log"
  tail -20 /tmp/beepm-tunnel.log
  kill $NODE_PID $TUNNEL_PID 2>/dev/null
  exit 1
fi

echo "✅ Tunnel: $TUNNEL_URL"

# Update config
cat > ~/.beepm-node/config.json <<EOF
{
  "port": 3064,
  "gatewayUrl": "https://beepm-gateway.claws.page",
  "publicUrl": "$TUNNEL_URL",
  "dataDir": "$HOME/.beepm-node/data"
}
EOF

# Restart node
kill $NODE_PID
sleep 1
cd "$INSTALL_DIR/node"
node bin/beepm-node.js start > /tmp/beepm-node.log 2>&1 &
NODE_PID=$!
sleep 1

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ beepm is LIVE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📍 Open:  $TUNNEL_URL"
echo ""
echo "🎯 Next:"
echo "  1. Open the URL above"
echo "  2. Scan QR with your phone"
echo "  3. Telegram opens → sign in → demo"
echo ""
echo "🔄 Reset:  curl -X POST http://localhost:3064/pair/unpair"
echo "🛑 Stop:   kill $NODE_PID $TUNNEL_PID"
echo ""
