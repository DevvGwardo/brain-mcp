# Brain MCP Hotspots

Use this file to avoid a full cold-start audit when the task is to harden `brain-mcp`.

## Highest-Value Starting Points

- `ANALYSIS.md`: Current weakness summary with concrete failure modes and priority order.
- `README.md`: Declared behavior, CLI contracts, and operator workflow.
- `ARCHITECTURE.md`: Current system boundaries and component responsibilities.
- `src/tools/swarm.ts`: Headless Hermes/Claude spawn flow, command construction, retry surface, and log capture.
- `src/index.ts`: Legacy tool registration and overlapping spawn logic. Confirm whether behavior has already moved into `src/tools/`.
- `src/watchdog.ts`: Stale-agent detection, alerting, and any recovery path.
- `src/gate.ts`: Validation coverage. Check whether it only proves TypeScript shape instead of runtime behavior.
- `src/db.ts`: Session state transitions, ghost-session cleanup, and heartbeat-driven status.
- `hermes/orchestrator.py`: Python conductor behavior. Compare failure handling with the TypeScript spawn path.

## Known Weak Spots From Existing Analysis

- Silent headless-agent failure during spawn.
- Ghost sessions created before a spawned process proves it is alive.
- Missing exit-code tracking for detached agents.
- Passive watchdog behavior that reports stale agents without recovering them.
- Gate coverage focused on TypeScript shape rather than behavior.
- Overgrown orchestration surface in `src/index.ts`.

Treat these as hypotheses with strong evidence, not as guaranteed truth. Reconfirm them in code before editing.

## Preferred Fix Order

1. Spawn reliability and observability.
2. Session-state correctness and ghost-session cleanup.
3. Watchdog recovery behavior.
4. Validation gaps that allow behavioral regressions through.
5. Maintainability cleanup only when it directly unlocks one of the above.

## Hermes Prompt Patterns

Use one of these short prompts to keep the audit focused:

```bash
hermes chat -q "Audit the current brain-mcp repo. Stay read-only. Find the single highest-leverage reliability weakness, cite exact files or functions, and recommend the smallest fix worth shipping first." -Q
```

```bash
hermes chat -q "Review brain-mcp for the sharpest orchestration failure mode. Stay read-only. Point to the code path, explain how it fails in practice, and rank the smallest repair over larger refactors." -Q
```

## Validation Checklist

- TypeScript touched: run `npm run build`.
- Python touched: run `python3 -m compileall hermes`.
- Spawn/watchdog behavior touched: run the smallest existing harness or smoke path that exercises the changed path.
- Docs only: ensure commands and behavior descriptions still match the code.

## Git Hygiene

- Use explicit path staging.
- Avoid `git add .` in a dirty repo.
- Do not include `.cron-logs/` unless the user explicitly asks for log artifacts.
- Review `git status --short` again before commit and before push.
