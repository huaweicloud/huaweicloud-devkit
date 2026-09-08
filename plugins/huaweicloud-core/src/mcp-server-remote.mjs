import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

import { dispatch } from './mcp-protocol.mjs';

export const DEFAULT_PORT = 9528;
export const DEFAULT_HOST = '127.0.0.1';

export async function startRemoteServer({ port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
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

    let message;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

    let response;
    try {
      const result = await dispatch(message.method, message.params || {});
      response = { jsonrpc: '2.0', id: message.id, result };
      if (message.method === 'initialize') {
        res.setHeader('MCP-Protocol-Version', result.protocolVersion || '2024-11-05');
      }
    } catch (error) {
      response = {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: error.message },
      };
    }

    writeMCPResponse(res, response, req.headers.accept || '');
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => resolvePromise());
  });

  const address = server.address();
  process.stdout.write(format('huaweicloud-devkit MCP server (remote) listening on %s:%s\n', host, address.port));

  return {
    server,
    port: address.port,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

function writeMCPResponse(res, response, accept) {
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
    process.stderr.write(`Failed to start MCP remote server: ${error.message}\n`);
    // eslint-disable-next-line n/no-process-exit -- fatal startup error in standalone CLI mode
    process.exit(1);
  });
}
