#!/usr/bin/env node
// Lane driver for the v2-pack program's live lanes. Spawns the real
// dist/mcp-server.js over stdio, speaks MCP JSON-RPC in both framings the
// DevkitStdioTransport accepts (Content-Length and newline), and writes the
// full round-trip transcript to a JSON file. Exit code carries the verdict.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const serverEntry = resolve(root, 'plugins', 'huaweicloud-core', 'dist', 'mcp-server.js');

function frame(message, framing) {
  const json = JSON.stringify(message);
  return framing === 'content-length'
    ? `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`
    : json + '\n';
}

// The transport answers with Content-Length frames; accept bare newline JSON
// as well so both server-side framing code paths are tolerated on read.
// Decoding is byte-accurate: Content-Length counts bytes, and tool payloads
// contain multibyte UTF-8, so string indexing would misjudge frame completeness.
function makeDecoder(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      const headerAt = buffer.indexOf('Content-Length:');
      if (headerAt === -1) {
        const nl = buffer.indexOf(0x0a);
        if (nl === -1) return;
        const line = buffer.slice(0, nl).toString('utf8').trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          try {
            onMessage(JSON.parse(line));
          } catch {
            // skip a non-JSON line so the decoder keeps draining stdout
          }
        }
        continue;
      }
      const sep = buffer.indexOf('\r\n\r\n', headerAt);
      if (sep === -1) return;
      const header = buffer.slice(headerAt, sep).toString('utf8');
      const len = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      if (!Number.isFinite(len)) {
        buffer = buffer.slice(sep + 4);
        continue;
      }
      if (buffer.length < sep + 4 + len) return;
      const body = buffer.slice(sep + 4, sep + 4 + len).toString('utf8');
      buffer = buffer.slice(sep + 4 + len);
      try {
        onMessage(JSON.parse(body));
      } catch {
        // skip a malformed frame so the decoder keeps draining stdout
      }
    }
  };
}

export async function probe({
  out,
  env = {},
  calls = [],
  framing = 'content-length',
  settleMs = 1200,
  splitWrite = false,
  serverEntry: serverEntryOverride,
  cwd,
}) {
  const DEBUG = process.env.PROBE_DEBUG === '1';
  const log = (...a) => DEBUG && console.error('[probe]', ...a);
  log('start', {
    out,
    calls: calls.length,
    framing,
    serverEntry: serverEntryOverride ?? 'default',
    cwd: cwd ?? 'default',
  });
  mkdirSync(dirname(out), { recursive: true });
  // serverEntry/cwd overrides let a lane drive an installed server (temp HOME
  // install dir) instead of the repo build; omitted values keep the default.
  const entry = serverEntryOverride ? resolve(serverEntryOverride) : serverEntry;
  const child = spawn(process.execPath, [entry], {
    cwd: cwd ? resolve(cwd) : root,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const transcript = { framing, sent: [], received: [], stderr: [], exited: null };
  let seq = 0;
  const nextId = () => ++seq;
  const pending = new Map();
  let drain;

  const decoder = makeDecoder((message) => {
    log('decoded', message.method ?? 'response', 'id', message.id);
    // `t` timestamps every transcript message (performance.now() origin) so
    // perf lanes can measure round-trips; a new field, existing assertions
    // on method/id/params keep working unchanged.
    transcript.received.push({ ...message, t: performance.now() });
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  child.stdout.on('data', decoder);
  child.stderr.on('data', (chunk) => transcript.stderr.push(chunk.toString('utf8')));
  child.on('exit', (code) => {
    transcript.exited = code;
    drain?.();
  });

  const send = (message) => {
    const wire = frame(message, framing);
    transcript.sent.push({ ...message, t: performance.now() });
    if (splitWrite && wire.length > 8) {
      // Half-open write: the first chunk lands without the frame terminator,
      // so the server must buffer and reassemble before responding.
      const cut = Math.floor(wire.length / 2);
      child.stdin.write(wire.slice(0, cut));
      setTimeout(() => child.stdin.write(wire.slice(cut)), 150);
    } else {
      child.stdin.write(wire);
    }
    return new Promise((res) => {
      if (message.id !== undefined) pending.set(message.id, res);
      else res();
    });
  };

  const results = {};
  try {
    log('sending initialize');
    results.initialize = await send({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-probe', version: '0' } },
      id: nextId(),
    });
    log('initialize done', !!results.initialize, 'exited', transcript.exited);
    if (results.initialize && !transcript.exited) {
      child.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }, framing));
      log('sending tools/list');
      results.toolsList = await send({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: nextId() });
      log('toolsList done');
      for (const call of calls) {
        log('sending call', call.name);
        results[call.name] = await send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: call.name, arguments: call.args ?? {} },
          id: nextId(),
        });
        log('call done', call.name);
      }
    }
  } catch {
    // a mid-session RPC failure still writes the transcript; the verdict checks which responses arrived
  }

  await new Promise((res) => {
    const timer = setTimeout(res, settleMs);
    drain = () => {
      clearTimeout(timer);
      res();
    };
  });
  child.kill('SIGKILL');
  writeFileSync(out, JSON.stringify({ ...transcript, results }, null, 2));
  return { transcript, results, child };
}

// CLI mode: node scripts/mcp-probe.mjs <out.json> [--framing nl] [--call name=json]...
// pathToFileURL, not `new URL('file://' + argv[1])`: the string form never
// matches import.meta.url on Windows (backslash, drive-letter paths), which
// would silently turn this CLI mode into a no-op there.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const out = args[0] ?? '/tmp/opencode/probe-transcript.json';
  const framing =
    args.includes('--framing') && args[args.indexOf('--framing') + 1] === 'nl' ? 'newline' : 'content-length';
  const splitWrite = args.includes('--split');
  const serverOverride = args.includes('--server') ? args[args.indexOf('--server') + 1] : undefined;
  const cwdArg = args.includes('--cwd') ? args[args.indexOf('--cwd') + 1] : undefined;
  const calls = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--call') continue;
    const [name, rawArgs] = args[i + 1].split('=');
    calls.push({ name, args: rawArgs ? JSON.parse(rawArgs) : {} });
    i++;
  }
  const { results, transcript } = await probe({
    out,
    calls,
    framing,
    splitWrite,
    serverEntry: serverOverride,
    cwd: cwdArg,
  });
  const toolCount = results.toolsList?.result?.tools?.length;
  const callOk = calls.every((c) => results[c.name] !== undefined);
  const pass = Number.isSafeInteger(toolCount) && toolCount > 0 && callOk;
  console.error(
    JSON.stringify({ out, framing, toolCount, calls: calls.map((c) => c.name), callOk, exited: transcript.exited }),
  );
  process.exit(pass ? 0 : 1);
}
