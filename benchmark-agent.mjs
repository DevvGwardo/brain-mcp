import { spawn } from 'child_process';
import { promisify } from 'util';

const exec = promisify(spawn);

const ITERATIONS = 5;
const TASKS = [
  "Write a simple hello world function in Python",
  "Write a simple add function in TypeScript",
  "Write a markdown file with one line: Hello",
];

async function runHermesTask(task, iteration) {
  const start = Date.now();
  const startMetrics = await getMetrics();

  // Run hermes in headless mode with the task
  const proc = spawn('hermes', ['-q', '--dangerously-skip-permissions', '-p', task], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BRAIN_ROOM: `benchmark-${iteration}` },
  });

  let output = '';
  let stderr = '';

  proc.stdout.on('data', (data) => { output += data; });
  proc.stderr.on('data', (data) => { stderr += data; });

  return new Promise((resolve, reject) => {
    proc.on('close', async (code) => {
      const duration = Date.now() - start;
      const endMetrics = await getMetrics();

      resolve({
        task,
        exitCode: code,
        duration,
        output: output.slice(0, 500),
        stderr: stderr.slice(0, 500),
        spawnTime: startMetrics.spawn_time || 0,
      });
    });

    proc.on('error', reject);

    // Timeout after 60 seconds
    setTimeout(() => {
      proc.kill();
      reject(new Error('Timeout'));
    }, 60000);
  });
}

async function getMetrics() {
  try {
    const result = await exec('hermes', ['-q', '-p', 'brain_metrics view=spawn_summary'], {
      encoding: 'utf8',
    });
    return { spawn_time: result.stdout?.slice(0, 200) };
  } catch {
    return { spawn_time: 'unavailable' };
  }
}

async function benchmark() {
  console.log('\n🧠 Brain-MCP Agent Benchmark');
  console.log('==========================\n');

  const results = [];

  for (let i = 0; i < ITERATIONS; i++) {
    console.log(`Iteration ${i + 1}/${ITERATIONS}: ${TASKS[i % TASKS.length].slice(0, 40)}...`);

    try {
      const result = await runHermesTask(TASKS[i % TASKS.length], i);
      results.push(result);
      console.log(`  ✅ ${result.duration}ms, exit: ${result.exitCode}`);
    } catch (err) {
      console.log(`  ❌ ${err.message}`);
      results.push({ duration: 60000, error: err.message, exitCode: -1 });
    }
  }

  // Summary
  const durations = results.map((r) => r.duration);
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const sorted = [...durations].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  const successRate = results.filter((r) => r.exitCode === 0).length / results.length;

  console.log('\n📊 Results');
  console.log('==========');
  console.log(`  Iterations:  ${ITERATIONS}`);
  console.log(`  Success:    ${(successRate * 100).toFixed(0)}%`);
  console.log(`  Avg time:  ${avg.toFixed(0)}ms`);
  console.log(`  p50:       ${p50}ms`);
  console.log(`  Min:       ${Math.min(...durations)}ms`);
  console.log(`  Max:       ${Math.max(...durations)}ms`);
}

benchmark().catch(console.error);