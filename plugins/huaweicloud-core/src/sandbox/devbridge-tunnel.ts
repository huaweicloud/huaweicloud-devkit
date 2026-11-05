// Stable public face of the DevBridge tunnel family. The internals live in
// the src/sandbox/ siblings; this module is the re-export seam every consumer
// imports — same exported names, same import path, same behavior:
//   devbridge-exec.ts         — the one-shot exec seam (test override + runOneShot)
//   devbridge-validation.ts   — tunnel parameter validators, the lifetime
//                               constants, and the 0.1.x version gate (#998)
//   devbridge-auth.ts         — the auth waterfall probe + parser + the
//                               expose auth/version gate
//   devbridge-expose.ts       — the expose attempt contract (script, DB_*
//                               stdout grammar, reachability warning, the
//                               no-URL failure verdict, ExposeTunnelResult)
//   devbridge-verify.ts       — the fresh-session re-verify family (#919/#922)
//   devbridge-renew.ts        — the renew flow (script, parser, renewTunnel)
//   devbridge-keepalive.ts    — the keepalive watchdog family + enrollment
//   devbridge-expose-flow.ts  — the exposeTunnel orchestration
// The sandbox siblings import each other's canonical modules directly (the
// DEVBRIDGE_* gateway constants from devbridge-gateway.ts, the escape stripper
// from sandbox-output.ts, execOneShot from hwlink-connection.ts); only
// consumers outside the family import through this face.

// The tunnel parameter policy (validators, lifetime constants, the 0.1.x
// version gate) lives in devbridge-validation.ts; re-exported as the public
// face (the sandbox pack's handlers-tunnel.ts and the tests import these
// names here).
export {
  DEVBRIDGE_HOST_EXPIRY_HOURS,
  DEVBRIDGE_MAX_EXPIRY_HOURS,
  DEVBRIDGE_RENEW_HOURS,
  evaluateDevbridgeVersion,
  validateExpiryHours,
  validateTunnelId,
  validateTunnelPort,
} from './devbridge-validation.ts';
export type { DevbridgeVersionVerdict } from './devbridge-validation.ts';
// The one-shot exec seam lives in devbridge-exec.ts; re-exported as the public
// face (the test harness imports _setOneShotForTests here).
export { _setOneShotForTests } from './devbridge-exec.ts';
// The DevBridge auth waterfall (probe script + stdout parser + the expose
// auth/version gate with the key-upgrade ladder) lives in devbridge-auth.ts;
// re-exported as the public face.
export { buildDevbridgeAuthProbe, gateExposeAuth, parseDevbridgeAuthOutput } from './devbridge-auth.ts';
export type {
  DevbridgeAuth,
  DevbridgeAuthGateOptions,
  DevbridgeKeyUpgradeDeps,
  ExposeAuthGate,
} from './devbridge-auth.ts';
// The expose attempt contract (script, stdout grammar, reachability warning,
// result interface) lives in devbridge-expose.ts; re-exported as the public
// face.
export {
  buildDevbridgeExposeScript,
  formatTunnelReachabilityWarning,
  parseDevbridgeExposeOutput,
  parseDevbridgeProbeSequence,
} from './devbridge-expose.ts';
export type { DevbridgeExpose, DevbridgeProbe, ExposeTunnelResult } from './devbridge-expose.ts';
// The fresh-session re-verify family (script + dedicated parser) lives in
// devbridge-verify.ts; re-exported as the public face.
export { buildDevbridgeVerifyScript, parseDevbridgeVerifyOutput } from './devbridge-verify.ts';
export type { DevbridgeVerify } from './devbridge-verify.ts';
// The renew family (script, parser, renewTunnel flow) lives in
// devbridge-renew.ts; re-exported as the public face.
export { buildDevbridgeRenewScript, parseDevbridgeRenewOutput, renewTunnel } from './devbridge-renew.ts';
export type { RenewTunnelResult } from './devbridge-renew.ts';
// The keepalive watchdog family lives in devbridge-keepalive.ts; re-exported
// as the public face.
export {
  buildDevbridgeKeepaliveScript,
  buildKeepaliveTunnelsReadScript,
  installKeepaliveWatchdog,
  mergeKeepaliveTunnels,
  parseKeepaliveTunnelsOutput,
} from './devbridge-keepalive.ts';
export type { KeepaliveTunnel, KeepaliveWatchdogResult } from './devbridge-keepalive.ts';
// The exposeTunnel orchestration lives in devbridge-expose-flow.ts;
// re-exported as the public face (the sandbox pack's handlers-tunnel.ts and
// the test harness import it here).
export { exposeTunnel } from './devbridge-expose-flow.ts';
