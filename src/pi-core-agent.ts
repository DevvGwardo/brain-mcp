/**
 * pi-core-agent — In-process pi-agent-core wrapper for brain-mcp.
 *
 * Uses @mariozechner/pi-agent-core directly instead of spawning the `pi` CLI.
 * Benefits:
 * - No subprocess cold-start overhead (~2s saved per agent)
 * - Guaranteed heartbeats via beforeToolCall hook (no agent cooperation needed)
 * - Full event visibility: turn_start/end, tool_execution_start/end per tool
 * - Parallel tool execution within a turn
 * - Structured result passing back to conductor
 */

import { Agent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import type { Model, ThinkingBudgets } from '@mariozechner/pi-ai';
import type { AgentEvent, ThinkingLevel } from '@mariozechner/pi-agent-core';
import { BrainDB } from './db.js';
import { createBrainTools } from './pi-core-tools.js';
import { createServerLogger } from './server-log.js';

export interface PiCoreAgentConfig {
  name: string;
  task: string;
  db: BrainDB;
  sessionId: string;
  room: string;
  cwd: string;
  model: string; // e.g. "anthropic/claude-sonnet-4-5" or "claude-sonnet-4-5"
  timeout: number; // seconds
  files?: string[];
  role?: string;
  acceptance?: string[];
  dependsOn?: string[];
  thinkingLevel?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
  onEvent?: (event: AgentEvent) => void;
  abortSignal?: AbortSignal;
}

function parseModelString(model: string): { provider: string; id: string } {
  // Handle "provider/model" format
  if (model.includes('/')) {
    const [provider, id] = model.split('/');
    return { provider: provider || 'anthropic', id: id || model };
  }
  // Bare model ID — assume anthropic
  return { provider: 'anthropic', id: model };
}

export async function runPiCoreAgent(config: PiCoreAgentConfig): Promise<{ exitCode: number; finalStatus: string }> {
  const agentLog = createServerLogger({ component: `pi-core:${config.name}`, room: config.room });
  const { provider, id } = parseModelString(config.model);
  const resolvedModel: Model<any> | undefined = getModel(provider as any, id as any);

  if (!resolvedModel) {
    throw new Error(`Model not found: ${provider}/${id}. Is it a valid model for that provider?`);
  }

  const brainTools = createBrainTools(config.db, config.sessionId, config.room);
  const fileScope = config.files?.length
    ? `\n\nFILE SCOPE: You are responsible for these files: ${config.files.join(', ')}.`
    : '';
  const roleLine = config.role ? `\nROLE: ${config.role}.` : '';
  const acceptance = config.acceptance?.length
    ? `\n\nSUCCESS CRITERIA:\n${config.acceptance.map((item) => `- ${item}`).join('\n')}`
    : '';
  const dependencies = config.dependsOn?.length
    ? `\n\nDEPENDENCIES: ${config.dependsOn.join(', ')}. Read shared state/messages before duplicating their work.`
    : '';

  const taskDirective = [
    `TASK: ${config.task}`,
    '',
    `IMPORTANT: You have these tools available:`,
    brainTools.map(t => `  - ${t.name}: ${t.description}`).join('\n'),
    '',
    `You MUST use the brain tools to complete your task. Call brain_set first, then brain_post when done.`,
  ].join('\n');

  const agent = new Agent({
    initialState: {
      systemPrompt: [
        `You are "${config.name}", a focused coding agent working in a multi-agent team.`,
        `Your working directory is: ${config.cwd}`,
        roleLine,
        fileScope,
        dependencies,
        acceptance,
        '',
        taskDirective,
      ].join('\n'),
      model: resolvedModel,
      thinkingLevel: config.thinkingLevel ?? 'medium',
      tools: brainTools,
    },
    toolExecution: 'parallel',
    thinkingBudgets: config.thinkingBudgets ?? {
      minimal: 1024,
      low: 4096,
      medium: 8192,
      high: 16384,
    },
    // getApiKey: forward API keys for all supported providers
    getApiKey: (provider: string) => {
      const keys: Record<string, string | undefined> = {
        minimax: process.env.MINIMAX_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        openai: process.env.OPENAI_API_KEY,
        'openai-gpt-4o': process.env.OPENAI_API_KEY,
        google: process.env.GEMINI_API_KEY,
        groq: process.env.GROQ_API_KEY,
        'github-copilot': process.env.GH_TOKEN || process.env.COPILOT_GITHUB_TOKEN,
      };
      return keys[provider];
    },
    // beforeToolCall fires on EVERY tool — this is the auto-heartbeat
    beforeToolCall: async (ctx) => {
      config.db.pulse(config.sessionId, 'working', `tool:${ctx.toolCall.name} ${JSON.stringify(ctx.args).slice(0, 50)}`);
      agentLog.log(`tool_call ${ctx.toolCall.name} args=${JSON.stringify(ctx.args).slice(0, 100)}`);
      return undefined;
    },
    // afterToolCall: log result for observability
    afterToolCall: async (ctx) => {
      agentLog.log(`tool_result ${ctx.toolCall.name} isError=${ctx.isError} result=${JSON.stringify(ctx.result).slice(0, 100)}`);
      if (ctx.isError) {
        const textContent = ctx.result.content?.find((c: any) => c.type === 'text') as any;
        config.db.pulse(config.sessionId, 'failed', `tool failed: ${ctx.toolCall.name} — ${textContent?.text?.slice(0, 100) ?? 'no message'}`);
      }
      return undefined;
    },
  });

  // Wire abortSignal to agent
  if (config.abortSignal) {
    config.abortSignal.addEventListener('abort', () => {
      agentLog.log('abort signal received');
      agent.abort();
    }, { once: true });
  }

  // Subscribe to events for visibility
  if (config.onEvent) {
    agent.subscribe(async (event) => {
      switch (event.type) {
        case 'agent_start':
          agentLog.log(`agent_start thinking=${config.thinkingLevel ?? 'medium'}`);
          config.db.pulse(config.sessionId, 'working', 'agent started');
          break;
        case 'turn_start':
          config.db.pulse(config.sessionId, 'working', 'thinking...');
          break;
        case 'turn_end':
          if (event.toolResults.length > 0) {
            const toolNames = event.toolResults.map(r => r.toolName).join(', ');
            config.db.pulse(config.sessionId, 'working', `${event.toolResults.length} tool(s): ${toolNames}`);
          }
          break;
        case 'tool_execution_start':
          config.db.pulse(config.sessionId, 'working', `executing tool:${event.toolName}`);
          break;
        case 'agent_end':
          agentLog.log(`agent_end ${event.messages.length} message(s) in transcript`);
          break;
      }
      config.onEvent?.(event);
    });
  }

  // Set up timeout
  const timeoutMs = config.timeout * 1000;
  let exitCode = 0;
  let finalStatus = 'done';

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`TIMEOUT after ${config.timeout}s`));
    }, timeoutMs);
  });

  try {
    await Promise.race([
      agent.prompt(config.task),
      timeoutPromise,
    ]);
    finalStatus = 'done';
    exitCode = 0;
  } catch (err: any) {
    finalStatus = err.message?.includes('TIMEOUT') ? 'timeout' : 'failed';
    exitCode = finalStatus === 'timeout' ? 124 : 1;
    // Try to post the error
    try {
      config.db.postMessage('general', config.room, config.sessionId, 'pi-core-agent',
        `[${config.name}] ${finalStatus}: ${err.message}`);
    } catch { /* ignore */ }
  }

  // Record exit
  config.db.pulse(config.sessionId, finalStatus as any, `pi-core-agent exit ${exitCode}`);
  config.db.set_exit_code(config.sessionId, exitCode);

  return { exitCode, finalStatus };
}
