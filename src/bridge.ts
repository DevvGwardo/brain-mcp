/**
 * Brain–MiniMax Bridge
 *
 * An OpenAI-compatible proxy that wraps any chat-completions provider
 * (MiniMax, Ollama, etc.) with automatic brain context injection.
 *
 * The model never needs to call brain tools — the bridge handles:
 * 1. Injects brain context (messages, agents, state, claims) into system prompt
 * 2. Forwards to upstream provider
 * 3. Auto-posts the response back to brain
 * 4. Auto-pulses heartbeat
 *
 * Usage:
 *   UPSTREAM_URL=https://api.minimax.io/v1 \
 *   UPSTREAM_KEY=sk-... \
 *   UPSTREAM_MODEL=MiniMax-M2.7 \
 *   BRIDGE_PORT=8650 \
 *   node dist/bridge.js
 *
 * Then point OpenCode at http://127.0.0.1:8650/v1 as an openai-compatible provider.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { BrainDB } from './db.js';

// ── Config ──────────────────────────────────────────────────────────────────

const UPSTREAM_URL = process.env.UPSTREAM_URL ?? 'https://api.minimax.io/v1';
const UPSTREAM_KEY = process.env.UPSTREAM_KEY ?? process.env.MINIMAX_API_KEY ?? '';
const UPSTREAM_MODEL = process.env.UPSTREAM_MODEL ?? 'MiniMax-M2.7';
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? '8650');
const BRIDGE_HOST = process.env.BRIDGE_HOST ?? '127.0.0.1';
const BRIDGE_AGENT = process.env.BRIDGE_AGENT ?? 'minimax-bridge';
const BRAIN_ROOM = process.env.BRAIN_ROOM ?? 'default';
const BRAIN_CHANNEL = process.env.BRAIN_CHANNEL ?? 'general';
const CONTEXT_MAX_MESSAGES = Number(process.env.CONTEXT_MAX_MESSAGES ?? '20');
const MINIMAX_DEFAULT_TEMPERATURE = 1;
const MINIMAX_DEFAULT_TOP_P = 0.95;
const MINIMAX_CONTEXT_LENGTH = 204800;

// ── DB ──────────────────────────────────────────────────────────────────────

const db = new BrainDB();
let sessionId: string | undefined;

function ensureSession(): string {
  if (!sessionId) {
    sessionId = db.registerSession(
      BRIDGE_AGENT,
      BRAIN_ROOM,
      JSON.stringify({ type: 'bridge', upstream: UPSTREAM_URL, model: UPSTREAM_MODEL }),
    );
  }
  db.pulse(sessionId, 'working', 'bridge:active');
  return sessionId;
}

// ── Brain context snapshot ──────────────────────────────────────────────────

function buildBrainContext(): string {
  const sid = ensureSession();
  const parts: string[] = ['[BRAIN CONTEXT — auto-injected, do not repeat this block]'];

  // Active agents
  const agents = db.getAgentHealth(BRAIN_ROOM);
  if (agents.length > 0) {
    parts.push('\n## Active Agents');
    for (const a of agents) {
      const stale = a.is_stale ? ' (STALE)' : '';
      parts.push(`- ${a.name}: ${a.status}${stale}${a.progress ? ` — ${a.progress}` : ''}`);
    }
  }

  // Recent messages
  const msgs = db.getMessages(BRAIN_CHANNEL, BRAIN_ROOM, undefined, CONTEXT_MAX_MESSAGES);
  if (msgs.length > 0) {
    parts.push('\n## Recent Messages (#' + BRAIN_CHANNEL + ')');
    for (const m of msgs) {
      parts.push(`- **${m.sender_name}**: ${m.content}`);
    }
  }

  // Shared state
  const keys = db.getKeys(BRAIN_ROOM);
  if (keys.length > 0) {
    parts.push('\n## Shared State');
    for (const k of keys) {
      const entry = db.getState(k, BRAIN_ROOM);
      if (entry) {
        const val = entry.value.length > 200 ? entry.value.slice(0, 200) + '…' : entry.value;
        parts.push(`- **${k}**: ${val}`);
      }
    }
  }

  // File claims
  const claims = db.getClaims(BRAIN_ROOM);
  if (claims.length > 0) {
    parts.push('\n## File Claims');
    for (const c of claims) {
      parts.push(`- \`${c.resource}\` claimed by ${c.owner_name}`);
    }
  }

  parts.push('\n[END BRAIN CONTEXT]');
  return parts.join('\n');
}

// ── Auto-post response back to brain ────────────────────────────────────────

function autoPost(content: string): void {
  const sid = ensureSession();
  // Truncate long responses for the brain channel
  const summary = content.length > 500
    ? content.slice(0, 500) + '… (truncated)'
    : content;
  db.postMessage(BRAIN_CHANNEL, BRAIN_ROOM, sid, BRIDGE_AGENT, summary);
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content.flatMap(part => {
      if (typeof part === 'string') return [part];
      if (!part || typeof part !== 'object') return [];
      const obj = part as Record<string, unknown>;
      if (obj.type === 'text' && typeof obj.text === 'string') return [obj.text];
      if (typeof obj.content === 'string') return [obj.content];
      return [];
    }).join('\n');
  }
  return String(content);
}

function normalizeRole(role: unknown): 'user' | 'assistant' | 'tool' {
  if (role === 'assistant') return 'assistant';
  if (role === 'tool') return 'tool';
  return 'user';
}

function stringifyToolArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function sanitizeToolCalls(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const toolCalls = value.flatMap((toolCall: any, index: number) => {
    if (!toolCall || typeof toolCall !== 'object') return [];
    const fn = toolCall.function && typeof toolCall.function === 'object'
      ? toolCall.function as Record<string, unknown>
      : toolCall as Record<string, unknown>;
    const name = typeof fn.name === 'string'
      ? fn.name
      : (typeof toolCall.name === 'string' ? toolCall.name : '');
    if (!name) return [];
    const id = typeof toolCall.id === 'string' && toolCall.id
      ? toolCall.id
      : `call_${index + 1}`;
    return [{
      id,
      type: 'function',
      function: {
        name,
        arguments: stringifyToolArguments(fn.arguments),
      },
    }];
  });
  return toolCalls.length > 0 ? toolCalls : undefined;
}

function sanitizeTools(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools = value.flatMap((tool: any) => {
    if (!tool || typeof tool !== 'object') return [];
    const fn = tool.function && typeof tool.function === 'object'
      ? tool.function as Record<string, unknown>
      : tool as Record<string, unknown>;
    const name = typeof fn.name === 'string'
      ? fn.name
      : (typeof tool.name === 'string' ? tool.name : '');
    if (!name) return [];
    const parameters = fn.parameters && typeof fn.parameters === 'object'
      ? fn.parameters
      : {
          type: 'object',
          properties: {},
          additionalProperties: true,
        };
    return [{
      type: 'function',
      function: {
        name,
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters,
      },
    }];
  });
  return tools.length > 0 ? tools : undefined;
}

function sanitizeToolChoice(value: unknown): Record<string, unknown> | string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const toolChoice = value as Record<string, any>;
  if (toolChoice.type === 'function' && toolChoice.function?.name) {
    return {
      type: 'function',
      function: { name: toolChoice.function.name },
    };
  }
  if (typeof toolChoice.name === 'string') {
    return {
      type: 'function',
      function: { name: toolChoice.name },
    };
  }
  return undefined;
}

function normalizeUserContent(role: unknown, content: unknown): string {
  const text = normalizeMessageContent(content).trim();
  if (!text) return '';
  if (role === 'system' || role === 'developer') {
    return `[System Instructions]\n${text}`;
  }
  return text;
}

function sanitizeSingleMessage(message: Record<string, unknown>): Record<string, unknown> | null {
  const rawRole = message.role;
  const role = normalizeRole(rawRole);

  if (role === 'tool') {
    const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
    const content = normalizeMessageContent(message.content).trim();
    if (!toolCallId || !content) return null;
    return {
      role: 'tool',
      tool_call_id: toolCallId,
      content,
    };
  }

  const toolCalls = sanitizeToolCalls(message.tool_calls);
  if (role === 'assistant') {
    const content = normalizeMessageContent(message.content).trim();
    if (toolCalls && toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls,
      };
    }
    if (!content) return null;
    return {
      role: 'assistant',
      content,
    };
  }

  const content = normalizeUserContent(rawRole, message.content);
  if (!content) return null;
  return {
    role: 'user',
    content,
  };
}

function reorderMiniMaxMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const fixed: Array<Record<string, unknown>> = [];
  const consumed = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    if (consumed.has(i)) continue;
    const message = messages[i];
    const role = message.role;

    if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      fixed.push(message);
      const toolCallIds = new Set(
        message.tool_calls
          .map((toolCall: any) => typeof toolCall?.id === 'string' ? toolCall.id : '')
          .filter(Boolean),
      );
      for (let j = i + 1; j < messages.length; j++) {
        if (consumed.has(j)) continue;
        const candidate = messages[j];
        if (candidate.role !== 'tool') continue;
        const toolCallId = typeof candidate.tool_call_id === 'string' ? candidate.tool_call_id : '';
        if (!toolCallIds.has(toolCallId)) continue;
        fixed.push(candidate);
        consumed.add(j);
      }
      continue;
    }

    if (role === 'tool') {
      const lastAssistantWithTools = [...fixed].reverse().find(
        item => item.role === 'assistant' && Array.isArray(item.tool_calls) && item.tool_calls.length > 0,
      );
      if (lastAssistantWithTools) {
        let insertAt = fixed.indexOf(lastAssistantWithTools) + 1;
        while (insertAt < fixed.length && fixed[insertAt].role === 'tool') insertAt++;
        fixed.splice(insertAt, 0, message);
      }
      continue;
    }

    fixed.push(message);
  }

  const merged: Array<Record<string, unknown>> = [];
  for (const message of fixed) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.role === 'user' &&
      message.role === 'user' &&
      typeof previous.content === 'string' &&
      typeof message.content === 'string'
    ) {
      previous.content += `\n\n${message.content}`;
      continue;
    }
    merged.push(message);
  }

  const validated: Array<Record<string, unknown>> = [];
  for (const message of merged) {
    if (message.role !== 'tool') {
      validated.push(message);
      continue;
    }
    const previous = validated[validated.length - 1];
    if (
      previous &&
      (previous.role === 'tool' ||
        (previous.role === 'assistant' && Array.isArray(previous.tool_calls) && previous.tool_calls.length > 0))
    ) {
      validated.push(message);
    }
  }

  return validated;
}

function sanitizeMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return reorderMiniMaxMessages(
    messages
      .map(message => sanitizeSingleMessage(message))
      .filter((message): message is Record<string, unknown> => message !== null),
  );
}

function sanitizeMiniMaxBody(input: Record<string, unknown>): Record<string, unknown> {
  const body = { ...input };

  // Strip params MiniMax rejects or Hermes does not need at the bridge layer.
  delete body.response_format;
  delete body.reasoning_effort;
  delete body.service_tier;
  delete body.metadata;
  delete body.store;
  delete body.stream_options;
  delete body.presence_penalty;
  delete body.frequency_penalty;
  delete body.logit_bias;
  delete body.logprobs;
  delete body.top_logprobs;
  delete body.seed;
  delete body.user;
  delete body.modalities;
  delete body.audio;
  delete body.prediction;
  delete body.functions;
  delete body.function_call;

  const temperature = parseFiniteNumber(body.temperature);
  if (temperature === undefined || temperature <= 0 || temperature > 1) {
    body.temperature = MINIMAX_DEFAULT_TEMPERATURE;
  } else {
    body.temperature = temperature;
  }

  const topP = parseFiniteNumber(body.top_p);
  if (topP !== undefined) {
    body.top_p = topP > 0 && topP <= 1 ? topP : MINIMAX_DEFAULT_TOP_P;
  }

  const n = parseFiniteNumber(body.n);
  if (n !== undefined && n !== 1) body.n = 1;

  const maxTokens = parseFiniteNumber(body.max_tokens);
  if (maxTokens !== undefined && maxTokens < 1) delete body.max_tokens;

  const maxCompletionTokens = parseFiniteNumber(body.max_completion_tokens);
  if (maxCompletionTokens !== undefined && maxCompletionTokens < 1) {
    delete body.max_completion_tokens;
  }

  if (Array.isArray(body.messages)) {
    body.messages = sanitizeMessages(body.messages as Array<Record<string, unknown>>);
  }

  const tools = sanitizeTools(body.tools);
  if (tools) body.tools = tools;
  else delete body.tools;

  const toolChoice = sanitizeToolChoice(body.tool_choice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  else delete body.tool_choice;

  if (typeof body.parallel_tool_calls !== 'boolean') {
    delete body.parallel_tool_calls;
  }

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) delete body[key];
  }

  return body;
}

function summarizeSettings(body: Record<string, unknown>): Record<string, unknown> {
  const roles = Array.isArray(body.messages)
    ? (body.messages as Array<Record<string, unknown>>).map(message => message.role)
    : [];
  return {
    model: body.model,
    stream: body.stream,
    temperature: body.temperature,
    top_p: body.top_p,
    n: body.n,
    max_tokens: body.max_tokens,
    max_completion_tokens: body.max_completion_tokens,
    message_count: Array.isArray(body.messages) ? body.messages.length : 0,
    message_roles: roles,
    tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
  };
}

function getModelDescriptor(id: string): Record<string, unknown> {
  return {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'brain-bridge',
    context_length: MINIMAX_CONTEXT_LENGTH,
    context_window: MINIMAX_CONTEXT_LENGTH,
    max_context_length: MINIMAX_CONTEXT_LENGTH,
    max_model_len: MINIMAX_CONTEXT_LENGTH,
  };
}

// ── Upstream proxy ──────────────────────────────────────────────────────────

async function proxyToUpstream(
  body: Record<string, unknown>,
  stream: boolean,
  res: ServerResponse,
): Promise<void> {
  const url = `${UPSTREAM_URL}/chat/completions`;

  const upstreamRes = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${UPSTREAM_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text();
    if (upstreamRes.status === 400) {
      console.error('[brain-bridge] MiniMax rejected request settings:', summarizeSettings(body));
    }
    jsonResponse(res, upstreamRes.status, { error: errText });
    return;
  }

  if (stream && upstreamRes.body) {
    cors(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);

        // Extract content from SSE chunks for auto-post
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) fullContent += delta;
            } catch { /* skip unparseable chunks */ }
          }
        }
      }
    } finally {
      res.end();
      if (fullContent.trim()) autoPost(fullContent);
    }
  } else {
    const data = await upstreamRes.json() as Record<string, unknown>;
    // Extract content for auto-post
    const content = (data as any).choices?.[0]?.message?.content;
    if (content) autoPost(content);
    jsonResponse(res, 200, data);
  }
}

// ── Request handler ─────────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? '/';

  // GET /v1/models — report the upstream model
  if (url === '/v1/models' && req.method === 'GET') {
    jsonResponse(res, 200, {
      object: 'list',
      data: [getModelDescriptor(UPSTREAM_MODEL)],
    });
    return;
  }

  if (url === `/v1/models/${encodeURIComponent(UPSTREAM_MODEL)}` && req.method === 'GET') {
    jsonResponse(res, 200, getModelDescriptor(UPSTREAM_MODEL));
    return;
  }

  // POST /v1/chat/completions — the main proxy endpoint
  if (url === '/v1/chat/completions' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const incoming = JSON.parse(raw) as Record<string, unknown>;
      const body = sanitizeMiniMaxBody(incoming);
      const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
      const stream = Boolean(body.stream);

      // Inject brain context as a system message at the front
      const brainContext = buildBrainContext();
      const contextMsg = { role: 'system', content: brainContext };

      // Insert after existing system messages, before user messages
      const systemEnd = messages.findIndex(m => m.role !== 'system');
      const insertAt = systemEnd === -1 ? messages.length : systemEnd;
      messages.splice(insertAt, 0, contextMsg);

      body.messages = sanitizeMessages(messages);

      // Override model to upstream
      body.model = UPSTREAM_MODEL;

      // Pulse heartbeat
      ensureSession();

      await proxyToUpstream(body, stream, res);
    } catch (err: any) {
      jsonResponse(res, 500, { error: err.message });
    }
    return;
  }

  // GET /v1/brain/context — expose the context snapshot for debugging
  if (url === '/v1/brain/context' && req.method === 'GET') {
    jsonResponse(res, 200, { context: buildBrainContext() });
    return;
  }

  // GET /health
  if (url === '/health') {
    jsonResponse(res, 200, {
      ok: true,
      bridge: BRIDGE_AGENT,
      upstream: UPSTREAM_URL,
      model: UPSTREAM_MODEL,
      room: BRAIN_ROOM,
    });
    return;
  }

  jsonResponse(res, 404, { error: 'not found' });
}

// ── Start ───────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('[bridge] unhandled error:', err);
    if (!res.headersSent) jsonResponse(res, 500, { error: 'internal error' });
  });
});

server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
  console.error(`[brain-bridge] listening on http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
  console.error(`[brain-bridge] upstream: ${UPSTREAM_URL} (model: ${UPSTREAM_MODEL})`);
  console.error(`[brain-bridge] brain room: ${BRAIN_ROOM}, channel: ${BRAIN_CHANNEL}`);
  console.error(`[brain-bridge] endpoints:`);
  console.error(`  POST /v1/chat/completions  — proxied with brain context`);
  console.error(`  GET  /v1/models            — reports upstream model`);
  console.error(`  GET  /v1/brain/context      — debug context snapshot`);
  console.error(`  GET  /health               — health check`);
});
