import { parseHermesModelSelection, resolvePiModelSpec } from './model-resolution.js';

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

test('parseHermesModelSelection reads provider and model from config block', () => {
  const selection = parseHermesModelSelection(`
model:
  default: MiniMax-M2.7
  provider: minimax
`);

  assert(selection.provider === 'minimax', 'reads the Hermes provider');
  assert(selection.model === 'MiniMax-M2.7', 'reads the Hermes default model');
});

test('resolvePiModelSpec falls back to Hermes current model for shorthand aliases', () => {
  const resolved = resolvePiModelSpec('sonnet', {
    hermesSelection: {
      provider: 'minimax',
      model: 'MiniMax-M2.7',
    },
  });

  assert(resolved.provider === 'minimax', 'uses Hermes-selected provider');
  assert(resolved.id === 'MiniMax-M2.7', 'uses Hermes-selected model');
  assert(resolved.source === 'hermes-current', 'marks the Hermes-model fallback source');
});

test('resolvePiModelSpec canonicalizes provider model ids case-insensitively', () => {
  const resolved = resolvePiModelSpec('minimax-m2.7', {
    hermesSelection: {
      provider: 'minimax',
    },
  });

  assert(resolved.provider === 'minimax', 'keeps the Hermes-selected provider');
  assert(resolved.id === 'MiniMax-M2.7', 'normalizes to the pi-ai canonical model id');
  assert(resolved.source === 'requested-normalized', 'marks the normalized source');
});

test('resolvePiModelSpec honors explicit provider-qualified models', () => {
  const resolved = resolvePiModelSpec('anthropic/claude-sonnet-4-20250514', {
    hermesSelection: {
      provider: 'minimax',
      model: 'MiniMax-M2.7',
    },
  });

  assert(resolved.provider === 'anthropic', 'keeps the explicit provider');
  assert(resolved.id === 'claude-sonnet-4-20250514', 'keeps the explicit model id');
  assert(resolved.source === 'explicit', 'marks the explicit source');
});
