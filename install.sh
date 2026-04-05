#!/bin/bash
set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  beepm installer"
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

# 1. Install system dependencies
echo "📦 Installing system dependencies..."
if [ "$OS" = "mac" ]; then
  if ! command -v brew &> /dev/null; then
    echo "❌ Homebrew not found. Install from https://brew.sh"
    exit 1
  fi
  brew list tesseract &>/dev/null || brew install tesseract
  brew list cloudflared &>/dev/null || brew install cloudflared
  echo "✅ tesseract + cloudflared installed (Homebrew)"
elif [ "$OS" = "linux" ]; then
  sudo apt-get update -qq
  sudo apt-get install -y tesseract-ocr python3-pip
  if ! command -v cloudflared &> /dev/null; then
    echo "Installing cloudflared..."
    wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
    sudo dpkg -i cloudflared-linux-amd64.deb
    rm cloudflared-linux-amd64.deb
  fi
  echo "✅ tesseract + cloudflared installed (apt)"
fi

# 2. Install Python deps
echo ""
echo "🐍 Installing Python dependencies..."
pip3 install --quiet opencv-python-headless 2>/dev/null || pip3 install opencv-python-headless
echo "✅ opencv-python-headless installed"

# 3. Install Node deps
echo ""
echo "📦 Installing Node.js dependencies..."
cd "$(dirname "$0")/node"
npm install --silent
echo "✅ npm packages installed"

# 4. Run init (non-interactive)
echo ""
echo "⚙️  Configuring beepm-node..."
cat > ~/.beepm-node-config-temp.txt <<EOF
3064
https://beepm-gateway.claws.page


EOF

node bin/beepm-node.js init < ~/.beepm-node-config-temp.txt > /dev/null 2>&1
rm ~/.beepm-node-config-temp.txt

echo "✅ Config created at ~/.beepm-node/config.json"

# 5. Start the node in background
echo ""
echo "🚀 Starting beepm-node..."
node bin/beepm-node.js start &
NODE_PID=$!
sleep 2

if kill -0 $NODE_PID 2>/dev/null; then
  echo "✅ beepm-node running (PID $NODE_PID) on http://localhost:3064"
else
  echo "❌ beepm-node failed to start"
  exit 1
fi

# 6. Start cloudflared tunnel
echo ""
echo "🌐 Starting cloudflared tunnel..."
cloudflared tunnel --url http://localhost:3064 > /tmp/beepm-tunnel.log 2>&1 &
TUNNEL_PID=$!
sleep 3

TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/beepm-tunnel.log | head -1)

if [ -z "$TUNNEL_URL" ]; then
  echo "❌ Failed to get cloudflared URL. Check /tmp/beepm-tunnel.log"
  kill $NODE_PID $TUNNEL_PID 2>/dev/null
  exit 1
fi

echo "✅ Cloudflared tunnel running (PID $TUNNEL_PID)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ beepm-node is live!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📍 Public URL:  $TUNNEL_URL"
echo "🔗 Local URL:   http://localhost:3064"
echo ""
echo "Next steps:"
echo "  1. Open $TUNNEL_URL in your browser"
echo "  2. Scan the QR code with your phone camera"
echo "  3. Telegram mini app will open, pre-paired"
echo ""
echo "To stop:"
echo "  kill $NODE_PID $TUNNEL_PID"
echo ""
echo "Logs:"
echo "  tail -f /tmp/beepm-tunnel.log"
echo ""
