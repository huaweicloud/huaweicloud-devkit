import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _setOneShotForTests,
  buildDevbridgeKeepaliveScript,
  buildDevbridgeRenewScript,
  parseDevbridgeRenewOutput,
  validateExpiryHours,
  validateTunnelId,
  validateTunnelPort,
} from '../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts';
import { exposeStdout, exposeViaSeam, healthyOneShot, recordingSeam, verifyStdout } from './devbridge-harness.ts';

test('P1: validateTunnelPort accepts integer ports in range', () => {
  assert.equal(validateTunnelPort(8080), 8080);
  assert.equal(validateTunnelPort('8081'), 8081);
  assert.equal(validateTunnelPort(1), 1);
  assert.equal(validateTunnelPort(65535), 65535);
});

test('P1: validateTunnelPort rejects strings, decimals, and out-of-range ports (shell-injection guard)', () => {
  for (const bad of ['80;rm -rf /', 'abc', '', null, undefined, 0, -1, 65536, 1.5, '8080;true']) {
    assert.throws(() => validateTunnelPort(bad), /invalid port/, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test('gateway 404 "tunnel not found" retries once, then returns ok:false — never a soft warning', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  const { calls, seam } = recordingSeam(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_FILE\n', exitCode: 0 };
    }
    if (command.startsWith('VERIFY_CODE=')) {
      return { stdout: verifyStdout('404'), exitCode: 0 };
    }
    // Every expose attempt: the gateway itself reports the tunnel dead.
    return { stdout: exposeStdout(url, '404', '0', 'tunnel not found'), exitCode: 0 };
  });
  const result = await exposeViaSeam(seam, 8080, { keepalive: false });
  assert.equal(result.ok, false);
  assert.equal(result.publicUrl, undefined);
  assert.match(result.error ?? '', /gateway reports the fresh tunnel URL as dead/);
  assert.match(result.error ?? '', /tunnel not found/);
  assert.equal(result.httpCode, '404');
  // auth → expose (404) → cleanup → expose (404) → ok:false; no verify is spent.
  assert.equal(calls.length, 4);
});

test('v2 deviation: a final unreachable attempt returns ok:false, never ok:true with a dead URL', async () => {
  // Attempt 1: unreachable → cleanup + retry; attempt 2: still unreachable →
  // ok:false (main returned ok:true with publicUrl undefined + HTTP 000).
  const { calls, seam } = recordingSeam(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_KEYRING\n', exitCode: 0 };
    }
    if (command.includes('nohup devbridge host')) {
      return { stdout: exposeStdout('', '000'), exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 }; // cleanup call
  });
  const result = await exposeViaSeam(seam, 8080, { keepalive: false });
  assert.equal(result.ok, false);
  assert.equal(result.publicUrl, undefined);
  assert.equal(result.httpCode, '000');
  // #998 taxonomy: an empty URL is the host-did-not-start class.
  assert.equal(result.error_code, 'no_tunnel_url');
  assert.match(result.error ?? '', /no Tunnel URL/);
  // auth → expose (attempt 1) → cleanup → expose (attempt 2) → #998 version
  // read-back (empty URL on the final attempt)
  assert.equal(calls.length, 5);
  assert.ok(calls[1]!.includes('pkill -f "devbridge host"'));
  assert.ok(calls[3]!.includes('pkill -f "devbridge host"'));
});

test('v2 deviation: a migrated-gateway placeholder (HTTP 200 + dead URL) is unusable', async () => {
  // The host log carries the migration marker (DB_MIGRATION=1, script-side
  // grep of /tmp/host.log) and the gateway serves the placeholder with HTTP
  // 200 — probe_tunnel treats that as unreachable, and so must the final
  // attempt. An APP body merely containing the marker never trips this (the
  // verdict is field-scoped to the host log, never the echoed probe body).
  const deadUrl = 'https://c4rdv7bv-8080.old-bridge.hwtunnel.com';
  const result = await exposeViaSeam(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_KEYRING\n', exitCode: 0 };
    }
    // Marker logged twice (retrying host) — count-robust parsing must still
    // classify it as migration, not silently read count 2 as "no".
    return { stdout: exposeStdout(deadUrl, '200', '0', '', '72', '2'), exitCode: 0 };
  });
  assert.equal(result.ok, false);
  assert.equal(result.publicUrl, undefined);
  assert.match(result.error ?? '', /migration placeholder/);
  assert.equal(result.httpCode, '200');
});

test('an app body that merely contains the migration marker is NOT a migration placeholder', async () => {
  // The probe body echo (DB_TUNNEL_BODY) is app content — a Chinese app page
  // legitimately containing 服务已迁移 in its first bytes must not be
  // misdiagnosed as a retired pre-migration gateway URL.
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  const appMarker = await exposeViaSeam(
    healthyOneShot(url, verifyStdout('200'), '欢迎！本服务已迁移到新域名。'),
    8080,
    { keepalive: false },
  );
  assert.equal(appMarker.ok, true);
  assert.equal(appMarker.publicUrl, url);
  assert.equal(appMarker.persistent, true);
  assert.equal(appMarker.warnings, undefined);
});

test('quota (10006) on the final attempt also returns ok:false with the quota warning', async () => {
  const { calls, seam } = recordingSeam(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_FILE\n', exitCode: 0 };
    }
    // Both attempts report quota exhausted and an unreachable URL.
    return { stdout: exposeStdout('', '000', '1') + '\n10006 quota exceeded', exitCode: 0 };
  });
  const result = await exposeViaSeam(seam, '8081', { keepalive: false });
  assert.equal(result.ok, false);
  assert.match(result.warnings ?? '', /10006/);
  assert.equal(result.port, 8081);
  assert.equal(calls.length, 4); // auth → expose ×2 (no cleanup between quota retries) → #998 version read-back
});

test('validateExpiryHours accepts 1..720 and rejects everything else (U16)', () => {
  assert.equal(validateExpiryHours(1), 1);
  assert.equal(validateExpiryHours(720), 720);
  assert.equal(validateExpiryHours('72'), 72, 'numeric strings coerce');
  for (const bad of [0, -1, 721, 1.5, NaN, Infinity, 'abc', undefined, null]) {
    assert.throws(() => validateExpiryHours(bad), /invalid expiry_hours/, `must reject ${String(bad)}`);
  }
});

test('validateTunnelId keeps shell metacharacters out of the splice (U16)', () => {
  assert.equal(validateTunnelId('nv2dvv6w'), 'nv2dvv6w');
  assert.equal(validateTunnelId('a-b_C9'), 'a-b_C9');
  for (const bad of ['rm -rf /', 'a;b', '', 'ab', 'x'.repeat(33)]) {
    assert.throws(() => validateTunnelId(bad), /invalid tunnel_id/, `must reject ${JSON.stringify(bad)}`);
  }
});

test('buildDevbridgeRenewScript splices the validated id/hours and reads back the expiration (U16)', () => {
  const script = buildDevbridgeRenewScript('nv2dvv6w', 720);
  assert.match(script, /devbridge update nv2dvv6w -e 720/);
  assert.match(script, /DB_EXPIRATION=\$\(devbridge show nv2dvv6w -v/);
  assert.match(script, /echo "DB_RENEW_EXIT=\$DB_RENEW_EXIT"/);
  assert.match(script, /export PATH="\/workspace\/\.local\/bin:\$HOME\/\.huawei\/bin:\$PATH"/, '#999 data-disk PATH');
  // Shell metacharacters never reach the splice.
  assert.throws(() => buildDevbridgeRenewScript('a;touch /tmp/pwned'), /invalid tunnel_id/);
});

test('parseDevbridgeRenewOutput: ok requires exit 0 AND the absolute expiration (U16)', () => {
  const good = parseDevbridgeRenewOutput(
    ['DB_RENEW_EXIT=0', 'DB_RENEW_ID=nv2dvv6w', 'DB_RENEW_HOURS=720', 'DB_EXPIRATION=1795022391'].join('\n'),
  );
  assert.equal(good.ok, true);
  assert.equal(good.tunnelId, 'nv2dvv6w');
  assert.equal(good.renewedForHours, 720);
  assert.equal(good.expirationUnix, 1795022391);
  assert.equal(good.expiresAt, new Date(1795022391 * 1000).toISOString());
  // The management-plane loss trap: exit 0 with no expiration = not ok.
  const lostRecord = parseDevbridgeRenewOutput('DB_RENEW_EXIT=0\nDB_EXPIRATION=\nDB_RENEW_ERROR=');
  assert.equal(lostRecord.ok, false, 'exit 0 alone must not read as renewal success');
  const failed = parseDevbridgeRenewOutput('DB_RENEW_EXIT=1\nDB_RENEW_ERROR=10002 tunnel not found\nDB_EXPIRATION=');
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? '', /10002 tunnel not found/);
  // #946 noise tolerance.
  const noisy = parseDevbridgeRenewOutput(
    '\x1b]133;C\x07DB_RENEW_EXIT=0\r\n\x1b]133;C\x07DB_EXPIRATION=1795022391\r\n',
  );
  assert.equal(noisy.ok, true);
});

test('buildDevbridgeKeepaliveScript: 3-layer loop, hardcoded URLs, --noproxy health check (U16)', () => {
  const script = buildDevbridgeKeepaliveScript([
    { tunnelId: 'nv2dvv6w', url: 'https://nv2dvv6w-8080.devbridge-s2.hwtunnel.com' },
  ]);
  // Layer 1: host re-attach keyed on the tunnel-specific pgrep.
  assert.match(script, /pgrep -f "devbridge host \$ID"/);
  assert.match(script, /pgrep -f "devbridge host -p \$PORT"/, 'the -p form expose launched must be probed too');
  assert.match(script, /setsid nohup devbridge host "\$ID"/);
  // Layer 2: daily 720h renewal.
  assert.match(script, /devbridge update "\$ID" -e 720/);
  assert.match(script, /86400/);
  // Layer 3: 5-min health check with the U11 landmine fix.
  assert.match(script, /HC=\$\(curl -s --noproxy '\*' -o \/dev\/null/);
  assert.match(script, /sleep 300/);
  // URLs hardcoded (the OSC trap doctrine), data-disk PATH.
  assert.match(
    script,
    /TUNNELS="nv2dvv6w:https:\/\/nv2dvv6w-8080\.devbridge-s2\.hwtunnel\.com:8080"/,
    'the entry carries id:url:port (the dual-form probe needs the port)',
  );
  assert.match(script, /export PATH="\/workspace\/\.local\/bin:\$HOME\/\.huawei\/bin:\$PATH"/);
  // Heredoc is single-quoted so the writer shell expands nothing.
  assert.match(script, /<< 'DB_KEEPALIVE_EOF'/);
  // Input validation reaches the splice.
  assert.throws(
    () => buildDevbridgeKeepaliveScript([{ tunnelId: 'a;rm', url: 'https://x.example.com' }]),
    /invalid tunnel_id/,
  );
  assert.throws(
    () => buildDevbridgeKeepaliveScript([{ tunnelId: 'aaaa1111', url: 'http://not-https.example.com' }]),
    /invalid tunnel URL/,
  );
  assert.throws(() => buildDevbridgeKeepaliveScript([]), /non-empty array/);
});
