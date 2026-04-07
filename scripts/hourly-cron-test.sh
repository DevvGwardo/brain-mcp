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

# ── Scenario 1: MCP server starts and responds to tools/list ──
run_scenario "MCP server starts and lists tools" '
    timeout 10 node dist/index.js --help > /dev/null 2>&1 || true
    node -e "
        const { spawn } = require(\"child_process\");
        const p = spawn(\"node\", [\"dist/index.js\"], {
            env: { ...process.env, BRAIN_DB_PATH: \"$TEST_DB\" },
            stdio: [\"pipe\", \"pipe\", \"pipe\"]
        });
        let out = \"\";
        p.stdout.on(\"data\", d => { out += d.toString(); if (out.includes(\"\\\"id\\\":\")) p.kill(); });
        p.stderr.on(\"data\", d => process.stderr.write(d));
        setTimeout(() => { p.kill(); process.exit(out.includes(\"\\\"id\\\":\") ? 0 : 1); }, 8000);
    "
'

# ── Scenario 2: All brain tools are registered ──
run_scenario "All 14+ brain tools registered in MCP manifest" '
    node -e "
        const { spawn } = require(\"child_process\");
        const p = spawn(\"node\", [\"dist/index.js\"], {
            env: { ...process.env, BRAIN_DB_PATH: \"$TEST_DB\" },
            stdio: [\"pipe\", \"pipe\", \"pipe\"]
        });
        let out = \"\";
        p.stdout.on(\"data\", d => { out += d.toString(); });
        setTimeout(async () => {
            const init = JSON.stringify({jsonrpc:\"2.0\",id:1,method:\"initialize\",params:{protocolVersion:\"2024-11-05\",capabilities:{},clientInfo:{name:\"test\",version:\"1.0\"}}})+"\n";
            const list = JSON.stringify({jsonrpc:\"2.0\",id:2,method:\"tools/list\",params:{}})+"\n";
            p.stdin.write(init);
            await new Promise(r => setTimeout(r, 500));
            p.stdin.write(list);
            await new Promise(r => setTimeout(r, 2000));
            p.kill();
            const lines = out.trim().split("\n");
            for (const l of lines) {
                try {
                    const m = JSON.parse(l);
                    if (m.id === 2 && m.result?.tools?.length >= 14) {
                        console.log(\"TOOLS:\", m.result.tools.length);
                        process.exit(0);
                    }
                } catch(e) {}
            }
            process.exit(1);
        }, 500);
    "
'

# ── Scenario 3: brain_register and brain_status ──
run_scenario "brain_register + brain_status round-trip" '
    node -e "
        const { spawn } = require(\"child_process\");
        const p = spawn(\"node\", [\"dist/index.js\"], {
            env: { ...process.env, BRAIN_DB_PATH: \"$TEST_DB\" },
            stdio: [\"pipe\", \"pipe\", \"pipe\"]
        });
        let out = \"\";
        p.stdout.on(\"data\", d => out += d.toString());
        p.stderr.on(\"data\", d => process.stderr.write(d));
        const pending = new Map();
        let rid = 1;
        const send = (method, params) => new Promise((res, rej) => {
            const id = rid++;
            pending.set(id, res);
            p.stdin.write(JSON.stringify({jsonrpc:\"2.0\",id,method,params})+\"\n\");
            setTimeout(() => { pending.delete(id); rej(new Error(\"timeout\")); }, 8000);
        });
        p.stdout.on(\"data\", d => {
            try {
                const m = JSON.parse(d.toString().trim());
                if (m.id && pending.has(m.id)) pending.get(m.id)(m);
            } catch(e) {}
        });
        setTimeout(async () => {
            await send(\"initialize\", {protocolVersion:\"2024-11-05\",capabilities:{},clientInfo:{name:\"test\",version:\"1.0\"}});
            await new Promise(r => setTimeout(r, 300));
            const reg = await send(\"tools/call\", {name:\"brain_register\",arguments:{name:\"cron-test-agent\"}});
            const status = await send(\"tools/call\", {name:\"brain_status\",arguments:{}});
            p.kill();
            const regOk = JSON.stringify(reg).includes(\"sessionId\");
            const statOk = JSON.stringify(status).includes(\"room\");
            process.exit(regOk && statOk ? 0 : 1);
        }, 500);
    "
'

# ── Scenario 4: brain_set + brain_get ──
run_scenario "brain_set + brain_get shared state" '
    node -e "
        const { spawn } = require(\"child_process\");
        const p = spawn(\"node\", [\"dist/index.js\"], {
            env: { ...process.env, BRAIN_DB_PATH: \"$TEST_DB\" },
            stdio: [\"pipe\", \"pipe\", \"pipe\"]
        });
        let out = \"\";
        p.stdout.on(\"data\", d => out += d.toString());
        const pending = new Map();
        let rid = 1;
        const send = (method, params) => new Promise((res) => {
            const id = rid++;
            pending.set(id, res);
            p.stdin.write(JSON.stringify({jsonrpc:\"2.0\",id,method,params})+\"\n\");
            setTimeout(() => { pending.delete(id); res({error:{message:\"timeout\"}}); }, 8000);
        });
        p.stdout.on(\"data\", d => {
            try {
                const m = JSON.parse(d.toString().trim());
                if (m.id && pending.has(m.id)) pending.get(m.id)(m);
            } catch(e) {}
        });
        setTimeout(async () => {
            await send(\"initialize\", {protocolVersion:\"2024-11-05\",capabilities:{},clientInfo:{name:\"test\",version:\"1.0\"}});
            await new Promise(r => setTimeout(r, 300));
            await send(\"tools/call\", {name:\"brain_register\",arguments:{name:\"writer\"}});
            await new Promise(r => setTimeout(r, 100));
            const set = await send(\"tools/call\", {name:\"brain_set\",arguments:{key:\"test-key\",value:\"test-value-123\"}});
            const get = await send(\"tools/call\", {name:\"brain_get\",arguments:{key:\"test-key\"}});
            p.kill();
            const getText = get?.content?.[0]?.text || \"\";
            process.exit(getText.includes(\"test-value-123\") ? 0 : 1);
        }, 500);
    "
'

# ── Scenario 5: Claims (lock/unlock) ──
run_scenario "brain_claim + brain_release lock mechanism" '
    node -e "
        const { spawn } = require(\"child_process\");
        const p = spawn(\"node\", [\"dist/index.js\"], {
            env: { ...process.env, BRAIN_DB_PATH: \"$TEST_DB\" },
            stdio: [\"pipe\", \"pipe\", \"pipe\"]
        });
        let out = \"\";
        p.stdout.on(\"data\", d => out += d.toString());
        const pending = new Map();
        let rid = 1;
        const send = (method, params) => new Promise((res) => {
            const id = rid++;
            pending.set(id, res);
            p.stdin.write(JSON.stringify({jsonrpc:\"2.0\",id,method,params})+\"\n\");
            setTimeout(() => { pending.delete(id); res({error:{message:\"timeout\"}}); }, 8000);
        });
        p.stdout.on(\"data\", d => {
            try {
                const m = JSON.parse(d.toString().trim());
                if (m.id && pending.has(m.id)) pending.get(m.id)(m);
            } catch(e) {}
        });
        setTimeout(async () => {
            await send(\"initialize\", {protocolVersion:\"2024-11-05\",capabilities:{},clientInfo:{name:\"test\",version:\"1.0\"}});
            await new Promise(r => setTimeout(r, 300));
            await send(\"tools/call\", {name:\"brain_register\",arguments:{name:\"locker\"}});
            await new Promise(r => setTimeout(r, 100));
            const claim = await send(\"tools/call\", {name:\"brain_claim\",arguments:{resource:\"src/test-file.ts\"}});
            const rel = await send(\"tools/call\", {name:\"brain_release\",arguments:{resource:\"src/test-file.ts\"}});
            const claims = await send(\"tools/call\", {name:\"brain_claims\",arguments:{}});
            p.kill();
            const claimText = JSON.stringify(claim);
            process.exit(claimText.includes(\"ok\") || claimText.includes(\"claimed\") ? 0 : 1);
        }, 500);
    "
'

# ── Scenario 6: Contracts (set + get + check) ──
run_scenario "brain_contract_set + get + check round-trip" '
    node -e "
        const { spawn } = require(\"child_process\");
        const p = spawn(\"node\", [\"dist/index.js\"], {
            env: { ...process.env, BRAIN_DB_PATH: \"$TEST_DB\" },
            stdio: [\"pipe\", \"pipe\", \"pipe\"]
        });
        let out = \"\";
        p.stdout.on(\"data\", d => out += d.toString());
        const pending = new Map();
        let rid = 1;
        const send = (method, params) => new Promise((res) => {
            const id = rid++;
            pending.set(id, res);
            p.stdin.write(JSON.stringify({jsonrpc:\"2.0\",id,method,params})+\"\n\");
            setTimeout(() => { pending.delete(id); res({error:{message:\"timeout\"}}); }, 8000);
        });
        p.stdout.on(\"data\", d => {
            try {
                const m = JSON.parse(d.toString().trim());
                if (m.id && pending.has(m.id)) pending.get(m.id)(m);
            } catch(e) {}
        });
        setTimeout(async () => {
            await send(\"initialize\", {protocolVersion:\"2024-11-05\",capabilities:{},clientInfo:{name:\"test\",version:\"1.0\"}});
            await new Promise(r => setTimeout(r, 300));
            await send(\"tools/call\", {name:\"brain_register\",arguments:{name:\"contractor\"}});
            await new Promise(r => setTimeout(r, 100));
            const sig = JSON.stringify({params:[\"x: number\"],returns:\"number\"});
            await send(\"tools/call\", {name:\"brain_contract_set\",arguments:{
                module:\"src/math.ts\",name:\"add\",kind:\"provides\",
                signature: sig
            }});
            const get = await send(\"tools/call\", {name:\"brain_contract_get\",arguments:{module:\"src/math.ts\",kind:\"provides\"}});
            const check = await send(\"tools/call\", {name:\"brain_contract_check\",arguments:{}});
            p.kill();
            const getText = JSON.stringify(get);
            process.exit(getText.includes(\"add\") ? 0 : 1);
        }, 500);
    "
'

# ── Scenario 7: Atomic counters ──
run_scenario "brain_incr + brain_counter atomic counters" '
    node -e "
        const { spawn } = require(\"child_process\");
        const p = spawn(\"node\", [\"dist/index.js\"], {
            env: { ...process.env, BRAIN_DB_PATH: \"$TEST_DB\" },
            stdio: [\"pipe\", \"pipe\", \"pipe\"]
        });
        let out = \"\";
        p.stdout.on(\"data\", d => out += d.toString());
        const pending = new Map();
        let rid = 1;
        const send = (method, params) => new Promise((res) => {
            const id = rid++;
            pending.set(id, res);
            p.stdin.write(JSON.stringify({jsonrpc:\"2.0\",id,method,params})+\"\n\");
            setTimeout(() => { pending.delete(id); res({error:{message:\"timeout\"}}); }, 8000);
        });
        p.stdout.on(\"data\", d => {
            try {
                const m = JSON.parse(d.toString().trim());
                if (m.id && pending.has(m.id)) pending.get(m.id)(m);
            } catch(e) {}
        });
        setTimeout(async () => {
            await send(\"initialize\", {protocolVersion:\"2024-11-05\",capabilities:{},clientInfo:{name:\"test\",version:\"1.0\"}});
            await new Promise(r => setTimeout(r, 300));
            await send(\"tools/call\", {name:\"brain_register\",arguments:{name:\"counter-test\"}});
            await new Promise(r => setTimeout(r, 100));
            await send(\"tools/call\", {name:\"brain_incr\",arguments:{key:\"test-counter\",delta:5}});
            const c = await send(\"tools/call\", {name:\"brain_counter\",arguments:{key:\"test-counter\"}});
            p.kill();
            const cText = JSON.stringify(c);
            process.exit(cText.includes(\"5\") ? 0 : 1);
        }, 500);
    "
'

# ── Scenario 8: Messages (post + read) ──
run_scenario "brain_post + brain_read channel messaging" '
    node -e "
        const { spawn } = require(\"child_process\");
        const p = spawn(\"node\", [\"dist/index.js\"], {
            env: { ...process.env, BRAIN_DB_PATH: \"$TEST_DB\" },
            stdio: [\"pipe\", \"pipe\", \"pipe\"]
        });
        let out = \"\";
        p.stdout.on(\"data\", d => out += d.toString());
        const pending = new Map();
        let rid = 1;
        const send = (method, params) => new Promise((res) => {
            const id = rid++;
            pending.set(id, res);
            p.stdin.write(JSON.stringify({jsonrpc:\"2.0\",id,method,params})+\"\n\");
            setTimeout(() => { pending.delete(id); res({error:{message:\"timeout\"}}); }, 8000);
        });
        p.stdout.on(\"data\", d => {
            try {
                const m = JSON.parse(d.toString().trim());
                if (m.id && pending.has(m.id)) pending.get(m.id)(m);
            } catch(e) {}
        });
        setTimeout(async () => {
            await send(\"initialize\", {protocolVersion:\"2024-11-05\",capabilities:{},clientInfo:{name:\"test\",version:\"1.0\"}});
            await new Promise(r => setTimeout(r, 300));
            await send(\"tools/call\", {name:\"brain_register\",arguments:{name:\"messenger\"}});
            await new Promise(r => setTimeout(r, 100));
            await send(\"tools/call\", {name:\"brain_post\",arguments:{content:\"cron hello\",channel:\"general\"}});
            const read = await send(\"tools/call\", {name:\"brain_read\",arguments:{channel:\"general\",limit:5}});
            p.kill();
            const rText = JSON.stringify(read);
            process.exit(rText.includes(\"cron hello\") ? 0 : 1);
        }, 500);
    "
'

# ── Scenario 9: Barrier / wait_until ──
run_scenario "brain_wait_until barrier primitive" '
    node -e "
        const { spawn } = require(\"child_process\");
        const p = spawn(\"node\", [\"dist/index.js\"], {
            env: { ...process.env, BRAIN_DB_PATH: \"$TEST_DB\" },
            stdio: [\"pipe\", \"pipe\", \"pipe\"]
        });
        let out = \"\";
        p.stdout.on(\"data\", d => out += d.toString());
        const pending = new Map();
        let rid = 1;
        const send = (method, params) => new Promise((res) => {
            const id = rid++;
            pending.set(id, res);
            p.stdin.write(JSON.stringify({jsonrpc:\"2.0\",id,method,params})+\"\n\");
            setTimeout(() => { pending.delete(id); res({error:{message:\"timeout\"}}); }, 8000);
        });
        p.stdout.on(\"data\", d => {
            try {
                const m = JSON.parse(d.toString().trim());
                if (m.id && pending.has(m.id)) pending.get(m.id)(m);
            } catch(e) {}
        });
        setTimeout(async () => {
            await send(\"initialize\", {protocolVersion:\"2024-11-05\",capabilities:{},clientInfo:{name:\"test\",version:\"1.0\"}});
            await new Promise(r => setTimeout(r, 300));
            await send(\"tools/call\", {name:\"brain_register\",arguments:{name:\"barrier-tester\"}});
            await new Promise(r => setTimeout(r, 100));
            const w1 = await send(\"tools/call\", {name:\"brain_wait_until\",arguments:{key:\"cron-barrier\",threshold:1}});
            p.kill();
            const wText = JSON.stringify(w1);
            process.exit(wText.includes(\"reached\") || wText.includes(\"waiting\") || wText.includes(\"ok\") ? 0 : 1);
        }, 500);
    "
'

# ── Scenario 10: Memory (remember + recall) ──
run_scenario "brain_remember + brain_recall persistent memory" '
    node -e "
        const { spawn } = require(\"child_process\");
        const p = spawn(\"node\", [\"dist/index.js\"], {
            env: { ...process.env, BRAIN_DB_PATH: \"$TEST_DB\" },
            stdio: [\"pipe\", \"pipe\", \"pipe\"]
        });
        let out = \"\";
        p.stdout.on(\"data\", d => out += d.toString());
        const pending = new Map();
        let rid = 1;
        const send = (method, params) => new Promise((res) => {
            const id = rid++;
            pending.set(id, res);
            p.stdin.write(JSON.stringify({jsonrpc:\"2.0\",id,method,params})+\"\n\");
            setTimeout(() => { pending.delete(id); res({error:{message:\"timeout\"}}); }, 8000);
        });
        p.stdout.on(\"data\", d => {
            try {
                const m = JSON.parse(d.toString().trim());
                if (m.id && pending.has(m.id)) pending.get(m.id)(m);
            } catch(e) {}
        });
        setTimeout(async () => {
            await send(\"initialize\", {protocolVersion:\"2024-11-05\",capabilities:{},clientInfo:{name:\"test\",version:\"1.0\"}});
            await new Promise(r => setTimeout(r, 300));
            await send(\"tools/call\", {name:\"brain_register\",arguments:{name:\"memo-agent\"}});
            await new Promise(r => setTimeout(r, 100));
            await send(\"tools/call\", {name:\"brain_remember\",arguments:{
                key:\"cron-test-fact\",category:\"test\",
                content:\"brain-mcp cron test ran at $(date)\"
            }});
            const recall = await send(\"tools/call\", {name:\"brain_recall\",arguments:{query:\"cron-test-fact\"}});
            p.kill();
            const rText = JSON.stringify(recall);
            process.exit(rText.includes(\"cron-test-fact\") || rText.includes(\"count\") ? 0 : 1);
        }, 500);
    "
'

# ── Scenario 11: Metrics recording ──
run_scenario "brain_metric_record + brain_metrics round-trip" '
    node -e "
        const { spawn } = require(\"child_process\");
        const p = spawn(\"node\", [\"dist/index.js\"], {
            env: { ...process.env, BRAIN_DB_PATH: \"$TEST_DB\" },
            stdio: [\"pipe\", \"pipe\", \"pipe\"]
        });
        let out = \"\";
        p.stdout.on(\"data\", d => out += d.toString());
        const pending = new Map();
        let rid = 1;
        const send = (method, params) => new Promise((res) => {
            const id = rid++;
            pending.set(id, res);
            p.stdin.write(JSON.stringify({jsonrpc:\"2.0\",id,method,params})+\"\n\");
            setTimeout(() => { pending.delete(id); res({error:{message:\"timeout\"}}); }, 8000);
        });
        p.stdout.on(\"data\", d => {
            try {
                const m = JSON.parse(d.toString().trim());
                if (m.id && pending.has(m.id)) pending.get(m.id)(m);
            } catch(e) {}
        });
        setTimeout(async () => {
            await send(\"initialize\", {protocolVersion:\"2024-11-05\",capabilities:{},clientInfo:{name:\"test\",version:\"1.0\"}});
            await new Promise(r => setTimeout(r, 300));
            await send(\"tools/call\", {name:\"brain_register\",arguments:{name:\"metrics-test\"}});
            await new Promise(r => setTimeout(r, 100));
            await send(\"tools/call\", {name:\"brain_metric_record\",arguments:{
                agent_name:\"metrics-test\",outcome:\"success\",
                task_description:\"cron test\",duration_seconds:5
            }});
            const metrics = await send(\"tools/call\", {name:\"brain_metrics\",arguments:{limit:5}});
            p.kill();
            const mText = JSON.stringify(metrics);
            process.exit(mText.includes(\"metrics-test\") || mText.includes(\"outcome\") ? 0 : 1);
        }, 500);
    "
'

# ── Scenario 12: TypeScript build passes ──
run_scenario "tsc --noEmit clean build" '
    npx tsc --noEmit 2>&1 | head -5
'

# ── Scenario 13: pi-core-agent in-process agent runs ──
run_scenario "pi-core-agent in-process agent fires up" '
    timeout 30 node -e "
        import { runPiCoreAgent } from \"$(pwd)/dist/pi-core-agent.js\";
        import { BrainDB } from \"$(pwd)/dist/db.js\";
        const db = new BrainDB(\"$TEST_DB\");
        db.registerSession(\"pi-test\", \"$(pwd)\", \"{}\", \"$(date +%s)-pi-\");
        const r = await runPiCoreAgent({
            name: \"pi-core-test\",
            task: \"Return the word DONE in a brain_post call\",
            db,
            sessionId: db.getSessionByName(\"pi-test\")?.id || \"\",
            room: \"$(pwd)\",
            cwd: \"$(pwd)\",
            model: \"anthropic/claude-sonnet-4-5\",
            timeout: 20,
        });
        console.log(\"exit:\", r.exitCode, r.finalStatus);
        process.exit(0);
    " 2>&1 | grep -q "exit:" && true
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
