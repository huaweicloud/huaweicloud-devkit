import { stdin, stdout } from 'node:process';
import { platform } from 'node:os';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { runInitializeSideEffects, normalizeToolCallParams } from './mcp-protocol.ts';
import { detectAgent } from './telemetry/agent-detect.ts';
import { traceOutboundDisclosure } from './lib/call-trace.ts';

type JsonRpcRequest = { id?: unknown; method?: string; params?: unknown };
type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

interface StdioTransportOptions {
  initializeSideEffects?: typeof runInitializeSideEffects;
}

// LSP-style Content-Length frames and newline-delimited JSON on the same
// stream. The response framing echoes the client's: framed requests get
// framed responses, line requests get newline responses. Release smoke
// gates and the Hermes-on-Windows manual workaround both speak
// Content-Length, which the SDK StdioServerTransport does not.
export class DevkitStdioTransport implements Transport {
  onmessage?: (_message: JSONRPCMessage) => void;
  onerror?: (_error: Error) => void;
  onclose?: () => void;

  private buffer = Buffer.alloc(0);
  private useContentLengthFraming = true;
  private closed = false;

  // Keep the event loop alive after stdin is closed (Windows Hermes
  // workaround). Node exits when no active handles remain; the stdin 'data'
  // listener is the only handle. On Windows, Hermes may close the stdin pipe
  // after the initial handshake, causing the process to exit silently
  // (exit 0). For Hermes on Windows: arm a keepalive timer on stdin close
  // and only shut down when stdout also closes. For every other agent,
  // stdin close is the shutdown signal — exit cleanly so the host does not
  // see CLOSE_TIMEOUT.
  //
  // Close semantics vs the SDK lifecycle: Protocol.connect wraps onclose and
  // aborts in-flight handlers when it fires. Arming the keepalive must NOT
  // propagate onclose (that would tear the server down while Hermes still
  // expects it alive), and the non-Hermes exit path bypasses onclose by
  // design — process.exit(0) is the whole point. Only stdout close runs the
  // real onclose/cleanup path.
  private readonly needsKeepalive = detectAgent().harness === 'hermes' && platform() === 'win32';
  private keepAlive: NodeJS.Timeout | null = null;
  private readonly options: StdioTransportOptions;

  constructor(options: StdioTransportOptions = {}) {
    this.options = options;
  }

  async start(): Promise<void> {
    stdin.on('close', () => this.onStdinClose());
    stdin.on('end', () => this.onStdinClose());
    stdout.on('close', () => this.onStdoutClose());
    stdin.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.readFrames();
    });
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed) return;
    // Outbound-wire disclosure tracing (see lib/call-trace.ts contract):
    // tools/list results and tools/list_changed notifications only.
    traceOutboundDisclosure(message);
    const json = JSON.stringify(message);
    if (this.useContentLengthFraming) {
      stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    } else {
      stdout.write(json + '\n');
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
    this.onclose?.();
  }

  private onStdinClose(): void {
    if (this.keepAlive) return;
    if (this.needsKeepalive) {
      this.keepAlive = setInterval(() => {}, 60000);
    } else {
      process.exit(0);
    }
  }

  private onStdoutClose(): void {
    process.exitCode = 0;
    void this.close();
  }

  private readFrames(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        this.useContentLengthFraming = true;
        if (!this.parseContentLengthFrame(headerEnd)) return;
        continue;
      }

      // A frame header split across chunks: the buffer holds a prefix of the
      // Content-Length token but the terminator has not arrived. Wait for
      // more bytes; consuming the prefix as a JSON line would emit a
      // spurious -32700, flip framing to newline mode, and desync the
      // stream permanently. No valid JSON line starts with this token.
      const headerPrefix = 'Content-Length:';
      const head = this.buffer.toString('latin1', 0, headerPrefix.length);
      if (head !== '' && headerPrefix.startsWith(head)) return;

      const lf = this.buffer.indexOf('\n');
      if (lf !== -1) {
        this.useContentLengthFraming = false;
        const line = this.buffer.subarray(0, lf).toString('utf8').trim();
        this.buffer = this.buffer.subarray(lf + 1);
        if (line) {
          try {
            void this.handleMessage(JSON.parse(line));
          } catch {
            this.writeParseError();
          }
        }
        continue;
      }

      return;
    }
  }

  private parseContentLengthFrame(headerEnd: number): boolean {
    const header = this.buffer.subarray(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      this.buffer = Buffer.alloc(0);
      return true;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (this.buffer.length < bodyEnd) return false;
    const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8');
    this.buffer = this.buffer.subarray(bodyEnd);
    try {
      void this.handleMessage(JSON.parse(body));
    } catch {
      this.writeParseError();
    }
    return true;
  }

  private async handleMessage(raw: unknown): Promise<void> {
    // Valid JSON that is not an object (null / array / string) is an invalid
    // request per JSON-RPC 2.0 — reply -32600 rather than silently dropping it.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      this.writeJsonRpcError(-32600, 'Invalid Request');
      return;
    }
    const message = raw as JsonRpcRequest;

    if (message.method === 'initialize') {
      try {
        await (this.options.initializeSideEffects ?? runInitializeSideEffects)(message.params);
      } catch {
        // best-effort: initialize side effects must not fail the handshake
      }
    }

    if (!Object.hasOwn(message, 'id')) {
      // Notifications (incl. notifications/initialized) carry no response.
      if (message.method && message.method.startsWith('notifications/')) {
        this.onmessage?.(raw as JSONRPCMessage);
      }
      return;
    }

    // An id-bearing message without a method is malformed: the SDK's
    // onmessage would silently drop it and the client would hang. Reply
    // -32601 echoing the request id so the failure is correlatable, matching
    // the legacy behavior.
    if (typeof message.method !== 'string' || !message.method) {
      this.writeJsonRpcError(-32601, 'Method not found: undefined', message.id);
      return;
    }

    this.onmessage?.(normalizeToolCallParams(raw as JSONRPCMessage));
  }

  private writeMessage(message: JsonRpcResponse): void {
    void this.send(message as unknown as JSONRPCMessage);
  }

  private writeJsonRpcError(code: number, message: string, id: unknown = null): void {
    this.writeMessage({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }

  private writeParseError(): void {
    this.writeJsonRpcError(-32700, 'Parse error');
  }
}
