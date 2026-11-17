import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { fixtureDir } from './fixture-dir.ts';
import { gatedAuthSwitchCall } from './cred-reconcile-harness.ts';
import {
  clearRuntimeCredentials,
  resolveCredentialsWithRuntime,
  setRuntimeCredentials,
} from '../plugins/huaweicloud-core/src/auth/credentials.ts';

// Deterministic-tier seam: disable the once-per-session first-assertion
// vendor challenge (HUAWEICLOUD_VENDOR_CHALLENGE=off, the installer-override
// pattern). In the pre-split tools.test.ts the in-file gate test cleared
// the challenge before these blocks ran; as an own-process suite part the
// seam is the deterministic equivalent. The dance itself stays pinned where
// it is the subject (tools.test.ts's gate test; the selfcheck on the wire).
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

interface AuthSwitchResult {
  status: string;
  scope?: string;
  error?: string;
}

test('auth_switch temporary sets runtime credentials for api path', async () => {
  const prev = {
    AK: process.env.HW_ACCESS_KEY,
    SK: process.env.HW_SECRET_KEY,
  };
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  try {
    const out = (await gatedAuthSwitchCall({
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'memory',
      action: 'temporary',
      ak: 'RUNTIME_AK',
      sk: 'RUNTIME_SK',
      region: 'cn-north-4',
    })) as AuthSwitchResult;
    assert.equal(out.scope, 'temporary');
    const resolved = resolveCredentialsWithRuntime({});
    assert.equal(resolved!.ak, 'RUNTIME_AK');
  } finally {
    clearRuntimeCredentials();
    if (prev.AK === undefined) delete process.env.HW_ACCESS_KEY;
    else process.env.HW_ACCESS_KEY = prev.AK;
    if (prev.SK === undefined) delete process.env.HW_SECRET_KEY;
    else process.env.HW_SECRET_KEY = prev.SK;
  }
});

test('auth_switch clear resets runtime', async () => {
  const isolatedHome = fixtureDir('huaweicloud-auth-clear-');
  const prevHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = isolatedHome;
  try {
    setRuntimeCredentials('A', 'B', undefined, 'cn-north-4');
    const out = (await gatedAuthSwitchCall({
      vendorConfirmed: 'test: vendor established by the harness',
      action: 'clear',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'cleared');
    let threw = false;
    try {
      resolveCredentialsWithRuntime({});
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = prevHome;
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

// Hand-rolled HUAWEICLOUD_HOME isolation for the import-file tests: set a
// fixture home, run, and restore (with the runtime store cleared either way).
async function withImportHome(fn: () => Promise<void>): Promise<void> {
  const home = fixtureDir('auth-import-case-');
  const prevHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = home;
  try {
    await fn();
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = prevHome;
    clearRuntimeCredentials();
    rmSync(home, { recursive: true, force: true });
  }
}

// Seed a creds-import.json under the isolated home.
function seedImportFile(ak: string, sk: string): { cfgDir: string; importFile: string } {
  const cfgDir = join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud');
  mkdirSync(cfgDir, { recursive: true });
  const importFile = join(cfgDir, 'creds-import.json');
  writeFileSync(importFile, JSON.stringify({ ak, sk }), 'utf8');
  return { cfgDir, importFile };
}

test('auth_switch persist(mode=import) without a region refuses before consent and keeps the import file (#502)', async () => {
  await withImportHome(async () => {
    const { cfgDir, importFile } = seedImportFile('IMPORT_AK', 'IMPORT_SK');

    // Round 2 closed the recorded round-1 residual on the assert route:
    // the regionless persist is a doomed shape, so the gate refuses it
    // before any consent (NoDoomedToken) — the human is never asked to
    // approve a call the handler answers invalid_region on. The import
    // file survives the gate's peek, so the operator can add the region
    // and retry.
    await assert.rejects(
      () =>
        gatedAuthSwitchCall({
          vendorConfirmed: 'test: vendor established by the harness',
          mode: 'import',
          action: 'persist',
        }),
      /region is required to persist credentials/,
    );

    assert.equal(existsSync(join(cfgDir, 'credentials.json')), false, 'S1 must not be written');
    assert.equal(existsSync(importFile), true, 'import file must survive for replay (#502)');
  });
});

test('auth_switch temporary(mode=import) clears import file on success', async () => {
  await withImportHome(async () => {
    const { importFile } = seedImportFile('TMP_AK', 'TMP_SK');

    const out = (await gatedAuthSwitchCall({
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'import',
      action: 'temporary',
    })) as AuthSwitchResult;

    assert.equal(out.scope, 'temporary');
    assert.equal(existsSync(importFile), false, 'import file should be cleared after successful temporary set');
    assert.equal(resolveCredentialsWithRuntime({})!.ak, 'TMP_AK');
  });
});

test('auth_switch persist(mode=import) with STS token is refused before consent (R3) and the import file survives', async () => {
  const home = fixtureDir('auth-import-sts-');
  const prevHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = home;
  try {
    const cfgDir = join(home, '.config', 'huaweicloud');
    mkdirSync(cfgDir, { recursive: true });
    const importFile = join(cfgDir, 'creds-import.json');
    writeFileSync(
      importFile,
      JSON.stringify({ ak: 'STS_AK', sk: 'STS_SK', securityToken: 'STS_TOK', region: 'cn-north-4' }),
      'utf8',
    );

    // PR-3b NoDoomedToken: the gate refuses the STS-persist shape before
    // any consent, so the R3 answer is a gate throw and the peeked file
    // stays — the same credentials remain replayable for action=temporary,
    // where the STS token is legitimate.
    await assert.rejects(
      () =>
        gatedAuthSwitchCall({
          vendorConfirmed: 'test: vendor established by the harness',
          mode: 'import',
          action: 'persist',
        }),
      /R3/,
    );
    assert.equal(
      existsSync(importFile),
      true,
      'the gate peeks without wiping: a refused call leaves the import file for the temporary retry',
    );
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = prevHome;
    clearRuntimeCredentials();
    rmSync(home, { recursive: true, force: true });
  }
});
