import * as hwlinkExec from './hwlink-exec-client.ts';
import * as hwlinkPacket from './hwlink-packet.ts';
import * as wsExec from './ws-exec-client.ts';
import { HwlinkWebSocketMultiplexer } from './hwlink-multiplexer.ts';
import { HwlinkTerminalChannel } from './hwlink-terminal-channel.ts';
import { HwlinkTunnelChannel } from './hwlink-tunnel-channel.ts';

export * from './ws-exec-client.ts';
export * from './hwlink-exec-client.ts';
export { HwlinkTerminalChannel } from './hwlink-terminal-channel.ts';
export { HwlinkTunnelChannel } from './hwlink-tunnel-channel.ts';
export { HwlinkWebSocketMultiplexer } from './hwlink-multiplexer.ts';
export { hwlinkPacket };

export default {
  ...wsExec,
  ...hwlinkExec,
  HwlinkTerminalChannel,
  HwlinkTunnelChannel,
  HwlinkWebSocketMultiplexer,
  hwlinkPacket,
};
