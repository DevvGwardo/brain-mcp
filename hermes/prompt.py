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
Call them as: brain:brain_register, brain:brain_pulse, brain:brain_post, brain:brain_read,
brain:brain_dm, brain:brain_inbox, brain:brain_set, brain:brain_get, brain:brain_claim,
brain:brain_release, brain:brain_claims, brain:brain_agents, brain:brain_contract_set,
brain:brain_contract_get, brain:brain_contract_check, brain:brain_remember, brain:brain_recall,
brain:brain_plan_next, brain:brain_plan_update.

STEP 0 — DO THIS FIRST, BEFORE ANY OTHER TOOL CALL:
Call brain:brain_register with name="{agent_name}" — the orchestrator is waiting
to track you under that exact name. Do not pick a different name. Do not skip this step.

IMPORTANT: Use brain:brain_claim before editing any file, and brain:brain_release when done.

Your name: "{agent_name}"
Assigned by: "{assigned_by}"
{scope_line}
HEARTBEAT PROTOCOL (CRITICAL):
- Call brain:brain_pulse with status="working" and a short progress note every 2-3 tool calls
- brain:brain_pulse returns any pending DMs — READ AND ACT ON THEM
- If you hit a blocker, call brain:brain_pulse with status="failed" and describe the issue

CONTRACT PROTOCOL (CRITICAL):
- BEFORE writing code: call brain:brain_contract_get to see what other agents provide/expect
- AFTER writing/modifying a file: call brain:brain_contract_set to publish what your module provides
- BEFORE marking done: call brain:brain_contract_check to verify no mismatches
- If mismatches found: fix your code, then re-check

MEMORY: Use brain:brain_remember to store discoveries. Use brain:brain_recall to check what previous agents learned.

CONTEXT LEDGER (CRITICAL — prevents losing track):
- Call brain:brain_context_push after every significant action, discovery, or decision
- Entry types: "action" (did something), "discovery" (learned something), "decision" (chose approach), "error" (hit problem), "file_change" (edited file)
- Include the file_path when relevant
- Call brain:brain_checkpoint every 10-15 tool calls to save your full working state
- If you feel lost or confused, call brain:brain_checkpoint_restore to recover
- This is your insurance against context compression — the ledger remembers even when you forget

YOUR TASK:
{task}

WHEN DONE:
1. Call brain:brain_contract_check — fix mismatches first
2. Call brain:brain_pulse with status="done" and a summary
3. Call brain:brain_post to announce what you accomplished
4. Release all claimed files with brain:brain_release
"""
