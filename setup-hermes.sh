#!/bin/bash
# Brain MCP — Full Hermes Integration Setup
#
# 1. Builds brain-mcp (Node.js MCP server)
# 2. Installs hermes-brain (Python orchestration package)
# 3. Registers brain-mcp as MCP server in hermes
#
# Usage:
#   ./setup-hermes.sh
set -e

BRAIN_DIR="$(cd "$(dirname "$0")" && pwd)"
BRAIN_INDEX="$BRAIN_DIR/dist/index.js"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     Hermes Brain — Full Setup        ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── Step 1: Build Node.js MCP server ──

echo "Step 1: Building brain-mcp (Node.js MCP server)..."
if [ ! -f "$BRAIN_INDEX" ]; then
  cd "$BRAIN_DIR" && npm install && npm run build
  echo "  ✓ Built"
else
  echo "  ✓ Already built"
fi

# ── Step 2: Install Python package ──

echo ""
echo "Step 2: Installing hermes-brain (Python orchestration)..."
cd "$BRAIN_DIR"
pip install -e . 2>/dev/null && echo "  ✓ Installed hermes-brain" \
  || pip install -e . --user 2>/dev/null && echo "  ✓ Installed hermes-brain (user)" \
  || echo "  ⚠ pip install failed — install manually: pip install -e $BRAIN_DIR"

# Verify CLI works
if command -v hermes-brain &>/dev/null; then
  echo "  ✓ hermes-brain CLI available"
else
  echo "  ⚠ hermes-brain not in PATH — you may need to add ~/.local/bin to PATH"
fi

# ── Step 3: Register MCP server with hermes ──

echo ""
echo "Step 3: Registering brain MCP server with hermes..."

if ! command -v hermes &>/dev/null; then
  echo "  ⚠ hermes not found in PATH — skipping MCP registration"
  echo "    Install hermes: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"
  echo "    Then run: hermes mcp add brain -- node $BRAIN_INDEX"
else
  # Register with BRAIN_DEFAULT_CLI=hermes so brain_wake auto-spawns hermes agents
  hermes mcp remove brain 2>/dev/null
  hermes mcp add brain --env BRAIN_DEFAULT_CLI=hermes -- node "$BRAIN_INDEX" 2>/dev/null \
    && echo "  ✓ Registered brain MCP server (with BRAIN_DEFAULT_CLI=hermes)" \
    || {
      # Fallback: register without --env flag (older hermes versions)
      hermes mcp add brain -- node "$BRAIN_INDEX" 2>/dev/null \
        && echo "  ✓ Registered brain MCP server" \
        || echo "  ✓ brain MCP already registered"
      echo "  ⚠ Could not set BRAIN_DEFAULT_CLI env — see manual config below"
    }

  # Also register with Claude Code if available
  if command -v claude &>/dev/null; then
    claude mcp add brain -s user -- node "$BRAIN_INDEX" 2>/dev/null \
      && echo "  ✓ Also registered with Claude Code" \
      || echo "  ✓ Already registered with Claude Code"
  fi
fi

# ── Done ──

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║            Setup Complete            ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo "  Two ways to orchestrate:"
echo ""
echo "  1. Python CLI (recommended):"
echo "     hermes-brain \"Build a REST API\" --agents api db tests"
echo "     hermes-brain \"Refactor auth\" --agents backend frontend --model claude-haiku-4-5"
echo "     hermes-brain --config pipeline.json"
echo ""
echo "  2. From Claude Code (mixed fleet):"
echo "     brain_wake({ task: '...', cli: 'hermes', layout: 'headless' })"
echo ""
echo "  3. From hermes interactive:"
echo "     hermes -q 'Use brain:brain_register, then brain:brain_wake to spawn 3 agents'"
echo ""
echo "  Brain tools in hermes: brain:brain_register, brain:brain_claim, brain:brain_post, etc."
echo "  Brain tools in Claude: brain_register, brain_claim, brain_post, etc."
echo "  Both share the same SQLite database — agents can cross-coordinate."
echo ""
