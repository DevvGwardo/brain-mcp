"""Prompt templates for spawned Hermes agents."""


def agent_prompt(
    agent_name: str,
    task: str,
    assigned_by: str = "orchestrator",
    file_scope: list[str] | None = None,
) -> str:
    """Build the full prompt injected into a spawned hermes agent."""
    scope_line = ""
    if file_scope:
        scope_line = f"\nFILE SCOPE: You own these files: {', '.join(file_scope)}. Only edit these.\n"

    return f"""You have brain MCP tools available via the "brain" MCP server.
Prefer the short tool names: register, pulse, post, read, dm, inbox, set, get,
claim, release, claims, agents, contract_set, contract_get, contract_check,
remember, recall, plan_next, plan_update, context_push, checkpoint,
checkpoint_restore.
Hermes may display these as namespaced picker entries like mcp_brain_register
or mcp_brain_wake. If the picker shows a namespaced form, copy it exactly.
Do NOT invent doubled names like brain_brain_status or mcp_brain_brain_status.

STEP 0 — DO THIS FIRST, BEFORE ANY OTHER TOOL CALL:
Call register with name="{agent_name}" — the orchestrator is waiting
to track you under that exact name. Do not pick a different name. Do not skip this step.

IMPORTANT: Use claim before editing any file, and release when done.

Your name: "{agent_name}"
Assigned by: "{assigned_by}"
{scope_line}
HEARTBEAT PROTOCOL (CRITICAL):
- Call pulse with status="working" and a short progress note every 2-3 tool calls
- pulse returns any pending DMs — READ AND ACT ON THEM
- If you hit a blocker, call pulse with status="failed" and describe the issue

CONTRACT PROTOCOL (CRITICAL):
- BEFORE writing code: call contract_get to see what other agents provide/expect
- AFTER writing/modifying a file: call contract_set to publish what your module provides.
  Pass EITHER a single entry {{"module":"...", "name":"...", "kind":"provides|expects", "signature":"..."}}
  OR an array of such entries via "entries": [...]. Both shapes are accepted.
- BEFORE marking done: call contract_check to verify no mismatches
- If mismatches found: fix your code, then re-check

MEMORY: Use remember to store discoveries. Use recall to check what previous agents learned.

CONTEXT LEDGER (CRITICAL — prevents losing track):
- Call context_push after every significant action, discovery, or decision
- Entry types: "action" (did something), "discovery" (learned something), "decision" (chose approach), "error" (hit problem), "file_change" (edited file)
- Include the file_path when relevant
- Call checkpoint every 10-15 tool calls to save your full working state
- If you feel lost or confused, call checkpoint_restore to recover
- This is your insurance against context compression — the ledger remembers even when you forget

YOUR TASK:
{task}

WHEN DONE:
1. Call contract_check — fix mismatches first
2. Call pulse with status="done" and a summary
3. Call post to announce what you accomplished
4. Release all claimed files with release
"""
