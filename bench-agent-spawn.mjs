import { spawn } from 'child_process';
import { promisify } from 'util';
import { BrainDB } from './dist/db.js';

const exec = promisify(spawn);

const TASKS = [
  { name: 'simple-echo', task: 'echo "hello world"' },
  { name: 'write-file', task: 'write "/tmp/bench-test.txt" content="hello from benchmark"' },
  { name: 'simple-math', task: 'calculate 2 + 2 and remember the result' },
];

const ITERATIONS = 3;

async function spawnHermes(name, task, room) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const proc = spawn('hermes', [
      '-q',
      '--dangerously-skip-permissions',
      '-p', `brain_register name="${name}" && brain_wake name="${name}-worker" task="${task}" cli="hermes" layout="headless"`
    ], {
      env: { ...process.env, BRAIN_ROOM: room },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    proc.on('close', code => {
      const duration = Date.now() - start;
      resolve({ name, task, duration, exitCode: code, stdout: stdout.slice(0, 200), stderr: stderr.slice(0, 200) });
    });

    proc.on('error', reject);

    setTimeout(() => {
      proc.kill();
      reject(new Error('Timeout'));
    }, 60000);
  });
}

async function benchmark() {
  console.log('\n🧠 Brain-MCP Agent Spawn Benchmark\n');
  console.log('='.repeat(50));

  const db = new BrainDB();
  const room = 'spawn-bench-' + Date.now();

  const results = [];

  for (let i = 0; i < ITERATIONS; i++) {
    for (const { name, task } of TASKS) {
      const taskName = `${name}-${i}`;

      console.log(`\n📤 Spawning: ${taskName}`);
      console.log(`   Task: ${task}`);

      try {
        const result = await spawnHermes(taskName, task, room);
        results.push(result);

        console.log(`   ✅ ${result.duration}ms (exit: ${result.exitCode})`);
      } catch (err) {
        console.log(`   ❌ ${err.message}`);
        results.push({ name: taskName, duration: 60000, error: err.message });
      }
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log('\n📊 Results\n');

  const durations = results.filter(r => !r.error).map(r => r.duration);

  console.log(`   Iterations:     ${results.length}`);
  console.log(`   Success rate:   ${((results.filter(r => !r.error).length / results.length) * 100).toFixed(0)}%`);
  console.log(`   Avg time:       ${(durations.reduce((a,b) => a+b, 0) / durations.length).toFixed(0)}ms`);
  console.log(`   Min time:       ${Math.min(...durations)}ms`);
  console.log(`   Max time:       ${Math.max(...durations)}ms`);

  console.log('\n   By task type:');
  const byTask = {};
  for (const r of results) {
    if (r.error) continue;
    const taskType = r.name.split('-')[0];
    if (!byTask[taskType]) byTask[taskType] = [];
    byTask[taskType].push(r.duration);
  }

  for (const [task, durs] of Object.entries(byTask)) {
    const avg = durs.reduce((a,b) => a+b, 0) / durs.length;
    console.log(`     ${task}: ${avg.toFixed(0)}ms avg`);
  }

  // Check metrics in DB
  console.log('\n📈 Database metrics:');
  const sessions = db.getSessions(room);
  console.log(`   Sessions created: ${sessions.length}`);

  db.close();
  console.log('\n✅ Benchmark complete\n');
}

benchmark().catch(console.error);