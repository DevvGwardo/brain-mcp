<div align="center">

<br>

# Brain MCP

**Multi-agent orchestration for Claude Code**

Give your AI agents a shared brain. Communicate, coordinate, and spawn<br>parallel agents — all through a single MCP server backed by SQLite.

<br>

[![License: MIT](https://img.shields.io/badge/License-MIT-3DA639.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Compatible-7C3AED)](https://modelcontextprotocol.io)
[![GitHub Stars](https://img.shields.io/github/stars/DevvGwardo/brain-mcp?style=flat&logo=github)](https://github.com/DevvGwardo/brain-mcp)

<br>

[Install](#install) · [Quick Start](#quick-start) · [How It Works](#how-it-works) · [Tools](#tools) · [Advanced](#advanced)

<br>

</div>

---

## Install

```bash
git clone https://github.com/DevvGwardo/brain-mcp.git ~/brain-mcp \
  && cd ~/brain-mcp \
  && npm install \
  && npm run build \
  && ./install.sh
```

**Or manually:**

```bash
claude mcp add brain -s user -- node ~/brain-mcp/dist/index.js
```

**Verify:**

```bash
claude mcp list | grep brain
# brain: node .../brain-mcp/dist/index.js - ✓ Connected
```

Restart Claude Code. Done.

---

## Quick Start

Open any project in Claude Code and say:

```
Refactor the API routes with 3 agents
```

That's it. Claude registers as lead, splits the work, spawns 3 agents in tmux panes, and coordinates through the brain.

**More examples:**

```
Add error handling to the whole codebase with 4 agents
```
```
Review this project in parallel with 2 agents
```
```
Use brain_wake to spawn 6 agents that each improve a different module
```

---

## How It Works

```mermaid
graph TB
    subgraph "Your Terminal"
        direction LR
        L["Lead Agent<br/><small>plans + coordinates</small>"]
        W1["Worker 1<br/><small>hooks</small>"]
        W2["Worker 2<br/><small>api</small>"]
        W3["Worker 3<br/><small>components</small>"]
    end

    L -->|"brain_wake"| W1
    L -->|"brain_wake"| W2
    L -->|"brain_wake"| W3

    subgraph "Brain"
        DB[("SQLite")]
        CH["Channels"]
        KV["Shared State"]
        MX["Mutex Locks"]
    end

    L <--> DB
    W1 <--> DB
    W2 <--> DB
    W3 <--> DB

    style L fill:#9333EA,stroke:#7C3AED,color:#fff
    style W1 fill:#3B82F6,stroke:#2563EB,color:#fff
    style W2 fill:#10B981,stroke:#059669,color:#fff
    style W3 fill:#F59E0B,stroke:#D97706,color:#000
    style DB fill:#1E293B,stroke:#334155,color:#fff
    style CH fill:#1E293B,stroke:#334155,color:#fff
    style KV fill:#1E293B,stroke:#334155,color:#fff
    style MX fill:#1E293B,stroke:#334155,color:#fff
```

Each Claude Code session spawns its own `brain-mcp` process via stdio. All processes share the same SQLite database with WAL mode for safe concurrent access. Sessions in the same directory auto-group into a room.

**No server to manage. No config per project. Just install once and use everywhere.**

---

## Tools

16 tools across 6 categories.

### Identity

| Tool | What it does |
|:-----|:-------------|
| `brain_register` | Name this session |
| `brain_sessions` | List active sessions |
| `brain_status` | Show session info + room |

### Messaging

| Tool | What it does |
|:-----|:-------------|
| `brain_post` | Post to a channel |
| `brain_read` | Read from a channel |
| `brain_dm` | Direct message another session |
| `brain_inbox` | Read your DMs |

### Shared State

| Tool | What it does |
|:-----|:-------------|
| `brain_set` | Store a key-value pair |
| `brain_get` | Read a value |
| `brain_keys` | List all keys |
| `brain_delete` | Remove a key |

### Coordination

| Tool | What it does |
|:-----|:-------------|
| `brain_claim` | Lock a resource (mutex) |
| `brain_release` | Unlock a resource |
| `brain_claims` | List all locks |

### Orchestration

| Tool | What it does |
|:-----|:-------------|
| `brain_wake` | Spawn a new Claude Code session in tmux |
| `brain_clear` | Reset all brain data |

---

## Agent Spawning

`brain_wake` opens a real interactive Claude Code session in a tmux split pane:

```mermaid
sequenceDiagram
    participant L as Lead
    participant B as Brain
    participant W as Worker

    L->>B: brain_set("context", ...)
    L->>B: brain_wake("worker", task)
    B-->>W: Opens tmux pane

    W->>B: brain_register("worker")
    W->>B: brain_claim("src/api/")

    Note over W: Does the work

    W->>B: brain_post("done")
    W->>B: brain_release("src/api/")
    W-->>W: Auto-exit

    L->>B: brain_read()
    Note over L: Sees results
```

**Layout options:**

| Layout | View | Best for |
|:-------|:-----|:---------|
| `horizontal` | Side by side (default) | 2 agents |
| `vertical` | Top / bottom | Full width |
| `tiled` | Auto-grid | 3+ agents |
| `window` | New tmux tab | Background |

**The lead pane** gets a purple tint and sits on the left at 45% width. Worker panes stack on the right, each with a unique colored border (blue, emerald, amber, red, violet, pink, cyan, orange, teal, purple).

---

## Brain vs Built-in Teams

| | Claude Code Teams | Brain MCP |
|:--|:--|:--|
| **Visibility** | Hidden | Visible split panes |
| **Communication** | None between agents | Channels, DMs, state |
| **File safety** | Can conflict | Mutex locking |
| **Persistence** | Dies with session | Survives restarts |
| **Spawning** | Parent only | Any agent can spawn more |
| **Independence** | Shared context | Fully standalone |

---

# Advanced

Everything below covers the full technical depth of Brain MCP.

---

## Architecture Deep Dive

```mermaid
graph TB
    subgraph "Claude Code Sessions"
        S1["Session 1<br/><small>PID 1234</small>"]
        S2["Session 2<br/><small>PID 1235</small>"]
        S3["Session 3<br/><small>PID 1236</small>"]
    end

    subgraph "MCP Layer"
        M1["brain-mcp<br/><small>stdio</small>"]
        M2["brain-mcp<br/><small>stdio</small>"]
        M3["brain-mcp<br/><small>stdio</small>"]
    end

    S1 --- M1
    S2 --- M2
    S3 --- M3

    subgraph "Storage"
        DB[("brain.db<br/><small>SQLite WAL</small>")]
    end

    M1 --> DB
    M2 --> DB
    M3 --> DB

    subgraph "Database Tables"
        T1["sessions<br/><small>id, name, room, heartbeat</small>"]
        T2["messages<br/><small>channel, room, sender, content</small>"]
        T3["direct_messages<br/><small>from, to, content</small>"]
        T4["state<br/><small>key, scope, value</small>"]
        T5["claims<br/><small>resource, owner, ttl</small>"]
    end

    DB --- T1
    DB --- T2
    DB --- T3
    DB --- T4
    DB --- T5

    style S1 fill:#9333EA,stroke:#7C3AED,color:#fff
    style S2 fill:#3B82F6,stroke:#2563EB,color:#fff
    style S3 fill:#10B981,stroke:#059669,color:#fff
    style DB fill:#F59E0B,stroke:#D97706,color:#000
    style T1 fill:#1E293B,stroke:#475569,color:#94A3B8
    style T2 fill:#1E293B,stroke:#475569,color:#94A3B8
    style T3 fill:#1E293B,stroke:#475569,color:#94A3B8
    style T4 fill:#1E293B,stroke:#475569,color:#94A3B8
    style T5 fill:#1E293B,stroke:#475569,color:#94A3B8
```

**Key design decisions:**

- **One process per session**: Each Claude Code session spawns its own `brain-mcp` process. No shared long-running server.
- **SQLite WAL mode**: Multiple processes can read simultaneously. Writes are serialized with a 5-second busy timeout.
- **Heartbeat cleanup**: Sessions that haven't pinged in 5 minutes are considered dead and excluded from listings.
- **Room scoping**: The working directory is the default room. Sessions in the same directory see each other's messages and state.

---

## Scoping Model

```mermaid
graph LR
    subgraph "Room: ~/project-a"
        A1["Session A1"]
        A2["Session A2"]
    end

    subgraph "Room: ~/project-b"
        B1["Session B1"]
    end

    subgraph "Brain DB"
        CH_A["#general<br/><small>room: project-a</small>"]
        CH_B["#general<br/><small>room: project-b</small>"]
        DM["Direct Messages<br/><small>cross-room</small>"]
        GS["Global State<br/><small>scope: global</small>"]
    end

    A1 <--> CH_A
    A2 <--> CH_A
    B1 <--> CH_B
    A1 <-.->|DM| B1
    A1 <-.-> GS
    B1 <-.-> GS

    style A1 fill:#3B82F6,stroke:#2563EB,color:#fff
    style A2 fill:#3B82F6,stroke:#2563EB,color:#fff
    style B1 fill:#10B981,stroke:#059669,color:#fff
```

| Scope | How it works |
|:------|:-------------|
| **Room** | Sessions in the same `cwd` share channels and state by default |
| **Channels** | Named streams within a room (e.g. `general`, `tasks`) |
| **DMs** | Cross-room direct messages between any two sessions |
| **Global state** | Use `scope: "global"` in `brain_set`/`brain_get` for cross-room data |

---

## Spawned Agent Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Spawning: brain_wake called

    Spawning --> Initializing: tmux pane created
    Initializing --> WaitingForReady: Claude Code loading

    state "Ready Detection" as Ready {
        WaitingForReady --> CheckPane: poll every 2s
        CheckPane --> PromptDetected: status bar text found
        CheckPane --> WaitingForReady: not ready yet
        CheckPane --> FallbackWait: 60 attempts
        FallbackWait --> PromptDetected: 15s flat sleep
    }

    PromptDetected --> PromptPasted: tmux paste-buffer
    PromptPasted --> Working: Agent executes task

    state "Working" as Working {
        [*] --> ReadingBrain: brain_get context
        ReadingBrain --> ClaimingFiles: brain_claim
        ClaimingFiles --> Editing: make changes
        Editing --> ReleasingFiles: brain_release
        ReleasingFiles --> PostingResults: brain_post
    }

    Working --> Idle: Task complete

    state "Auto-Exit Detection" as AutoExit {
        Idle --> HashCheck: content hash every 5s
        HashCheck --> StableCount: hash unchanged
        StableCount --> HashCheck: count < 3
        StableCount --> SendExit: 3 consecutive (15s stable)
    }

    SendExit --> ExitSent: /exit sent to pane
    ExitSent --> PaneClosed: Claude exits
    PaneClosed --> ForceKill: still alive after 5s
    ExitSent --> [*]: pane closed
    ForceKill --> [*]: tmux kill-pane
```

**Three phases:**

1. **Ready detection** — Polls the tmux pane every 2 seconds looking for Claude Code's status bar. Falls back to a 15-second flat wait.
2. **Prompt injection** — Uses `tmux load-buffer` + `tmux paste-buffer` to send the task prompt to the interactive session.
3. **Auto-exit** — Hashes pane content every 5 seconds. When unchanged for 15 seconds (3 checks), sends `/exit`. Force-kills if still alive after 5 more seconds.

---

## Conflict Prevention

```mermaid
sequenceDiagram
    participant A as Agent A
    participant B as Brain DB
    participant C as Agent C

    Note over A,C: Both want to edit src/api/routes.ts

    A->>B: brain_claim("src/api/routes.ts")
    B-->>A: { claimed: true }

    C->>B: brain_claim("src/api/routes.ts")
    B-->>C: { claimed: false, owner: "Agent A" }

    Note over C: Skips file, works on something else

    A->>B: brain_release("src/api/routes.ts")

    C->>B: brain_claim("src/api/routes.ts")
    B-->>C: { claimed: true }
```

**Two layers of protection:**

1. **Planning layer** — The lead agent assigns non-overlapping files to each worker
2. **Runtime layer** — `brain_claim` is an atomic mutex. The second claimer gets `{ claimed: false, owner: "..." }` and must skip or wait

**TTL safety net**: `brain_claim("file", ttl=300)` auto-releases after 5 minutes, preventing zombie locks from crashed agents.

---

## Tmux Layout Engine

```mermaid
graph TB
    subgraph "main-vertical layout"
        direction LR
        subgraph "Left 45%"
            Lead["LEAD<br/><small>purple tint</small><br/><small>bright border</small>"]
        end
        subgraph "Right 55%"
            W1["Worker 1<br/><small>blue border</small>"]
            W2["Worker 2<br/><small>emerald border</small>"]
            W3["Worker 3<br/><small>amber border</small>"]
            W4["Worker 4<br/><small>red border</small>"]
        end
    end

    style Lead fill:#0d0a1a,stroke:#9333EA,color:#fff,stroke-width:3px
    style W1 fill:#0F172A,stroke:#3B82F6,color:#fff
    style W2 fill:#0F172A,stroke:#10B981,color:#fff
    style W3 fill:#0F172A,stroke:#F59E0B,color:#fff
    style W4 fill:#0F172A,stroke:#EF4444,color:#fff
```

**10 agent colors** (cycling): blue, emerald, amber, red, violet, pink, cyan, orange, teal, purple

**Layout auto-selection:**
- Default: `main-vertical` — lead on left, workers stacked right
- `tiled`: even grid for 3+ agents
- `horizontal` / `vertical`: simple 2-pane splits
- `window`: separate tmux tab

---

## Database Schema

```mermaid
erDiagram
    sessions {
        text id PK
        text name
        int pid
        text cwd
        text room
        text metadata
        text created_at
        text last_heartbeat
    }

    messages {
        int id PK
        text channel
        text room
        text sender_id FK
        text sender_name
        text content
        text metadata
        text created_at
    }

    direct_messages {
        int id PK
        text from_id FK
        text from_name
        text to_id FK
        text content
        text metadata
        text created_at
    }

    state {
        text key PK
        text scope PK
        text value
        text updated_by FK
        text updated_by_name
        text updated_at
    }

    claims {
        text resource PK
        text owner_id FK
        text owner_name
        text room
        text expires_at
        text claimed_at
    }

    sessions ||--o{ messages : sends
    sessions ||--o{ direct_messages : sends
    sessions ||--o{ state : updates
    sessions ||--o{ claims : owns
```

**Database location**: `~/.claude/brain/brain.db`

**Indexes**: channel+room+id on messages, to_id+id on DMs, room on sessions

---

## Configuration Reference

| Variable | Default | Description |
|:---------|:--------|:------------|
| `BRAIN_SESSION_NAME` | `session-{pid}` | Pre-set session name |
| `BRAIN_ROOM` | Working directory | Override room grouping |
| `BRAIN_DB_PATH` | `~/.claude/brain/brain.db` | Custom database path |

---

## CLAUDE.md Integration

Add to your project's `CLAUDE.md` for automatic orchestration:

```markdown
## Brain MCP

When the user asks for parallel agents, multi-agent work, or swarm:
1. brain_register as "lead"
2. Split work across agents with non-overlapping files
3. brain_set shared context
4. brain_wake each agent
5. Monitor with brain_read
6. brain_claim before editing, brain_release after
```

---

## Companion: Brain Swarm

[Brain Swarm](https://github.com/DevvGwardo/brain-swarm) adds predefined team templates on top of Brain MCP:

```
Swarm this codebase with the dev team
```

Spawns a 6-agent pipeline: planner, backend-dev, frontend-dev, tester, reviewer, deployer.

---

## Development

```bash
npm run dev     # Watch mode
npm run build   # Compile
npm start       # Run server
```

---

<div align="center">

<br>

Node.js 18+ &nbsp;&middot;&nbsp; Claude Code &nbsp;&middot;&nbsp; tmux &nbsp;&middot;&nbsp; [MCP Protocol](https://modelcontextprotocol.io)

[MIT License](LICENSE)

<br>

</div>
