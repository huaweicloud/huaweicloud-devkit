// Round-29/MUST-1 driver for the 512MB-budget process pin (spawned by
// test/hdkit-gate-retry.test.ts with `node --max-old-space-size=512`).
// Each shape fires one oversized JSON payload; the driver prints
// `RESULT: <json>` and exits 0 when the bounded reads hold. Unbounded
// code-point materialization (the pre-round-29 cleanMessage/canonCode
// spreads) OOM-kills this process at the budget (non-zero status, heap
// message on stderr).
// argv[2] = shape: gate409 | exhaust502 | trace | nonjson-control
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const shape = process.argv[2] ?? 'gate409';
const { hdkitConnectWithRetry } = await import(`${ROOT}/plugins/huaweicloud-core/src/lib/hdkit/hdkitservice-api.ts`);
const { transientExhaustionResult, versionGateResult } = await import(
  `${ROOT}/plugins/huaweicloud-core/src/lib/hdkit/hdkit-gate.ts`
);

const BIG = 'A'.repeat(8 * 1024 * 1024);
const respond = () => {
  if (shape === 'gate409') {
    return new Response(JSON.stringify({ code: 'HDKIT_VERSION_TOO_OLD', message: BIG }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (shape === 'exhaust502') {
    return new Response(JSON.stringify({ message: BIG }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (shape === 'trace') {
    return new Response(JSON.stringify({ message: 'ok', traceId: 'T'.repeat(2 * 1024 * 1024) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response('x'.repeat(8 * 1024 * 1024), { status: 502 });
};
global.fetch = async () => respond();

try {
  await hdkitConnectWithRetry({});
  console.log('RESULT: {"unexpected":"connected"}');
} catch (error) {
  const gate = versionGateResult(error);
  const exhaust = transientExhaustionResult(error);
  const err = error;
  console.log(
    `RESULT: ${JSON.stringify({
      shape,
      code: err.code,
      traceLen: String(err.traceId ?? '').length,
      messageLen: String(err.message ?? '').length,
      gateCode: gate?.code,
      gateMsgLen: String(gate?.message ?? '').length,
      exhaustCode: exhaust?.code,
      exhaustMsgLen: String(exhaust?.message ?? '').length,
    })}`,
  );
}
console.log('ALIVE');
