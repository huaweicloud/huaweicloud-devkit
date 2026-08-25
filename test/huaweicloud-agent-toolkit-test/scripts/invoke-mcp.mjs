// Driver for huaweicloud-devkit MCP server (plugin's own code path).
// Usage: node invoke-mcp.mjs <toolName> '<jsonArgs>'
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MCP = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'plugins',
  'huaweicloud-core',
  'src',
  'mcp-server.mjs',
);
const toolName = process.argv[2];
const args = JSON.parse(process.argv[3] || '{}');

const child = spawn('node', [MCP], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = Buffer.alloc(0);
let seq = 1;

const send = (method, params = {}) => {
  const msg = JSON.stringify({ jsonrpc: '2.0', id: seq++, method, params });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
};

child.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (true) {
    const i = buf.indexOf('\r\n\r\n');
    if (i === -1) return;
    const header = buf.subarray(0, i).toString('utf8');
    const len = Number(header.match(/Content-Length: (\d+)/i)?.[1]);
    if (!len) {
      buf = buf.subarray(i + 4);
      continue;
    }
    if (buf.length < i + 4 + len) return;
    const body = buf.subarray(i + 4, i + 4 + len).toString('utf8');
    buf = buf.subarray(i + 4 + len);
    const msg = JSON.parse(body);
    if (msg.id === 1) {
      send('tools/call', { name: toolName, arguments: args });
    } else {
      console.log(JSON.stringify(msg.result ?? msg.error, null, 2));
      child.kill();
      process.exit(0);
    }
  }
});

send('initialize', { protocolVersion: '2024-11-05' });
setTimeout(() => {
  console.error('TIMEOUT');
  process.exit(1);
}, 240000);
