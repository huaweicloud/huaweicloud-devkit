/*
 * This file contains code derived from hwlink.
 *
 * Source:
 * https://gitcode.com/huawei-developers/hwlink
 *
 * Licensed under the ISC License.
 */

import { Buffer } from 'node:buffer';

import { FairQueue } from './hwlink-fair-queue.ts';
import { formatPacketOneLine, parsePacket } from './hwlink-packet.ts';
import type { HwlinkPacket } from './hwlink-packet.ts';

const WS_OPEN = 1;

type WsListener = (..._args: unknown[]) => void;

// Structural view of the WebSocket instance we drive. Both Node's global
// WebSocket and the proxy/undici implementations satisfy it; `on` is the
// ws-package listener API, `addEventListener` the WHATWG one.
interface WebSocketLike {
  readyState: number;
  binaryType?: string;
  on?: (_event: string, _handler: WsListener) => void;
  addEventListener?: (_event: string, _handler: WsListener) => void;
  send: (_data: Uint8Array, _cb?: (_error?: unknown) => void) => unknown;
  close: () => void;
}

export type WebSocketConstructor = new (_url: string, _protocol?: string) => WebSocketLike;

interface CloseEventLike {
  code: number;
  reason: string;
}

export interface FrameReport {
  direction: 'in' | 'out';
  packet: HwlinkPacket;
  line: string;
}

interface MultiplexerOptions {
  WebSocketImpl?: WebSocketConstructor;
  protocol?: string;
  onFrame?: (_frame: FrameReport) => void;
  trace?: boolean;
}

// Minimal contract every registered channel must expose. Terminal and tunnel
// channels satisfy it; callbacks that ignore arguments remain assignable.
interface HwlinkChannel {
  identifier: number;
  onopen: () => void;
  onmessage: (_packet: HwlinkPacket) => void;
  onerror: (_error: unknown) => void;
  onclose: (_event: CloseEventLike) => void;
}

interface ArrayBufferProvider {
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function addWsListener(ws: WebSocketLike, event: string, handler: WsListener): void {
  if (typeof ws.on === 'function') {
    ws.on(event, handler);
    return;
  }
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener(event, handler);
    return;
  }
  throw new Error('WebSocket implementation does not support event listeners');
}

function closeQuietly(ws: WebSocketLike): void {
  try {
    ws.close();
  } catch {
    // Close is best-effort during error settlement.
  }
}

function extractMessageData(eventOrData: unknown): unknown {
  if (
    eventOrData &&
    typeof eventOrData === 'object' &&
    !Buffer.isBuffer(eventOrData) &&
    !(eventOrData instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(eventOrData) &&
    'data' in eventOrData
  ) {
    return eventOrData.data;
  }
  return eventOrData;
}

function hasArrayBuffer(value: unknown): value is ArrayBufferProvider {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  return 'arrayBuffer' in value && typeof value.arrayBuffer === 'function';
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

function eventDataToUint8Array(data: unknown): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return Promise.resolve(data);
  if (Buffer.isBuffer(data)) {
    return Promise.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (data instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (hasArrayBuffer(data)) {
    return data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return Promise.reject(new Error(`unsupported websocket message data: ${typeof data}`));
}

function sendBinary(ws: WebSocketLike, data: Uint8Array): Promise<void> {
  if (ws.readyState !== WS_OPEN) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    try {
      const maybePromise = ws.send(data, done);
      if (isPromiseLike(maybePromise)) {
        maybePromise.then(() => done(), done);
        return;
      }
      if (ws.send.length < 2) done();
    } catch (error) {
      done(error);
    }
  });
}

class HwlinkWebSocketMultiplexer {
  url: string;
  source: number;
  onFrame: ((_frame: FrameReport) => void) | undefined;
  trace: boolean;
  channels: Map<number, HwlinkChannel>;
  unknownIdentifierHandler: ((_packet: HwlinkPacket, _mux: HwlinkWebSocketMultiplexer) => void) | null;
  onClose: ((_event: CloseEventLike) => void) | null;
  onError: ((_error: unknown) => void) | null;
  closed: boolean;
  queue: FairQueue;
  ws: WebSocketLike;

  constructor(url: string, source: number, options: MultiplexerOptions = {}) {
    const { WebSocketImpl = globalThis.WebSocket, protocol = 'devenv', onFrame, trace = false } = options;

    if (typeof WebSocketImpl !== 'function') {
      throw new TypeError('global WebSocket is unavailable; use Node.js 22+ or pass WebSocketImpl');
    }
    if (!Number.isInteger(source) || source < -0x80000000 || source > 0xffffffff) {
      throw new Error('hwlink source must be an int32 or uint32 number');
    }

    this.url = url;
    this.source = source;
    this.onFrame = onFrame;
    this.trace = trace;
    this.channels = new Map();
    this.unknownIdentifierHandler = null;
    this.onClose = null;
    this.onError = null;
    this.closed = false;
    this.queue = new FairQueue((data) => this.wsSend(data));
    this.ws = new WebSocketImpl(url, protocol);

    if ('binaryType' in this.ws) {
      this.ws.binaryType = 'arraybuffer';
    }

    addWsListener(this.ws, 'open', () => {
      for (const ch of this.channels.values()) ch.onopen();
    });

    addWsListener(this.ws, 'message', (eventOrData) => {
      this.handleMessage(extractMessageData(eventOrData)).catch((error) => {
        this.handleError(error);
      });
    });

    addWsListener(this.ws, 'error', (eventOrError) => {
      const error = eventOrError instanceof Error ? eventOrError : new Error('hwlink websocket error');
      this.handleError(error);
    });

    addWsListener(this.ws, 'close', (eventOrCode, maybeReason) => {
      this.closed = true;
      const closeEvent = this.normalizeCloseEvent(eventOrCode, maybeReason);
      for (const ch of this.channels.values()) ch.onclose(closeEvent);
      if (this.onClose) this.onClose(closeEvent);
    });
  }

  normalizeCloseEvent(eventOrCode: unknown, maybeReason: unknown): CloseEventLike {
    if (typeof eventOrCode === 'number') {
      return {
        code: eventOrCode,
        reason: Buffer.isBuffer(maybeReason) ? maybeReason.toString() : String(maybeReason || ''),
      };
    }

    const code =
      eventOrCode && typeof eventOrCode === 'object' && 'code' in eventOrCode && typeof eventOrCode.code === 'number'
        ? eventOrCode.code
        : 0;
    const reason =
      eventOrCode && typeof eventOrCode === 'object' && 'reason' in eventOrCode && eventOrCode.reason
        ? String(eventOrCode.reason)
        : '';
    return { code, reason };
  }

  register(ch: HwlinkChannel): void {
    this.channels.set(ch.identifier, ch);
    this.queue.register(ch);
    if (this.ws.readyState === WS_OPEN) {
      ch.onopen();
    }
  }

  unregister(ch: HwlinkChannel): void {
    this.channels.delete(ch.identifier);
    this.queue.unregister(ch);
  }

  sendFairly(ch: HwlinkChannel, data: Uint8Array): void {
    this.queue.sendFairly(ch, data);
  }

  sendImmediately(data: Uint8Array): void {
    this.queue.sendImmediately(data);
  }

  get readyState(): number {
    return this.ws.readyState;
  }

  async handleMessage(data: unknown): Promise<void> {
    const bytes = await eventDataToUint8Array(data);
    const packet = parsePacket(bytes);
    this.reportFrame('in', packet);

    const ch = this.channels.get(packet.identifier);
    if (ch) {
      ch.onmessage(packet);
      return;
    }

    if (this.unknownIdentifierHandler) {
      this.unknownIdentifierHandler(packet, this);
    }
  }

  wsSend(data: Uint8Array): Promise<void> {
    const packet = parsePacket(data);
    this.reportFrame('out', packet);
    return sendBinary(this.ws, data);
  }

  reportFrame(direction: 'in' | 'out', packet: HwlinkPacket): void {
    if (this.onFrame) {
      this.onFrame({ direction, packet, line: formatPacketOneLine(packet) });
    }
    if (this.trace) {
      const arrow = direction === 'in' ? '<-' : '->';
      console.error(`${arrow} ${formatPacketOneLine(packet)}`);
    }
  }

  handleError(error: unknown): void {
    for (const ch of this.channels.values()) ch.onerror(error);
    if (this.onError) this.onError(error);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeQuietly(this.ws);
  }
}

export { HwlinkWebSocketMultiplexer, addWsListener, closeQuietly, eventDataToUint8Array };
