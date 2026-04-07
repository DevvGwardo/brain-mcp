"""
Brain DB — Python SQLite coordination layer.

Same schema as the Node.js brain-mcp db.ts. Both implementations share
the same database file so Hermes and Claude Code agents coexist.
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def _default_db_path() -> str:
    return os.path.join(Path.home(), ".claude", "brain", "brain.db")


@dataclass
class Session:
    id: str
    name: str
    pid: int
    cwd: str
    room: str
    metadata: Optional[str]
    status: str
    progress: Optional[str]
    created_at: str
    last_heartbeat: str
    last_seen_dm_id: int = 0
    exit_code: Optional[int] = None


@dataclass
class AgentHealth:
    id: str
    name: str
    status: str
    progress: Optional[str]
    last_heartbeat: str
    heartbeat_age_seconds: int
    is_stale: bool
    claims: list[str] = field(default_factory=list)


@dataclass
class Message:
    id: int
    channel: str
    room: str
    sender_id: str
    sender_name: str
    content: str
    metadata: Optional[str]
    created_at: str


@dataclass
class ContractMismatch:
    name: str
    expected_by: str
    expected_module: str
    expected_signature: str
    provided_by: Optional[str]
    provided_module: Optional[str]
    provided_signature: Optional[str]
    issue: str
    detail: str


@dataclass
class MemoryEntry:
    id: str
    room: str
    key: str
    content: str
    category: str
    created_by: Optional[str]
    created_by_name: Optional[str]
    created_at: str
    updated_at: str
    access_count: int
    last_accessed: Optional[str]


@dataclass
class TaskNode:
    id: str
    room: str
    plan_id: str
    name: str
    description: str
    agent_name: Optional[str]
    agent_id: Optional[str]
    status: str
    depends_on: str  # JSON array
    result: Optional[str]
    created_at: str
    started_at: Optional[str]
    completed_at: Optional[str]


@dataclass
class PlanSummary:
    plan_id: str
    total: int
    pending: int
    ready: int
    running: int
    done: int
    failed: int
    tasks: list[TaskNode]


class BrainDB:
    """Cross-compatible SQLite coordination layer.

    Uses the exact same schema as the Node.js brain-mcp server.
    Both can read/write the same database file concurrently (WAL mode).
    """

    def __init__(self, db_path: Optional[str] = None):
        path = db_path or os.environ.get("BRAIN_DB_PATH") or _default_db_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.conn = sqlite3.connect(path, timeout=5.0)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.execute("PRAGMA busy_timeout = 5000")
        self._migrate()

    def _migrate(self) -> None:
        c = self.conn
        c.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                pid INTEGER,
                cwd TEXT,
                room TEXT NOT NULL,
                metadata TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                last_heartbeat TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel TEXT NOT NULL,
                room TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS direct_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_id TEXT NOT NULL,
                from_name TEXT NOT NULL,
                to_id TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS state (
                key TEXT NOT NULL,
                scope TEXT NOT NULL DEFAULT 'default',
                value TEXT,
                updated_by TEXT NOT NULL,
                updated_by_name TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (key, scope)
            );
            CREATE TABLE IF NOT EXISTS claims (
                resource TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                owner_name TEXT NOT NULL,
                room TEXT NOT NULL,
                expires_at TEXT,
                claimed_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS contracts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                module TEXT NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('provides', 'expects')),
                signature TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                agent_name TEXT NOT NULL,
                room TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now')),
                UNIQUE(module, name, kind, room)
            );
            CREATE TABLE IF NOT EXISTS memory (
                id TEXT PRIMARY KEY,
                room TEXT NOT NULL,
                key TEXT NOT NULL,
                content TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'general',
                created_by TEXT,
                created_by_name TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                access_count INTEGER NOT NULL DEFAULT 0,
                last_accessed TEXT
            );
            CREATE TABLE IF NOT EXISTS task_graph (
                id TEXT PRIMARY KEY,
                room TEXT NOT NULL,
                plan_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                agent_name TEXT,
                agent_id TEXT,
                status TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','ready','running','done','failed','skipped')),
                depends_on TEXT NOT NULL DEFAULT '[]',
                result TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                started_at TEXT,
                completed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS agent_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room TEXT NOT NULL,
                agent_name TEXT NOT NULL,
                agent_id TEXT,
                task_description TEXT,
                started_at TEXT,
                completed_at TEXT,
                duration_seconds REAL,
                gate_passes INTEGER NOT NULL DEFAULT 0,
                tsc_errors INTEGER NOT NULL DEFAULT 0,
                contract_mismatches INTEGER NOT NULL DEFAULT 0,
                files_changed INTEGER NOT NULL DEFAULT 0,
                outcome TEXT NOT NULL DEFAULT 'unknown',
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, room, id);
            CREATE INDEX IF NOT EXISTS idx_dm_to ON direct_messages(to_id, id);
            CREATE INDEX IF NOT EXISTS idx_dm_from ON direct_messages(from_id, id);
            CREATE INDEX IF NOT EXISTS idx_sessions_room ON sessions(room);
            CREATE INDEX IF NOT EXISTS idx_claims_expires ON claims(expires_at);
            CREATE INDEX IF NOT EXISTS idx_contracts_room ON contracts(room, kind);
            CREATE INDEX IF NOT EXISTS idx_memory_room_key ON memory(room, key);
            CREATE INDEX IF NOT EXISTS idx_memory_room_cat ON memory(room, category);
            CREATE INDEX IF NOT EXISTS idx_task_graph_room ON task_graph(room, plan_id);
            CREATE INDEX IF NOT EXISTS idx_task_graph_status ON task_graph(room, status);
            CREATE INDEX IF NOT EXISTS idx_metrics_room ON agent_metrics(room);
        """)
        # Safe column additions (idempotent)
        for stmt in [
            "ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'",
            "ALTER TABLE sessions ADD COLUMN progress TEXT DEFAULT NULL",
            "ALTER TABLE sessions ADD COLUMN last_seen_dm_id INTEGER NOT NULL DEFAULT 0",
        ]:
            try:
                self.conn.execute(stmt)
            except sqlite3.OperationalError:
                pass  # column already exists
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # ── Sessions ──

    def register_session(
        self, name: str, room: str, metadata: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> str:
        sid = session_id or str(uuid.uuid4())
        self.conn.execute(
            """INSERT INTO sessions (id, name, pid, cwd, room, metadata)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 name=excluded.name, pid=excluded.pid, cwd=excluded.cwd,
                 room=excluded.room, metadata=excluded.metadata""",
            (sid, name, os.getpid(), os.getcwd(), room, metadata),
        )
        self.conn.commit()
        return sid

    def remove_session(self, sid: str) -> None:
        self.conn.execute("DELETE FROM sessions WHERE id = ?", (sid,))
        self.conn.execute("DELETE FROM claims WHERE owner_id = ?", (sid,))
        self.conn.commit()

    def heartbeat(self, sid: str) -> bool:
        r = self.conn.execute(
            "UPDATE sessions SET last_heartbeat = datetime('now') WHERE id = ?", (sid,)
        )
        self.conn.commit()
        return r.rowcount > 0

    def pulse(self, sid: str, status: str, progress: Optional[str] = None) -> bool:
        r = self.conn.execute(
            "UPDATE sessions SET last_heartbeat = datetime('now'), status = ?, progress = ? WHERE id = ?",
            (status, progress, sid),
        )
        self.conn.commit()
        return r.rowcount > 0

    def prune_stale_sessions(self) -> int:
        """Remove sessions with no heartbeat for over 5 minutes and their orphaned claims."""
        r = self.conn.execute(
            "DELETE FROM sessions WHERE last_heartbeat < datetime('now', '-5 minutes')"
        )
        if r.rowcount > 0:
            self.conn.execute(
                "DELETE FROM claims WHERE owner_id NOT IN (SELECT id FROM sessions)"
            )
        self.conn.commit()
        return r.rowcount

    _SESSION_COLS = "id, name, pid, cwd, room, metadata, status, progress, created_at, last_heartbeat, last_seen_dm_id, exit_code"

    def _row_to_session(self, r) -> Session:
        """Convert a row to Session, tolerant of extra columns."""
        d = dict(r)
        # Only pass fields Session knows about
        known = {f.name for f in Session.__dataclass_fields__.values()}
        return Session(**{k: v for k, v in d.items() if k in known})

    def get_sessions(self, room: Optional[str] = None) -> list[Session]:
        self.prune_stale_sessions()
        if room:
            rows = self.conn.execute(
                "SELECT * FROM sessions WHERE room = ? AND last_heartbeat > datetime('now', '-5 minutes') ORDER BY created_at",
                (room,),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM sessions WHERE last_heartbeat > datetime('now', '-5 minutes') ORDER BY created_at"
            ).fetchall()
        return [self._row_to_session(r) for r in rows]

    def get_session(self, sid: str) -> Optional[Session]:
        r = self.conn.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()
        return self._row_to_session(r) if r else None

    def get_agent_health(self, room: Optional[str] = None) -> list[AgentHealth]:
        self.prune_stale_sessions()
        self._prune_claims()
        filt = "WHERE room = ?" if room else ""
        params = (room,) if room else ()
        rows = self.conn.execute(
            f"""SELECT *, CAST((julianday('now') - julianday(last_heartbeat)) * 86400 AS INTEGER)
                AS heartbeat_age_seconds FROM sessions {filt} ORDER BY created_at""",
            params,
        ).fetchall()
        claim_rows = self.conn.execute("SELECT resource, owner_id FROM claims").fetchall()
        claims_by_owner: dict[str, list[str]] = {}
        for cr in claim_rows:
            claims_by_owner.setdefault(cr["owner_id"], []).append(cr["resource"])
        result = []
        for r in rows:
            d = dict(r)
            age = d["heartbeat_age_seconds"]
            result.append(AgentHealth(
                id=d["id"], name=d["name"], status=d["status"],
                progress=d.get("progress"), last_heartbeat=d["last_heartbeat"],
                heartbeat_age_seconds=age, is_stale=age > 60,
                claims=claims_by_owner.get(d["id"], []),
            ))
        return result

    # ── Messaging ──

    def post_message(
        self, channel: str, room: str, sender_id: str,
        sender_name: str, content: str,
    ) -> int:
        c = self.conn.execute(
            "INSERT INTO messages (channel, room, sender_id, sender_name, content) VALUES (?,?,?,?,?)",
            (channel, room, sender_id, sender_name, content),
        )
        self.conn.commit()
        return c.lastrowid or 0

    def get_messages(
        self, channel: str, room: str, since_id: int = 0, limit: int = 50,
    ) -> list[Message]:
        rows = self.conn.execute(
            "SELECT * FROM messages WHERE channel=? AND room=? AND id>? ORDER BY id ASC LIMIT ?",
            (channel, room, since_id, limit),
        ).fetchall()
        return [Message(**dict(r)) for r in rows]

    def send_dm(
        self, from_id: str, from_name: str, to_id: str, content: str,
    ) -> int:
        c = self.conn.execute(
            "INSERT INTO direct_messages (from_id, from_name, to_id, content) VALUES (?,?,?,?)",
            (from_id, from_name, to_id, content),
        )
        self.conn.commit()
        return c.lastrowid or 0

    # ── Shared State ──

    def set_state(
        self, key: str, scope: str, value: str,
        updated_by: str, updated_by_name: str,
    ) -> None:
        self.conn.execute(
            """INSERT INTO state (key, scope, value, updated_by, updated_by_name, updated_at)
               VALUES (?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(key, scope) DO UPDATE SET
                 value=excluded.value, updated_by=excluded.updated_by,
                 updated_by_name=excluded.updated_by_name, updated_at=excluded.updated_at""",
            (key, scope, value, updated_by, updated_by_name),
        )
        self.conn.commit()

    def get_state(self, key: str, scope: str) -> Optional[dict[str, Any]]:
        r = self.conn.execute("SELECT * FROM state WHERE key=? AND scope=?", (key, scope)).fetchone()
        return dict(r) if r else None

    # ── Claims ──

    def _prune_claims(self) -> None:
        self.conn.execute("""
            DELETE FROM claims WHERE
              (expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now'))
              OR owner_id NOT IN (
                SELECT id FROM sessions WHERE last_heartbeat > datetime('now', '-90 seconds')
              )
        """)
        self.conn.commit()

    def claim(
        self, resource: str, owner_id: str, owner_name: str,
        room: str, ttl_seconds: Optional[int] = None,
    ) -> dict[str, Any]:
        self._prune_claims()
        existing = self.conn.execute(
            "SELECT * FROM claims WHERE resource = ?", (resource,)
        ).fetchone()
        if existing and existing["owner_id"] != owner_id:
            return {"claimed": False, "owner": existing["owner_name"]}
        expires = f"datetime('now', '+{ttl_seconds} seconds')" if ttl_seconds else "NULL"
        self.conn.execute(
            f"""INSERT INTO claims (resource, owner_id, owner_name, room, expires_at)
                VALUES (?, ?, ?, ?, {expires})
                ON CONFLICT(resource) DO UPDATE SET
                  owner_id=excluded.owner_id, owner_name=excluded.owner_name,
                  room=excluded.room, expires_at=excluded.expires_at, claimed_at=datetime('now')""",
            (resource, owner_id, owner_name, room),
        )
        self.conn.commit()
        return {"claimed": True}

    def release(self, resource: str, owner_id: str) -> bool:
        r = self.conn.execute(
            "DELETE FROM claims WHERE resource=? AND owner_id=?", (resource, owner_id)
        )
        self.conn.commit()
        return r.rowcount > 0

    def release_all(self, owner_id: str) -> int:
        r = self.conn.execute("DELETE FROM claims WHERE owner_id=?", (owner_id,))
        self.conn.commit()
        return r.rowcount

    def get_claims(self, room: Optional[str] = None) -> list[dict[str, Any]]:
        self._prune_claims()
        if room:
            rows = self.conn.execute("SELECT * FROM claims WHERE room=?", (room,)).fetchall()
        else:
            rows = self.conn.execute("SELECT * FROM claims").fetchall()
        return [dict(r) for r in rows]

    # ── Contracts ──

    def set_contract(
        self, module: str, name: str, kind: str, signature: str,
        agent_id: str, agent_name: str, room: str,
    ) -> None:
        self.conn.execute(
            """INSERT INTO contracts (module, name, kind, signature, agent_id, agent_name, room, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(module, name, kind, room) DO UPDATE SET
                 signature=excluded.signature, agent_id=excluded.agent_id,
                 agent_name=excluded.agent_name, updated_at=excluded.updated_at""",
            (module, name, kind, signature, agent_id, agent_name, room),
        )
        self.conn.commit()

    def get_contracts(
        self, room: str, module: Optional[str] = None, kind: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM contracts WHERE room = ?"
        params: list[Any] = [room]
        if module:
            sql += " AND module = ?"
            params.append(module)
        if kind:
            sql += " AND kind = ?"
            params.append(kind)
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def validate_contracts(self, room: str) -> list[ContractMismatch]:
        expects = self.conn.execute(
            "SELECT * FROM contracts WHERE room=? AND kind='expects'", (room,)
        ).fetchall()
        provides = self.conn.execute(
            "SELECT * FROM contracts WHERE room=? AND kind='provides'", (room,)
        ).fetchall()
        provider_map = {p["name"]: dict(p) for p in provides}
        mismatches: list[ContractMismatch] = []
        for exp in expects:
            e = dict(exp)
            prov = provider_map.get(e["name"])
            if not prov:
                mismatches.append(ContractMismatch(
                    name=e["name"], expected_by=e["agent_name"],
                    expected_module=e["module"], expected_signature=e["signature"],
                    provided_by=None, provided_module=None, provided_signature=None,
                    issue="missing",
                    detail=f'"{e["name"]}" expected by {e["agent_name"]} but no agent provides it',
                ))
                continue
            try:
                es = json.loads(e["signature"])
                ps = json.loads(prov["signature"])
                ep = es.get("params", [])
                pp = ps.get("params", [])
                if len(ep) != len(pp):
                    mismatches.append(ContractMismatch(
                        name=e["name"], expected_by=e["agent_name"],
                        expected_module=e["module"], expected_signature=e["signature"],
                        provided_by=prov["agent_name"], provided_module=prov["module"],
                        provided_signature=prov["signature"], issue="param_count",
                        detail=f'{e["agent_name"]} expects {len(ep)} params, {prov["agent_name"]} provides {len(pp)}',
                    ))
                if es.get("returns") and ps.get("returns") and es["returns"] != ps["returns"]:
                    mismatches.append(ContractMismatch(
                        name=e["name"], expected_by=e["agent_name"],
                        expected_module=e["module"], expected_signature=e["signature"],
                        provided_by=prov["agent_name"], provided_module=prov["module"],
                        provided_signature=prov["signature"], issue="return_type",
                        detail=f'return mismatch: expected "{es["returns"]}", got "{ps["returns"]}"',
                    ))
            except (json.JSONDecodeError, KeyError):
                if e["signature"] != prov["signature"]:
                    mismatches.append(ContractMismatch(
                        name=e["name"], expected_by=e["agent_name"],
                        expected_module=e["module"], expected_signature=e["signature"],
                        provided_by=prov["agent_name"], provided_module=prov["module"],
                        provided_signature=prov["signature"], issue="param_type",
                        detail=f'raw signature mismatch',
                    ))
        return mismatches

    # ── Memory ──

    def store_memory(
        self, room: str, key: str, content: str, category: str,
        created_by: str, created_by_name: str,
    ) -> str:
        existing = self.conn.execute(
            "SELECT id FROM memory WHERE room=? AND key=?", (room, key)
        ).fetchone()
        if existing:
            self.conn.execute(
                "UPDATE memory SET content=?, category=?, updated_at=datetime('now'), created_by=?, created_by_name=? WHERE id=?",
                (content, category, created_by, created_by_name, existing["id"]),
            )
            self.conn.commit()
            return existing["id"]
        mid = str(uuid.uuid4())
        self.conn.execute(
            "INSERT INTO memory (id, room, key, content, category, created_by, created_by_name) VALUES (?,?,?,?,?,?,?)",
            (mid, room, key, content, category, created_by, created_by_name),
        )
        self.conn.commit()
        return mid

    def recall_memory(
        self, room: str, query: Optional[str] = None,
        category: Optional[str] = None, limit: int = 20,
    ) -> list[MemoryEntry]:
        sql = "SELECT * FROM memory WHERE room = ?"
        params: list[Any] = [room]
        if category:
            sql += " AND category = ?"
            params.append(category)
        if query:
            sql += " AND (key LIKE ? OR content LIKE ?)"
            p = f"%{query}%"
            params.extend([p, p])
        sql += " ORDER BY access_count DESC, updated_at DESC LIMIT ?"
        params.append(limit)
        rows = self.conn.execute(sql, params).fetchall()
        if rows:
            ids = [r["id"] for r in rows]
            ph = ",".join("?" * len(ids))
            self.conn.execute(
                f"UPDATE memory SET access_count=access_count+1, last_accessed=datetime('now') WHERE id IN ({ph})",
                ids,
            )
            self.conn.commit()
        return [MemoryEntry(**dict(r)) for r in rows]

    def forget_memory(self, room: str, key: str) -> bool:
        r = self.conn.execute("DELETE FROM memory WHERE room=? AND key=?", (room, key))
        self.conn.commit()
        return r.rowcount > 0

    # ── Task DAG ──

    def create_plan(
        self, room: str,
        tasks: list[dict[str, Any]],
    ) -> tuple[str, list[TaskNode]]:
        plan_id = str(uuid.uuid4())
        name_to_id: dict[str, str] = {}
        for t in tasks:
            name_to_id[t["name"]] = str(uuid.uuid4())

        created: list[TaskNode] = []
        for t in tasks:
            tid = name_to_id[t["name"]]
            dep_ids = [name_to_id[d] for d in t.get("depends_on", [])]
            status = "ready" if not dep_ids else "pending"
            self.conn.execute(
                "INSERT INTO task_graph (id, room, plan_id, name, description, agent_name, status, depends_on) VALUES (?,?,?,?,?,?,?,?)",
                (tid, room, plan_id, t["name"], t.get("description", ""),
                 t.get("agent_name"), status, json.dumps(dep_ids)),
            )
            created.append(TaskNode(
                id=tid, room=room, plan_id=plan_id, name=t["name"],
                description=t.get("description", ""), agent_name=t.get("agent_name"),
                agent_id=None, status=status, depends_on=json.dumps(dep_ids),
                result=None, created_at=datetime.now(timezone.utc).isoformat(),
                started_at=None, completed_at=None,
            ))
        self.conn.commit()
        return plan_id, created

    def get_ready_tasks(self, room: str, plan_id: str) -> list[TaskNode]:
        rows = self.conn.execute(
            "SELECT * FROM task_graph WHERE room=? AND plan_id=? AND status='ready' ORDER BY created_at",
            (room, plan_id),
        ).fetchall()
        return [TaskNode(**dict(r)) for r in rows]

    def update_task_node(
        self, task_id: str, status: str,
        agent_id: Optional[str] = None, agent_name: Optional[str] = None,
        result: Optional[str] = None,
    ) -> None:
        sets = ["status = ?"]
        params: list[Any] = [status]
        if status == "running":
            sets.append("started_at = datetime('now')")
        if status in ("done", "failed"):
            sets.append("completed_at = datetime('now')")
        if agent_id:
            sets.append("agent_id = ?")
            params.append(agent_id)
        if agent_name:
            sets.append("agent_name = ?")
            params.append(agent_name)
        if result is not None:
            sets.append("result = ?")
            params.append(result)
        params.append(task_id)
        self.conn.execute(f"UPDATE task_graph SET {', '.join(sets)} WHERE id = ?", params)

        task = self.conn.execute("SELECT * FROM task_graph WHERE id=?", (task_id,)).fetchone()
        if not task:
            self.conn.commit()
            return

        if status == "done":
            pending = self.conn.execute(
                "SELECT * FROM task_graph WHERE room=? AND plan_id=? AND status='pending'",
                (task["room"], task["plan_id"]),
            ).fetchall()
            for t in pending:
                deps = json.loads(t["depends_on"])
                if task_id not in deps:
                    continue
                all_done = all(
                    (self.conn.execute("SELECT status FROM task_graph WHERE id=?", (d,)).fetchone() or {"status": ""})["status"] == "done"
                    for d in deps
                )
                if all_done:
                    self.conn.execute("UPDATE task_graph SET status='ready' WHERE id=?", (t["id"],))

        if status == "failed":
            self._cascade_skip(task["room"], task["plan_id"], task_id)

        self.conn.commit()

    def _cascade_skip(self, room: str, plan_id: str, failed_id: str) -> None:
        pending = self.conn.execute(
            "SELECT * FROM task_graph WHERE room=? AND plan_id=? AND status IN ('pending','ready')",
            (room, plan_id),
        ).fetchall()
        for t in pending:
            deps = json.loads(t["depends_on"])
            if failed_id in deps:
                self.conn.execute(
                    "UPDATE task_graph SET status='skipped', completed_at=datetime('now') WHERE id=?",
                    (t["id"],),
                )
                self._cascade_skip(room, plan_id, t["id"])

    def get_plan_status(self, room: str, plan_id: str) -> PlanSummary:
        rows = self.conn.execute(
            "SELECT * FROM task_graph WHERE room=? AND plan_id=? ORDER BY created_at",
            (room, plan_id),
        ).fetchall()
        tasks = [TaskNode(**dict(r)) for r in rows]
        return PlanSummary(
            plan_id=plan_id, total=len(tasks),
            pending=sum(1 for t in tasks if t.status == "pending"),
            ready=sum(1 for t in tasks if t.status == "ready"),
            running=sum(1 for t in tasks if t.status == "running"),
            done=sum(1 for t in tasks if t.status == "done"),
            failed=sum(1 for t in tasks if t.status == "failed"),
            tasks=tasks,
        )

    # ── Metrics ──

    def record_metric(self, room: str, agent_name: str, **kwargs: Any) -> int:
        c = self.conn.execute(
            """INSERT INTO agent_metrics
               (room, agent_name, agent_id, task_description, started_at, completed_at,
                duration_seconds, gate_passes, tsc_errors, contract_mismatches, files_changed, outcome)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (room, agent_name, kwargs.get("agent_id"),
             kwargs.get("task_description"), kwargs.get("started_at"),
             kwargs.get("completed_at"), kwargs.get("duration_seconds"),
             kwargs.get("gate_passes", 0), kwargs.get("tsc_errors", 0),
             kwargs.get("contract_mismatches", 0), kwargs.get("files_changed", 0),
             kwargs.get("outcome", "unknown")),
        )
        self.conn.commit()
        return c.lastrowid or 0

    def get_metrics_summary(self, room: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """SELECT agent_name, COUNT(*) as total_tasks,
                      SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) as successes,
                      SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) as failures,
                      AVG(duration_seconds) as avg_duration,
                      AVG(gate_passes) as avg_gate_passes
               FROM agent_metrics WHERE room=? GROUP BY agent_name""",
            (room,),
        ).fetchall()
        return [dict(r) for r in rows]

    # ── Context Ledger ──

    def push_context(
        self, room: str, session_id: str, agent_name: str,
        entry_type: str, summary: str,
        detail: Optional[str] = None, file_path: Optional[str] = None,
        tags: Optional[list[str]] = None,
    ) -> int:
        c = self.conn.execute(
            "INSERT INTO context_ledger (room, session_id, agent_name, entry_type, summary, detail, file_path, tags) VALUES (?,?,?,?,?,?,?,?)",
            (room, session_id, agent_name, entry_type, summary, detail, file_path, json.dumps(tags or [])),
        )
        self.conn.commit()
        return c.lastrowid or 0

    def get_context(
        self, room: str, session_id: Optional[str] = None,
        entry_type: Optional[str] = None, file_path: Optional[str] = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM context_ledger WHERE room = ?"
        params: list[Any] = [room]
        if session_id:
            sql += " AND session_id = ?"
            params.append(session_id)
        if entry_type:
            sql += " AND entry_type = ?"
            params.append(entry_type)
        if file_path:
            sql += " AND file_path = ?"
            params.append(file_path)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def save_checkpoint(
        self, room: str, session_id: str, agent_name: str,
        state: dict[str, Any],
    ) -> str:
        cid = str(uuid.uuid4())
        self.conn.execute(
            "INSERT INTO checkpoints (id, room, session_id, agent_name, state) VALUES (?,?,?,?,?)",
            (cid, room, session_id, agent_name, json.dumps(state)),
        )
        self.conn.commit()
        return cid

    def restore_checkpoint(self, room: str, session_id: Optional[str] = None) -> Optional[dict[str, Any]]:
        if session_id:
            r = self.conn.execute(
                "SELECT * FROM checkpoints WHERE room=? AND session_id=? ORDER BY created_at DESC LIMIT 1",
                (room, session_id),
            ).fetchone()
        else:
            r = self.conn.execute(
                "SELECT * FROM checkpoints WHERE room=? ORDER BY created_at DESC LIMIT 1",
                (room,),
            ).fetchone()
        return dict(r) if r else None

    # ── Clear ──

    def clear(self) -> dict[str, int]:
        counts = {}
        for table in ["messages", "direct_messages", "state", "claims",
                       "contracts", "sessions", "memory", "task_graph", "agent_metrics",
                       "context_ledger", "checkpoints"]:
            r = self.conn.execute(f"DELETE FROM {table}")
            counts[table] = r.rowcount
        self.conn.commit()
        return counts
