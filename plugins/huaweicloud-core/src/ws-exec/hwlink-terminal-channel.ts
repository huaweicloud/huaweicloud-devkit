/*
 * This file contains code derived from hwlink.
 *
 * Source:
 * https://gitcode.com/huawei-developers/hwlink
 *
 * Licensed under the ISC License.
 */

import {
  OpCode,
  ReserveSource,
  FIXED_HEADER_LEN,
  MAX_SEND_CHUNK_SIZE,
  createPacket,
  isOpCmdTerminalData,
  isOpFailed,
  isSubStreamPing,
  nextIdentifier,
} from './hwlink-packet.ts';
import type { HwlinkPacket } from './hwlink-packet.ts';
import type { HwlinkWebSocketMultiplexer } from './hwlink-multiplexer.ts';

const encoder = new TextEncoder();
const MAX_TERMINAL_PAYLOAD_SIZE = MAX_SEND_CHUNK_SIZE - FIXED_HEADER_LEN;

class HwlinkTerminalChannel {
  username: string;
  identifier: number;
  mux: HwlinkWebSocketMultiplexer | null;
  closed: boolean;
  opened: boolean;
  onDataCb: ((_data: Uint8Array) => void) | null;
  onCloseCb: (() => void) | null;
  onErrorCb: ((_error: unknown) => void) | null;
  onReadyCb: (() => void) | null;

  constructor(username = 'root') {
    this.username = username;
    this.identifier = nextIdentifier();
    this.mux = null;
    this.closed = false;
    this.opened = false;
    this.onDataCb = null;
    this.onCloseCb = null;
    this.onErrorCb = null;
    this.onReadyCb = null;
  }

  onData(cb: (_data: Uint8Array) => void): void {
    this.onDataCb = cb;
  }

  onClose(cb: () => void): void {
    this.onCloseCb = cb;
  }

  onError(cb: (_error: unknown) => void): void {
    this.onErrorCb = cb;
  }

  onReady(cb: () => void): void {
    this.onReadyCb = cb;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  attach(mux: HwlinkWebSocketMultiplexer): void {
    this.mux = mux;
    mux.register(this);
  }

  onopen(): void {
    if (this.closed || this.opened) return;
    this.opened = true;
    this.sendRaw(
      createPacket({
        operation: OpCode.OpNewCmdTerminal,
        reserve: ReserveSource.Web,
        identifier: this.identifier,
        source: this.mux ? this.mux.source : 0,
        payload: encoder.encode(this.username),
      }),
    );
    if (this.onReadyCb) this.onReadyCb();
  }

  onmessage(packet: HwlinkPacket): void {
    if (this.closed) return;

    if (isOpFailed(packet.operation)) {
      this.handleError(new Error(`hwlink terminal failed: 0x${packet.operation.toString(16)}`));
      return;
    }

    if (isSubStreamPing(packet.operation)) {
      this.sendRaw(
        createPacket({
          operation: OpCode.OpCmdTerminalData | OpCode.OpSubStreamPong,
          reserve: ReserveSource.Web,
          identifier: this.identifier,
          source: this.mux ? this.mux.source : 0,
          payload: new Uint8Array(0),
        }),
      );
      return;
    }

    if (isOpCmdTerminalData(packet.operation) && packet.data) {
      if (this.onDataCb) this.onDataCb(packet.data);
    }
  }

  onerror(error: unknown): void {
    if (this.onErrorCb) this.onErrorCb(error);
  }

  onclose(): void {
    this.close();
  }

  sendInput(data: Uint8Array): void {
    if (this.closed) return;
    for (let offset = 0; offset < data.byteLength; offset += MAX_TERMINAL_PAYLOAD_SIZE) {
      const payload = data.subarray(offset, offset + MAX_TERMINAL_PAYLOAD_SIZE);
      this.sendTerminalData(payload);
    }
  }

  sendTerminalData(payload: Uint8Array): void {
    this.sendRaw(
      createPacket({
        operation: OpCode.OpCmdTerminalData | OpCode.OpSubStreamPong,
        reserve: ReserveSource.Web,
        identifier: this.identifier,
        source: this.mux ? this.mux.source : 0,
        payload,
      }),
    );
  }

  sendText(text: string): void {
    this.sendInput(encoder.encode(text));
  }

  resize(cols: number, rows: number): void {
    if (this.closed) return;
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint16(0, rows, false);
    view.setUint16(2, cols, false);
    this.sendRaw(
      createPacket({
        operation: OpCode.OpCmdTerminalResize,
        reserve: ReserveSource.Web,
        identifier: this.identifier,
        source: this.mux ? this.mux.source : 0,
        payload,
      }),
    );
  }

  sendRaw(data: Uint8Array): void {
    if (this.mux) this.mux.sendFairly(this, data);
  }

  handleError(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    if (this.mux) this.mux.unregister(this);
    if (this.onErrorCb) this.onErrorCb(error);
    if (this.onCloseCb) this.onCloseCb();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.mux) this.mux.unregister(this);
    if (this.onCloseCb) this.onCloseCb();
  }
}

export { HwlinkTerminalChannel };
