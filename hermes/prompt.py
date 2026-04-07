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
Hermes exposes them as mcp_brain_<tool>. Prefer these short names:
mcp_brain_register, mcp_brain_pulse, mcp_brain_post, mcp_brain_read,
mcp_brain_dm, mcp_brain_inbox, mcp_brain_set, mcp_brain_get,
mcp_brain_claim, mcp_brain_release, mcp_brain_claims,
mcp_brain_agents, mcp_brain_contract_set, mcp_brain_contract_get,
mcp_brain_contract_check, mcp_brain_remember, mcp_brain_recall,
mcp_brain_plan_next, mcp_brain_plan_update,
mcp_brain_context_push, mcp_brain_checkpoint, mcp_brain_checkpoint_restore.
Do NOT invent names like brain_brain_status or mcp_brain_brain_status.
If the tool picker shows a slightly different exact name, copy the picker exactly.

STEP 0 — DO THIS FIRST, BEFORE ANY OTHER TOOL CALL:
Call mcp_brain_register with name="{agent_name}" — the orchestrator is waiting
to track you under that exact name. Do not pick a different name. Do not skip this step.

IMPORTANT: Use mcp_brain_claim before editing any file, and mcp_brain_release when done.

Your name: "{agent_name}"
Assigned by: "{assigned_by}"
{scope_line}
HEARTBEAT PROTOCOL (CRITICAL):
- Call mcp_brain_pulse with status="working" and a short progress note every 2-3 tool calls
- mcp_brain_pulse returns any pending DMs — READ AND ACT ON THEM
- If you hit a blocker, call mcp_brain_pulse with status="failed" and describe the issue

CONTRACT PROTOCOL (CRITICAL):
- BEFORE writing code: call mcp_brain_contract_get to see what other agents provide/expect
- AFTER writing/modifying a file: call mcp_brain_contract_set to publish what your module provides.
  Pass EITHER a single entry {{"module":"...", "name":"...", "kind":"provides|expects", "signature":"..."}}
  OR an array of such entries via "entries": [...]. Both shapes are accepted.
- BEFORE marking done: call mcp_brain_contract_check to verify no mismatches
- If mismatches found: fix your code, then re-check

MEMORY: Use mcp_brain_remember to store discoveries. Use mcp_brain_recall to check what previous agents learned.

CONTEXT LEDGER (CRITICAL — prevents losing track):
- Call mcp_brain_context_push after every significant action, discovery, or decision
- Entry types: "action" (did something), "discovery" (learned something), "decision" (chose approach), "error" (hit problem), "file_change" (edited file)
- Include the file_path when relevant
- Call mcp_brain_checkpoint every 10-15 tool calls to save your full working state
- If you feel lost or confused, call mcp_brain_checkpoint_restore to recover
- This is your insurance against context compression — the ledger remembers even when you forget

YOUR TASK:
{task}

WHEN DONE:
1. Call mcp_brain_contract_check — fix mismatches first
2. Call mcp_brain_pulse with status="done" and a summary
3. Call mcp_brain_post to announce what you accomplished
4. Release all claimed files with mcp_brain_release
"""
