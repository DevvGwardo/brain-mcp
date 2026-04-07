---
name: brain-mcp-hermes-hardening
description: Audit and harden the brain-mcp repository with Hermes Agent. Use when Codex needs to inspect this repo for reliability, orchestration, or maintainability weak spots; run a read-only Hermes audit; implement one or two bounded fixes locally; validate the result; and then commit and push only the intended changes.
---

# Brain MCP Hermes Hardening

Use Hermes as an external reviewer for `brain-mcp`, then implement the chosen fix locally in the repo. Keep the Hermes pass read-only, keep the local write set small, and treat commit/push as the last step after validation.

## Workflow

### 1. Gather Repo State

- Run `git status --short --branch` before planning any edits.
- Read `README.md`, `ANALYSIS.md`, and `ARCHITECTURE.md` when they exist.
- Read `references/brain-mcp-hotspots.md` for the highest-value starting points in this repo.
- Detect whether the tree is already dirty. If it is, isolate your work and do not revert or stage unrelated changes.

### 2. Run a Hermes Audit First

- Use Hermes for the first-pass audit, not for broad autonomous editing.
- Ask for the single highest-leverage weakness, exact files/functions, the failure mode, and the smallest credible fix worth shipping first.
- Keep the prompt short enough that Hermes can inspect the repo on disk instead of receiving a massive inline context dump.

Example prompt:

```bash
hermes chat -q "Audit the current brain-mcp repo. Stay read-only. Find the single highest-leverage reliability or maintainability weakness, cite exact files or functions, explain the user-visible failure mode, and recommend the smallest fix worth shipping first." -Q
```

- If Hermes returns multiple issues, prioritize the one backed by existing code, logs, or documentation over speculative cleanup.

### 3. Choose a Bounded Fix

- Prefer concrete failures over structural polish.
- Prefer one or two files over a broad rewrite.
- Prefer reliability fixes in spawn, watchdog, gate, or session-state handling.
- Avoid large decomposition work such as splitting `src/index.ts` unless the user explicitly asks for refactoring instead of hardening.
- Avoid files that already have unrelated local edits unless the fix truly belongs there.

### 4. Implement Locally

- Make code changes with local editing tools after the Hermes review.
- Keep Hermes as reviewer/orienter, not primary patch generator.
- Preserve existing project conventions and avoid “cleanup” changes that are not required for the fix.
- Update docs only when behavior, commands, or operator expectations actually change.

### 5. Validate Before Git Operations

- Run `npm run build` after TypeScript changes.
- Run `python3 -m compileall hermes` after Python changes under `hermes/`.
- Run the narrowest existing smoke test or harness that matches the fix when behavior changed.
- Check `git diff --stat` and `git diff --cached --stat` before committing.
- Do not treat “build passes” as enough if the fix targets runtime spawn or watchdog behavior and a focused smoke check is available.

### 6. Commit and Push Safely

- Stage explicit paths only. Prefer `git add path/to/file` over `git add .`.
- Leave unrelated modified or untracked files unstaged.
- Use a focused commit message that matches the change scope.
- Push only after validation is complete and the staged diff is intentional.

## Repo-Specific Guardrails

- Start with the hotspots in `references/brain-mcp-hotspots.md` instead of scanning the whole repo blindly.
- Treat documented failures in `ANALYSIS.md` as a strong prior; confirm them against code before editing.
- Treat `src/tools/swarm.ts`, `src/watchdog.ts`, `src/gate.ts`, `src/db.ts`, `src/index.ts`, and `hermes/orchestrator.py` as the most likely hardening targets.
- Expect the working tree to be dirty. This repo often contains concurrent local work, so isolate your changes carefully.
