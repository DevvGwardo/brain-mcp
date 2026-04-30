import { agentEnvShellPairs, buildAgentEnv } from './agent-env.js';

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

const FAKE_ENV: NodeJS.ProcessEnv = {
  // allowed
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/alice',
  USER: 'alice',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'C.UTF-8',
  LC_CTYPE: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  TMPDIR: '/tmp',
  SHELL: '/bin/zsh',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  OPENAI_API_KEY: 'sk-oa-test',
  NOUS_API_KEY: 'nous-test',
  OPENROUTER_API_KEY: 'or-test',
  HERMES_MODEL: 'claude-sonnet-4-6',
  HERMES_LOG_LEVEL: 'info',
  BRAIN_ROOM: '/repo',
  BRAIN_DB_PATH: '/db.sqlite',
  BRAIN_SESSION_ID: 'sess-1',
  NPM_CONFIG_PREFIX: '/usr/local',
  // denied
  RAILWAY_TOKEN: 'rly-secret',
  CF_API_TOKEN: 'cf-secret',
  GITHUB_TOKEN: 'ghp-secret',
  DO_API_TOKEN: 'do-secret',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  AWS_ACCESS_KEY_ID: 'aws-id',
  GCP_SERVICE_ACCOUNT: 'gcp-secret',
  AZURE_CLIENT_SECRET: 'az-secret',
  DATABASE_URL: 'postgres://user:pass@host/db',
  STRIPE_SECRET_KEY: 'sk-live-test',
  NODE_OPTIONS: '--require=/evil.js',
  RANDOM_VAR: 'leaks',
};

test('buildAgentEnv passes the explicit allowlist', () => {
  const env = buildAgentEnv({}, FAKE_ENV);
  assert(env.PATH === '/usr/local/bin:/usr/bin:/bin', 'PATH passes');
  assert(env.HOME === '/home/alice', 'HOME passes');
  assert(env.USER === 'alice', 'USER passes');
  assert(env.SHELL === '/bin/zsh', 'SHELL passes');
  assert(env.LANG === 'en_US.UTF-8', 'LANG passes');
  assert(env.TERM === 'xterm-256color', 'TERM passes');
  assert(env.TMPDIR === '/tmp', 'TMPDIR passes');
  assert(env.NPM_CONFIG_PREFIX === '/usr/local', 'NPM_CONFIG_PREFIX passes');
});

test('buildAgentEnv passes wildcard prefixes (LC_, BRAIN_, HERMES_)', () => {
  const env = buildAgentEnv({}, FAKE_ENV);
  assert(env.LC_ALL === 'C.UTF-8', 'LC_ALL passes');
  assert(env.LC_CTYPE === 'en_US.UTF-8', 'LC_CTYPE passes');
  assert(env.BRAIN_ROOM === '/repo', 'BRAIN_ROOM passes');
  assert(env.BRAIN_DB_PATH === '/db.sqlite', 'BRAIN_DB_PATH passes');
  assert(env.HERMES_MODEL === 'claude-sonnet-4-6', 'HERMES_MODEL passes');
  assert(env.HERMES_LOG_LEVEL === 'info', 'HERMES_LOG_LEVEL passes');
});

test('buildAgentEnv passes AI provider keys', () => {
  const env = buildAgentEnv({}, FAKE_ENV);
  assert(env.ANTHROPIC_API_KEY === 'sk-ant-test', 'ANTHROPIC_API_KEY passes');
  assert(env.OPENAI_API_KEY === 'sk-oa-test', 'OPENAI_API_KEY passes');
  assert(env.NOUS_API_KEY === 'nous-test', 'NOUS_API_KEY passes');
  assert(env.OPENROUTER_API_KEY === 'or-test', 'OPENROUTER_API_KEY passes');
});

test('buildAgentEnv blocks deployment / cloud secrets', () => {
  const env = buildAgentEnv({}, FAKE_ENV);
  assert(env.RAILWAY_TOKEN === undefined, 'RAILWAY_TOKEN filtered');
  assert(env.CF_API_TOKEN === undefined, 'CF_API_TOKEN filtered');
  assert(env.GITHUB_TOKEN === undefined, 'GITHUB_TOKEN filtered');
  assert(env.DO_API_TOKEN === undefined, 'DO_API_TOKEN filtered');
  assert(env.AWS_SECRET_ACCESS_KEY === undefined, 'AWS_SECRET_ACCESS_KEY filtered');
  assert(env.AWS_ACCESS_KEY_ID === undefined, 'AWS_ACCESS_KEY_ID filtered');
  assert(env.GCP_SERVICE_ACCOUNT === undefined, 'GCP_SERVICE_ACCOUNT filtered');
  assert(env.AZURE_CLIENT_SECRET === undefined, 'AZURE_CLIENT_SECRET filtered');
});

test('buildAgentEnv blocks DB credentials and unrelated tokens', () => {
  const env = buildAgentEnv({}, FAKE_ENV);
  assert(env.DATABASE_URL === undefined, 'DATABASE_URL filtered');
  assert(env.STRIPE_SECRET_KEY === undefined, 'STRIPE_SECRET_KEY filtered');
  assert(env.RANDOM_VAR === undefined, 'unknown var filtered');
});

test('buildAgentEnv blocks NODE_OPTIONS (preload-script vector)', () => {
  const env = buildAgentEnv({}, FAKE_ENV);
  assert(env.NODE_OPTIONS === undefined, 'NODE_OPTIONS filtered');
});

test('extras override allowlist and add new keys', () => {
  const env = buildAgentEnv({ BRAIN_ROOM: 'override', NEW_VAR: 'added' }, FAKE_ENV);
  assert(env.BRAIN_ROOM === 'override', 'extras override BRAIN_ROOM');
  assert(env.NEW_VAR === 'added', 'extras add NEW_VAR even though not in allowlist');
});

test('extras with undefined value are dropped (matches optional-pass-through pattern)', () => {
  const env = buildAgentEnv({ FOO: undefined as any }, { PATH: '/bin' });
  assert(!('FOO' in env), 'undefined FOO not present');
  assert(env.PATH === '/bin', 'PATH still passes');
});

test('agentEnvShellPairs returns shell-quoted KEY=value strings', () => {
  const pairs = agentEnvShellPairs({}, { PATH: '/bin', RAILWAY_TOKEN: 'leak-me' });
  const path = pairs.find(p => p.startsWith('PATH='));
  assert(path === "PATH='/bin'", `PATH quoted (got: ${path})`);
  assert(!pairs.some(p => p.includes('RAILWAY_TOKEN')), 'RAILWAY_TOKEN excluded from pairs');
});

test('agentEnvShellPairs escapes single quotes in values', () => {
  const pairs = agentEnvShellPairs({ NOTE: "it's fine" }, {});
  const note = pairs.find(p => p.startsWith('NOTE='));
  assert(note === "NOTE='it'\\''s fine'", `single quote escaped (got: ${note})`);
});
