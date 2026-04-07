/**
 * Brain MCP HTTP/SSE Transport
 *
 * Adds HTTP endpoints alongside the stdio transport:
 * - POST/GET/DELETE /mcp — MCP Streamable HTTP protocol
 * - GET /sse/events — Server-Sent Events for real-time dashboard updates
 * - GET /api/* — REST endpoints for dashboard reads
 * - GET /health — Health check
 *
 * Zero new dependencies — uses Express 5 and StreamableHTTPServerTransport
 * from the MCP SDK (already transitive deps).
 */

import { randomUUID } from 'node:crypto';
import type { BrainDB } from './db.js';

// Dynamic imports to avoid breaking stdio-only mode if deps are missing
async function loadDeps() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  let createApp: (opts?: any) => any;
  const mod = await import('@modelcontextprotocol/sdk/server/express.js');
  createApp = mod.createMcpExpressApp;
  return { McpServer, StreamableHTTPServerTransport, createApp };
}

interface HttpSession {
  transport: InstanceType<any>;
  server: InstanceType<any>;
  createdAt: number;
}

export async function startHttpServer(
  db: BrainDB,
  room: string,
  port: number,
  host = '127.0.0.1',
): Promise<void> {
  const { McpServer, StreamableHTTPServerTransport, createApp } = await loadDeps();

  const app = createApp({ host });
  const sessions = new Map<string, HttpSession>();

  // ── MCP Streamable HTTP endpoint ────────────────────────────────────────

  app.post('/mcp', async (req: any, res: any) => {
    try {
      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      // New session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, { transport, server, createdAt: Date.now() });
        },
      });

      const server = new McpServer(
        { name: 'brain-http', version: '1.0.0' },
        { instructions: 'Brain MCP via HTTP transport.' },
      );

      // Register a minimal set of tools for HTTP sessions
      // (tools are registered on the server instance — import registerAllTools when extracted)
      // For now, connect and handle
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });

  app.get('/mcp', async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
    } else {
      res.status(400).json({ error: 'Missing or invalid session ID' });
    }
  });

  app.delete('/mcp', async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      try { await session.transport.close(); } catch { /* best effort */ }
      sessions.delete(sessionId);
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // ── SSE Events endpoint ─────────────────────────────────────────────────

  app.get('/sse/events', (req: any, res: any) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sendEvent = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Forward DB events to SSE
    const onMessage = (data: any) => sendEvent('message', data);
    const onPulse = (data: any) => sendEvent('pulse', data);
    const onMemory = (data: any) => sendEvent('memory', data);
    const onMetric = (data: any) => sendEvent('metric', data);

    db.events.on('message', onMessage);
    db.events.on('pulse', onPulse);
    db.events.on('memory', onMemory);
    db.events.on('metric', onMetric);

    // Heartbeat every 30s
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30000);

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      db.events.off('message', onMessage);
      db.events.off('pulse', onPulse);
      db.events.off('memory', onMemory);
      db.events.off('metric', onMetric);
    });
  });

  // ── REST API endpoints (read-only, for dashboards) ──────────────────────

  app.get('/api/sessions', (_req: any, res: any) => {
    res.json(db.getSessions(room));
  });

  app.get('/api/agents', (_req: any, res: any) => {
    res.json(db.getAgentHealth(room));
  });

  app.get('/api/messages/:channel', (req: any, res: any) => {
    const sinceId = req.query.since_id ? Number(req.query.since_id) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(db.getMessages(req.params.channel, room, sinceId, limit));
  });

  app.get('/api/memory', async (req: any, res: any) => {
    const query = req.query.query as string | undefined;
    const category = req.query.category as string | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const results = await db.recallMemory(room, query, category, limit);
    res.json(results);
  });

  app.get('/api/metrics', (_req: any, res: any) => {
    const agentName = _req.query.agent as string | undefined;
    if (agentName) {
      res.json(db.getMetrics(room, agentName));
    } else {
      res.json(db.getMetricsSummary(room));
    }
  });

  app.get('/api/plan/:planId', (req: any, res: any) => {
    res.json(db.getPlanStatus(room, req.params.planId));
  });

  // ── Health check ────────────────────────────────────────────────────────

  app.get('/health', (_req: any, res: any) => {
    res.json({
      ok: true,
      sessions: sessions.size,
      room,
      uptime: Math.round(process.uptime()),
    });
  });

  // ── Start ───────────────────────────────────────────────────────────────

  app.listen(port, host, () => {
    console.error(`[brain-mcp] HTTP server listening on http://${host}:${port}`);
    console.error(`[brain-mcp]   MCP endpoint: POST/GET/DELETE /mcp`);
    console.error(`[brain-mcp]   SSE events:   GET /sse/events`);
    console.error(`[brain-mcp]   REST API:     GET /api/{sessions,agents,messages,memory,metrics,plan}`);
    console.error(`[brain-mcp]   Health:       GET /health`);
  });
}
