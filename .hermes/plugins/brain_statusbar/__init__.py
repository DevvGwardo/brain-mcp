"""Hermes plugin: show brain-mcp status via slash command."""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_PLUGIN_DIR = Path(__file__).resolve().parent
_BRAIN_DB = Path.home() / ".hermes" / "brain" / "brain.db"


class BrainStatusProvider:
    """Provides brain-mcp status by querying the SQLite database directly."""

    def __init__(self):
        self._status_cache: dict[str, Any] = {}
        self._last_update = 0.0
        self._cache_ttl = 5  # seconds
        self._lock = threading.Lock()

    def get_status(self) -> dict[str, Any]:
        """Get current brain-mcp status."""
        with self._lock:
            now = time.time()
            if now - self._last_update < self._cache_ttl:
                return self._status_cache

            if not _BRAIN_DB.exists():
                self._status_cache = {
                    "connected": False,
                    "agents": 0,
                    "sessions": 0,
                    "claims": 0,
                    "last_error": f"No database at {_BRAIN_DB}",
                }
                self._last_update = now
                return self._status_cache

            try:
                conn = sqlite3.connect(str(_BRAIN_DB), timeout=2)
                try:
                    agents = conn.execute("SELECT COUNT(*) FROM sessions WHERE status = 'active'").fetchone()[0]
                    sessions = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
                    claims = conn.execute("SELECT COUNT(*) FROM claims").fetchone()[0]
                    self._status_cache = {
                        "connected": True,
                        "agents": agents,
                        "sessions": sessions,
                        "claims": claims,
                        "last_error": None,
                    }
                finally:
                    conn.close()
            except Exception as e:
                self._status_cache = {
                    "connected": False,
                    "agents": 0,
                    "sessions": 0,
                    "claims": 0,
                    "last_error": str(e)[:100],
                }

            self._last_update = now
            return self._status_cache

# Global status provider
_status_provider = BrainStatusProvider()

def register(ctx) -> None:
    """Register the brain status command."""
    logger.info("Registering brain-statusbar plugin")
    _install_plugin_command_shim()
    _register_brain_status_command(ctx)

def _install_plugin_command_shim() -> None:
    """Install the plugin command shim (same as brain-swarm)."""
    import hermes_cli.plugins as plugins_mod

    manager = plugins_mod.get_plugin_manager()
    if not hasattr(manager, "_plugin_commands"):
        manager._plugin_commands = {}

    if not hasattr(plugins_mod, "get_plugin_command_handler"):
        def get_plugin_command_handler(name: str):
            entry = getattr(plugins_mod.get_plugin_manager(), "_plugin_commands", {}).get(name)
            if callable(entry):
                return entry
            if isinstance(entry, dict):
                return entry.get("handler")
            return None

        plugins_mod.get_plugin_command_handler = get_plugin_command_handler

    plugin_context = getattr(plugins_mod, "PluginContext", None)
    if plugin_context is not None and not hasattr(plugin_context, "register_command"):
        def register_command(self, name: str, handler, description: str = "") -> None:
            if not hasattr(self._manager, "_plugin_commands"):
                self._manager._plugin_commands = {}
            self._manager._plugin_commands[name] = {
                "handler": handler,
                "description": description,
                "plugin": self.manifest.name,
            }

        plugin_context.register_command = register_command

def _register_brain_status_command(ctx) -> None:
    """Register the brain-status slash command."""
    from hermes_cli.commands import COMMAND_REGISTRY, CommandDef

    if not any(cmd.name == "brain-status" for cmd in COMMAND_REGISTRY):
        try:
            from hermes_cli.commands import register_plugin_command
            register_plugin_command(
                CommandDef(
                    "brain-status",
                    "Show brain-mcp status",
                    "Tools & Skills",
                    aliases=("bs",),
                )
            )
        except ImportError:
            pass  # shim handles registration
        
        # Also register the handler
        if hasattr(ctx, "register_command"):
            ctx.register_command("brain-status", _handle_brain_status, "Show brain-mcp status")
            ctx.register_command("bs", _handle_brain_status, "Show brain-mcp status (alias)")

def _handle_brain_status(args: str = "") -> str:
    """Handle the /brain-status command."""
    status = _status_provider.get_status()
    
    if status["connected"]:
        agents = status["agents"]
        sessions = status["sessions"]
        claims = status["claims"]
        return f"""Brain MCP Status
━━━━━━━━━━━━━━━━━━━━━━━
Connected
  Active agents: {agents}
  Sessions:      {sessions}
  Claims:        {claims}"""
    else:
        error = status.get("last_error", "Disconnected")
        return f"""Brain MCP Status
━━━━━━━━━━━━━━━━━━━━━━━
Disconnected
  Error: {error}"""

def get_status() -> dict[str, Any]:
    """Get current brain-mcp status (for external use)."""
    return _status_provider.get_status()
