import { compileWorkflow } from './workflow.js';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  PASS: ${message}`);
}

function test(name: string, fn: () => void) {
  process.stdout.write(`\n${name}\n`);
  try {
    fn();
  } catch (error: any) {
    console.error(`  FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

test('feature workflow compiles into design/build/quality phases', () => {
  const workflow = compileWorkflow('Add an AutoAgent-inspired workflow compiler for brain_swarm', {
    cwd: '/repo/brain-mcp',
    mode: 'pi-core',
  });

  assert(workflow.kind === 'feature', 'classifies feature work');
  assert(workflow.phases[0]?.name === 'design', 'includes design phase');
  assert(workflow.phases.some((phase) => phase.name === 'build'), 'includes build phase');
  assert(workflow.phases.some((phase) => phase.name === 'quality'), 'includes quality phase');

  const buildAgents = workflow.phases.find((phase) => phase.name === 'build')?.agents ?? [];
  assert(buildAgents.some((agent) => agent.role === 'workflow-compiler'), 'assigns orchestration/compiler role');
  assert(buildAgents.some((agent) => agent.files.includes('src/index.ts')), 'assigns index.ts file scope');
});

test('bugfix workflow biases toward transport/runtime scope', () => {
  const workflow = compileWorkflow('Fix the ugly Hermes output rendering issue in the renderer/transport path', {
    cwd: '/repo/brain-mcp',
  });

  assert(workflow.kind === 'bugfix', 'classifies bugfix work');
  const buildAgents = workflow.phases.find((phase) => phase.name === 'build')?.agents ?? [];
  assert(buildAgents.some((agent) => agent.role === 'transport-runtime'), 'includes transport runtime role');
  assert(buildAgents.some((agent) => agent.files.includes('src/renderer.ts')), 'assigns renderer file scope');
});

test('workflow compiler threads model suggestions into agent specs', () => {
  const workflow = compileWorkflow('Integrate a reusable workflow schema with the Python conductor', {
    cwd: '/repo/brain-mcp',
    recommendModel: (_task, role) => ({
      model: `model-for-${role}`,
      confidence: 0.77,
      reasoning: `picked for ${role}`,
    }),
  });

  const modeledAgents = workflow.phases.flatMap((phase) => phase.agents).filter((agent) => agent.model);
  assert(modeledAgents.length > 0, 'applies model suggestions');
  assert(modeledAgents.every((agent) => agent.model?.startsWith('model-for-')), 'stores the model name');
  assert(modeledAgents.every((agent) => agent.model_confidence === 0.77), 'stores the model confidence');
});
