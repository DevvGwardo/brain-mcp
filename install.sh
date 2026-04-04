#!/bin/bash
# Brain MCP — Install Script
set -e

BRAIN_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing Brain MCP..."
echo "  Source: $BRAIN_DIR"

# Build if needed
if [ ! -f "$BRAIN_DIR/dist/index.js" ]; then
  echo "  Building..."
  cd "$BRAIN_DIR" && npm install && npm run build
fi

# Register with Claude Code CLI (the correct way)
claude mcp add brain -s user -- node "$BRAIN_DIR/dist/index.js" 2>/dev/null && echo "  Registered brain MCP server" || echo "  brain MCP already registered (or claude CLI not found)"

echo ""
echo "Done! Restart Claude Code to use the brain tools."
echo ""
echo "  Verify:  claude mcp list | grep brain"
echo "  Try:     \"Improve this codebase with 3 parallel agents\""
