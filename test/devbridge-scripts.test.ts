import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  DEVBRIDGE_HOST_EXPIRY_HOURS,
  buildDevbridgeAuthProbe,
  buildDevbridgeExposeScript,
  buildDevbridgeVerifyScript,
  parseDevbridgeAuthOutput,
  parseDevbridgeExposeOutput,
  parseDevbridgeVerifyOutput,
} from '../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts';
import { fixtureDir } from './fixture-dir.ts';

test('D: buildDevbridgeAuthProbe implements the verified waterfall (keyring → file, AK/SK removed)', () => {
  const script = buildDevbridgeAuthProbe();
  // Tier 1: keyring API Key — stderr capture (2>&1), devbridge_ prefix filter, env self-heal
  assert.match(script, /hwcloud keyring get HW_DEVBRIDGE_API_KEY 2>&1/);
  assert.match(script, /"devbridge_"\*\)/);
  assert.match(script, /DB_AUTH_MODE=API_KEY_KEYRING/);
  assert.match(script, /DBUS_SESSION_BUS_ADDRESS.*unix:path=\/run\/dbus-session/);
  assert.match(script, /HOME.*:-\/root/);
  // Tier 1 light revive: bus restart + unlocked keyring daemon, no package installs
  assert.match(script, /dbus-daemon --session/);
  assert.match(script, /gnome-keyring-daemon --unlock/);
  assert.ok(!script.includes('dnf install'), 'waterfall must not install packages at runtime');
  // AK/SK login REMOVED (2026-11-04 定稿：devbridge 认证固定 API Key)
  assert.ok(!script.includes('--access-key'), 'AK/SK login must be removed from the probe');
  assert.ok(!script.includes('AKSK_SUPPORTED'), 'AKSK_SUPPORTED mode must be removed');
  assert.ok(!script.includes('source /tmp/hw_creds.sh'), 'probe must not read STS AK/SK file for devbridge auth');
  assert.ok(!script.includes('DB_TOKEN_ARGS'), 'the dead AK/SK token-arg vocabulary must be gone');
  // Tier 2: file fallback (auto-injected or user-provided)
  assert.match(script, /source \/tmp\/hw_api_key/);
  assert.match(script, /--api-key "\$HW_API_KEY"/);
  assert.match(script, /DB_AUTH_MODE=API_KEY_FILE/);
  // All tiers verified via real login + auth status; diagnostics emitted; final failure mode
  assert.match(script, /db_login_ok\(\) \{ devbridge auth status.*Logged in/);
  assert.match(script, /DB_ATTEMPT_/);
  assert.match(script, /DB_AUTH_MODE=NO_CREDENTIAL/);
  // Secrets are not left in the environment after the probe
  assert.match(script, /unset HW_DB_KEY HW_API_KEY/);
});

test('D: parseDevbridgeAuthOutput extracts the final auth mode and per-tier attempt diagnostics', () => {
  const stdout = [
    'DB_ATTEMPT_KEYRING=no-valid-key',
    'DB_ATTEMPT_APIKEY_FILE=no-file',
    'DB_AUTH_MODE=NO_CREDENTIAL',
  ].join('\n');
  const parsed = parseDevbridgeAuthOutput(stdout);
  assert.equal(parsed.authMode, 'NO_CREDENTIAL');
  assert.equal(parsed.attempts.KEYRING, 'no-valid-key');
  assert.equal(parsed.attempts.APIKEY_FILE, 'no-file');

  const success = parseDevbridgeAuthOutput('DB_ATTEMPT_KEYRING=no-valid-key\nDB_AUTH_MODE=API_KEY_FILE\n');
  assert.equal(success.authMode, 'API_KEY_FILE');
  assert.equal(success.attempts.KEYRING, 'no-valid-key');
  assert.deepEqual(success.attempts.AKSK, undefined);

  const empty = parseDevbridgeAuthOutput('');
  assert.equal(empty.authMode, '');
  assert.deepEqual(empty.attempts, {});
});

test('D: buildDevbridgeExposeScript starts a session-surviving host with port-anchored URL extraction', () => {
  const script = buildDevbridgeExposeScript(8081);
  assert.match(script, /devbridge delete-all/);
  assert.match(script, /pkill -f "devbridge host"/);
  // #919/#922: setsid-detached launch with the guarded fallback + guarded disown,
  // 72-hour expiry echoed for the expiresAt field.
  assert.match(
    script,
    /if command -v setsid > \/dev\/null 2>&1; then setsid nohup devbridge host -p 8081 -e 72 > \/tmp\/host\.log 2>&1 < \/dev\/null & else nohup devbridge host -p 8081 -e 72 > \/tmp\/host\.log 2>&1 < \/dev\/null & fi/,
  );
  assert.match(script, /^disown 2>\/dev\/null \|\| true$/m);
  assert.doesNotMatch(script, /-e 8\b/);
  // Port-anchored extraction (multi-port hosts print one URL line per port).
  // The domain is derived from the shared constant, not hardcoded.
  assert.ok(
    script.includes('grep -oE "https://[A-Za-z0-9_-]+-8081\\.devbridge-s2\\.hwtunnel\\.com" /tmp/host.log | head -1'),
  );
  assert.match(script, /DB_TUNNEL_URL=/);
  assert.match(script, /DB_HTTP_CODE=/);
  assert.match(script, /DB_EXPIRY_HOURS=72/);
  // First 64 bytes of the probe body feed the exact gateway-error body matching
  // — newlines stripped so an app body can never line-inject later DB_ fields.
  assert.match(script, /DB_TUNNEL_BODY=\$\(head -c 64 \/tmp\/\.db_probe_body 2>\/dev\/null \| tr -d '\\r\\n'\)/);
  assert.match(script, /rm -f \/tmp\/\.db_probe_body/);
  // No `|| echo "000"`: curl's -w already prints 000 on transport failure and
  // exits non-zero, so `|| echo` CONCATENATES a second 000 → "000000", which
  // slips past every '000' sentinel check (review round 1, consensus critical).
  assert.doesNotMatch(script, /\|\| echo "000"/);
  // The default expiry is the 72h constant and is overridable.
  assert.equal(DEVBRIDGE_HOST_EXPIRY_HOURS, 72);
  const custom = buildDevbridgeExposeScript(8081, 8);
  assert.match(custom, /-e 8 /);
  assert.doesNotMatch(custom, /-e 72/);
});

test('D: buildDevbridgeVerifyScript emits a fresh-session GET with the not-found body check', () => {
  const url = 'https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com';
  const script = buildDevbridgeVerifyScript(url);
  // #1000: the verify curl must bypass the injected sandbox proxy.
  assert.ok(
    script.includes(`curl -s --noproxy '*' -o /tmp/devbridge_verify_body -w "%{http_code}" --max-time 10 "${url}"`),
  );
  // Exact whole-content body match via tr (CRLF-tolerant) — NOT a grep -q form:
  // command substitution captures stdout, and -q prints none, so the verdict
  // would be stuck at "not found = no" forever (round-2 review critical).
  assert.match(script, /VERIFY_BODY=\$\(tr -d '\\r\\n' < \/tmp\/devbridge_verify_body/);
  assert.match(
    script,
    /if \[ "\$VERIFY_BODY" = 'tunnel not found' \]; then VERIFY_NOT_FOUND=1; else VERIFY_NOT_FOUND=0; fi/,
  );
  assert.match(script, /DB_VERIFY_HTTP_CODE=\$VERIFY_CODE/);
  assert.match(script, /DB_VERIFY_NOT_FOUND=\$VERIFY_NOT_FOUND/);
  assert.match(script, /rm -f \/tmp\/devbridge_verify_body/);
  // No `|| echo "000"` (same sentinel-doubling defect as the expose script).
  assert.doesNotMatch(script, /\|\| echo "000"/);
  // URL validation before the shell splice: non-https, schemes, and shell
  // metacharacters are rejected.
  for (const bad of [
    '',
    'http://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
    'https://evil.com"; rm -rf /',
    "https://evil.com'$(pwn)'",
    'ftp://x/y',
  ]) {
    assert.throws(() => buildDevbridgeVerifyScript(bad), /invalid tunnel URL/, `expected rejection for ${bad}`);
  }
  // URL-safe path characters are accepted (the tunnel URLs we build are bare,
  // but the validator must not over-reject ports and paths).
  assert.doesNotThrow(() => buildDevbridgeVerifyScript('https://host.example.com:8443/some/path'));
});

test(
  'D: the verify script body-check executes correctly under /bin/sh (behavioral pin)',
  { skip: process.platform !== 'linux' },
  () => {
    // Round-2 review found the grammar pin one-directional: a `grep -q` form
    // emitted nothing and the not-found verdict was dead code in production
    // while the suite stayed green. This pin EXECUTES the real script's body
    // logic through /bin/sh (curl stubbed, body file redirected into a
    // registered fixture dir) and parses the emitted keys with the product
    // parser — the behavior, not just the shape, is pinned. Linux-only: the CI
    // test matrix includes windows-latest, where /bin/sh does not resolve.
    const dir = fixtureDir('dbverify-');
    const bodyFile = join(dir, 'devbridge_verify_body');
    const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
    const runWithBody = (body: string | null) => {
      if (body === null) {
        writeFileSync(bodyFile, '');
      } else {
        writeFileSync(bodyFile, body);
      }
      const script = buildDevbridgeVerifyScript(url)
        .replace(/^VERIFY_CODE=.*$/m, 'VERIFY_CODE=200')
        .replaceAll('/tmp/devbridge_verify_body', bodyFile);
      return parseDevbridgeVerifyOutput(execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' }));
    };
    // The live gateway form (LF).
    assert.equal(runWithBody('tunnel not found\n').notFound, true);
    // CRLF form compares equal (tr strips \r).
    assert.equal(runWithBody('tunnel not found\r\n').notFound, true);
    // Case-sensitive doctrine: the gateway serves lowercase.
    assert.equal(runWithBody('TUNNEL NOT FOUND\n').notFound, false);
    // An app page that merely MENTIONS the phrase never trips the verdict.
    assert.equal(runWithBody('<html>Docs: handling tunnel not found errors</html>\n').notFound, false);
    // Healthy body / empty body.
    assert.equal(runWithBody('hello from the app\n').notFound, false);
    assert.equal(runWithBody(null).notFound, false);
  },
);

test('D: parseDevbridgeVerifyOutput reads the dedicated DB_VERIFY_* keys', () => {
  const parsed = parseDevbridgeVerifyOutput('DB_VERIFY_HTTP_CODE=200\nDB_VERIFY_NOT_FOUND=0\n');
  assert.equal(parsed.httpCode, '200');
  assert.equal(parsed.notFound, false);
  const notFound = parseDevbridgeVerifyOutput('DB_VERIFY_HTTP_CODE=200\nDB_VERIFY_NOT_FOUND=1\n');
  assert.equal(notFound.httpCode, '200');
  assert.equal(notFound.notFound, true);
  // The script emits 0/1 through the exact-body if/else; a missing field
  // (exec died before emitting) must not read as found.
  const zero = parseDevbridgeVerifyOutput('DB_VERIFY_HTTP_CODE=404\nDB_VERIFY_NOT_FOUND=0\n');
  assert.equal(zero.notFound, false);
  const empty = parseDevbridgeVerifyOutput('');
  assert.equal(empty.httpCode, '');
  assert.equal(empty.notFound, false);
  // #946: OSC/CSI escapes and \r must not blind the anchored lookups. The
  // assertion is non-vacuous: the ?2026h-prefixed line carries a NON-default
  // value (HTTP 404) — a stripper gap that blinds the lookup fails here,
  // instead of silently reading the field's default.
  const noisy = parseDevbridgeVerifyOutput(
    '\x1b[?2026hDB_VERIFY_HTTP_CODE=404\r\n\x1b]133;C\x07DB_VERIFY_NOT_FOUND=1\r\n',
  );
  assert.equal(noisy.httpCode, '404', 'private-mode CSI (?2026h) must be stripped');
  assert.equal(noisy.notFound, true, 'OSC-prefixed field must be stripped and read');
});

test('D: parseDevbridgeExposeOutput extracts the full field set from a healthy expose', () => {
  const stdout = [
    'DB_HOST_LOG=',
    'some log line',
    'Tunnel URL: https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
    'DB_PROBE_1=502',
    'DB_PROBE_2=200',
    'DB_TUNNEL_URL=https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
    'DB_HTTP_CODE=200',
    'DB_EXPIRY_HOURS=72',
    'DB_TUNNEL_BODY=',
    'DB_QUOTA_ERROR=0',
  ].join('\n');
  assert.deepEqual(parseDevbridgeExposeOutput(stdout), {
    tunnelUrl: 'https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
    httpCode: '200',
    quotaError: false,
    tunnelId: 'c4rdv7bv',
    expiryHours: 72,
    gatewayTunnelError: false,
    badGateway: false,
    migration: false,
    probes: [
      { attempt: 1, httpCode: '502' },
      { attempt: 2, httpCode: '200' },
    ],
  });
});

test('D: parseDevbridgeExposeOutput classifies gateway-level tunnel errors by exact body + status', () => {
  // 404 "tunnel not found" — the gateway itself reports the tunnel dead.
  const notFound = parseDevbridgeExposeOutput(
    [
      'DB_TUNNEL_URL=https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
      'DB_HTTP_CODE=404',
      'DB_TUNNEL_BODY=tunnel not found',
      'DB_QUOTA_ERROR=0',
    ].join('\n'),
  );
  assert.equal(notFound.gatewayTunnelError, true);
  assert.equal(notFound.badGateway, false);
  // 404 "port not configured" — same family.
  const portMissing = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=404', 'DB_TUNNEL_BODY=port not configured', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(portMissing.gatewayTunnelError, true);
  // 502 "bad gateway" — tunnel alive, local service down.
  const badGateway = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=502', 'DB_TUNNEL_BODY=bad gateway', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(badGateway.gatewayTunnelError, false);
  assert.equal(badGateway.badGateway, true);
  // The app's own 404/502 pages are NEVER misjudged: different body, or the
  // right body under the wrong status.
  const appNotFound = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=404', 'DB_TUNNEL_BODY=<html>404 Not Found</html>', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(appNotFound.gatewayTunnelError, false);
  const bodyUnderWrongStatus = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=200', 'DB_TUNNEL_BODY=tunnel not found', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(bodyUnderWrongStatus.gatewayTunnelError, false);
  const notFoundUnder500 = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=500', 'DB_TUNNEL_BODY=tunnel not found', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(notFoundUnder500.gatewayTunnelError, false);
  // A longer body (truncated at 64 bytes) that merely CONTAINS the marker is
  // not the exact text/plain form.
  const padded = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=404', 'DB_TUNNEL_BODY=tunnel not found — please retry later', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(padded.gatewayTunnelError, false);
});

test('D: parseDevbridgeExposeOutput flags quota error 10006', () => {
  const stdout = ['DB_TUNNEL_URL=', 'DB_HTTP_CODE=000', 'DB_QUOTA_ERROR=1', 'tail: 10006 quota exceeded'].join('\n');
  const parsed = parseDevbridgeExposeOutput(stdout);
  assert.equal(parsed.quotaError, true);
  assert.equal(parsed.tunnelUrl, '');
});

test('D: quota and migration verdicts are count-robust (grep -c line counts, not booleans)', () => {
  // grep -c prints the number of matching LINES — a retrying host can log the
  // marker several times; `=== '1'` parsing would silently flip the verdict.
  const quotaTwice = parseDevbridgeExposeOutput('DB_QUOTA_ERROR=2\nDB_MIGRATION=0\n');
  assert.equal(quotaTwice.quotaError, true);
  const migrationTwice = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=200', 'DB_MIGRATION=2', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(migrationTwice.migration, true);
  // Zero and missing fields stay negative.
  assert.equal(parseDevbridgeExposeOutput('DB_QUOTA_ERROR=0\nDB_MIGRATION=0\n').quotaError, false);
  assert.equal(parseDevbridgeExposeOutput('DB_QUOTA_ERROR=\nDB_MIGRATION=\n').migration, false);
});

test('D: the flattened probe body cannot spoof verdicts (tr strips newlines script-side)', () => {
  // The script echoes DB_TUNNEL_BODY with \r/\n stripped, so an app body whose
  // first 64 bytes contain "tunnel not found\nDB_MIGRATION=1" arrives as ONE
  // flat value — no second line exists to spoof the migration verdict, and the
  // flat value no longer equals the exact marker.
  const spoof = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=404', 'DB_TUNNEL_BODY=tunnel not foundDB_MIGRATION=1', 'DB_QUOTA_ERROR=0', 'DB_MIGRATION=0'].join(
      '\n',
    ),
  );
  assert.equal(spoof.gatewayTunnelError, false);
  assert.equal(spoof.migration, false);
  // A multi-line app 404 whose FIRST line is the marker also fails the exact
  // match once flattened (the continuation bytes are part of the value).
  const multiLine = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=404', 'DB_TUNNEL_BODY=tunnel not found<html>…', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(multiLine.gatewayTunnelError, false);
});

test('D: parseDevbridgeExposeOutput tolerates empty host log (no tunnel yet)', () => {
  const parsed = parseDevbridgeExposeOutput('DB_HOST_LOG=\nDB_TUNNEL_URL=\nDB_HTTP_CODE=\nDB_QUOTA_ERROR=0');
  assert.equal(parsed.tunnelUrl, '');
  assert.equal(parsed.httpCode, '');
  assert.equal(parsed.tunnelId, '');
  assert.equal(parsed.expiryHours, undefined);
});

test('D: parseDevbridgeExposeOutput and the auth parser survive OSC/CSI-wrapped output (#946)', () => {
  // Integration-enabled shells wrap EVERY line in OSC 133 markers — without
  // stripping, every anchored ^DB_ lookup comes back empty and a good tunnel
  // reads as missing.
  const noisy = [
    '\x1b]133;C\x07DB_TUNNEL_URL=https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com\r',
    '\x1b]133;C\x07DB_HTTP_CODE=200\r',
    '\x1b]133;C\x07DB_EXPIRY_HOURS=72\r',
    '\x1b]133;C\x07DB_QUOTA_ERROR=0\r',
  ].join('\n');
  const parsed = parseDevbridgeExposeOutput(noisy);
  assert.equal(parsed.tunnelUrl, 'https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com');
  assert.equal(parsed.httpCode, '200');
  assert.equal(parsed.expiryHours, 72);
  const noisyAuth = parseDevbridgeAuthOutput(
    '\x1b]133;C\x07DB_ATTEMPT_KEYRING=no-valid-key\r\n\x1b]133;C\x07DB_AUTH_MODE=API_KEY_FILE\r\n',
  );
  assert.equal(noisyAuth.authMode, 'API_KEY_FILE');
  assert.equal(noisyAuth.attempts.KEYRING, 'no-valid-key');
});
