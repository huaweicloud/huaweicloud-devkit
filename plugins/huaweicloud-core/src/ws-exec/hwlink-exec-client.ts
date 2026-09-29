/*
 * This file contains code derived from hwlink.
 *
 * Source:
 * https://gitcode.com/huawei-developers/hwlink
 *
 * Licensed under the ISC License.
 */

import {
  DEFAULT_TIMEOUT_MS,
  WebSocketExecError,
  buildMarkers,
  buildShellCommands,
  cleanCommandOutput,
} from './ws-exec-client.ts';
import { HwlinkWebSocketMultiplexer } from './hwlink-multiplexer.ts';
import { HwlinkTerminalChannel } from './hwlink-terminal-channel.ts';
import type { FrameReport, WebSocketConstructor } from './hwlink-multiplexer.ts';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

type Markers = ReturnType<typeof buildMarkers>;

interface HwlinkExecResult {
  stdout: string;
  exitCode: number;
  url: string;
  source: number;
  username: string;
  command: string;
}

interface PendingExec {
  buffer: string;
  command: string;
  doneCommand: string;
  markers: Markers;
  reject: (_error: unknown) => void;
  resolve: (_result: HwlinkExecResult) => void;
  timeout: NodeJS.Timeout;
}

interface CreateHwlinkTerminalOptions {
  url?: string;
  source?: unknown;
  username?: string;
  WebSocketImpl?: WebSocketConstructor;
  protocol?: string;
  cols?: number;
  rows?: number;
  onFrame?: (_frame: FrameReport) => void;
  onData?: (_data: Uint8Array) => void;
  onError?: (_error: WebSocketExecError) => void;
  onClose?: () => void;
  trace?: boolean;
}

interface HwlinkTerminalHandle {
  url: string;
  source: number;
  username: string;
  mux: HwlinkWebSocketMultiplexer;
  term: HwlinkTerminalChannel;
  ready: Promise<HwlinkTerminalHandle>;
  close: () => void;
  resize: (_nextCols: number, _nextRows: number) => void;
  sendInput: (_data: Uint8Array) => void;
  sendText: (_text: string) => void;
}

interface HwlinkTerminalSessionOptions {
  url?: string;
  source?: unknown;
  username?: string;
  timeoutMs?: number;
  WebSocketImpl?: WebSocketConstructor;
  protocol?: string;
  cols?: number;
  rows?: number;
  onFrame?: (_frame: FrameReport) => void;
  onData?: (_data: Uint8Array, _chunk: string) => void;
  trace?: boolean;
}

interface ExecuteHwlinkCommandOptions extends HwlinkTerminalSessionOptions {
  command?: string;
}

interface ExecOptions {
  timeoutMs?: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

// Number.isFinite returns true only for primitive numbers, so adding the
// typeof check is a pure narrowing with identical results.
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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

function normalizeSource(source: unknown): number {
  const numericSource = Number(source);
  if (!Number.isInteger(numericSource) || numericSource < -0x80000000 || numericSource > 0xffffffff) {
    throw new WebSocketExecError('hwlink source must be an int32 or uint32 number', 2);
  }
  return numericSource;
}

function normalizeUrl(url: unknown): string {
  if (!url || !String(url).trim()) {
    throw new WebSocketExecError('hwlink url is required', 2);
  }
  return String(url);
}

function createHwlinkTerminal(options: CreateHwlinkTerminalOptions = {}): HwlinkTerminalHandle {
  const {
    url,
    source,
    username = 'root',
    WebSocketImpl = globalThis.WebSocket,
    protocol = 'devenv',
    cols,
    rows,
    onFrame,
    onData,
    onError,
    onClose,
    trace = false,
  } = options;

  const normalizedUrl = normalizeUrl(url);
  const normalizedSource = normalizeSource(source);
  const mux = new HwlinkWebSocketMultiplexer(normalizedUrl, normalizedSource, {
    WebSocketImpl,
    protocol,
    onFrame,
    trace,
  });
  const term = new HwlinkTerminalChannel(username);
  let closed = false;
  let readySettled = false;
  let readyResolve: (_handle: HwlinkTerminalHandle) => void = () => {};
  let readyReject: (_error: unknown) => void = () => {};

  const ready = new Promise<HwlinkTerminalHandle>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  function settleReady(error?: unknown): void {
    if (readySettled) return;
    readySettled = true;
    if (error) readyReject(error);
    else readyResolve(handle);
  }

  function handleError(error: unknown, prefix: string): void {
    const wrapped = new WebSocketExecError(`${prefix}: ${errorMessage(error)}`, 1, {
      cause: error,
      phase: readySettled ? 'open' : 'opening',
    });
    settleReady(wrapped);
    if (onError) onError(wrapped);
    close();
  }

  function handleClose(): void {
    settleReady(
      new WebSocketExecError('hwlink terminal closed before ready', 1, {
        phase: 'opening',
      }),
    );
    if (closed) return;
    closed = true;
    if (onClose) onClose();
  }

  term.onReady(() => {
    if (isFiniteNumber(cols) && isFiniteNumber(rows)) {
      term.resize(cols, rows);
    }
    settleReady();
  });
  term.onData((data) => {
    if (onData) onData(data);
  });
  term.onError((error) => handleError(error, 'hwlink terminal error'));
  term.onClose(handleClose);
  mux.onError = (error) => handleError(error, 'hwlink websocket error');
  mux.onClose = handleClose;

  function close(): void {
    if (closed) return;
    closed = true;
    term.close();
    mux.close();
  }

  const handle: HwlinkTerminalHandle = {
    url: normalizedUrl,
    source: normalizedSource,
    username,
    mux,
    term,
    ready,
    close,
    resize: (nextCols: number, nextRows: number) => term.resize(nextCols, nextRows),
    sendInput: (data: Uint8Array) => term.sendInput(data),
    sendText: (text: string) => term.sendText(text),
  };

  term.attach(mux);
  return handle;
}

class HwlinkTerminalExecSession {
  url: string;
  source: number;
  username: string;
  timeoutMs: number;
  onData: ((_data: Uint8Array, _chunk: string) => void) | undefined;
  initialCols: number | undefined;
  initialRows: number | undefined;
  state: 'opening' | 'ready' | 'closed';
  readyBuffer: string;
  inputEchoed: boolean;
  pending: PendingExec | null;
  queue: Promise<unknown>;
  readyMarkers: Markers;
  readyCommand: string;
  readyPromise: Promise<HwlinkTerminalExecSession>;
  resolveReady: (_session: HwlinkTerminalExecSession) => void;
  rejectReady: (_error: unknown) => void;
  readyTimeout: NodeJS.Timeout;
  mux!: HwlinkWebSocketMultiplexer;
  term!: HwlinkTerminalChannel;

  constructor(options: HwlinkTerminalSessionOptions = {}) {
    const {
      url,
      source,
      username = 'root',
      timeoutMs = DEFAULT_TIMEOUT_MS,
      WebSocketImpl = globalThis.WebSocket,
      protocol = 'devenv',
      cols,
      rows,
      onFrame,
      onData,
      trace = false,
    } = options;

    this.url = normalizeUrl(url);
    this.source = normalizeSource(source);
    this.username = username;
    this.timeoutMs = normalizeTimeout(timeoutMs);
    this.onData = onData;
    this.initialCols = cols;
    this.initialRows = rows;
    this.state = 'opening';
    this.readyBuffer = '';
    this.inputEchoed = false;
    this.pending = null;
    this.queue = Promise.resolve();
    this.readyMarkers = buildMarkers();
    const { readyCommand } = buildShellCommands(this.readyMarkers);
    this.readyCommand = readyCommand;

    this.resolveReady = () => {};
    this.rejectReady = () => {};
    this.readyPromise = new Promise<HwlinkTerminalExecSession>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.readyTimeout = setTimeout(() => {
      this.fail(
        new WebSocketExecError(`hwlink terminal ready timeout after ${this.timeoutMs}ms`, 124, {
          partialOutput: this.readyBuffer,
          phase: 'opening',
        }),
      );
    }, this.timeoutMs);

    try {
      this.mux = new HwlinkWebSocketMultiplexer(this.url, this.source, {
        WebSocketImpl,
        protocol,
        onFrame,
        trace,
      });
    } catch (error) {
      clearTimeout(this.readyTimeout);
      throw new WebSocketExecError(errorMessage(error), 2, { cause: error, phase: 'opening' });
    }

    this.term = new HwlinkTerminalChannel(username);
    this.term.onData((data) => this.handleTerminalData(data));
    this.term.onError((error) => {
      this.fail(
        new WebSocketExecError(`hwlink terminal error: ${errorMessage(error)}`, 1, {
          cause: error,
          phase: this.state,
        }),
      );
    });
    this.term.onReady(() => {
      if (isFiniteNumber(this.initialCols) && isFiniteNumber(this.initialRows)) {
        this.term.resize(this.initialCols, this.initialRows);
      }
      this.sendLine(this.readyCommand);
    });
    this.term.onClose(() => {
      if (this.state !== 'closed') {
        this.fail(
          new WebSocketExecError('hwlink terminal closed before completion marker', 1, {
            phase: this.state,
          }),
        );
      }
    });
    this.mux.onClose = () => {
      if (this.state !== 'closed') {
        this.fail(
          new WebSocketExecError('hwlink websocket closed before completion marker', 1, {
            phase: this.state,
          }),
        );
      }
    };
    this.mux.onError = (error) => {
      if (this.state !== 'closed') {
        this.fail(
          new WebSocketExecError(`hwlink websocket error: ${errorMessage(error)}`, 1, {
            cause: error,
            phase: this.state,
          }),
        );
      }
    };

    this.term.attach(this.mux);
  }

  ready(): Promise<HwlinkTerminalExecSession> {
    return this.readyPromise;
  }

  exec(command: unknown, options: ExecOptions = {}): Promise<HwlinkExecResult> {
    const run = (): Promise<HwlinkExecResult> => this.runExec(command, options);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  close(): void {
    if (this.state === 'closed') return;
    const wasOpening = this.state === 'opening';
    const pending = this.pending;
    this.state = 'closed';
    clearTimeout(this.readyTimeout);
    this.pending = null;

    if (wasOpening) {
      this.rejectReady(
        new WebSocketExecError('hwlink terminal session closed before ready', 1, {
          phase: 'opening',
        }),
      );
    }

    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(
        new WebSocketExecError('hwlink terminal session closed before completion marker', 1, {
          phase: 'running',
        }),
      );
    }

    this.term.close();
    this.mux.close();
  }

  fail(error: unknown): void {
    if (this.state === 'closed') return;

    const wasOpening = this.state === 'opening';
    const pending = this.pending;
    this.state = 'closed';
    this.pending = null;
    clearTimeout(this.readyTimeout);

    if (wasOpening) {
      this.rejectReady(error);
    }

    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }

    this.term.close();
    this.mux.close();
  }

  handleTerminalData(data: Uint8Array): void {
    if (this.state === 'closed') return;

    const chunk = decoder.decode(data, { stream: true });
    if (this.onData) this.onData(data, chunk);

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

  runExec(command: unknown, options: ExecOptions = {}): Promise<HwlinkExecResult> {
    if (this.state !== 'ready') {
      return Promise.reject(
        new WebSocketExecError('hwlink terminal exec session is not ready', 1, {
          phase: this.state,
        }),
      );
    }

    const shellCommand = normalizeCommand(command);
    const timeoutMs = normalizeTimeout(options.timeoutMs === undefined ? this.timeoutMs : options.timeoutMs);
    const markers = buildMarkers();
    const { doneCommand } = buildShellCommands(markers);

    return new Promise<HwlinkExecResult>((resolve, reject) => {
      this.pending = {
        buffer: '',
        command: shellCommand,
        doneCommand,
        markers,
        reject,
        resolve,
        timeout: setTimeout(() => {
          this.fail(
            new WebSocketExecError(`hwlink terminal exec timeout after ${timeoutMs}ms`, 124, {
              partialOutput: this.pending ? this.pending.buffer : '',
              phase: 'running',
            }),
          );
        }, timeoutMs),
      };

      this.sendLine(shellCommand);
      this.sendLine(doneCommand);
    });
  }

  tryCompletePending(): void {
    const pending = this.pending;
    if (!pending) return;

    const doneMarker = pending.markers.doneMarker;
    const markerIndex = pending.buffer.lastIndexOf(doneMarker);
    if (markerIndex === -1) return;

    const afterMarker = pending.buffer.slice(markerIndex + doneMarker.length);
    const exitMatch = afterMarker.match(/^(\d+)/);
    if (!exitMatch) return;

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
      source: this.source,
      username: this.username,
      command: pending.command,
    });
  }

  sendLine(line: string): void {
    this.term.sendInput(encoder.encode(`${line}\n`));
  }
}

async function connectHwlinkTerminalSession(
  options: HwlinkTerminalSessionOptions = {},
): Promise<HwlinkTerminalExecSession> {
  const session = new HwlinkTerminalExecSession(options);
  await session.ready();
  return session;
}

async function connectHwlinkInteractiveTerminal(
  options: CreateHwlinkTerminalOptions = {},
): Promise<HwlinkTerminalHandle> {
  const terminal = createHwlinkTerminal(options);
  await terminal.ready;
  return terminal;
}

async function executeHwlinkCommand(options: ExecuteHwlinkCommandOptions = {}): Promise<HwlinkExecResult> {
  const { command, timeoutMs = DEFAULT_TIMEOUT_MS, ...sessionOptions } = options;
  const shellCommand = normalizeCommand(command);
  const normalizedTimeoutMs = normalizeTimeout(timeoutMs);
  const session = await connectHwlinkTerminalSession({
    ...sessionOptions,
    timeoutMs: normalizedTimeoutMs,
  });
  try {
    return await session.exec(shellCommand, { timeoutMs: normalizedTimeoutMs });
  } finally {
    session.close();
  }
}

export {
  HwlinkTerminalExecSession,
  connectHwlinkInteractiveTerminal,
  connectHwlinkTerminalSession,
  createHwlinkTerminal,
  executeHwlinkCommand,
  normalizeSource,
};
