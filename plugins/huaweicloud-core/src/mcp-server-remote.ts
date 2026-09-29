import { createServer, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

import { dispatch } from './mcp-protocol.ts';

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

interface JsonRpcMessage {
  id?: unknown;
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// method is coerced to string exactly as the original interpolation did: a
// missing method becomes "undefined", which dispatch then rejects as unknown.
// `id` is only copied when the source actually had one, so notification
// detection via Object.hasOwn(message, 'id') stays accurate.
function toJsonRpcMessage(value: unknown): JsonRpcMessage {
  const record = asRecord(value);
  const message: JsonRpcMessage = {
    method: typeof record.method === 'string' ? record.method : String(record.method),
    params: record.params,
  };
  if (Object.hasOwn(record, 'id')) message.id = record.id;
  return message;
}

export async function startRemoteServer({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
}: RemoteServerOptions = {}): Promise<StartedRemoteServer> {
  const server = createServer(async (req, res) => {
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

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, OPTIONS' });
      res.end();
      return;
    }

    let message: JsonRpcMessage;
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      message = toJsonRpcMessage(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    if (!Object.hasOwn(message, 'id')) {
      // 通知类消息（含 notifications/initialized）无需响应体，HTTP 层直接 202。
      res.writeHead(202);
      res.end();
      return;
    }

    let response: JsonRpcResponse;
    try {
      const headerValue = req.headers['mcp-session-id'];
      const sessionId = (typeof headerValue === 'string' ? headerValue : '').trim() || 'default';
      const result = await dispatch(message.method, message.params || {}, { sessionId });
      response = { jsonrpc: '2.0', id: message.id, result };
      if (message.method === 'initialize') {
        const resultRecord = asRecord(result);
        const protocolVersion =
          typeof resultRecord.protocolVersion === 'string' ? resultRecord.protocolVersion : '2024-11-05';
        res.setHeader('MCP-Protocol-Version', protocolVersion);
      }
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      response = {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: Number.isSafeInteger(code) ? (code as number) : -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    writeMCPResponse(res, response, req.headers.accept || '');
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

function writeMCPResponse(res: ServerResponse, response: JsonRpcResponse, accept: string): void {
  const json = JSON.stringify(response);
  if (accept.includes('application/json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(json);
    return;
  }
  // 客户端只接受 SSE 时的兜底：单帧 event 后关闭流。
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(`event: message\ndata: ${json}\n\n`);
  res.end();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const portIdx = process.argv.indexOf('--port');
  const port = portIdx > -1 ? Number(process.argv[portIdx + 1]) : DEFAULT_PORT;
  const hostIdx = process.argv.indexOf('--host');
  const host = hostIdx > -1 && process.argv[hostIdx + 1] ? process.argv[hostIdx + 1] : DEFAULT_HOST;
  startRemoteServer({ port, host }).catch((error) => {
    process.stderr.write(
      `Failed to start MCP remote server: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    // eslint-disable-next-line n/no-process-exit -- fatal startup error in standalone CLI mode
    process.exit(1);
  });
}
