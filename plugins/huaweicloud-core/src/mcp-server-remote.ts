import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { format } from 'node:util';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createDevkitMcpServer, runInitializeSideEffects, normalizeToolCallParams } from './mcp-protocol.ts';

export const DEFAULT_PORT = 9528;
export const DEFAULT_HOST = '127.0.0.1';

interface RemoteServerOptions {
  port?: number;
  host?: string;
}

interface StartedRemoteServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function startRemoteServer({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
}: RemoteServerOptions = {}): Promise<StartedRemoteServer> {
  // node:http wants a void-returning listener; the async request handling
  // lives in handleRemoteRequest and every failure path inside it answers
  // the response (400/202/500) rather than rejecting.
  const server = createServer((req, res) => {
    void handleRemoteRequest(req, res);
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => resolvePromise());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('remote server did not bind a TCP address');
  }
  process.stdout.write(format('huaweicloud-devkit MCP server (remote) listening on %s:%s\n', host, address.port));

  return {
    server,
    port: address.port,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

async function handleRemoteRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Accept, Authorization',
  );
  res.setHeader('Access-Control-Expose-Headers', 'MCP-Protocol-Version, Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // The shell keeps the method filter: GET stays 405 (legacy contract; the
  // SDK transport would turn it into a 406/200 SSE stream) and only POST
  // reaches the transport.
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST, OPTIONS' });
    res.end();
    return;
  }

  let message: unknown;
  try {
    const chunks: Uint8Array[] = [];
    // Readable's async iterator is typed to yield `any` in @types/node; the
    // body chunks are Buffers, so the local types the boundary.
    const reqBody: AsyncIterable<Uint8Array> = req;
    for await (const chunk of reqBody) chunks.push(chunk);
    message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }

  // Notifications (incl. notifications/initialized) get no response body;
  // the stateless transport would 202 them, but skipping construction
  // entirely is cheaper and preserves the 202 status contract.
  if (message !== null && typeof message === 'object' && !Array.isArray(message) && !Object.hasOwn(message, 'id')) {
    res.writeHead(202);
    res.end();
    return;
  }

  if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
    const record = message as Record<string, unknown>;
    if (record.method === 'initialize') {
      try {
        await runInitializeSideEffects(record.params);
      } catch {
        // best-effort: initialize side effects must not fail the request
      }
    }
  }

  const sessionId =
    (typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : '').trim() || 'default';

  // The shell owns the request headers. undici's fetch stamps a default
  // `text/plain;charset=UTF-8` on bodies sent without a Content-Type, and
  // the SDK would 415 them; the legacy shell accepted bare `curl -d`
  // bodies. Normalize the undici default back to JSON; explicit
  // non-default types still 415. enableJsonResponse keeps successful
  // responses as JSON bodies for dual-Accept clients; Accept headers
  // lacking either application/json or text/event-stream are rejected 406
  // by the transport.
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) continue;
    if (value !== undefined) headers.set(name, value);
  }
  const rawContentType = headers.get('content-type');
  if (!rawContentType || /^text\/plain\b/i.test(rawContentType)) {
    headers.set('content-type', 'application/json');
  }
  headers.set('accept', req.headers.accept || 'application/json, text/event-stream');

  const webRequest = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  transport.onerror = (error) => {
    process.stderr.write(`remote transport error: ${error.message}\n`);
  };

  // Server construction happens inside the try because it can throw
  // (resolveEnabledPacks fail-fasts on unknown DEVKIT_PACKS ids): each
  // request must answer 500 instead of leaving the rejection unhandled and
  // crashing the listener.
  let mcpServer: McpServer | undefined;
  try {
    mcpServer = createDevkitMcpServer({ sessionId, remoteSurface: true });
    await mcpServer.connect(transport);
    const response = await transport.handleRequest(webRequest, {
      parsedBody: normalizeToolCallParams(message as JSONRPCMessage),
    });
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk);
    }
    res.end();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: Number.isSafeInteger(code) ? (code as number) : -32603, message: String(error) },
        }),
      );
    }
  } finally {
    await mcpServer?.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}
