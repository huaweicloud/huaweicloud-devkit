import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';
import { clearCustodyCache } from '../plugins/huaweicloud-core/src/lib/secret-vault/custody.ts';
import { vaultSet } from '../plugins/huaweicloud-core/src/lib/secret-vault/store.ts';
import {
  readGlobalCredentials,
  resolveCredentials,
  setConfiguredBySession,
  writeGlobalCredentials,
} from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { fingerprint, scanState } from '../plugins/huaweicloud-core/src/auth/reconcile.ts';
import { computeOnboarding, getAuthStatus, syncAuth } from '../plugins/huaweicloud-core/src/auth/service.ts';
import { persistCredentials } from '../plugins/huaweicloud-core/src/lib/credentials.ts';

// Phase-4 consumer integration: S1 holds secret:// refs, and every value
// consumer resolves them through the shared seam — the resolver, the
// fingerprint scan, the S2/S3 sync fan-out, and the flag-preserving
// read-modify-write. The invariant under test: no raw `secret://` string
// propagates into ~/.obsutilconfig or a fingerprint, and no plaintext lands
// anywhere it did not already land before the vault existed.

const AK_REF = 'secret://user/hw-ak';
const SK_REF = 'secret://user/hw-sk';
const AK_PLAINTEXT = 'AKPLAIN-7c31';
const SK_PLAINTEXT = 'SKPLAIN-91af';

function withVaultHome(fn: (home: string) => void): void {
  const home = fixtureDir('secret-vault-creds-');
  const previous = {
    HUAWEICLOUD_HOME: process.env.HUAWEICLOUD_HOME,
    HCLOUD_OBS_CONFIG_PATH: process.env.HCLOUD_OBS_CONFIG_PATH,
    HW_ACCESS_KEY: process.env.HW_ACCESS_KEY,
    HW_SECRET_KEY: process.env.HW_SECRET_KEY,
    HW_SECURITY_TOKEN: process.env.HW_SECURITY_TOKEN,
    HW_REGION: process.env.HW_REGION,
    HUAWEICLOUD_REGION: process.env.HUAWEICLOUD_REGION,
    HW_VAULT_MASTER_KEY: process.env.HW_VAULT_MASTER_KEY,
  };
  process.env.HUAWEICLOUD_HOME = home;
  process.env.HCLOUD_OBS_CONFIG_PATH = join(home, '.obsutilconfig');
  process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x44).toString('base64');
  for (const key of ['HW_ACCESS_KEY', 'HW_SECRET_KEY', 'HW_SECURITY_TOKEN', 'HW_REGION', 'HUAWEICLOUD_REGION']) {
    delete process.env[key];
  }
  clearCustodyCache();
  try {
    return fn(home);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearCustodyCache();
  }
}

function seedVaultAndS1(): void {
  vaultSet(AK_REF, AK_PLAINTEXT);
  vaultSet(SK_REF, SK_PLAINTEXT);
  writeGlobalCredentials({ ak: AK_REF, sk: SK_REF, region: 'cn-north-4' });
}

test('resolveCredentials decrypts secret:// refs stored in S1', () => {
  withVaultHome(() => {
    seedVaultAndS1();
    const resolved = resolveCredentials();
    assert.ok(resolved, 'resolveCredentials must throw, not return null, when credentials exist');
    assert.equal(resolved.ak, AK_PLAINTEXT);
    assert.equal(resolved.sk, SK_PLAINTEXT);
    assert.equal(resolved.region, 'cn-north-4');
    assert.equal(resolved.securityToken, '');
  });
});

test('an unresolvable S1 ref fails loud instead of falling through to env', () => {
  withVaultHome(() => {
    vaultSet(AK_REF, AK_PLAINTEXT);
    writeGlobalCredentials({ ak: AK_REF, sk: 'secret://user/never-stored', region: 'cn-north-4' });
    assert.throws(() => resolveCredentials(), /is not stored in the vault/);
  });
});

test('scanState fingerprints the resolved values and surfaces ref errors', () => {
  withVaultHome(() => {
    seedVaultAndS1();
    const state = scanState();
    assert.equal(state.s1RefError, null);
    assert.equal(state.stores.s1Fingerprint, fingerprint(AK_PLAINTEXT, SK_PLAINTEXT));

    writeGlobalCredentials({ ak: AK_REF, sk: 'secret://user/gone', region: 'cn-north-4' });
    const broken = scanState();
    assert.match(broken.s1RefError ?? '', /is not stored in the vault/);
    assert.equal(broken.stores.s1Fingerprint, '');
  });
});

test('syncAuth fans resolved values into ~/.obsutilconfig, never the ref strings', () => {
  withVaultHome((home) => {
    seedVaultAndS1();
    const result = syncAuth();
    // hcloud may be absent on the test machine; the OBS write happens before
    // the KooCLI probe either way — what matters is the file content.
    assert.notEqual(result.ok, undefined);
    const obs = readFileSync(join(home, '.obsutilconfig'), 'utf8');
    assert.match(obs, new RegExp(`^ak=${AK_PLAINTEXT}$`, 'm'));
    assert.match(obs, new RegExp(`^sk=${SK_PLAINTEXT}$`, 'm'));
    assert.doesNotMatch(obs, /secret:\/\//);
  });
});

test('setConfiguredBySession preserves the refs in the S1 file', () => {
  withVaultHome(() => {
    seedVaultAndS1();
    setConfiguredBySession(true);
    const stored = readGlobalCredentials();
    assert.equal(stored?.ak, AK_REF);
    assert.equal(stored?.sk, SK_REF);
    assert.equal(stored?.configuredBySession, true);
    const resolved = resolveCredentials();
    assert.ok(resolved, 'resolveCredentials must throw, not return null, when credentials exist');
    assert.equal(resolved.ak, AK_PLAINTEXT);
    assert.equal(resolved.sk, SK_PLAINTEXT);
  });
});

test('plaintext S1 files keep working unchanged (no regression through the seam)', () => {
  withVaultHome(() => {
    writeGlobalCredentials({ ak: 'AKLegacy123', sk: 'SKLegacy456', region: 'cn-north-4' });
    const resolved = resolveCredentials();
    assert.ok(resolved, 'resolveCredentials must throw, not return null, when credentials exist');
    assert.equal(resolved.ak, 'AKLegacy123');
    assert.equal(resolved.sk, 'SKLegacy456');
    const state = scanState();
    assert.equal(state.s1RefError, null);
    assert.equal(state.stores.s1Fingerprint, fingerprint('AKLegacy123', 'SKLegacy456'));
  });
});

test('auth_switch persist with identical resolved values keeps the refs in S1', () => {
  withVaultHome(() => {
    seedVaultAndS1();
    // The incoming values equal what the S1 refs resolve to: the persist
    // path must sync the mirrors WITHOUT downgrading S1 to plaintext.
    const result = persistCredentials(AK_PLAINTEXT, SK_PLAINTEXT, '', 'cn-north-4');
    assert.ok(result.status === 'ok' || result.status === 'partial', JSON.stringify(result));
    const stored = readGlobalCredentials();
    assert.equal(stored?.ak, AK_REF, 'S1 keeps the ref representation');
    assert.equal(stored?.sk, SK_REF, 'S1 keeps the ref representation');
    const resolved = resolveCredentials();
    assert.ok(resolved);
    assert.equal(resolved.ak, AK_PLAINTEXT);
    assert.equal(resolved.sk, SK_PLAINTEXT);
    // Changed values still win: a persist with different plaintext replaces the refs.
    const rotated = persistCredentials('AKNEW-11', 'SKNEW-22', '', 'cn-north-4');
    assert.ok(rotated.status === 'ok' || rotated.status === 'partial');
    assert.equal(readGlobalCredentials()?.ak, 'AKNEW-11');
  });
});

test('computeOnboarding annotates (not hides) a broken S1 vault link', () => {
  withVaultHome(() => {
    seedVaultAndS1();
    writeGlobalCredentials({ ak: AK_REF, sk: 'secret://user/gone', region: 'cn-north-4' });
    const onboarding = computeOnboarding({});
    assert.match(onboarding.message, /secret:\/\/.*无法解析|cannot be resolved/);
    assert.equal(onboarding.accountHint, null, 'the raw-ref fingerprint must not pose as an account hint');
    assert.ok(onboarding.steps.some((step) => step.action === 'fix-vault'));
    // The status surface carries the failure for printers to render.
    const status = getAuthStatus('all') as { reconciled: { s1RefError: string | null } };
    assert.match(status.reconciled.s1RefError ?? '', /is not stored in the vault/);
  });
});

test('persistCredentials resolves incoming ref strings before the mirror fan-out', () => {
  withVaultHome((home) => {
    seedVaultAndS1();
    const result = persistCredentials(AK_REF, SK_REF, '', 'cn-north-4');
    assert.ok(result.status === 'ok' || result.status === 'partial', JSON.stringify(result));
    const obs = readFileSync(join(home, '.obsutilconfig'), 'utf8');
    assert.match(obs, new RegExp(`^ak=${AK_PLAINTEXT}$`, 'm'));
    assert.match(obs, new RegExp(`^sk=${SK_PLAINTEXT}$`, 'm'));
    assert.doesNotMatch(obs, /secret:\/\//);
    // S1 keeps the ref representation (preserveRefForm): the incoming refs
    // resolve to the values the stored refs resolve to.
    const stored = readGlobalCredentials();
    assert.equal(stored?.ak, AK_REF);
    assert.equal(stored?.sk, SK_REF);
  });
});
