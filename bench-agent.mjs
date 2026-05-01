import { spawn } from 'child_process';
import { BrainDB } from './dist/db.js';

const TASKS = [
  { name: 'echo', prompt: 'say exactly: hello world' },
  { name: 'math', prompt: 'calculate 5 + 7 and tell me only the number' },
  { name: 'memory', prompt: 'brain_set key="bench_test" value="test_value" scope="room" && brain_status' },
];

const ITERATIONS = 3;

function runHermes(prompt) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const proc = spawn('hermes', ['chat', '-q', prompt, '-Q'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BRAIN_ROOM: 'bench-' + Date.now() }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    proc.on('close', code => {
      const duration = Date.now() - start;
      resolve({ duration, exitCode: code, stdout: stdout.slice(0, 100), stderr: stderr.slice(0, 100) });
    });

    proc.on('error', reject);
    setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 90000);
  });
}

async function benchmark() {
  console.log('\n🧠 Brain-MCP Hermes Agent Benchmark\n');
  console.log('='.repeat(50));

  const results = [];

  for (let i = 0; i < ITERATIONS; i++) {
    for (const { name, prompt } of TASKS) {
      console.log(`\n📤 ${name} (${i+1}/${ITERATIONS})...`);

      try {
        const result = await runHermes(prompt);
        results.push({ name, ...result });
        console.log(`   ✅ ${result.duration}ms`);
      } catch (err) {
        console.log(`   ❌ ${err.message}`);
        results.push({ name, duration: 90000, error: err.message });
      }
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log('\n📊 Results\n');

  const success = results.filter(r => !r.error);
  const durations = success.map(r => r.duration);

  console.log(`   Runs:         ${results.length}`);
  console.log(`   Success:      ${success.length} (${(success.length/results.length*100).toFixed(0)}%)`);
  console.log(`   Avg time:     ${(durations.reduce((a,b)=>a+b,0)/durations.length).toFixed(0)}ms`);
  console.log(`   Min:          ${Math.min(...durations)}ms`);
  console.log(`   Max:          ${Math.max(...durations)}ms`);

  console.log('\n   By task:');
  const byTask = {};
  for (const r of success) {
    if (!byTask[r.name]) byTask[r.name] = [];
    byTask[r.name].push(r.duration);
  }
  for (const [task, durs] of Object.entries(byTask)) {
    console.log(`     ${task}: ${(durs.reduce((a,b)=>a+b,0)/durs.length).toFixed(0)}ms avg`);
  }

  console.log('\n✅ Done\n');
}

benchmark().catch(console.error);