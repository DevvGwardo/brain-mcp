# Brain-MCP Architecture — Module Decomposition Plan

## Overview

`src/index.ts` is a 2,917-line monolithic MCP server file with 45+ tool registrations. This document describes the planned decomposition into logical modules.

---

## Complete Tool Catalog (45 tools)

### Identity & Discovery (3)
| Tool | Description |
|------|-------------|
| `register` | Register or rename this session |
| `sessions` | List all active sessions |
| `status` | Show session info and room stats |

### Heartbeat & Health (2)
| Tool | Description |
|------|-------------|
| `pulse` | Report progress and stay alive; returns pending DMs |
| `agents` | Check health of all agents in the room |

### Channel Messaging (2)
| Tool | Description |
|------|-------------|
| `post` | Post a message to a channel |
| `read` | Read messages from a channel (with since_id polling) |

### Direct Messages (2)
| Tool | Description |
|------|-------------|
| `dm` | Send a direct message to another session |
| `inbox` | Read DMs sent to or from this session |

### State / KV Store (4)
| Tool | Description |
|------|-------------|
| `set` | Set a key-value pair |
| `get` | Get a value by key |
| `keys` | List all keys in a scope |
| `delete` | Delete a key |

### Atomic Counters (2)
| Tool | Description |
|------|-------------|
| `incr` | Atomically increment a counter |
| `counter` | Get current counter value without incrementing |

### Barriers (2)
| Tool | Description |
|------|-------------|
| `wait_until` | Barrier primitive — wait for N agents to check in |
| `barrier_reset` | Reset a barrier for fresh use |

### Resource Coordination / Claims (3)
| Tool | Description |
|------|-------------|
| `claim` | Claim exclusive access to a resource (with optional TTL) |
| `release` | Release a previously claimed resource |
| `claims` | List all active resource claims |

### Interface Contracts (3)
| Tool | Description |
|------|-------------|
| `contract_set` | Publish interface contracts (provides/expects) |
| `contract_get` | Read published contracts |
| `contract_check` | Validate all contracts in the room |

### Integration Gate (1)
| Tool | Description |
|------|-------------|
| `gate` | Run tsc --noEmit + contract validation; optionally DM agents |

### Admin (4)
| Tool | Description |
|------|-------------|
| `clear` | Clear all brain data (with confirm) |
| `incr` | *(moved to counters above)* |
| `counter` | *(moved to counters above)* |
| `compact` | Toggle compact response mode (reduces tokens 30-80%) |

### Context Ledger (5)
| Tool | Description |
|------|-------------|
| `context_push` | Record action/discovery/decision/error/checkpoint |
| `context_get` | Read context ledger entries |
| `context_summary` | Get condensed overview of all context |
| `checkpoint` | Save a snapshot of working state |
| `checkpoint_restore` | Restore last saved checkpoint |

### Swarm Orchestration (1)
| Tool | Description |
|------|-------------|
| `swarm` | Spawn multiple agents at once (high-level orchestration) |

### Persistent Memory (3)
| Tool | Description |
|------|-------------|
| `remember` | Store knowledge that survives brain_clear |
| `recall` | Search persistent memory |
| `forget` | Remove a memory by key |

### Task DAG (4)
| Tool | Description |
|------|-------------|
| `plan` | Create a dependency-aware task plan |
| `plan_next` | Get tasks whose dependencies are all satisfied |
| `plan_update` | Update task status (done/failed/running) |
| `plan_status` | View full plan status or list all plans |

### Workflow Compiler (3)
| Tool | Description |
|------|-------------|
| `workflow_compile` | Compile goal → workflow (preview) |
| `workflow_apply` | Compile and persist workflow to brain state |
| `workflow_run` | Compile, persist, and launch Node conductor |

### Auto-Recovery (1)
| Tool | Description |
|------|-------------|
| `respawn` | Respawn failed/stale agent with recovery context |

### Auto-Gate (1)
| Tool | Description |
|------|-------------|
| `auto_gate` | Run gate in loop until all errors fixed (with agent DMs) |

### Metrics (2)
| Tool | Description |
|------|-------------|
| `metrics` | View agent performance history |
| `metric_record` | Record a performance metric for an agent |

### Session Orchestration (1)
| Tool | Description |
|------|-------------|
| `wake` | Spawn a new agent session (tmux or headless) |

### Smart Task Router (1)
| Tool | Description |
|------|-------------|
| `route` | Get model recommendation based on historical data |

### Git Workflow (3)
| Tool | Description |
|------|-------------|
| `commit` | Auto-generate conventional commit message and commit |
| `pr` | Create GitHub pull request |
| `clean_branches` | Prune gone branches and stale worktrees |

### Security (1)
| Tool | Description |
|------|-------------|
| `security_scan` | Scan for credentials, injection, XSS, GHA injection vectors |

### Feature Dev (1)
| Tool | Description |
|------|-------------|
| `feature_dev` | Structured multi-phase workflow (foundation → impl → integration → testing → quality) |

---

## Planned Module Structure

```
src/
├── index.ts                    # Main entry — imports and registers all modules
├── tools/
│   ├── identity.ts             # ✅ register, sessions, status
│   ├── messaging.ts            # ✅ post, read, dm, inbox
│   ├── state.ts                # ✅ set, get, keys, delete
│   ├── claims.ts               # ✅ claim, release, claims
│   ├── swarm.ts                # ✅ swarm, wake, respawn
│   ├── admin.ts                # ✅ clear, incr, counter, compact
│   ├── heartbeat.ts            # pulse, agents
│   ├── barriers.ts             # wait_until, barrier_reset
│   ├── contracts.ts            # contract_set, contract_get, contract_check
│   ├── gate.ts                 # gate, auto_gate
│   ├── context.ts              # context_push, context_get, context_summary, checkpoint, checkpoint_restore
│   ├── memory.ts               # remember, recall, forget
│   ├── plan.ts                 # plan, plan_next, plan_update, plan_status
│   ├── workflow.ts             # workflow_compile, workflow_apply, workflow_run
│   ├── metrics.ts              # metrics, metric_record
│   ├── router.ts               # route
│   ├── git.ts                  # commit, pr, clean_branches
│   ├── security.ts             # security_scan
│   └── feature.ts              # feature_dev
├── db.ts                       # BrainDB (better-sqlite3 wrapper)
├── gate.ts                     # runGate, runGateAndNotify
├── embeddings.ts               # Embedding provider setup
├── router.ts                   # TaskRouter
├── autopilot.ts                # registerAutopilot, minimalAgentPrompt
├── workflow.ts                 # compileWorkflow
├── conductor.js                # Node-based workflow conductor (runtime)
└── http.js                     # Optional HTTP server
```

---

## Module Interface Convention

Each module exports a `register${Name}Tools(server, options)` function that receives:

```typescript
interface BaseToolsOptions {
  db: BrainDB;
  room: string;
  roomLabel: string;
  sessionId: string | null;       // mutable ref
  sessionName: string;            // mutable ref
  ensureSession: () => string;
  getSessionId: () => string | null;
  setSessionId: (id: string) => void;
  getSessionName: () => string;
  setSessionName: (name: string) => void;
  startLeadWatchdog: (leadSessionId: string) => void;
  prepareAgentWorkspace: (baseCwd: string, agentName: string, isolation: IsolationMode) => string;
  spawnedAgentCount: number;
  incrementSpawnedAgentCount: () => number;
  AGENT_COLORS: string[];
  compactMode: boolean;
  setCompactMode: (v: boolean) => void;
}
```

---

## Status

### ✅ Extracted (this session)
- `tools/identity.ts` — register, sessions, status
- `tools/messaging.ts` — post, read, dm, inbox
- `tools/state.ts` — set, get, keys, delete
- `tools/claims.ts` — claim, release, claims
- `tools/swarm.ts` — swarm, wake, respawn
- `tools/admin.ts` — clear, incr, counter, compact

### 📋 Remaining (to extract)
- `tools/heartbeat.ts` — pulse, agents
- `tools/barriers.ts` — wait_until, barrier_reset
- `tools/contracts.ts` — contract_set, contract_get, contract_check
- `tools/gate.ts` — gate, auto_gate
- `tools/context.ts` — context_push, context_get, context_summary, checkpoint, checkpoint_restore
- `tools/memory.ts` — remember, recall, forget
- `tools/plan.ts` — plan, plan_next, plan_update, plan_status
- `tools/workflow.ts` — workflow_compile, workflow_apply, workflow_run
- `tools/metrics.ts` — metrics, metric_record
- `tools/router.ts` — route
- `tools/git.ts` — commit, pr, clean_branches
- `tools/security.ts` — security_scan
- `tools/feature.ts` — feature_dev

---

## Key Observations

1. **Tool count**: 45 tool registrations + 1 internal autopilot meta-tool = 46 total
2. **Largest tools by line count**: `wake` (~330 lines), `security_scan` (~130 lines), `workflow_run` (~100 lines), `feature_dev` (~150 lines)
3. **Cross-cutting concerns**: The `ensureSession()`, `reply()`, `ack()`, `sh()` helpers are used by many modules and should be centralized in a `tools/utils.ts` or passed as options
4. **Workspace preparation**: `prepareAgentWorkspace()` and `startLeadWatchdog()` are shared by swarm, wake, and respawn
5. **Dynamic imports**: Some tools import `TaskRouter` dynamically (to avoid circular deps) — this pattern should be preserved
6. **tmux logic**: The `wake` tool has extensive tmux handling that could potentially be extracted to a `tools/tmux.ts` helper module
7. **Security patterns**: The `SECURITY_PATTERNS` array is a large constant (~30 regex patterns) that could live in `tools/security.ts` as a named export
