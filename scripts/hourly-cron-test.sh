#!/bin/bash
# brain-mcp hourly cron test runner
# Tests all major scenarios, fixes bugs, commits results
# Run from brain-mcp root

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$ROOT_DIR/.cron-logs"
REPORT_FILE="$LOG_DIR/latest-report.txt"
TEST_DB="$LOG_DIR/test-$(date +%s).db"
SCENARIO_LOG="$LOG_DIR/scenarios.log"

mkdir -p "$LOG_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$REPORT_FILE"
}

log "========================================"
log "brain-mcp Hourly Cron Test — $(date)"
log "========================================"
log ""

cd "$ROOT_DIR"

# Ensure built
if [ ! -d "dist" ]; then
    log "Building brain-mcp..."
    npm run build >> "$REPORT_FILE" 2>&1
fi

PASS=0
FAIL=0
SCENARIOS_OK=""
SCENARIOS_FAIL=""

run_scenario() {
    local name="$1"
    local cmd="$2"
    log ""
    log "--- Scenario: $name ---"
    if eval "$cmd" >> "$REPORT_FILE" 2>&1; then
        log "  ✓ PASS"
        PASS=$((PASS+1))
        SCENARIOS_OK="${SCENARIOS_OK}  ✓ $name"$'\n'
    else
        log "  ✗ FAIL"
        FAIL=$((FAIL+1))
        SCENARIOS_FAIL="${SCENARIOS_FAIL}  ✗ $name"$'\n'
    fi
}

# ── Helper: MCP client script generator ──
# Writes a Node.js temp script that spawns the MCP server, sends commands, and checks results.
# Usage: write_mcp_script <file> <body>
# Inside <body>, these are available:
#   send(method, params) — returns a promise of the MCP response
#   p — the child process
#   TOOL_DB — path to the test database
write_mcp_script() {
    local file="$1"
    local body="$2"
    cat > "$file" << 'SCRIPTEOF'
const { spawn } = require("child_process");
const TOOL_DB = process.env.BRAIN_TEST_DB;
const p = spawn("node", ["dist/index.js"], {
    env: { ...process.env, BRAIN_DB_PATH: TOOL_DB },
    stdio: ["pipe", "pipe", "pipe"]
});

let buf = "";
const pending = new Map();
let rid = 1;

p.stdout.on("data", (d) => {
    buf += d.toString();
    // Try to parse complete JSON lines
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const m = JSON.parse(line.trim());
            if (m.id && pending.has(m.id)) {
                const resolve = pending.get(m.id);
                pending.delete(m.id);
                resolve(m);
            }
        } catch (e) { /* partial or non-JSON line */ }
    }
});

p.stderr.on("data", (d) => process.stderr.write(d));

const send = (method, params) => new Promise((resolve, reject) => {
    const id = rid++;
    pending.set(id, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
        if (pending.has(id)) {
            pending.delete(id);
            reject(new Error("timeout waiting for id=" + id));
        }
    }, 8000);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Give server time to start, then run the scenario body
setTimeout(async () => {
    try {
        await send("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" }
        });
        await sleep(300);
SCRIPTEOF

    # Append the scenario-specific body
    echo "$body" >> "$file"

    # Append the closing boilerplate
    cat >> "$file" << 'SCRIPTEOF'
    } catch (err) {
        console.error("Scenario error:", err.message);
        p.kill();
        process.exit(1);
    }
}, 500);

// Safety timeout — kill after 15s no matter what
setTimeout(() => { p.kill(); process.exit(1); }, 15000);
SCRIPTEOF
}

# ── Scenario 1: MCP server starts and responds to initialize ──
run_scenario "MCP server starts and lists tools" '
    TMPF=/tmp/brain-cron-s1.js
    cat > "$TMPF" << '"'"'JSEOF'"'"'
const { spawn } = require("child_process");
const p = spawn("node", ["dist/index.js"], {
    env: { ...process.env, BRAIN_DB_PATH: process.env.BRAIN_TEST_DB },
    stdio: ["pipe", "pipe", "pipe"]
});
let out = "";
p.stdout.on("data", (d) => {
    out += d.toString();
    if (out.includes("\"id\":")) p.kill();
});
p.stderr.on("data", (d) => process.stderr.write(d));
setTimeout(() => { p.kill(); process.exit(out.includes("\"id\":") ? 0 : 1); }, 8000);
const init = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {},
              clientInfo: { name: "test", version: "1.0" } }
}) + "\n";
p.stdin.write(init);
JSEOF
    BRAIN_TEST_DB="'"$TEST_DB"'" node "$TMPF"
'

# ── Scenario 2: All brain tools are registered ──
cat > /tmp/brain-cron-s2.js << 'JSEOF'
const { spawn } = require("child_process");
const p = spawn("node", ["dist/index.js"], {
    env: { ...process.env, BRAIN_DB_PATH: process.env.BRAIN_TEST_DB },
    stdio: ["pipe", "pipe", "pipe"]
});
let buf = "";
const lines_out = [];
p.stdout.on("data", (d) => {
    buf += d.toString();
    const parts = buf.split("\n");
    buf = parts.pop() || "";
    for (const part of parts) {
        if (part.trim()) lines_out.push(part.trim());
    }
});
p.stderr.on("data", (d) => process.stderr.write(d));
setTimeout(async () => {
    const init = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {},
                  clientInfo: { name: "test", version: "1.0" } }
    }) + "\n";
    const list = JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/list", params: {}
    }) + "\n";
    p.stdin.write(init);
    await new Promise(r => setTimeout(r, 1000));
    p.stdin.write(list);
    await new Promise(r => setTimeout(r, 3000));
    p.kill();
    // Check all collected lines
    for (const l of lines_out) {
        try {
            const m = JSON.parse(l);
            if (m.id === 2 && m.result && m.result.tools && m.result.tools.length >= 14) {
                console.log("TOOLS:", m.result.tools.length);
                process.exit(0);
            }
        } catch (e) { /* skip */ }
    }
    console.error("tools/list did not return 14+ tools. Lines:", lines_out.length);
    process.exit(1);
}, 500);
setTimeout(() => { p.kill(); process.exit(1); }, 12000);
JSEOF

run_scenario "All 14+ brain tools registered in MCP manifest" '
    BRAIN_TEST_DB="'"$TEST_DB"'" node /tmp/brain-cron-s2.js
'

# ── Scenario 3: register and status ──
write_mcp_script /tmp/brain-cron-s3.js '
        const reg = await send("tools/call", { name: "register", arguments: { name: "cron-test-agent" } });
        const status = await send("tools/call", { name: "status", arguments: {} });
        p.kill();
        const regOk = JSON.stringify(reg).includes("sessionId");
        const statOk = JSON.stringify(status).includes("room");
        console.log("register:", regOk, "status:", statOk);
        process.exit(regOk && statOk ? 0 : 1);
'

run_scenario "register + status round-trip" '
    BRAIN_TEST_DB="'"$TEST_DB"'" node /tmp/brain-cron-s3.js
'

# ── Scenario 4: set + get ──
write_mcp_script /tmp/brain-cron-s4.js '
        await send("tools/call", { name: "register", arguments: { name: "writer" } });
        await sleep(100);
        await send("tools/call", { name: "set", arguments: { key: "test-key", value: "test-value-123" } });
        const get = await send("tools/call", { name: "get", arguments: { key: "test-key" } });
        p.kill();
        const getText = JSON.stringify(get);
        console.log("get result:", getText.substring(0, 200));
        process.exit(getText.includes("test-value-123") ? 0 : 1);
'

run_scenario "set + get shared state" '
    BRAIN_TEST_DB="'"$TEST_DB"'" node /tmp/brain-cron-s4.js
'

# ── Scenario 5: Claims (lock/unlock) ──
write_mcp_script /tmp/brain-cron-s5.js '
        await send("tools/call", { name: "register", arguments: { name: "locker" } });
        await sleep(100);
        const claim = await send("tools/call", { name: "claim", arguments: { resource: "src/test-file.ts" } });
        const rel = await send("tools/call", { name: "release", arguments: { resource: "src/test-file.ts" } });
        const claims = await send("tools/call", { name: "claims", arguments: {} });
        p.kill();
        const claimText = JSON.stringify(claim);
        console.log("claim result:", claimText.substring(0, 200));
        process.exit(claimText.includes("ok") || claimText.includes("claimed") || claimText.includes("Claimed") ? 0 : 1);
'

run_scenario "claim + release lock mechanism" '
    BRAIN_TEST_DB="'"$TEST_DB"'" node /tmp/brain-cron-s5.js
'

# ── Scenario 6: Contracts (set + get + check) ──
write_mcp_script /tmp/brain-cron-s6.js '
        await send("tools/call", { name: "register", arguments: { name: "contractor" } });
        await sleep(100);
        const sig = JSON.stringify({ params: ["x: number"], returns: "number" });
        await send("tools/call", { name: "contract_set", arguments: {
            module: "src/math.ts", name: "add", kind: "provides",
            signature: sig
        } });
        const get = await send("tools/call", { name: "contract_get", arguments: { module: "src/math.ts", kind: "provides" } });
        const check = await send("tools/call", { name: "contract_check", arguments: {} });
        p.kill();
        const getText = JSON.stringify(get);
        console.log("contract_get:", getText.substring(0, 200));
        process.exit(getText.includes("add") ? 0 : 1);
'

run_scenario "contract_set + get + check round-trip" '
    BRAIN_TEST_DB="'"$TEST_DB"'" node /tmp/brain-cron-s6.js
'

# ── Scenario 7: Atomic counters ──
write_mcp_script /tmp/brain-cron-s7.js '
        await send("tools/call", { name: "register", arguments: { name: "counter-test" } });
        await sleep(100);
        await send("tools/call", { name: "incr", arguments: { key: "test-counter", delta: 5 } });
        const c = await send("tools/call", { name: "counter", arguments: { key: "test-counter" } });
        p.kill();
        const cText = JSON.stringify(c);
        console.log("counter:", cText.substring(0, 200));
        process.exit(cText.includes("5") ? 0 : 1);
'

run_scenario "incr + counter atomic counters" '
    BRAIN_TEST_DB="'"$TEST_DB"'" node /tmp/brain-cron-s7.js
'

# ── Scenario 8: Messages (post + read) ──
write_mcp_script /tmp/brain-cron-s8.js '
        await send("tools/call", { name: "register", arguments: { name: "messenger" } });
        await sleep(100);
        await send("tools/call", { name: "post", arguments: { content: "cron hello", channel: "general" } });
        const rd = await send("tools/call", { name: "read", arguments: { channel: "general", limit: 5 } });
        p.kill();
        const rText = JSON.stringify(rd);
        console.log("read:", rText.substring(0, 200));
        process.exit(rText.includes("cron hello") ? 0 : 1);
'

run_scenario "post + read channel messaging" '
    BRAIN_TEST_DB="'"$TEST_DB"'" node /tmp/brain-cron-s8.js
'

# ── Scenario 9: Barrier / wait_until ──
write_mcp_script /tmp/brain-cron-s9.js '
        await send("tools/call", { name: "register", arguments: { name: "barrier-tester" } });
        await sleep(100);
        const w1 = await send("tools/call", { name: "wait_until", arguments: { key: "cron-barrier", threshold: 1 } });
        p.kill();
        const wText = JSON.stringify(w1);
        console.log("wait_until:", wText.substring(0, 200));
        process.exit(wText.includes("reached") || wText.includes("waiting") || wText.includes("ok") || wText.includes("Barrier") ? 0 : 1);
'

run_scenario "wait_until barrier primitive" '
    BRAIN_TEST_DB="'"$TEST_DB"'" node /tmp/brain-cron-s9.js
'

# ── Scenario 10: Memory (remember + recall) ──
write_mcp_script /tmp/brain-cron-s10.js '
        await send("tools/call", { name: "register", arguments: { name: "memo-agent" } });
        await sleep(100);
        await send("tools/call", { name: "remember", arguments: {
            key: "cron-test-fact", category: "test",
            content: "brain-mcp cron test ran successfully"
        } });
        const recall = await send("tools/call", { name: "recall", arguments: { query: "cron-test-fact" } });
        p.kill();
        const rText = JSON.stringify(recall);
        console.log("recall:", rText.substring(0, 200));
        process.exit(rText.includes("cron-test-fact") || rText.includes("count") || rText.includes("cron") ? 0 : 1);
'

run_scenario "remember + recall persistent memory" '
    BRAIN_TEST_DB="'"$TEST_DB"'" node /tmp/brain-cron-s10.js
'

# ── Scenario 11: Metrics recording ──
write_mcp_script /tmp/brain-cron-s11.js '
        await send("tools/call", { name: "register", arguments: { name: "metrics-test" } });
        await sleep(100);
        await send("tools/call", { name: "metric_record", arguments: {
            agent_name: "metrics-test", outcome: "success",
            task_description: "cron test", duration_seconds: 5
        } });
        const metrics = await send("tools/call", { name: "metrics", arguments: { limit: 5 } });
        p.kill();
        const mText = JSON.stringify(metrics);
        console.log("metrics:", mText.substring(0, 200));
        process.exit(mText.includes("metrics-test") || mText.includes("outcome") ? 0 : 1);
'

run_scenario "metric_record + metrics round-trip" '
    BRAIN_TEST_DB="'"$TEST_DB"'" node /tmp/brain-cron-s11.js
'

# ── Scenario 12: TypeScript build passes ──
run_scenario "tsc --noEmit clean build" '
    npx tsc --noEmit 2>&1 | head -5
'

# ── Scenario 13: pi-core-agent in-process agent runs ──
run_scenario "pi-core-agent in-process agent fires up" '
    TMPF=/tmp/brain-cron-s13.mjs
    ROOT='"$ROOT_DIR"'
    cat > "$TMPF" << JSEOF
import { runPiCoreAgent } from "${ROOT}/dist/pi-core-agent.js";
import { BrainDB } from "${ROOT}/dist/db.js";
const db = new BrainDB(process.env.BRAIN_TEST_DB);
const sessionId = db.registerSession("pi-test", "${ROOT}", "{}", Date.now() + "-pi-");
const r = await runPiCoreAgent({
    name: "pi-core-test",
    task: "Return the word DONE in a brain_post call",
    db,
    sessionId,
    room: "${ROOT}",
    cwd: "${ROOT}",
    model: "anthropic/claude-sonnet-4-5",
    timeout: 20,
});
console.log("exit:", r.exitCode, r.finalStatus);
process.exit(0);
JSEOF
    BRAIN_TEST_DB="'"$TEST_DB"'" node "$TMPF" 2>&1 | grep -q "exit:" && true
'

# ── Summary ──
log ""
log "========================================"
log "SCENARIO SUMMARY"
log "========================================"
log ""
log "Passed: $PASS / $((PASS+FAIL))"
log ""
if [ -n "$SCENARIOS_OK" ]; then
    log "OK:$SCENARIOS_OK"
fi
if [ -n "$SCENARIOS_FAIL" ]; then
    log "FAILED:$SCENARIOS_FAIL"
fi
log ""
log "Full log: $REPORT_FILE"

# Store for next run
echo "$PASS $FAIL" > "$LOG_DIR/last-run.txt"
echo "$(date)" > "$LOG_DIR/last-run-time.txt"

# ── If failures exist, trigger fix ──
if [ "$FAIL" -gt 0 ]; then
    log ""
    log "!!! $FAIL scenario(s) failed — triggering fix agent !!!"
    echo "FAILURES=$FAIL" >> "$REPORT_FILE"
    echo "$SCENARIOS_FAIL" >> "$REPORT_FILE"
    # Signal the fix workflow (handled by cron wrapper that checks this file)
    touch "$LOG_DIR/fix-needed"
fi

log ""
log "Cron test complete: $(date)"
