#!/bin/bash
# Brain MCP — Install Script
# Adds the brain MCP server to Claude Code's global settings

set -e

BRAIN_DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS_FILE="$HOME/.claude/settings.json"

echo "Installing Brain MCP..."
echo "  Source: $BRAIN_DIR"

# Build if needed
if [ ! -f "$BRAIN_DIR/dist/index.js" ]; then
  echo "  Building..."
  cd "$BRAIN_DIR" && npm install && npm run build
fi

# Ensure settings directory exists
mkdir -p "$HOME/.claude"

# Create settings.json if it doesn't exist
if [ ! -f "$SETTINGS_FILE" ]; then
  echo '{}' > "$SETTINGS_FILE"
fi

# Add brain MCP server to settings using node
node -e "
const fs = require('fs');
const path = '$SETTINGS_FILE';
const brainPath = '$BRAIN_DIR/dist/index.js';

const settings = JSON.parse(fs.readFileSync(path, 'utf8'));

// Add mcpServers if missing
if (!settings.mcpServers) settings.mcpServers = {};

// Add brain server
settings.mcpServers.brain = {
  command: 'node',
  args: [brainPath]
};

// Add permission if missing
if (!settings.permissions) settings.permissions = {};
if (!settings.permissions.allow) settings.permissions.allow = [];
if (!settings.permissions.allow.includes('mcp__brain')) {
  settings.permissions.allow.push('mcp__brain');
}

fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
console.log('  Added brain MCP to ' + path);
console.log('  Added mcp__brain permission');
"

echo ""
echo "Done! Restart Claude Code to use the brain tools."
echo "  Try: \"Improve this codebase with 3 parallel agents\""
