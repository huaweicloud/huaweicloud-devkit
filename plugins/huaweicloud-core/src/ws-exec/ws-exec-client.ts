import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

const DEFAULT_URL = 'ws://127.0.0.1:8080';
const DEFAULT_TIMEOUT_MS = 30000;

type WsListener = (..._args: unknown[]) => void;

interface WebSocketLike {
  send: (_data: string) => unknown;
  close: () => void;
  addEventListener: (_event: string, _handler: WsListener) => void;
}

type WebSocketConstructor = new (_url: string) => WebSocketLike;

interface MessageEventLike {
  data: unknown;
}

interface ArrayBufferProvider {
  arrayBuffer: () => Promise<ArrayBuffer>;
}

interface Markers {
  nonce: string;
  readyPrefix: string;
  donePrefix: string;
  readySuffix: string;
  doneSuffix: string;
  readyMarker: string;
  doneMarker: string;
}

interface ExecResult {
  stdout: string;
  exitCode: number;
  url: string;
  command: string;
}

interface ShellSessionOptions {
  url?: string;
  timeoutMs?: number;
  WebSocketImpl?: WebSocketConstructor;
  onFrame?: (_chunk: string) => void;
}

interface ExecuteCommandOptions extends ShellSessionOptions {
  command?: string;
}

interface ExecOptions {
  timeoutMs?: number;
}

interface CleanCommandOutputOptions {
  inputEchoed: boolean;
  command: string;
  doneCommand: string;
}

interface PendingExec {
  buffer: string;
  command: string;
  doneCommand: string;
  markers: Markers;
  reject: (_error: unknown) => void;
  resolve: (_result: ExecResult) => void;
  timeout: NodeJS.Timeout;
}

class WebSocketExecError extends Error {
  exitCode: number;

  constructor(message: string, exitCode: number, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WebSocketExecError';
    this.exitCode = exitCode;
    Object.assign(this, details);
  }
}

function hasArrayBuffer(value: unknown): value is ArrayBufferProvider {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  return 'arrayBuffer' in value && typeof value.arrayBuffer === 'function';
}

function isMessageEvent(value: unknown): value is MessageEventLike {
  return typeof value === 'object' && value !== null && 'data' in value;
}

async function eventDataToString(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (hasArrayBuffer(data)) {
    return Buffer.from(await data.arrayBuffer()).toString('utf8');
  }
  return String(data);
}

function sendLine(ws: WebSocketLike, line: string): void {
  ws.send(`${line}\n`);
}

function closeQuietly(ws: WebSocketLike): void {
  try {
    ws.close();
  } catch {
    // The caller is already settling the operation; close errors are not useful.
  }
}

function stripEchoedLine(text: string, line: string, options: { allowAttached?: boolean } = {}): string {
  if (text.startsWith(line)) {
    text = text.slice(line.length);
    text = text.replace(/^\r?\n/, '');
    if (!options.allowAttached) return text;
  }

  for (const nl of ['\r\n', '\n']) {
    const idx = text.indexOf(nl + line);
    if (idx !== -1) {
      const before = text.slice(0, idx + nl.length);
      const after = text.slice(idx + nl.length + line.length);
      text = before + after.replace(/^\r?\n/, '');
      if (!options.allowAttached) return text;
      break;
    }
  }

  if (options.allowAttached) {
    for (let trail = 2; trail >= 0; trail--) {
      for (const nl of ['\r\n', '\n']) {
        const suffix = nl.repeat(trail);
        if (text.endsWith(line + suffix)) {
          return text.slice(0, text.length - line.length - suffix.length);
        }
      }
    }
  }

  return text;
}

function buildMarkers(nonce: string = randomBytes(8).toString('hex')): Markers {
  const readyPrefix = '__WS_EXEC_READY_';
  const donePrefix = '__WS_EXEC_DONE_';
  const readySuffix = `${nonce}__`;
  const doneSuffix = `${nonce}__:`;
  const readyMarker = `${readyPrefix}${readySuffix}`;
  const doneMarker = `${donePrefix}${doneSuffix}`;

  return {
    nonce,
    readyPrefix,
    donePrefix,
    readySuffix,
    doneSuffix,
    readyMarker,
    doneMarker,
  };
}

function buildShellCommands(markers: Markers): { readyCommand: string; doneCommand: string } {
  return {
    readyCommand: `stty -echo 2>/dev/null; export PS1= PS2= PROMPT_COMMAND=; printf '\\n%s%s\\n' '${markers.readyPrefix}' '${markers.readySuffix}'`,
    doneCommand: `__ws_exec_rc=$?; printf '\\n%s%s%d\\n' '${markers.donePrefix}' '${markers.doneSuffix}' "$__ws_exec_rc"`,
  };
}

function cleanCommandOutput(output: string, { inputEchoed, command, doneCommand }: CleanCommandOutputOptions): string {
  let cleaned = output;
  if (inputEchoed) cleaned = stripEchoedLine(cleaned, command);
  cleaned = stripEchoedLine(cleaned, doneCommand, { allowAttached: true });
  return cleaned.replace(/^\r?\n/, '').replace(/\r?\n\r?\n$/, '\n');
}

function normalizeCommand(command: unknown): string {
  if (!command || !String(command).trim()) {
    throw new WebSocketExecError('missing command', 2);
  }
  return String(command).trim();
}

function normalizeTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new WebSocketExecError('timeoutMs must be a positive number of milliseconds', 2);
  }
  return timeoutMs;
}

class WebSocketShellSession {
  url: string;
  timeoutMs: number;
  WebSocketImpl: WebSocketConstructor;
  onFrame: ((_chunk: string) => void) | undefined;
  state: 'opening' | 'ready' | 'closed';
  readyBuffer: string;
  inputEchoed: boolean;
  pending: PendingExec | null;
  queue: Promise<unknown>;
  ws: WebSocketLike;
  readyMarkers: Markers;
  readyCommand: string;
  readyPromise: Promise<WebSocketShellSession>;
  resolveReady: (_session: WebSocketShellSession) => void;
  rejectReady: (_error: unknown) => void;
  readyTimeout: NodeJS.Timeout;

  constructor(options: ShellSessionOptions = {}) {
    const {
      url = DEFAULT_URL,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      WebSocketImpl = globalThis.WebSocket,
      onFrame,
    } = options;

    if (typeof WebSocketImpl !== 'function') {
      throw new WebSocketExecError('global WebSocket is unavailable; use Node.js 22+ or pass WebSocketImpl', 2);
    }

    this.url = url;
    this.timeoutMs = normalizeTimeout(timeoutMs);
    this.WebSocketImpl = WebSocketImpl;
    this.onFrame = onFrame;
    this.state = 'opening';
    this.readyBuffer = '';
    this.inputEchoed = false;
    this.pending = null;
    this.queue = Promise.resolve();
    this.ws = new WebSocketImpl(url);

    this.readyMarkers = buildMarkers();
    const { readyCommand } = buildShellCommands(this.readyMarkers);
    this.readyCommand = readyCommand;

    this.resolveReady = () => {};
    this.rejectReady = () => {};
    this.readyPromise = new Promise<WebSocketShellSession>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.readyTimeout = setTimeout(() => {
      this.fail(
        new WebSocketExecError(`exec ready timeout after ${this.timeoutMs}ms`, 124, {
          partialOutput: this.readyBuffer,
          phase: 'opening',
        }),
      );
    }, this.timeoutMs);

    this.ws.addEventListener('open', () => {
      sendLine(this.ws, this.readyCommand);
    });

    this.ws.addEventListener('message', (event) => {
      const data = isMessageEvent(event) ? event.data : event;
      this.handleMessage(data).catch((error) => {
        this.fail(
          new WebSocketExecError(`exec message handling error: ${error.message}`, 1, {
            cause: error,
            phase: this.state,
          }),
        );
      });
    });

    this.ws.addEventListener('close', () => {
      if (this.state !== 'closed') {
        this.fail(new WebSocketExecError('exec websocket closed before completion marker', 1, { phase: this.state }));
      }
    });

    this.ws.addEventListener('error', () => {
      if (this.state !== 'closed') {
        this.fail(new WebSocketExecError('exec websocket error', 1, { phase: this.state }));
      }
    });
  }

  ready(): Promise<WebSocketShellSession> {
    return this.readyPromise;
  }

  exec(command: unknown, options: ExecOptions = {}): Promise<ExecResult> {
    const run = (): Promise<ExecResult> => this.runExec(command, options);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  close(): void {
    if (this.state === 'closed') return;
    const wasOpening = this.state === 'opening';
    const pending = this.pending;
    this.state = 'closed';
    clearTimeout(this.readyTimeout);
    this.pending = null;

    if (wasOpening) {
      this.rejectReady(new WebSocketExecError('exec session closed before ready', 1, { phase: 'opening' }));
    }

    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(new WebSocketExecError('exec session closed before completion marker', 1, { phase: 'running' }));
    }

    closeQuietly(this.ws);
  }

  fail(error: unknown): void {
    if (this.state === 'closed') return;

    const wasOpening = this.state === 'opening';
    const pending = this.pending;
    this.state = 'closed';
    this.pending = null;
    clearTimeout(this.readyTimeout);
    closeQuietly(this.ws);

    if (wasOpening) {
      this.rejectReady(error);
    }

    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  async handleMessage(data: unknown): Promise<void> {
    if (this.state === 'closed') return;

    const chunk = await eventDataToString(data);
    if (this.onFrame) this.onFrame(chunk);

    if (this.state === 'opening') {
      this.readyBuffer += chunk;
      this.tryCompleteReady();
      return;
    }

    if (this.pending) {
      this.pending.buffer += chunk;
      this.tryCompletePending();
    }
  }

  tryCompleteReady(): void {
    const readyIndex = this.readyBuffer.indexOf(this.readyMarkers.readyMarker);
    if (readyIndex === -1) return;

    this.inputEchoed = this.readyBuffer.slice(0, readyIndex).includes(this.readyCommand);
    this.readyBuffer = '';
    this.state = 'ready';
    clearTimeout(this.readyTimeout);
    this.resolveReady(this);
  }

  runExec(command: unknown, options: ExecOptions = {}): Promise<ExecResult> {
    if (this.state !== 'ready') {
      return Promise.reject(new WebSocketExecError('exec session is not ready', 1, { phase: this.state }));
    }

    const shellCommand = normalizeCommand(command);
    const timeoutMs = normalizeTimeout(options.timeoutMs === undefined ? this.timeoutMs : options.timeoutMs);
    const markers = buildMarkers();
    const { doneCommand } = buildShellCommands(markers);

    return new Promise<ExecResult>((resolve, reject) => {
      this.pending = {
        buffer: '',
        command: shellCommand,
        doneCommand,
        markers,
        reject,
        resolve,
        timeout: setTimeout(() => {
          this.fail(
            new WebSocketExecError(`exec timeout after ${timeoutMs}ms`, 124, {
              partialOutput: this.pending ? this.pending.buffer : '',
              phase: 'running',
            }),
          );
        }, timeoutMs),
      };

      sendLine(this.ws, shellCommand);
      sendLine(this.ws, doneCommand);
    });
  }

  tryCompletePending(): void {
    const pending = this.pending;
    if (!pending) return;

    const doneMarker = pending.markers.doneMarker;
    const markerIndex = pending.buffer.lastIndexOf(doneMarker);
    if (markerIndex === -1) return;

    // eslint-disable-next-line unicorn/no-unsafe-buffer-conversion -- pending.buffer is a String, not a Buffer
    const afterMarker = pending.buffer.slice(markerIndex + doneMarker.length);
    const exitMatch = afterMarker.match(/^(\d+)/);
    if (!exitMatch) return;

    // eslint-disable-next-line unicorn/no-unsafe-buffer-conversion -- pending.buffer is a String, not a Buffer
    const rawOutput = pending.buffer.slice(0, markerIndex);
    const stdout = cleanCommandOutput(rawOutput, {
      inputEchoed: this.inputEchoed,
      command: pending.command,
      doneCommand: pending.doneCommand,
    });

    clearTimeout(pending.timeout);
    this.pending = null;
    pending.resolve({
      stdout,
      exitCode: Number(exitMatch[1]),
      url: this.url,
      command: pending.command,
    });
  }
}

async function connectShellSession(options: ShellSessionOptions = {}): Promise<WebSocketShellSession> {
  const session = new WebSocketShellSession(options);
  await session.ready();
  return session;
}

async function executeCommand(options: ExecuteCommandOptions = {}): Promise<ExecResult> {
  const { command, timeoutMs = DEFAULT_TIMEOUT_MS, ...sessionOptions } = options;
  const shellCommand = normalizeCommand(command);
  const normalizedTimeoutMs = normalizeTimeout(timeoutMs);
  const session = await connectShellSession({ ...sessionOptions, timeoutMs: normalizedTimeoutMs });
  try {
    return await session.exec(shellCommand, { timeoutMs: normalizedTimeoutMs });
  } finally {
    session.close();
  }
}

export {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_URL,
  WebSocketExecError,
  WebSocketShellSession,
  buildMarkers,
  buildShellCommands,
  cleanCommandOutput,
  connectShellSession,
  eventDataToString,
  executeCommand,
  stripEchoedLine,
};
