#!/usr/bin/env python3
"""
Extract tool groups from index.ts into separate modules.
"""

import re
import sys

# Read the file
with open('/Users/devgwardo/brain-mcp/src/index.ts', 'r') as f:
    lines = f.readlines()

original = lines[:]
total = len(lines)

def find_tool_start(tool_name, start_from=0):
    """Find server.tool('tool_name', line. Returns 0-indexed line number."""
    marker = f"  '{tool_name}',"
    for i in range(start_from, total):
        if marker in lines[i]:
            for j in range(i, max(i-5, start_from-1), -1):
                if 'server.tool(' in lines[j] or "server.tool(" in lines[j]:
                    return j
    return -1

def find_tool_end(start_line):
    """Find the closing ');' after a server.tool() call."""
    for i in range(start_line + 1, total):
        stripped = lines[i].strip()
        if stripped == ');' or stripped.startswith(');'):
            return i
    return -1

def find_comment_back(tool_start, keywords):
    """Find section comment(s) above a tool by going backward."""
    for i in range(tool_start - 1, -1, -1):
        stripped = lines[i].strip()
        if stripped == '':
            continue
        if any(kw in stripped for kw in keywords) and '//' in stripped:
            return i
        # Hit non-comment, non-blank content — stop
        break
    return -1

def skip_blanks_forward(start):
    """Skip blank lines forward, return first non-blank line index."""
    i = start
    while i < total and lines[i].strip() == '':
        i += 1
    return i

# ══════════════════════════════════════════════════════════
#  Find the anchor for register calls BEFORE any removals
# ══════════════════════════════════════════════════════════

anchor_line = -1
for i in range(total):
    if 'registerAdminTools(' in lines[i]:
        # Find end of this call (close paren)
        paren = 0
        for j in range(i, total):
            for ch in lines[j]:
                if ch == '(':
                    paren += 1
                elif ch == ')':
                    paren -= 1
            if paren <= 0 and j > i:
                anchor_line = j
                break
        break

if anchor_line == -1:
    # Fallback
    for i in range(total):
        if 'registerGateTools(' in lines[i]:
            paren = 0
            for j in range(i, total):
                for ch in lines[j]:
                    if ch == '(':
                        paren += 1
                    elif ch == ')':
                        paren -= 1
                if paren <= 0 and j > i:
                    anchor_line = j
                    break
            break

print(f"Anchor line for register calls: {anchor_line}")

# ══════════════════════════════════════════════════════════
#  Find all sections to remove
# ══════════════════════════════════════════════════════════

removals = []

# 1. Metrics group: compact, brain_metrics, brain_metric_record
compact_comment = find_comment_back(find_tool_start('compact'), ['Compact', '═'])
compact_start = compact_comment if compact_comment >= 0 else find_tool_start('compact')
brain_metric_record_end = find_tool_end(find_tool_start('brain_metric_record'))
end = skip_blanks_forward(brain_metric_record_end + 1)
removals.append((compact_start, end))
print(f"Metrics group: lines {compact_start+1}-{end}")

# 2. Workflow group: workflow_compile, workflow_apply, workflow_run
wc_start = find_tool_start('workflow_compile')
wc_comment = find_comment_back(wc_start, ['Workflow', '═', '─'])
wr_end = find_tool_end(find_tool_start('workflow_run'))
end = skip_blanks_forward(wr_end + 1)
wf_start = wc_comment if wc_comment >= 0 else wc_start
removals.append((wf_start, end))
print(f"Workflow group: lines {wf_start+1}-{end}")

# 3. Agent Metrics group: metrics, metric_record
m_start = find_tool_start('metrics')
m_comment = find_comment_back(m_start, ['Metrics', 'Agent', '═'])
mr_end = find_tool_end(find_tool_start('metric_record'))
end = skip_blanks_forward(mr_end + 1)
am_start = m_comment if m_comment >= 0 else m_start
removals.append((am_start, end))
print(f"Agent Metrics group: lines {am_start+1}-{end}")

# 4. Router group: route, wake (wake comes first!)
w_start = find_tool_start('wake')
w_comment = find_comment_back(w_start, ['Spawn', 'wake', '══'])
r_start = find_tool_start('route')
r_end = find_tool_end(r_start)
end = skip_blanks_forward(r_end + 1)
rt_start = w_comment if w_comment >= 0 else w_start
removals.append((rt_start, end))
print(f"Router group: lines {rt_start+1}-{end}")

# 5. Git group: commit, pr, clean_branches
c_start = find_tool_start('commit')
c_comment = find_comment_back(c_start, ['Git', '═', '─'])
cb_end = find_tool_end(find_tool_start('clean_branches'))
end = skip_blanks_forward(cb_end + 1)
g_start = c_comment if c_comment >= 0 else c_start
removals.append((g_start, end))
print(f"Git group: lines {g_start+1}-{end}")

# 6. Security scan (with SECURITY_PATTERNS)
ss_start = find_tool_start('security_scan')
ss_comment = find_comment_back(ss_start, ['Security', '═', '─'])
# Find SECURITY_PATTERNS const
patterns_line = -1
for i in range(ss_start - 1, max(ss_start - 200, -1), -1):
    if 'SECURITY_PATTERNS' in lines[i] and 'const' in lines[i]:
        patterns_line = i
        break
sec_start = ss_comment if ss_comment >= 0 else (patterns_line if patterns_line >= 0 else ss_start)
ss_end = find_tool_end(ss_start)
end = skip_blanks_forward(ss_end + 1)
removals.append((sec_start, end))
print(f"Security group: lines {sec_start+1}-{end} (patterns at {patterns_line+1})")

# 7. Feature dev
fd_start = find_tool_start('feature_dev')
fd_comment = find_comment_back(fd_start, ['Feature', '═', 'multi-phase'])
fd_end = find_tool_end(fd_start)
end = skip_blanks_forward(fd_end + 1)
f_start = fd_comment if fd_comment >= 0 else fd_start
removals.append((f_start, end))
print(f"Feature Dev group: lines {f_start+1}-{end}")

# ══════════════════════════════════════════════════════════
#  Sort by start descending and remove
# ══════════════════════════════════════════════════════════

# Check for overlaps
removals.sort(key=lambda r: r[0])
for i in range(len(removals) - 1):
    if removals[i][1] > removals[i + 1][0]:
        print(f"WARNING: Overlap between {removals[i]} and {removals[i+1]}")
        # Merge
        removals[i + 1] = (removals[i][0], max(removals[i][1], removals[i + 1][1]))
        removals[i] = None

removals = [r for r in removals if r is not None]
removals.sort(key=lambda r: r[0], reverse=True)

print(f"\nApplying {len(removals)} removal blocks...")
for start, end in removals:
    print(f"  Removing lines {start+1}-{end} ({end - start} lines)")
    del lines[start:end]

# Recalculate anchor line after removals (its content shifted)
# Find the registerAdminTools or registerGateTools in the new line list
new_anchor = -1
for i in range(len(lines)):
    if 'registerAdminTools(' in lines[i]:
        paren = 0
        for j in range(i, len(lines)):
            for ch in lines[j]:
                if ch == '(':
                    paren += 1
                elif ch == ')':
                    paren -= 1
            if paren <= 0 and j > i:
                new_anchor = j
                break
        break

if new_anchor == -1:
    for i in range(len(lines)):
        if 'registerGateTools(' in lines[i]:
            paren = 0
            for j in range(i, len(lines)):
                for ch in lines[j]:
                    if ch == '(':
                        paren += 1
                    elif ch == ')':
                        paren -= 1
                if paren <= 0 and j > i:
                    new_anchor = j
                    break
            break

print(f"New anchor line: {new_anchor}")

# ══════════════════════════════════════════════════════════
#  Add imports
# ══════════════════════════════════════════════════════════

last_import = 0
for i in range(len(lines)):
    if lines[i].strip().startswith('import '):
        last_import = i

new_imports = [
    "import { registerWorkflowTools } from './tools/workflow-tools.js';\n",
    "import { registerMetricsTools } from './tools/metrics.js';\n",
    "import { registerGitTools } from './tools/git.js';\n",
    "import { registerSecurityTools } from './tools/security-tools.js';\n",
    "import { registerFeatureDevTools } from './tools/feature-dev.js';\n",
    "import { registerRouterTools } from './tools/router-tools.js';\n",
]

for i, imp in enumerate(new_imports):
    lines.insert(last_import + 1 + i, imp)

# Recalculate anchor after import insertion
new_anchor += len(new_imports)

# ══════════════════════════════════════════════════════════
#  Add register calls
# ══════════════════════════════════════════════════════════

register_calls = [
    "\n// ── Extracted tool modules ──────────────────────────────────────────────────\n\n",
    "registerMetricsTools(server, {\n",
    "  db,\n",
    "  room,\n",
    "  ensureSession,\n",
    "  compactMode,\n",
    "  setCompactMode: (v: boolean) => { compactMode = v; },\n",
    "  reply,\n",
    "});\n",
    "\n",
    "registerWorkflowTools(server, {\n",
    "  db,\n",
    "  room,\n",
    "  ensureSession,\n",
    "  sessionName,\n",
    "  startLeadWatchdog,\n",
    "  prepareAgentWorkspace,\n",
    "  sh,\n",
    "});\n",
    "\n",
    "registerRouterTools(server, {\n",
    "  db,\n",
    "  room,\n",
    "  ensureSession,\n",
    "  sessionName,\n",
    "  startLeadWatchdog,\n",
    "  prepareAgentWorkspace,\n",
    "  minimalAgentPrompt,\n",
    "  spawnWithRecovery,\n",
    "  sh,\n",
    "  spawnedAgentCount,\n",
    "  incrementSpawnedAgentCount: () => { spawnedAgentCount++; return spawnedAgentCount; },\n",
    "  AGENT_COLORS,\n",
    "});\n",
    "\n",
    "registerGitTools(server, {\n",
    "  db,\n",
    "  room,\n",
    "  ensureSession,\n",
    "  sh,\n",
    "});\n",
    "\n",
    "registerSecurityTools(server, {\n",
    "  db,\n",
    "  room,\n",
    "  ensureSession,\n",
    "  sessionName,\n",
    "  sh,\n",
    "});\n",
    "\n",
    "registerFeatureDevTools(server, {\n",
    "  db,\n",
    "  room,\n",
    "  ensureSession,\n",
    "  sessionName,\n",
    "  startLeadWatchdog,\n",
    "});\n",
    "\n",
]

for i, line in enumerate(register_calls):
    lines.insert(new_anchor + 1 + i, line)

# Write result
with open('/Users/devgwardo/brain-mcp/src/index.ts', 'w') as f:
    f.writelines(lines)

new_total = len(lines)
print(f"\nDone! Original: {total} lines -> New: {new_total} lines")
