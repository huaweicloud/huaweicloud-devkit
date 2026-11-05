import assert from 'node:assert/strict';
import test from 'node:test';

import { exposeStdout, exposeViaSeam, withAuthOk } from './devbridge-harness.ts';
import {
  buildDevbridgeAuthProbe,
  evaluateDevbridgeVersion,
  parseDevbridgeAuthOutput,
} from '../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts';

test('the auth probe reads the version in the same exec, data-disk PATH first (#998 + #999)', () => {
  const script = buildDevbridgeAuthProbe();
  assert.match(script, /DB_VERSION=\$\(devbridge version 2>\/dev\/null \| head -1\)/);
  assert.match(script, /echo "DB_VERSION=\$\{DB_VERSION\}"/);
  // #999: the auth probe itself prepends the data-disk bin dir (main's #998
  // test pinned this function-scoped; the v2 port had it only source-level).
  assert.match(script, /export PATH="\/workspace\/.local\/bin:\$HOME\/\.huawei\/bin:\$PATH"/);
});

test('parseDevbridgeAuthOutput reads the version field, OSC-noise tolerant (#998 + #946)', () => {
  const osc = '\x1b]133;C\x07';
  const parsed = parseDevbridgeAuthOutput(`${osc}DB_VERSION=0.1.13-release\n${osc}DB_AUTH_MODE=API_KEY_FILE\n`);
  assert.equal(parsed.version, '0.1.13-release');
  assert.equal(parsed.authMode, 'API_KEY_FILE');
  assert.equal(parseDevbridgeAuthOutput('DB_AUTH_MODE=API_KEY_KEYRING\n').version, '', 'absent version parses empty');
});

test('evaluateDevbridgeVersion blocks 0.1.x with devbridge_too_old + remediation (#998)', () => {
  const blocked = evaluateDevbridgeVersion('0.1.13-release');
  assert.equal(blocked.blocked, true);
  assert.match(blocked.error ?? '', /devbridge_too_old/);
  assert.match(blocked.error ?? '', /0\.1\.13-release/);
  assert.match(blocked.remediation ?? '', /Step 0/);
  assert.match(blocked.remediation ?? '', /workspace\/\.local\/bin/);
  // v2 divergence: the remediation carries the -p data-disk prefix (#999).
  assert.match(blocked.remediation ?? '', /install\.sh -s -p \/workspace\/\.local\/bin/);

  // Boundary rows: the terminator class is load-bearing — bare ^0\.1 would
  // mis-block a future 0.10.x (semver-newer than 0.2); the v-tolerance keeps a
  // hypothetical v-prefixed tag from slipping.
  assert.equal(evaluateDevbridgeVersion('0.1').blocked, true, 'bare 0.1 is the dead line');
  assert.equal(evaluateDevbridgeVersion('0.10.0').blocked, false, '0.10.x is semver-newer than 0.2 — must pass');
  assert.equal(evaluateDevbridgeVersion('v0.1.13').blocked, true, 'v-prefixed 0.1.x must not slip');
  assert.equal(evaluateDevbridgeVersion('0.2.2-release').blocked, false);
  assert.equal(evaluateDevbridgeVersion('').blocked, false, 'absent binary must not block — auth handles it');
  assert.equal(evaluateDevbridgeVersion(undefined).blocked, false);
});

test('exposeTunnel blocks 0.1.x BEFORE the expose loop — auth green-light is not enough (#998)', async () => {
  let exposeCalls = 0;
  const result = await exposeViaSeam(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      // 0.1.x: the keyring tier still logs in — the auth alone would pass.
      return { stdout: 'DB_VERSION=0.1.13-release\nDB_AUTH_MODE=API_KEY_KEYRING\n', exitCode: 0 };
    }
    if (command.includes('pkill -f "devbridge host"')) {
      exposeCalls += 1;
    }
    return { stdout: '', exitCode: 0 };
  });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'devbridge_too_old');
  assert.equal(result.version, '0.1.13-release');
  assert.match(result.error ?? '', /服务已迁移/);
  assert.match(result.remediation ?? '', /Step 0/);
  assert.equal(exposeCalls, 0, 'the expose script must never run for a 0.1.x binary');
});

test('#998 read-back rescues a no-URL failure when the auth probe lost the version (#998)', async () => {
  // The gate's blind spot: the probe's DB_VERSION line lost (e.g. to OSC
  // noise), auth green — the read-back catches the 0.1.x on the final attempt.
  const result = await exposeViaSeam(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_KEYRING\n', exitCode: 0 };
    }
    if (command.includes('devbridge version')) {
      // #946 shell shape: OSC-wrapped DB_VERSION field — the read-back must
      // strip before the anchored parse.
      return { stdout: '\x1b]133;C\x07DB_VERSION=0.1.13-release\r\n', exitCode: 0 };
    }
    return { stdout: exposeStdout('', '000'), exitCode: 0 };
  });
  assert.equal(result.error_code, 'devbridge_too_old');
  assert.equal(result.version, '0.1.13-release', 'the version field must be clean, not escape-laden');
  assert.match(result.remediation ?? '', /Step 0/);
  assert.match(result.warnings ?? '', /too old to serve tunnels/);
});

test('#998 the too_old gate precedes the auth check — the combined case keeps BOTH diagnoses (#998)', async () => {
  const result = await exposeViaSeam(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_VERSION=0.1.13-release\nDB_AUTH_MODE=NO_CREDENTIAL\n', exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  });
  assert.equal(result.error_code, 'devbridge_too_old');
  assert.equal(result.authMode, 'NO_CREDENTIAL');
  assert.match(result.remediation ?? '', /SEPARATE credential issue/);
});

test('#998 the URL-present-unreachable terminal class carries its own code (#998 taxonomy)', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  const result = await exposeViaSeam(
    withAuthOk(() => ({ stdout: exposeStdout(url, '000'), exitCode: 0 })),
    8080,
    { keepalive: false },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'tunnel_unreachable');
  assert.match(result.error ?? '', /no reachable public URL after retries/);
});
