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

# Register with Hermes Agent
echo "  Registering MCP server..."
hermes mcp add brain -s user -- node "$INSTALL_DIR/dist/index.js" 2>/dev/null && \
  echo "  Registered brain MCP server" || \
  echo "  Already registered (or hermes CLI not found)"

echo ""
echo "Done! Restart your Hermes session to use brain tools."
echo ""
echo "  Verify:  hermes mcp list | grep brain"
echo "  Try:     hermes chat \"Improve this codebase with 3 parallel agents\""
