"""
hermes-brain — Multi-agent orchestration for Hermes Agent.

Same SQLite database as brain-mcp (Node.js), so Hermes and Claude Code
agents can coordinate in the same room.

Usage:
    from hermes.db import BrainDB
    from hermes.orchestrator import Orchestrator
"""

from hermes.db import BrainDB

__version__ = "1.0.0"
__all__ = ["BrainDB"]
