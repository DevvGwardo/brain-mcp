import { getTmuxPanePid, isProcessAlive, isTmuxTargetAlive, readTmuxTargetFromSession } from './tmux-runtime.js';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  PASS: ${message}`);
}

function test(name: string, fn: () => void) {
  process.stdout.write(`\n${name}\n`);
  try {
    fn();
  } catch (e: any) {
    console.error(`  FAIL: ${e.message}`);
    process.exitCode = 1;
  }
}

test('readTmuxTargetFromSession returns the persisted tmux target', () => {
  const target = readTmuxTargetFromSession({
    metadata: JSON.stringify({ spawn_transport: 'tmux', tmux_target: '%17' }),
  });

  assert(target === '%17', 'reads tmux_target from session metadata');
});

test('getTmuxPanePid parses the pane pid from tmux output', () => {
  const pid = getTmuxPanePid('%17', () => '4242\n');
  assert(pid === 4242, 'parses a numeric pane pid');
});

test('isTmuxTargetAlive treats tmux query success as alive', () => {
  const alive = isTmuxTargetAlive('%17', () => '');
  assert(alive === true, 'returns alive when tmux target resolves');
});

test('isTmuxTargetAlive treats tmux query failure as dead', () => {
  const alive = isTmuxTargetAlive('%17', () => {
    throw new Error('pane missing');
  });
  assert(alive === false, 'returns false when tmux target is gone');
});

test('isProcessAlive uses kill zero liveness', () => {
  assert(isProcessAlive(process.pid) === true, 'current process is alive');
  assert(isProcessAlive(99999999) === false, 'unlikely pid is not alive');
});
