<div align="center">

<br>

# Hermes Brain

**Multi-agent orchestration for [Hermes Agent](https://github.com/NousResearch/hermes-agent)**

Spawn parallel Hermes agents. Give them a shared brain. Ship in one command.<br>Backed by SQLite, coordinated by Python, zero tokens spent on coordination.

<br>

[![License: MIT](https://img.shields.io/badge/License-MIT-3DA639.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)](https://python.org)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Hermes](https://img.shields.io/badge/Hermes-Agent-FF6B6B)](https://github.com/NousResearch/hermes-agent)
[![MCP](https://img.shields.io/badge/MCP-Compatible-7C3AED)](https://modelcontextprotocol.io)

<br>

[Install](#install) · [Quick Start](#quick-start) · [How It Works](#how-it-works) · [CLI](#the-hermes-brain-cli) · [Tools](#brain-tools) · [Advanced](#advanced)

<br>

</div>

---

## Install

```bash
git clone https://github.com/DevvGwardo/brain-mcp.git ~/brain-mcp \
  && cd ~/brain-mcp \
  && ./setup-hermes.sh
```

The installer does three things:
1. Builds the Node.js MCP server (`brain-mcp`)
2. Installs the Python orchestration package (`hermes-brain`)
3. Registers the brain as an MCP server in Hermes (and Claude Code if present)

**Prerequisites:** [Hermes Agent](https://github.com/NousResearch/hermes-agent), Python 3.10+, Node.js 18+

**Verify:**

```bash
hermes mcp list | grep brain
# brain: node .../brain-mcp/dist/index.js - ✓ Connected

hermes-brain --help
```

---

## Quick Start

**One command to orchestrate a fleet of Hermes agents:**

```bash
hermes-brain "Build a REST API with auth, users, and posts" \
  --agents api-routes auth-layer db-models tests
```

What happens:
1. Python conductor spawns 4 background Hermes agents (`hermes -q`)
2. Each agent claims its files, publishes contracts, writes code, pulses heartbeats
3. Conductor runs an **integration gate** — compiles the project, routes errors back to responsible agents via DM
4. Agents self-correct. Gate retries until clean.
5. Summary printed: agents, contracts, memories, metrics, done.

**More ways to run it:**

```bash
# Auto-named agents
hermes-brain "Add error handling to the whole codebase"

# Mix models per task
hermes-brain "Build a game" --agents engine ui store --model claude-sonnet-4-5

# Cheap model for boilerplate
hermes-brain "Generate 10 test files" --model claude-haiku-4-5

# JSON pipeline with multiple phases
hermes-brain --config pipeline.json
```

**Or from inside Hermes (interactive):**

```
hermes> Use brain:brain_register, then brain:brain_wake to spawn 3 agents
        that each refactor a different module.
```

---

## How It Works

```mermaid
graph TB
    subgraph "Python Conductor"
        CLI["hermes-brain CLI"]
        ORCH["Orchestrator<br/><small>spawn · wait · gate · retry</small>"]
    end

    subgraph "Hermes Agents"
        direction LR
        H1["Agent 1<br/><small>hermes -q</small>"]
        H2["Agent 2<br/><small>hermes -q</small>"]
        H3["Agent 3<br/><small>hermes -q</small>"]
    end

    CLI --> ORCH
    ORCH -->|spawn| H1
    ORCH -->|spawn| H2
    ORCH -->|spawn| H3

    subgraph "Brain (shared SQLite)"
        DB[("brain.db")]
        PULSE["Heartbeats"]
        MX["Mutex Locks"]
        KV["Shared State"]
        CON["Contracts"]
        MEM["Memory"]
        PLAN["Task DAG"]
    end

    ORCH <--> DB
    H1 <--> DB
    H2 <--> DB
    H3 <--> DB

    subgraph "Integration Gate"
        GATE["tsc · mypy · cargo · go vet"]
        ROUTE["DM errors → agents"]
    end

    ORCH --> GATE
    GATE --> ROUTE
    ROUTE -.->|DM| H1
    ROUTE -.->|DM| H2

    style CLI fill:#9333EA,stroke:#7C3AED,color:#fff
    style ORCH fill:#9333EA,stroke:#7C3AED,color:#fff
    style H1 fill:#3B82F6,stroke:#2563EB,color:#fff
    style H2 fill:#10B981,stroke:#059669,color:#fff
    style H3 fill:#F59E0B,stroke:#D97706,color:#000
    style DB fill:#1E293B,stroke:#334155,color:#fff
    style GATE fill:#EF4444,stroke:#DC2626,color:#fff
```

**Zero-token coordination.** The conductor is pure Python — LLM tokens are only spent on the actual work. Heartbeats, claims, contracts, gates, retries all run locally.

**No server to manage.** Each agent opens its own stdio connection to the brain. SQLite WAL mode handles concurrent access safely.

**Same brain, any CLI.** Hermes, Claude Code, MiniMax — all clients hit the same SQLite DB. A mixed fleet of Hermes + Claude agents can coordinate on the same task.

---

## The `hermes-brain` CLI

```bash
hermes-brain <task> [options]
```

| Flag | Default | What it does |
|:-----|:--------|:-------------|
| `--agents <names...>` | `agent-1 agent-2` | Agent names to spawn in parallel |
| `--model <id>` | `claude-sonnet-4-5` | Model passed to each agent |
| `--no-gate` | off | Skip integration gate |
| `--retries <n>` | `3` | Max gate retry attempts |
| `--timeout <seconds>` | `600` | Per-agent timeout |
| `--config <file.json>` | | Load a multi-phase pipeline |
| `--db-path <path>` | `~/.claude/brain/brain.db` | Custom brain DB |

### Pipeline config file

```json
{
  "task": "Build a todo app",
  "model": "claude-sonnet-4-5",
  "gate": true,
  "max_gate_retries": 3,
  "phases": [
    {
      "name": "foundation",
      "parallel": true,
      "agents": [
        { "name": "types",  "files": ["src/types/"], "task": "Define all TS types" },
        { "name": "db",     "files": ["src/db/"],    "task": "Set up Prisma schema" }
      ]
    },
    {
      "name": "feature",
      "parallel": true,
      "agents": [
        { "name": "api",    "files": ["src/api/"],   "task": "REST endpoints" },
        { "name": "ui",     "files": ["src/ui/"],    "task": "React components" }
      ]
    },
    {
      "name": "quality",
      "parallel": true,
      "agents": [
        { "name": "tests",  "task": "Write unit + integration tests" }
      ]
    }
  ]
}
```

Phases run sequentially. Agents within a phase run in parallel. The integration gate runs between phases.

---

## Brain Tools

**30+ tools across 9 categories.** All available to Hermes, Claude Code, and any MCP-compatible agent.

### Identity & Health

| Tool | What it does |
|:-----|:-------------|
| `brain_register` | Name this session |
| `brain_sessions` | List active sessions |
| `brain_status` | Show session info + room |
| `brain_pulse` | Heartbeat with status + progress (returns pending DMs) |
| `brain_agents` | Live health of all agents (status, heartbeat age, claims) |

### Messaging

| Tool | What it does |
|:-----|:-------------|
| `brain_post` | Post to a channel |
| `brain_read` | Read from a channel |
| `brain_dm` | Direct message another agent |
| `brain_inbox` | Read your DMs |

### Shared State & Memory

| Tool | What it does |
|:-----|:-------------|
| `brain_set` / `brain_get` | Ephemeral key-value store |
| `brain_keys` / `brain_delete` | List / remove keys |
| `brain_remember` | Store persistent knowledge (survives `brain_clear`) |
| `brain_recall` | Search memories from previous sessions |
| `brain_forget` | Remove outdated memories |

### File Locking

| Tool | What it does |
|:-----|:-------------|
| `brain_claim` | Lock a file/resource (TTL-based mutex) |
| `brain_release` | Unlock |
| `brain_claims` | List active locks |

### Contracts (prevents integration bugs)

| Tool | What it does |
|:-----|:-------------|
| `brain_contract_set` | Publish what your module provides / expects |
| `brain_contract_get` | Read other agents' contracts before coding |
| `brain_contract_check` | Validate all contracts — catches param mismatches, missing functions |

### Integration Gate

| Tool | What it does |
|:-----|:-------------|
| `brain_gate` | Run compile + contract check, DM errors to responsible agents |
| `brain_auto_gate` | Run gate in a loop, wait for fixes, retry until clean |

### Task Planning (DAG)

| Tool | What it does |
|:-----|:-------------|
| `brain_plan` | Create a task DAG with dependencies |
| `brain_plan_next` | Get tasks whose dependencies are satisfied |
| `brain_plan_update` | Mark task done/failed (auto-promotes dependents) |
| `brain_plan_status` | Overall progress |

### Orchestration

| Tool | What it does |
|:-----|:-------------|
| `brain_wake` | Spawn a new agent (hermes, claude, or headless) |
| `brain_swarm` | Spawn multiple agents in one call |
| `brain_respawn` | Replace a failed agent with recovery context |
| `brain_metrics` | Success rates, duration, error counts per agent |

### Context Ledger (prevents losing track)

| Tool | What it does |
|:-----|:-------------|
| `brain_context_push` | Log action/discovery/decision/error |
| `brain_context_get` | Read the ledger |
| `brain_context_summary` | Condensed view for context recovery |
| `brain_checkpoint` | Save full working state |
| `brain_checkpoint_restore` | Recover after context compression |

---

## Heartbeat & Contract Protocol

Every spawned agent follows two protocols that the orchestrator enforces:

**Heartbeat** — agents call `brain_pulse` every 2-3 tool calls with their status and a short progress note. The conductor uses this to:
- Show live status in the terminal (`● working — editing src/api/routes.ts`)
- Detect stalled agents (no pulse in 60s → `stale`)
- Deliver pending DMs as pulse return values (no extra round-trip)

**Contracts** — before agents write code, they call `brain_contract_get` to see what other agents export. After writing, they publish their own contract with `brain_contract_set`. Before marking done, `brain_contract_check` validates the whole fleet — catches:
- Function signature mismatches (expected 2 args, got 3)
- Missing exports (agent A imports `getUser` but agent B never exported it)
- Type drift (expected `User`, got `{name, email}`)

This is the key to matching single-agent integration quality with a parallel fleet.

---

## Integration Gate

```mermaid
sequenceDiagram
    participant O as Orchestrator
    participant C as Compiler
    participant DB as Brain DB
    participant A as Agent

    O->>C: Run tsc / mypy / cargo / go vet
    C-->>O: Errors with file:line:message

    O->>DB: Query: who claimed this file?
    DB-->>O: Agent X owned src/api/routes.ts

    O->>A: DM: "Fix these errors in your files"
    Note over A: Agent reads DM on next pulse
    Note over A: Fixes code, pulses done

    O->>C: Re-run compiler
    C-->>O: Clean
    O->>DB: Record metrics
```

The gate auto-detects the project language and runs the appropriate checker:

| Language | Checker |
|:---------|:--------|
| TypeScript | `npx tsc --noEmit` |
| Python | `mypy` |
| Rust | `cargo check` |
| Go | `go vet` |

Errors are parsed, matched to the agent that claimed the failing file, and routed as a DM. Agents pick up their errors on the next pulse and self-correct. The loop retries up to `--retries` times before giving up.

---

## Mixed Fleets

The brain DB is shared across all MCP clients. A single project can have:

```mermaid
graph LR
    subgraph "Fleet"
        direction TB
        HA["Hermes Agent<br/><small>fast local inference</small>"]
        CC["Claude Code<br/><small>deep reasoning</small>"]
        MM["MiniMax<br/><small>cheap boilerplate</small>"]
    end

    subgraph "Brain"
        DB[("brain.db")]
    end

    HA <--> DB
    CC <--> DB
    MM <--> DB

    style HA fill:#F59E0B,stroke:#D97706,color:#000
    style CC fill:#9333EA,stroke:#7C3AED,color:#fff
    style MM fill:#3B82F6,stroke:#2563EB,color:#fff
    style DB fill:#1E293B,stroke:#334155,color:#fff
```

Route by task type. Use Hermes for routine work, Claude for architectural decisions, cheaper models for boilerplate — all coordinating through the same brain, sharing contracts, gates, memory.

From Claude Code:

```
brain_wake({ task: "...", cli: "hermes", layout: "headless" })
brain_wake({ task: "...", cli: "claude", layout: "horizontal" })
```

---

# Advanced

Everything below covers the full technical depth.

---

## Architecture Deep Dive

```mermaid
graph TB
    subgraph "MCP Clients"
        HA["hermes sessions"]
        CC["claude sessions"]
        PY["Python orchestrator"]
    end

    subgraph "MCP Layer"
        M1["brain-mcp<br/><small>stdio server</small>"]
    end

    subgraph "Python API"
        PYDB["hermes.db.BrainDB<br/><small>direct SQLite access</small>"]
    end

    subgraph "Storage"
        DB[("~/.claude/brain/brain.db<br/><small>SQLite WAL</small>")]
    end

    HA --> M1
    CC --> M1
    PY --> PYDB
    M1 --> DB
    PYDB --> DB

    subgraph "Tables"
        T1["sessions · messages · dms"]
        T2["state · claims · contracts"]
        T3["memory · plans · metrics"]
        T4["context_ledger · checkpoints"]
    end

    DB --- T1
    DB --- T2
    DB --- T3
    DB --- T4

    style HA fill:#F59E0B,stroke:#D97706,color:#000
    style CC fill:#9333EA,stroke:#7C3AED,color:#fff
    style PY fill:#3776AB,stroke:#2C5F8D,color:#fff
    style DB fill:#10B981,stroke:#059669,color:#fff
```

**Design decisions:**

- **Dual access paths** — Agents use MCP (stdio) via `brain-mcp`. The Python orchestrator uses `hermes.db.BrainDB` for direct, fast access to the same SQLite file.
- **One process per session** — No long-running daemon. Each agent opens its own stdio.
- **WAL mode + 5s busy timeout** — Multiple writers serialize safely.
- **Heartbeat-based liveness** — Agents dead in 60s = stale, dead in 5m = cleaned up.
- **Room scoping** — Working directory is the default room. Override with `BRAIN_ROOM`.

---

## Spawned Agent Lifecycle (Hermes Headless)

```mermaid
stateDiagram-v2
    [*] --> Spawned: hermes -q &
    Spawned --> Initializing: MCP connected
    Initializing --> Registered: brain_register
    Registered --> ReadingContext: brain_get / brain_recall
    ReadingContext --> CheckingContracts: brain_contract_get

    state "Working Loop" as Loop {
        CheckingContracts --> Claiming: brain_claim files
        Claiming --> Editing: make changes
        Editing --> Pulsing: brain_pulse (every 2-3 calls)
        Pulsing --> ReadingDMs: DMs returned in pulse
        ReadingDMs --> Editing: fix errors if any
        Editing --> Publishing: brain_contract_set
    }

    Publishing --> FinalCheck: brain_contract_check
    FinalCheck --> Publishing: mismatches found
    FinalCheck --> Done: clean
    Done --> Releasing: brain_release all files
    Releasing --> Reporting: brain_pulse status=done
    Reporting --> Exited: process ends
    Exited --> [*]
```

---

## Auto-Recovery

If an agent crashes or goes stale, the orchestrator spawns a replacement with full context:

```mermaid
sequenceDiagram
    participant O as Orchestrator
    participant DB as Brain DB
    participant R as Replacement

    Note over O,DB: Agent X went stale (no pulse 60s+)

    O->>DB: Get X's progress, claims, messages
    DB-->>O: "was editing src/api; claimed 3 files"

    O->>DB: Release X's claims
    O->>DB: Record failure metric

    O->>R: Spawn "X-r4521" with recovery prompt:
    Note over R: "You're replacing X.<br/>Last progress: 'editing routes.ts'.<br/>Pick up where they left off."

    R->>DB: brain_register, brain_claim, continue
```

The replacement inherits the original task, knows what files the failed agent touched, and has context about their last known progress.

---

## Database Schema

```mermaid
erDiagram
    sessions ||--o{ messages : sends
    sessions ||--o{ direct_messages : sends
    sessions ||--o{ claims : owns
    sessions ||--o{ contracts : publishes
    sessions ||--o{ pulses : heartbeats
    sessions ||--o{ context_ledger : logs
    sessions ||--o{ checkpoints : saves
    sessions ||--o{ metrics : records

    sessions { text id PK text name text room text status text progress text last_heartbeat }
    messages { int id PK text channel text room text sender content text created_at }
    direct_messages { int id PK text from_id text to_id text content bool read }
    state { text key PK text scope text value text updated_by }
    claims { text resource PK text owner_id text expires_at }
    contracts { text module PK text agent_id json provides json expects }
    memory { text id PK text room text topic text content text tags }
    plans { text id PK text room json tasks json dependencies }
    metrics { int id PK text agent_name text outcome int duration_ms }
    context_ledger { int id PK text agent_id text entry_type text content text file_path }
    checkpoints { text id PK text agent_id json working_state text summary }
```

**Database location:** `~/.claude/brain/brain.db`

---

## Configuration Reference

| Variable | Default | Description |
|:---------|:--------|:------------|
| `BRAIN_SESSION_NAME` | `session-{pid}` | Pre-set session name |
| `BRAIN_SESSION_ID` | uuid | Pre-set session id (used by orchestrator) |
| `BRAIN_ROOM` | Working directory | Override room grouping |
| `BRAIN_DB_PATH` | `~/.claude/brain/brain.db` | Custom database path |
| `BRAIN_DEFAULT_CLI` | `claude` | Default CLI for `brain_wake` (`hermes`/`claude`) |
| `HERMES_MODEL` | | Model passed to spawned hermes agents |

---

## Using Brain Tools Directly From Hermes

If you don't want the Python CLI, you can orchestrate directly from inside a Hermes session:

```
hermes> brain:brain_register with name "lead"
hermes> brain:brain_set key="task" value="refactor auth" scope="room"
hermes> brain:brain_wake name="worker-1" task="..." cli="hermes" layout="headless"
hermes> brain:brain_wake name="worker-2" task="..." cli="hermes" layout="headless"
hermes> brain:brain_agents        # monitor health
hermes> brain:brain_auto_gate     # run gate loop until clean
```

The tools work identically in interactive mode, headless mode, and across mixed fleets.

---

## Claude Code (Visible tmux Panes)

Brain also supports spawning Claude Code sessions in tmux split panes for visual orchestration:

```mermaid
graph TB
    subgraph "Your terminal"
        direction LR
        L["LEAD<br/><small>purple border</small>"]
        W1["worker 1<br/><small>blue</small>"]
        W2["worker 2<br/><small>emerald</small>"]
        W3["worker 3<br/><small>amber</small>"]
    end
    L -->|brain_wake| W1
    L -->|brain_wake| W2
    L -->|brain_wake| W3

    style L fill:#0d0a1a,stroke:#9333EA,color:#fff,stroke-width:3px
    style W1 fill:#0F172A,stroke:#3B82F6,color:#fff
    style W2 fill:#0F172A,stroke:#10B981,color:#fff
    style W3 fill:#0F172A,stroke:#F59E0B,color:#fff
```

From Claude Code, say *"Refactor the API with 3 agents"* — the lead splits the work, spawns 3 Claude sessions in tmux panes, each with a unique colored border, and coordinates through the brain.

**Layouts:** `headless` (Hermes default), `horizontal`, `vertical`, `tiled`, `window`

---

## Development

```bash
# Node.js MCP server
npm run dev          # watch mode
npm run build        # compile TypeScript
npm start            # run server

# Python orchestrator
pip install -e .     # install hermes-brain
python -m hermes.cli "task" --agents a b c
```

**Repo layout:**
```
brain-mcp/
├── src/                  # TypeScript MCP server (brain-mcp)
│   ├── index.ts          # Tool definitions (30+ tools)
│   ├── db.ts             # SQLite layer
│   ├── conductor.ts      # brain_wake / brain_swarm logic
│   └── gate.ts           # Integration gate
├── hermes/               # Python orchestration (hermes-brain)
│   ├── cli.py            # hermes-brain CLI entry point
│   ├── orchestrator.py   # Conductor — spawn, wait, gate, retry
│   ├── db.py             # Direct SQLite access (shares brain.db)
│   ├── gate.py           # Compiler + contract checks
│   └── prompt.py         # Agent prompt templates
├── setup-hermes.sh       # Full installer
└── pyproject.toml        # Python package config
```

---

<div align="center">

<br>

Python 3.10+ &nbsp;&middot;&nbsp; Node.js 18+ &nbsp;&middot;&nbsp; [Hermes Agent](https://github.com/NousResearch/hermes-agent) &nbsp;&middot;&nbsp; [MCP Protocol](https://modelcontextprotocol.io)

[MIT License](LICENSE)

<br>

</div>
