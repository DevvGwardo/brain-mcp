<div align="center">

# 🧠 Brain MCP

**Inter-session communication layer for Claude Code**

Give your AI agents a shared brain. Message each other, share state,<br>and coordinate work — all through a lightweight MCP server backed by SQLite.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Compatible-7C3AED?logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIyIi8+PC9zdmc+)](https://modelcontextprotocol.io)

<br>

<img width="680" alt="architecture" src="https://img.shields.io/badge/Sessions_×_N_→_Shared_SQLite_Brain-1a1a2e?style=for-the-badge&labelColor=1a1a2e">

</div>

---

<div align="center">

### The Problem

Multiple Claude Code sessions in the same project can't talk to each other.<br>
They duplicate work, create merge conflicts, and have no way to coordinate.

### The Solution

A shared brain that every session can read and write to — <br>
messages, state, and resource locks — through the MCP protocol.

</div>

---

## How It Works

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Claude Code 1 │    │ Claude Code 2 │    │ Claude Code 3 │
│  "architect"  │    │  "frontend"   │    │  "backend"    │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │ stdio             │ stdio             │ stdio
       ▼                   ▼                   ▼
   brain-mcp           brain-mcp           brain-mcp
       │                   │                   │
       └───────────────────┼───────────────────┘
                           ▼
                  ~/.claude/brain/brain.db
                       (SQLite WAL)
```

<div align="center">

Each Claude Code session spawns its own `brain-mcp` process via stdio.<br>
All processes share the same SQLite database. **Zero server management required.**

Sessions in the **same working directory** are automatically grouped into a room.<br>
Sessions in **different directories** can still communicate via DMs or global state.

</div>

---

## Quick Start

### 1. Clone & Build

```bash
git clone https://github.com/devgwardo/brain-mcp.git
cd brain-mcp
npm install
npm run build
```

### 2. Add to Claude Code

Add to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/path/to/brain-mcp/dist/index.js"]
    }
  }
}
```

### 3. Use It

Open two or more Claude Code sessions in the same directory and start coordinating.

---

## Tools

<div align="center">

### Identity & Discovery

</div>

| Tool | Description |
|:-----|:------------|
| `brain_register` | Set a display name for this session |
| `brain_sessions` | List all active sessions |
| `brain_status` | Show this session's info and room |

<div align="center">

### Messaging

</div>

| Tool | Description |
|:-----|:------------|
| `brain_post` | Post a message to a channel (room-scoped) |
| `brain_read` | Read messages from a channel with polling support |
| `brain_dm` | Send a direct message to another session |
| `brain_inbox` | Read direct messages |

<div align="center">

### Shared State

</div>

| Tool | Description |
|:-----|:------------|
| `brain_set` | Set a key-value pair in shared state |
| `brain_get` | Read a value from shared state |
| `brain_keys` | List all keys in a scope |
| `brain_delete` | Remove a key from shared state |

<div align="center">

### Resource Coordination

</div>

| Tool | Description |
|:-----|:------------|
| `brain_claim` | Claim exclusive access to a resource (mutex) |
| `brain_release` | Release a claimed resource |
| `brain_claims` | List all active claims |

---

## Example

<div align="center">

Three Claude Code sessions working on the same project:

</div>

**Session 1 — Architect**
```
brain_register("architect")
brain_set(key="api_contract", value='{"users": "GET /api/users", "posts": "GET /api/posts"}')
brain_post(content="Contract is set. Frontend: take users. Backend: take posts.")
```

**Session 2 — Frontend**
```
brain_register("frontend")
brain_read()                              # sees architect's message
brain_get(key="api_contract")             # reads the contract
brain_claim("src/pages/Users.tsx")        # locks the file
brain_dm(to="backend", content="What shape is the /users response?")
```

**Session 3 — Backend**
```
brain_register("backend")
brain_inbox()                             # sees frontend's question
brain_claim("src/api/posts.ts", ttl=300)  # auto-releases in 5 min
brain_post(content="Users response: { id, name, email }[]")
```

---

## Configuration

<div align="center">

All configuration is through environment variables — set them in your MCP config.

</div>

| Variable | Default | Description |
|:---------|:--------|:------------|
| `BRAIN_SESSION_NAME` | `session-{pid}` | Pre-set session name (skip `brain_register`) |
| `BRAIN_ROOM` | Working directory | Override automatic room grouping |
| `BRAIN_DB_PATH` | `~/.claude/brain/brain.db` | Custom database location |

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/path/to/brain-mcp/dist/index.js"],
      "env": {
        "BRAIN_SESSION_NAME": "worker-1",
        "BRAIN_ROOM": "my-project"
      }
    }
  }
}
```

---

## Architecture

<div align="center">

### Scoping Model

</div>

- **Room** — Sessions in the same working directory share a room automatically
- **Channels** — Named message streams within a room (e.g. `general`, `api-updates`)
- **DMs** — Direct messages work across all rooms
- **Global state** — Use `scope: "global"` to share state across rooms

<div align="center">

### Storage

</div>

- **SQLite** with **WAL mode** — safe concurrent access from multiple processes
- **Busy timeout** of 5 seconds — handles lock contention gracefully
- **Heartbeat-based cleanup** — stale sessions expire after 5 minutes
- **TTL on claims** — prevents zombie resource locks

---

## Use Cases

<div align="center">

| Pattern | Description |
|:--------|:------------|
| **Parallel Development** | Frontend + backend sessions share API contracts |
| **Divide & Conquer** | Break a large task into parts, each session takes one |
| **Supervisor / Worker** | One session coordinates, others execute |
| **Code Review** | One session writes, another reviews in real-time |
| **Knowledge Sharing** | Discoveries about the codebase shared instantly |
| **File Locking** | Prevent two sessions from editing the same file |

</div>

---

## Development

```bash
# Watch mode for development
npm run dev

# Build
npm run build

# Run directly
npm start
```

---

<div align="center">

### Requirements

Node.js 18+ &nbsp;·&nbsp; Claude Code with MCP support

<br>

MIT License

<br>

Built for the [Model Context Protocol](https://modelcontextprotocol.io) ecosystem.

</div>
