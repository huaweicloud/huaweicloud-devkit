// Local hwlink ws-exec fake. Speaks the product's binary protocol via the
// PRODUCT's own packet codec (hwlink-packet.ts — vendored upstream ISC code,
// byte-pinned by test/ws-exec-protocol.test.ts) and the product's marker
// vocabulary (fake-shell.ts). Per-connection byte-stream reassembly (the
// client chunks sends at MAX_SEND_CHUNK_SIZE - FIXED_HEADER_LEN = 8172
// bytes; a 60KB upload line arrives as ~8 ws messages), blob dispatch on
// the done-marker terminator, chunked sends back. The client connects with
// subprotocol 'devenv' (Node's global WebSocket FAILS the handshake if the
// server does not echo it) — handleProtocols selects it.
//
// Recording channel: every connection (source, username, per-command
// intents, close kind) — the ws expectation surface. 'unknown' intents are
// recorded distinctly so cases can gate zero-unknown (fake drift = red).
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  FIXED_HEADER_LEN,
  MAX_SEND_CHUNK_SIZE,
  OpCode,
  createPacket,
  parsePacket,
  type HwlinkPacket,
} from '../../../plugins/huaweicloud-core/src/ws-exec/hwlink-packet.ts';
import {
  FakeFs,
  READY_PREFIX,
  doneMarkerFor,
  extractDoneNonce,
  extractReadyNonce,
  isDoneCommandLine,
  readyMarkerFor,
  runShellCommand,
} from './fake-shell.ts';

export interface WsCommandRecording {
  intent: string;
  exitCode: number;
}

export interface WsConnectionRecording {
  source: number | null;
  username: string | null;
  commands: WsCommandRecording[];
  close: 'graceful' | 'abrupt' | null;
}

const SEND_CHUNK = MAX_SEND_CHUNK_SIZE - FIXED_HEADER_LEN;

interface ParsedHttp {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer | null;
  consumed: number;
}

// Minimal HTTP request parser over the tunnel byte stream: complete
// head + (Content-Length) body or nothing (partial stays buffered).
function tryParseHttp(buffer: Buffer): ParsedHttp | null {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;
  const head = buffer.subarray(0, headerEnd).toString('utf8');
  const lines = head.split('\r\n');
  const requestLine = lines[0] ?? '';
  const [method, path] = requestLine.split(' ');
  if (!method || !path) return null;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const contentLength = Number(headers['content-length'] ?? '0');
  const total = headerEnd + 4 + contentLength;
  if (buffer.length < total) return null;
  return {
    method,
    path,
    headers,
    body: contentLength > 0 ? Buffer.from(buffer.subarray(headerEnd + 4, total)) : null,
    consumed: total,
  };
}

interface ConnState {
  recording: WsConnectionRecording;
  socket: WebSocket;
  // Byte-stream accumulator: command blobs are terminated by the client's
  // done line, NEVER by ws-message boundaries (60KB single-line commands
  // arrive as ~8 packets).
  input: string;
  readyNonce: string | null;
  // The terminal channel's identifier from the client's 0xfb open — the
  // client's mux routes incoming packets BY IDENTIFIER, so responses must
  // echo it (an identifier-0 reply is silently dropped).
  identifier: number | null;
  // Tunnel sub-connections (tunnel sessions never open a terminal):
  // identifier → HTTP-over-stream state for the in-fake file server.
  tunnels: Map<number, { buffer: Buffer }>;
}

export class WsFake {
  readonly connections: WsConnectionRecording[] = [];
  // ONE fake machine: terminal sessions and tunnel sessions share the
  // filesystem and the process table — deployFileServer runs on the
  // terminal session, the tunnel connects from another ws connection.
  private readonly fs = new FakeFs();
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;

  async start(): Promise<void> {
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({ server, handleProtocols: () => 'devenv' });
    wss.on('connection', (socket, req) => this.handleConnection(socket, req));
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.wss = wss;
    this.port = (server.address() as { port: number }).port;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/hwlink`;
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    const server = this.server;
    if (!wss || !server) return;
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.wss = null;
    this.server = null;
  }

  private handleConnection(socket: WebSocket, req: import('node:http').IncomingMessage): void {
    const source = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('source');
    const recording: WsConnectionRecording = {
      source: source !== null && /^\d+$/.test(source) ? Number(source) : null,
      username: null,
      commands: [],
      close: null,
    };
    this.connections.push(recording);
    const state: ConnState = {
      recording,
      socket,
      input: '',
      readyNonce: null,
      identifier: null,
      tunnels: new Map(),
    };
    socket.on('message', (data) => {
      try {
        this.handlePacket(state, parsePacket(data as Uint8Array));
      } catch {
        // A malformed frame is a protocol bug worth surfacing as an unknown
        // command, not a server crash.
        recording.commands.push({ intent: 'unknown', exitCode: -1 });
      }
    });
    socket.on('close', (code) => {
      recording.close = code === 1000 ? 'graceful' : 'abrupt';
    });
    socket.on('error', () => {
      recording.close = recording.close ?? 'abrupt';
    });
  }

  private handlePacket(state: ConnState, packet: HwlinkPacket): void {
    const op = packet.operation;
    if (op === OpCode.OpNewCmdTerminal) {
      // Fire-and-forget terminal open: payload is the username; the
      // identifier is the channel address every reply must carry.
      state.identifier = packet.identifier;
      state.recording.username = new TextDecoder().decode(packet.data ?? new Uint8Array(0));
      return;
    }
    if (op === OpCode.OpCmdTerminalResize || op === OpCode.OpCmdTerminalInit) {
      // Resize (sent when the client has initial cols/rows) and the init
      // ack are transport plumbing — silently ignored, never recorded.
      return;
    }
    // --- tunnel ops (tunnel sessions carry no terminal channel) ---
    if (op === OpCode.OpCreateTcpTunnel) {
      this.handleTunnelCreate(state, packet);
      return;
    }
    if (op === OpCode.OpDisconnect) {
      state.tunnels.delete(packet.identifier);
      return;
    }
    if ((op & 0xff) === OpCode.OpTcpTunnelData) {
      this.handleTunnelData(state, packet);
      return;
    }
    const isTerminalData =
      op === OpCode.OpCmdTerminalData || op === (OpCode.OpSubStreamPong | OpCode.OpCmdTerminalData);
    if (!isTerminalData) {
      // Anything else is unexpected at this layer — record it visibly.
      state.recording.commands.push({ intent: `op:0x${op.toString(16)}`, exitCode: 0 });
      return;
    }
    state.input += new TextDecoder().decode(packet.data ?? new Uint8Array(0));
    this.drainBuffer(state);
  }

  // Tunnel relay with a bounded surface: only ports the fake shell has
  // "listened" on (a start-fileserver intent) are connectable — dstPort is
  // agent-influenced input, and an unbounded relay would connect the fake
  // to arbitrary local ports (an SSRF-shaped hole inside the harness).
  private handleTunnelCreate(state: ConnState, packet: HwlinkPacket): void {
    if (!this.fs.servicePorts.has(packet.dstPort)) {
      this.sendRaw(
        state,
        createPacket({
          operation: 0x0e << 24,
          identifier: packet.identifier,
          source: packet.source,
          payload: new Uint8Array(0),
        }),
      );
      return;
    }
    state.tunnels.set(packet.identifier, { buffer: Buffer.alloc(0) });
    this.sendRaw(
      state,
      createPacket({
        operation: OpCode.OpTunnelSuccess,
        identifier: packet.identifier,
        source: packet.source,
        payload: new Uint8Array(0),
      }),
    );
  }

  private handleTunnelData(state: ConnState, packet: HwlinkPacket): void {
    const tunnel = state.tunnels.get(packet.identifier);
    if (!tunnel) return;
    tunnel.buffer = Buffer.concat([tunnel.buffer, Buffer.from(packet.data ?? new Uint8Array(0))]);
    // HTTP-over-stream: answer complete requests; keep partial ones
    // buffered (the client chunks tunnel data too).
    while (true) {
      const request = tryParseHttp(tunnel.buffer);
      if (!request) return;
      tunnel.buffer = tunnel.buffer.subarray(request.consumed);
      const response = this.answerFileServer(state, request);
      this.sendRaw(
        state,
        createPacket({
          operation: OpCode.OpTcpTunnelData,
          identifier: packet.identifier,
          source: packet.source,
          payload: response,
        }),
      );
    }
  }

  // The in-fake file server (the sandbox-file-server.py stand-in): /health
  // answers raw 200 OK; /upload lands the archive in the fake fs and
  // answers the JSON the product consumes (bytes + md5 over the RECEIVED
  // bytes — a corruption anywhere in the tunnel chain mismatches the
  // product's local hash and it throws).
  private answerFileServer(state: ConnState, request: ParsedHttp): Buffer {
    if (request.method === 'GET' && request.path === '/health') {
      state.recording.commands.push({ intent: 'tunnel:health', exitCode: 0 });
      return Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    }
    if (request.method === 'POST' && request.path === '/upload') {
      state.recording.commands.push({ intent: 'tunnel:upload', exitCode: 0 });
      const targetPath = request.headers['x-target-path'] ?? '/tmp/upload.bin';
      const body = request.body ?? Buffer.alloc(0);
      this.fs.write(targetPath, body);
      const md5 = createHash('md5').update(body).digest('hex');
      const json = JSON.stringify({ ok: true, path: targetPath, bytes: body.length, md5 });
      return Buffer.concat([
        Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${json.length}\r\n\r\n`),
        Buffer.from(json),
      ]);
    }
    const notFound = JSON.stringify({ ok: false, error: 'not found' });
    return Buffer.concat([
      Buffer.from(`HTTP/1.1 404 Not Found\r\nContent-Length: ${notFound.length}\r\n\r\n`),
      Buffer.from(notFound),
    ]);
  }

  private sendRaw(state: ConnState, frame: Uint8Array): void {
    state.socket.send(Buffer.from(frame));
  }

  private drainBuffer(state: ConnState): void {
    // 1. Ready handshake: the client sends its ready command and waits for
    //    its own nonce echoed back (a fake-emitted nonce never completes it).
    if (!state.readyNonce) {
      const idx = state.input.indexOf(READY_PREFIX);
      if (idx === -1) return;
      const lineEnd = state.input.indexOf('\n', idx);
      if (lineEnd === -1) return; // partial line: wait for more bytes
      const nonce = extractReadyNonce(state.input.slice(0, lineEnd));
      if (!nonce) return;
      state.readyNonce = nonce;
      state.input = state.input.slice(lineEnd + 1);
      this.sendTerminalData(state, readyMarkerFor(nonce));
    }
    // 2. Command blobs, each terminated by the done line.
    while (state.readyNonce) {
      const doneIdx = state.input.indexOf('__ws_exec_rc=$?');
      if (doneIdx === -1) return;
      const lineEnd = state.input.indexOf('\n', doneIdx);
      if (lineEnd === -1) return; // partial done line: wait
      const blob = state.input.slice(0, doneIdx);
      const doneLine = state.input.slice(doneIdx, lineEnd);
      state.input = state.input.slice(lineEnd + 1);
      if (!isDoneCommandLine(doneLine)) continue;
      const nonce = extractDoneNonce(doneLine) ?? state.readyNonce;
      const result = runShellCommand(blob, this.fs);
      state.recording.commands.push({ intent: result.intent, exitCode: result.exitCode });
      this.sendTerminalData(state, result.stdout + doneMarkerFor(nonce, result.exitCode));
    }
  }

  private sendTerminalData(state: ConnState, text: string): void {
    const bytes = new TextEncoder().encode(text);
    for (let offset = 0; offset < bytes.length; offset += SEND_CHUNK) {
      const chunk = bytes.subarray(offset, Math.min(offset + SEND_CHUNK, bytes.length));
      const frame = createPacket({
        operation: OpCode.OpCmdTerminalData,
        identifier: state.identifier ?? 0,
        source: state.recording.source ?? 0,
        payload: chunk,
      });
      state.socket.send(Buffer.from(frame));
    }
  }
}
