#!/bin/bash
# Brain MCP — One-line installer
# Usage: curl -fsSL https://raw.githubusercontent.com/DevvGwardo/brain-mcp/main/install.sh | bash
set -e

INSTALL_DIR="${BRAIN_MCP_DIR:-$HOME/brain-mcp}"
REPO="https://github.com/DevvGwardo/brain-mcp.git"

echo "Installing Brain MCP to $INSTALL_DIR..."

# Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Updating existing installation..."
  cd "$INSTALL_DIR" && git pull
else
  echo "  Cloning repository..."
  git clone "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Install dependencies (postinstall will rebuild native modules)
echo "  Installing dependencies..."
npm install

# Build TypeScript
echo "  Building..."
npm run build

# Install Python orchestration CLI
echo "  Installing hermes-brain..."
if python3 -m pip install -e . >/dev/null 2>&1; then
  echo "  Installed hermes-brain"
elif python3 -m pip install -e . --user >/dev/null 2>&1; then
  echo "  Installed hermes-brain (user)"
else
  echo "  Warning: pip install failed; run manually: python3 -m pip install -e \"$INSTALL_DIR\""
fi

# Register with Hermes Agent
echo "  Registering MCP server..."
if command -v hermes >/dev/null 2>&1; then
  hermes mcp remove brain >/dev/null 2>&1 || true
  hermes mcp add brain --command node --args "$INSTALL_DIR/dist/index.js" >/dev/null 2>&1 && \
    echo "  Registered brain MCP server" || \
    echo "  Warning: Hermes MCP registration failed; run manually: hermes mcp add brain --command node --args \"$INSTALL_DIR/dist/index.js\""
else
  echo "  Warning: hermes CLI not found; run manually after install:"
  echo "    hermes mcp add brain --command node --args \"$INSTALL_DIR/dist/index.js\""
fi

echo ""
echo "Done! Restart your Hermes session to use brain tools."
echo ""
echo "  Verify:  hermes mcp list | grep brain"
echo "           hermes mcp test brain"
echo "           hermes-brain --help"
echo "  Try:     hermes chat \"Improve this codebase with 3 parallel agents\""
