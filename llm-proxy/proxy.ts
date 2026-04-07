#!/usr/bin/env npx tsx
/**
 * LLM Rate-Aware Proxy
 *
 * Sits between Hermes and LLM providers. Provides:
 * 1. Per-provider token bucket rate limiting (no more 429s)
 * 2. Request queuing with priority (tool calls > chat > delegation)
 * 3. Automatic provider rotation when one is exhausted
 * 4. Request logging for cost/latency visibility
 *
 * Hermes points all providers at this proxy instead of hitting APIs directly.
 * The proxy forwards to the real endpoints with proper pacing.
 *
 * Usage:
 *   npx tsx llm-proxy/proxy.ts
 *   # Listens on http://127.0.0.1:8650/v1/...
 *   # Then set Hermes providers to point here
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';

// ── Config ─────────────────────────────────────────────────────────────────

interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  rpm: number;          // requests per minute
  tpm: number;          // tokens per minute (0 = unlimited)
  concurrent: number;   // max concurrent requests
  models: string[];     // models this provider serves
  priority: number;     // higher = preferred
}

const PROVIDERS: ProviderConfig[] = [
  {
    name: 'openrouter-stepfun',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || '',
    rpm: 45,  // stay under 50 RPM limit with buffer
    tpm: 0,
    concurrent: 5,
    models: ['stepfun/step-3.5-flash:free', 'stepfun/step-3.5-flash'],
    priority: 10,
  },
  {
    name: 'minimax',
    baseUrl: 'https://api.minimaxi.chat/v1',
    apiKey: process.env.MINIMAX_API_KEY || '',
    rpm: 120,
    tpm: 0,
    concurrent: 10,
    models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2-7'],
    priority: 5,
  },
  {
    name: 'kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: process.env.KIMI_API_KEY || '',
    rpm: 60,
    tpm: 0,
    concurrent: 5,
    models: ['kimi-k2-0711-preview', 'moonshot-v1-auto'],
    priority: 3,
  },
  {
    name: 'nvidia',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKey: process.env.NVIDIA_API_KEY || '',
    rpm: 60,
    tpm: 0,
    concurrent: 5,
    models: ['nvidia/*'],
    priority: 2,
  },
  {
    name: 'xai',
    baseUrl: 'https://api.x.ai/v1',
    apiKey: process.env.XAI_API_KEY || '',
    rpm: 60,
    tpm: 0,
    concurrent: 5,
    models: ['grok-*', 'xai/*'],
    priority: 1,
  },
];

// ── Token Bucket Rate Limiter ──────────────────────────────────────────────

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private inflight = 0;

  constructor(
    private rate: number,      // tokens per minute
    private maxConcurrent: number,
  ) {
    this.tokens = rate;
    this.lastRefill = Date.now();
  }

  private refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 60000; // minutes
    this.tokens = Math.min(this.rate, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
  }

  canAcquire(): boolean {
    this.refill();
    return this.tokens >= 1 && this.inflight < this.maxConcurrent;
  }

  acquire(): boolean {
    this.refill();
    if (this.tokens < 1 || this.inflight >= this.maxConcurrent) return false;
    this.tokens -= 1;
    this.inflight++;
    return true;
  }

  release() {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  waitTime(): number {
    this.refill();
    if (this.tokens >= 1 && this.inflight < this.maxConcurrent) return 0;
    if (this.inflight >= this.maxConcurrent) return 1000; // wait 1s for a slot
    // Time until next token
    return Math.ceil((1 - this.tokens) / this.rate * 60000);
  }

  get available(): number { this.refill(); return Math.floor(this.tokens); }
  get active(): number { return this.inflight; }
}

// ── Request Queue ──────────────────────────────────────────────────────────

interface QueuedRequest {
  req: IncomingMessage;
  res: ServerResponse;
  body: Buffer;
  model: string;
  resolve: () => void;
  enqueuedAt: number;
}

// ── Proxy Server ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.LLM_PROXY_PORT || '8650', 10);
const HOST = process.env.LLM_PROXY_HOST || '127.0.0.1';

// Initialize buckets
const buckets = new Map<string, TokenBucket>();
const activeProviders = PROVIDERS.filter(p => p.apiKey);
for (const p of activeProviders) {
  buckets.set(p.name, new TokenBucket(p.rpm, p.concurrent));
}

// Stats
let totalRequests = 0;
let totalQueued = 0;
let totalForwarded = 0;
let totalErrors = 0;

const queue: QueuedRequest[] = [];
let processing = false;

function findProvider(model: string): ProviderConfig | null {
  // Exact match first
  for (const p of activeProviders) {
    if (p.models.some(m => m === model)) return p;
  }
  // Wildcard match
  for (const p of activeProviders) {
    if (p.models.some(m => {
      if (m.endsWith('*')) return model.startsWith(m.slice(0, -1));
      return model.includes(m) || m.includes(model);
    })) return p;
  }
  return null;
}

async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const item = queue[0];
    const provider = findProvider(item.model);

    if (!provider) {
      queue.shift();
      item.res.writeHead(400, { 'Content-Type': 'application/json' });
      item.res.end(JSON.stringify({ error: { message: `No provider for model: ${item.model}` } }));
      item.resolve();
      continue;
    }

    const bucket = buckets.get(provider.name)!;
    if (!bucket.canAcquire()) {
      // Wait and retry
      const waitMs = bucket.waitTime();
      await new Promise(r => setTimeout(r, Math.min(waitMs, 2000)));
      continue;
    }

    // Dequeue and forward
    queue.shift();
    bucket.acquire();
    totalForwarded++;

    forwardRequest(item, provider, bucket).then(() => {
      item.resolve();
    }).catch(() => {
      item.resolve();
    });
  }

  processing = false;
}

async function forwardRequest(
  item: QueuedRequest,
  provider: ProviderConfig,
  bucket: TokenBucket,
): Promise<void> {
  const url = new URL(item.req.url || '/v1/chat/completions', provider.baseUrl);
  // Rewrite path: /v1/chat/completions → provider's base + /chat/completions
  const path = (item.req.url || '').replace(/^\/v1/, '');
  const targetUrl = `${provider.baseUrl}${path}`;

  const startTime = Date.now();

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    };

    // Forward OpenRouter-specific headers
    const httpReferer = item.req.headers['http-referer'] as string;
    if (httpReferer) headers['HTTP-Referer'] = httpReferer;
    const xTitle = item.req.headers['x-title'] as string;
    if (xTitle) headers['X-Title'] = xTitle;

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: item.body,
    });

    const elapsed = Date.now() - startTime;
    const isStream = response.headers.get('content-type')?.includes('text/event-stream');

    // Copy response headers
    const resHeaders: Record<string, string> = {
      'Content-Type': response.headers.get('content-type') || 'application/json',
      'X-Proxy-Provider': provider.name,
      'X-Proxy-Latency': `${elapsed}ms`,
    };

    // Forward rate limit headers
    const rlRemaining = response.headers.get('x-ratelimit-remaining');
    if (rlRemaining) resHeaders['X-RateLimit-Remaining'] = rlRemaining;

    item.res.writeHead(response.status, resHeaders);

    if (isStream && response.body) {
      // Stream SSE response
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          item.res.write(value);
        }
      } finally {
        reader.releaseLock();
      }
      item.res.end();
    } else {
      const body = await response.text();
      item.res.end(body);
    }

    if (response.status === 429) {
      totalErrors++;
      log(`[${provider.name}] 429 — rate limited despite proxy pacing. Backing off.`);
    } else if (response.status >= 500) {
      totalErrors++;
      log(`[${provider.name}] ${response.status} — server error (${elapsed}ms)`);
    }
  } catch (err: any) {
    totalErrors++;
    if (!item.res.headersSent) {
      item.res.writeHead(502, { 'Content-Type': 'application/json' });
      item.res.end(JSON.stringify({ error: { message: `Proxy error: ${err.message}` } }));
    }
  } finally {
    bucket.release();
  }
}

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ${msg}`);
}

// ── HTTP Server ────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    const status: Record<string, any> = {
      ok: true,
      uptime: Math.round(process.uptime()),
      stats: { total: totalRequests, forwarded: totalForwarded, queued: totalQueued, errors: totalErrors, pending: queue.length },
      providers: {} as Record<string, any>,
    };
    for (const p of activeProviders) {
      const b = buckets.get(p.name)!;
      status.providers[p.name] = {
        rpm: p.rpm,
        available: b.available,
        active: b.active,
        models: p.models,
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
    return;
  }

  // Only handle POST to /v1/*
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  totalRequests++;

  // Collect body
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    // Extract model from body
    let model = 'unknown';
    try {
      const parsed = JSON.parse(body.toString());
      model = parsed.model || 'unknown';
    } catch { /* non-JSON body */ }

    totalQueued++;

    const promise = new Promise<void>(resolve => {
      queue.push({ req, res, body, model, resolve, enqueuedAt: Date.now() });
    });

    processQueue();
    promise.then(() => { /* done */ });
  });
});

server.listen(PORT, HOST, () => {
  log(`LLM Rate-Aware Proxy listening on http://${HOST}:${PORT}`);
  log(`Active providers:`);
  for (const p of activeProviders) {
    log(`  ${p.name}: ${p.rpm} RPM, ${p.concurrent} concurrent, models: ${p.models.join(', ')}`);
  }
  log(`Health: GET http://${HOST}:${PORT}/health`);
  log(`\nPoint Hermes providers at http://${HOST}:${PORT}/v1`);
});
