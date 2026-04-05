#!/bin/bash
set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  beepm quickstart — complete setup from scratch"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
  OS="mac"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  OS="linux"
else
  echo "❌ Unsupported OS: $OSTYPE"
  exit 1
fi

echo "🖥️  Detected OS: $OS"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Install from https://nodejs.org"
  exit 1
fi
echo "✅ Node.js $(node -v)"

# 1. Install system dependencies
echo ""
echo "📦 Installing system dependencies..."
if [ "$OS" = "mac" ]; then
  if ! command -v brew &> /dev/null; then
    echo "❌ Homebrew not found. Install from https://brew.sh"
    exit 1
  fi
  brew list tesseract &>/dev/null || brew install tesseract
  brew list cloudflared &>/dev/null || brew install cloudflared
  echo "✅ tesseract + cloudflared"
elif [ "$OS" = "linux" ]; then
  sudo apt-get update -qq
  sudo apt-get install -y tesseract-ocr python3-pip
  if ! command -v cloudflared &> /dev/null; then
    wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
    sudo dpkg -i cloudflared-linux-amd64.deb
    rm cloudflared-linux-amd64.deb
  fi
  echo "✅ tesseract + cloudflared"
fi

pip3 install --quiet opencv-python-headless 2>/dev/null || pip3 install opencv-python-headless
echo "✅ opencv-python-headless"

# 2. Clone repo
echo ""
INSTALL_DIR="$HOME/beepm"
if [ -d "$INSTALL_DIR" ]; then
  echo "📂 $INSTALL_DIR exists — pulling latest..."
  cd "$INSTALL_DIR"
  git pull origin main
else
  echo "📥 Cloning github.com/agoston0x/beepm..."
  git clone https://github.com/agoston0x/beepm.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
echo "✅ Repo ready at $INSTALL_DIR"

# 3. Install Node deps
echo ""
echo "📦 Installing Node.js dependencies..."
cd "$INSTALL_DIR/node"
npm install --silent
echo "✅ npm packages installed"

# 4. Configure beepm-node
echo ""
echo "⚙️  Configuring beepm-node..."
mkdir -p ~/.beepm-node/data
cat > ~/.beepm-node/config.json <<EOF
{
  "port": 3064,
  "gatewayUrl": "https://beepm-gateway.claws.page",
  "publicUrl": "",
  "dataDir": "$HOME/.beepm-node/data"
}
EOF
echo "✅ Config created at ~/.beepm-node/config.json"

# 5. Start beepm-node
echo ""
echo "🚀 Starting beepm-node..."
node bin/beepm-node.js start > /tmp/beepm-node.log 2>&1 &
NODE_PID=$!
sleep 2

if ! kill -0 $NODE_PID 2>/dev/null; then
  echo "❌ beepm-node failed to start. Check /tmp/beepm-node.log"
  exit 1
fi
echo "✅ beepm-node running (PID $NODE_PID) on http://localhost:3064"

# 6. Start cloudflared tunnel
echo ""
echo "🌐 Starting cloudflared tunnel..."
cloudflared tunnel --url http://localhost:3064 > /tmp/beepm-tunnel.log 2>&1 &
TUNNEL_PID=$!
sleep 4

TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/beepm-tunnel.log | head -1)

if [ -z "$TUNNEL_URL" ]; then
  echo "⚠️  Cloudflared URL not detected yet. Waiting 3 more seconds..."
  sleep 3
  TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/beepm-tunnel.log | head -1)
fi

if [ -z "$TUNNEL_URL" ]; then
  echo "❌ Failed to get tunnel URL. Check /tmp/beepm-tunnel.log"
  echo "Logs:"
  tail -20 /tmp/beepm-tunnel.log
  kill $NODE_PID $TUNNEL_PID 2>/dev/null
  exit 1
fi

echo "✅ Cloudflared tunnel: $TUNNEL_URL"

# 7. Update config with public URL
echo ""
echo "⚙️  Updating config with public URL..."
cat > ~/.beepm-node/config.json <<EOF
{
  "port": 3064,
  "gatewayUrl": "https://beepm-gateway.claws.page",
  "publicUrl": "$TUNNEL_URL",
  "dataDir": "$HOME/.beepm-node/data"
}
EOF

# Restart node to pick up new config
kill $NODE_PID
sleep 1
cd "$INSTALL_DIR/node"
node bin/beepm-node.js start > /tmp/beepm-node.log 2>&1 &
NODE_PID=$!
sleep 2

echo "✅ Config updated, node restarted"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ beepm is LIVE!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📍 Public URL:   $TUNNEL_URL"
echo "🔗 Local URL:    http://localhost:3064"
echo "📂 Install dir:  $INSTALL_DIR"
echo "⚙️  Config:       ~/.beepm-node/config.json"
echo ""
echo "🎯 Next steps:"
echo "  1. Open $TUNNEL_URL in your browser"
echo "  2. Scan the QR code with your phone camera"
echo "  3. Telegram mini app opens → sign in → pair → demo!"
echo ""
echo "🔄 To reset for fresh demo:"
echo "  curl -X POST http://localhost:3064/pair/unpair"
echo "  (In mini app: tap 'sign out' button)"
echo ""
echo "🛑 To stop:"
echo "  kill $NODE_PID $TUNNEL_PID"
echo ""
echo "📋 Logs:"
echo "  tail -f /tmp/beepm-node.log"
echo "  tail -f /tmp/beepm-tunnel.log"
echo ""
