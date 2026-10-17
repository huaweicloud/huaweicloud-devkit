import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { fixtureDir } from './fixture-dir.ts';
import {
  clearCustodyCache,
  custodyReport,
  ensureMasterKey,
  resolveMasterKey,
  VaultCustodyError,
} from '../plugins/huaweicloud-core/src/lib/secret-vault/custody.ts';
import {
  resolveSecretValue,
  vaultDelete,
  vaultGet,
  vaultList,
  vaultSet,
  VaultError,
} from '../plugins/huaweicloud-core/src/lib/secret-vault/store.ts';
import { isSecretRef, parseSecretRef } from '../plugins/huaweicloud-core/src/lib/secret-vault/refs.ts';

// The vault contracts, driven through the public functions against temp
// roots. Keychain tiers run against injected fake spawners (the secret-tool /
// security / powershell contracts); the keyfile tier is exercised for real.

const ENOENT_SPAWN = (() => {
  const impl = () => ({
    status: null,
    stdout: '',
    stderr: '',
    error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException,
  });
  return impl as unknown as typeof spawnSync;
})();

function fakeKeychainSpawn(stored: { b64?: string } = {}, failureStderr?: string) {
  const impl = (
    _command: string,
    args: string[],
    options: { input?: Buffer | string },
  ): { status: number | null; stdout: string; stderr: string } => {
    const input = options.input === undefined ? '' : Buffer.from(options.input).toString('utf8');
    if (args[0] === 'lookup') {
      if (failureStderr !== undefined) return { status: 1, stdout: '', stderr: failureStderr };
      // The secret-tool contract: a silent non-zero exit is not-found.
      if (stored.b64 === undefined) return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: `${stored.b64}\n`, stderr: '' };
    }
    if (args[0] === 'store') {
      stored.b64 = input.trim();
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected args: ${args.join(' ')}` };
  };
  return impl as unknown as typeof spawnSync;
}

function freshRoot(): string {
  const root = fixtureDir('secret-vault-');
  clearCustodyCache(root);
  return root;
}

// Every store test injects the ENOENT spawner so a dev machine with a real
// secret-tool never gains a devkit vault-master key from the test run.
function opts(root: string): { root: string; spawnImpl: typeof spawnSync } {
  return { root, spawnImpl: ENOENT_SPAWN };
}

function vaultErrorCode(error: unknown): string {
  return error instanceof VaultError || error instanceof VaultCustodyError ? error.code : String(error);
}

test('refs: grammar accepts the canonical shape only', () => {
  assert.deepEqual(parseSecretRef('secret://user/hw-ak'), { scope: 'user', name: 'hw-ak' });
  assert.equal(isSecretRef('secret://devteam/prod-token'), true);
  for (const bad of [
    'secret://User/hw-ak',
    'secret://user/HW-AK',
    'secret://user/../etc/passwd',
    'secret://user/a%2Fb',
    'secret://user:8080/ak',
    'secret://user/ak/inner',
    'secret://user',
    'secret://user/',
    'secret://lock/foo',
    'SECRET://user/ak',
    'hw-ak',
    '',
  ]) {
    assert.equal(parseSecretRef(bad), null, `"${bad}" must be rejected`);
    assert.equal(isSecretRef(bad), false, `"${bad}" must fail the type guard`);
  }
  const longSegment = 'a'.repeat(64);
  assert.deepEqual(parseSecretRef(`secret://user/${longSegment}`), { scope: 'user', name: longSegment });
  assert.equal(parseSecretRef(`secret://user/${'a'.repeat(65)}`), null);
});

test('store: set/get round-trips through the keyfile tier', () => {
  const root = freshRoot();
  const result = vaultSet('secret://user/hw-sk', 'SKVALUE-abc123', 'main account', opts(root));
  assert.equal(result.status, 'set');
  assert.equal(result.version, 1);
  const read = vaultGet('secret://user/hw-sk', opts(root));
  assert.equal(read.value, 'SKVALUE-abc123');
  assert.equal(read.note, 'main account');
  assert.equal(read.version, 1);
  assert.equal(existsSync(join(root, '.master-key')), true);
  const mode = statSync(join(root, '.master-key')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('store: idempotent set keeps the version; rotation increments it', () => {
  const root = freshRoot();
  vaultSet('secret://user/token', 'v1', undefined, opts(root));
  const again = vaultSet('secret://user/token', 'v1', undefined, opts(root));
  assert.equal(again.status, 'unchanged');
  assert.equal(again.version, 1);
  const rotated = vaultSet('secret://user/token', 'v2', undefined, opts(root));
  assert.equal(rotated.status, 'set');
  assert.equal(rotated.version, 2);
  assert.equal(vaultGet('secret://user/token', opts(root)).value, 'v2');
});

test('store: ciphertext is AAD-bound to its ref — swapping files fails decryption', () => {
  const root = freshRoot();
  vaultSet('secret://user/alpha', 'alpha-secret', undefined, opts(root));
  vaultSet('secret://user/beta', 'beta-secret', undefined, opts(root));
  const alphaPath = join(root, 'user', 'alpha.json');
  const betaPath = join(root, 'user', 'beta.json');
  writeFileSync(betaPath, readFileSync(alphaPath, 'utf8'), 'utf8');
  let caught: unknown;
  assert.throws(
    () => vaultGet('secret://user/beta', opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_DECRYPT_FAILED');
  assert.equal(vaultGet('secret://user/alpha', opts(root)).value, 'alpha-secret');
});

test('store: file contents never contain the plaintext', () => {
  const root = freshRoot();
  vaultSet('secret://user/hw-ak', 'PLAINTEXT-MARKER-9f2e', undefined, opts(root));
  const raw = readFileSync(join(root, 'user', 'hw-ak.json'), 'utf8');
  assert.doesNotMatch(raw, /PLAINTEXT-MARKER-9f2e/);
  assert.match(raw, /"format": 1/);
  assert.match(raw, /"ciphertext": "/);
});

test('store: rm is count-reporting and idempotent; get then fails loud', () => {
  const root = freshRoot();
  vaultSet('secret://user/gone', 'x', undefined, opts(root));
  assert.deepEqual(vaultDelete('secret://user/gone', opts(root)), { removed: 1 });
  assert.deepEqual(vaultDelete('secret://user/gone', opts(root)), { removed: 0 });
  let caught: unknown;
  assert.throws(
    () => vaultGet('secret://user/gone', opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_REF_NOT_FOUND');
});

test('store: list returns envelope metadata without decrypting, skips reserved and foreign dirs', () => {
  const root = freshRoot();
  vaultSet('secret://user/one', 'v1', 'note one', opts(root));
  vaultSet('secret://user/two', 'v2', undefined, opts(root));
  vaultSet('secret://ci/three', 'v3', undefined, opts(root));
  mkdirSync(join(root, 'lock'), { recursive: true });
  writeFileSync(join(root, 'lock', 'pid'), `${process.pid}\n`, 'utf8');
  mkdirSync(join(root, 'stash.dir'), { recursive: true });
  const listed = vaultList(undefined, opts(root));
  assert.deepEqual(
    listed.map((entry) => entry.ref),
    ['secret://ci/three', 'secret://user/one', 'secret://user/two'],
  );
  assert.equal(
    listed.every((entry) => entry.fingerprint.length === 16),
    true,
  );
  assert.equal(listed[1]!.note, 'note one');
  assert.equal(listed[1]!.version, 1);
  const scoped = vaultList('user', opts(root));
  assert.equal(scoped.length, 2);
  let caught: unknown;
  assert.throws(
    () => vaultList('BAD SCOPE', opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_BAD_SCOPE');
});

test('custody: env tier resolves a strict 32-byte key and rejects everything else', () => {
  const root = freshRoot();
  const previous = process.env.HW_VAULT_MASTER_KEY;
  try {
    const key = Buffer.alloc(32, 7);
    process.env.HW_VAULT_MASTER_KEY = key.toString('base64');
    const resolved = resolveMasterKey(opts(root));
    assert.equal(resolved?.tier, 'env');
    assert.equal(resolved?.key.equals(key), true);
    clearCustodyCache(root);
    process.env.HW_VAULT_MASTER_KEY = key.toString('hex');
    assert.equal(resolveMasterKey(opts(root))?.tier, 'env');
    clearCustodyCache(root);
    const invalid = ['not-a-key', Buffer.alloc(16, 1).toString('base64')];
    for (const value of invalid) {
      process.env.HW_VAULT_MASTER_KEY = value;
      let caught: unknown;
      assert.throws(
        () => resolveMasterKey(opts(root)),
        (error: unknown) => {
          caught = error;
          return true;
        },
      );
      assert.equal(vaultErrorCode(caught), 'HW_VAULT_MASTER_KEY_INVALID');
      clearCustodyCache(root);
    }
  } finally {
    if (previous === undefined) delete process.env.HW_VAULT_MASTER_KEY;
    else process.env.HW_VAULT_MASTER_KEY = previous;
    clearCustodyCache(root);
  }
});

test('custody: bootstrap converges on the keychain tier and adopts a pre-existing key', () => {
  const root = freshRoot();
  const stored: { b64?: string } = { b64: Buffer.alloc(32, 9).toString('base64') };
  const spawn = fakeKeychainSpawn(stored);
  const resolved = ensureMasterKey({ root, spawnImpl: spawn });
  assert.equal(resolved.tier, 'keychain');
  assert.equal(resolved.key.equals(Buffer.alloc(32, 9)), true);
  vaultSet('secret://user/kc', 'value-kc', undefined, { root, spawnImpl: spawn });
  const direct = resolveMasterKey({ root, spawnImpl: spawn });
  assert.equal(direct?.tier, 'keychain');
  assert.equal(vaultGet('secret://user/kc', { root, spawnImpl: spawn }).value, 'value-kc');
  assert.equal(existsSync(join(root, '.master-key')), false);
});

test('custody: bootstrap writes the keyfile tier when no keychain tool exists', () => {
  const root = freshRoot();
  const resolved = ensureMasterKey(opts(root));
  assert.equal(resolved.tier, 'keyfile');
  assert.equal(existsSync(join(root, '.master-key')), true);
  assert.deepEqual(custodyReport(opts(root)), { initialized: true, tier: 'keyfile' });
});

test('custody: report is honest before initialization', () => {
  const root = freshRoot();
  assert.deepEqual(custodyReport(opts(root)), { initialized: false, tier: null });
});

test('store: get on an uninitialized vault fails loud with guidance', () => {
  const root = freshRoot();
  let caught: unknown;
  assert.throws(
    () => vaultGet('secret://user/never-set', opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_NOT_INITIALIZED');
});

test('store: a corrupt keyfile fails loud instead of silently re-keying', () => {
  const root = freshRoot();
  vaultSet('secret://user/x', 'v', undefined, opts(root));
  writeFileSync(join(root, '.master-key'), 'not-base64-32-bytes!!', 'utf8');
  clearCustodyCache(root);
  let caught: unknown;
  assert.throws(
    () => vaultGet('secret://user/x', opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_KEYFILE_CORRUPT');
});

test('store: unknown record format fails with an upgrade hint', () => {
  const root = freshRoot();
  vaultSet('secret://user/fmt', 'v', undefined, opts(root));
  const path = join(root, 'user', 'fmt.json');
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...record, format: 99 }), 'utf8');
  let caught: unknown;
  assert.throws(
    () => vaultGet('secret://user/fmt', opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_FORMAT_UNKNOWN');
});

test('store: bad refs are rejected at every entry point', () => {
  const root = freshRoot();
  const cases = [
    () => vaultSet('secret://user/BAD', 'x', undefined, opts(root)),
    () => vaultGet('secret://lock/pid', opts(root)),
    () => vaultDelete('secret://user/../etc', opts(root)),
    () => vaultGet('hw-ak', opts(root)),
  ];
  for (const fn of cases) {
    let caught: unknown;
    assert.throws(fn, (error: unknown) => {
      caught = error;
      return true;
    });
    assert.equal(vaultErrorCode(caught), 'VAULT_BAD_REF');
  }
});

test('store: resolveSecretValue is the pass-through-or-resolve seam', () => {
  const root = freshRoot();
  vaultSet('secret://user/ak', 'RESOLVED-AK', undefined, opts(root));
  assert.equal(resolveSecretValue('plain-value', opts(root)), 'plain-value');
  assert.equal(resolveSecretValue('secret://user/ak', opts(root)), 'RESOLVED-AK');
  assert.equal(resolveSecretValue(undefined, opts(root)), undefined);
  let caught: unknown;
  assert.throws(
    () => resolveSecretValue('secret://user/missing', opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_REF_NOT_FOUND');
});

test('store: interleaved set/get/set converges (rotation visible to readers)', () => {
  const root = freshRoot();
  vaultSet('secret://user/seq', 'one', undefined, opts(root));
  assert.equal(vaultGet('secret://user/seq', opts(root)).value, 'one');
  vaultSet('secret://user/seq', 'two', undefined, opts(root));
  assert.equal(vaultGet('secret://user/seq', opts(root)).value, 'two');
  assert.equal(vaultGet('secret://user/seq', opts(root)).version, 2);
  vaultSet('secret://user/seq', 'two', undefined, opts(root));
  assert.equal(vaultGet('secret://user/seq', opts(root)).version, 2);
});

test('store: the lock directory is released after mutations and never appears as a scope', () => {
  const root = freshRoot();
  vaultSet('secret://user/a', 'v', undefined, opts(root));
  vaultSet('secret://user/b', 'v', undefined, opts(root));
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.deepEqual(
    dirs.sort((a, b) => a.localeCompare(b)),
    ['user'],
  );
  assert.deepEqual([...new Set(vaultList(undefined, opts(root)).map((entry) => entry.scope))], ['user']);
});

test('custody: a readable-but-wrong keychain decode is an error, not a silent tier skip', () => {
  const root = freshRoot();
  const stored: { b64?: string } = { b64: Buffer.alloc(8, 3).toString('base64') };
  const spawn = fakeKeychainSpawn(stored);
  let caught: unknown;
  assert.throws(
    () => resolveMasterKey({ root, spawnImpl: spawn }),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_CUSTODY_READ_FAILED');
});

test('store: secret files keep 0600 permissions', () => {
  const root = freshRoot();
  vaultSet('secret://user/perm', 'v', undefined, opts(root));
  const mode = statSync(join(root, 'user', 'perm.json')).mode & 0o777;
  assert.equal(mode, 0o600);
  chmodSync(join(root, 'user', 'perm.json'), 0o600);
});

test('custody: a failing backend with EXISTING records is an error, never an absent tier', () => {
  const root = freshRoot();
  const stored: { b64?: string } = { b64: Buffer.alloc(32, 5).toString('base64') };
  const healthy = fakeKeychainSpawn(stored);
  // Seed one record under the healthy backend first.
  vaultSet('secret://user/precious', 'v', undefined, { root, spawnImpl: healthy });
  clearCustodyCache(root);
  // Now the backend starts failing (daemon down / no D-Bus session).
  const spawn = fakeKeychainSpawn(stored, 'Error calling StartServiceByName for org.freedesktop.secrets');
  let caught: unknown;
  assert.throws(
    () => resolveMasterKey({ root, spawnImpl: spawn }),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_CUSTODY_READ_FAILED');
  // A failing tier with records to protect must not silently fall through to
  // a keyfile bootstrap: a second master key would orphan every secret.
  let setCaught: unknown;
  assert.throws(
    () => vaultSet('secret://user/x', 'v', undefined, { root, spawnImpl: spawn }),
    (error: unknown) => {
      setCaught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(setCaught), 'VAULT_CUSTODY_READ_FAILED');
  assert.equal(existsSync(join(root, '.master-key')), false);
});

test('custody: a failing backend on a FRESH vault falls back to the keyfile tier', () => {
  const root = freshRoot();
  const stored: { b64?: string } = {};
  const spawn = fakeKeychainSpawn(stored, 'Error calling StartServiceByName for org.freedesktop.secrets');
  // No records exist: nothing can be orphaned by a fresh key, and
  // secret-tool-on-PATH-without-a-daemon is a common headless shape that
  // must not dead-end the first `secret set`.
  const result = vaultSet('secret://user/first', 'v', undefined, { root, spawnImpl: spawn });
  assert.equal(result.status, 'set');
  assert.equal(existsSync(join(root, '.master-key')), true);
  assert.equal(vaultGet('secret://user/first', { root, spawnImpl: spawn }).value, 'v');
});

test('store: empty plaintext is refused at the shared boundary (CLI and MCP fold here)', () => {
  const root = freshRoot();
  vaultSet('secret://user/keep', 'real-value', undefined, opts(root));
  let caught: unknown;
  assert.throws(
    () => vaultSet('secret://user/keep', '', undefined, opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_EMPTY_SECRET');
  // The previous secret survives the refused rotation.
  assert.equal(vaultGet('secret://user/keep', opts(root)).value, 'real-value');
});

test('store: a record with empty ciphertext reads as an empty secret, not as corruption', () => {
  const root = freshRoot();
  const masterKey = Buffer.alloc(32, 0x44);
  process.env.HW_VAULT_MASTER_KEY = masterKey.toString('base64');
  clearCustodyCache(root);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
    cipher.setAAD(Buffer.from('secret://user/empty'));
    const ciphertext = cipher.final();
    mkdirSync(join(root, 'user'), { recursive: true });
    writeFileSync(
      join(root, 'user', 'empty.json'),
      JSON.stringify({
        format: 1,
        version: 1,
        created: '2026-10-16T00:00:00.000Z',
        updated: '2026-10-16T00:00:00.000Z',
        note: '',
        fingerprint: createHmac('sha256', masterKey).update('', 'utf8').digest('hex').slice(0, 16),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      }),
      'utf8',
    );
    assert.equal(vaultGet('secret://user/empty', opts(root)).value, '');
    assert.equal(vaultList(undefined, opts(root)).length, 1);
    // The record heals: a normal set over it works.
    const healed = vaultSet('secret://user/empty', 'now-real', undefined, opts(root));
    assert.equal(healed.status, 'set');
    assert.equal(vaultGet('secret://user/empty', opts(root)).value, 'now-real');
  } finally {
    delete process.env.HW_VAULT_MASTER_KEY;
    clearCustodyCache(root);
  }
});

test('custody: a LOST key over existing records refuses to mint a new one', () => {
  const root = freshRoot();
  // Seed under the env tier (no keyfile is written for env-tier keys).
  process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x11).toString('base64');
  clearCustodyCache(root);
  try {
    vaultSet('secret://user/precious', 'v', undefined, opts(root));
    // Every tier now absent (env dropped, no keychain item, no keyfile).
    delete process.env.HW_VAULT_MASTER_KEY;
    clearCustodyCache(root);
    let caught: unknown;
    assert.throws(
      () => vaultSet('secret://user/new', 'v2', undefined, opts(root)),
      (error: unknown) => {
        caught = error;
        return true;
      },
    );
    assert.equal(vaultErrorCode(caught), 'VAULT_MASTER_KEY_LOST');
    // The existing record is untouched — no new key was minted over it.
    assert.equal(existsSync(join(root, '.master-key')), false);
  } finally {
    delete process.env.HW_VAULT_MASTER_KEY;
    clearCustodyCache(root);
  }
});

test('store: a different-but-resolvable key refuses to overwrite an existing record', () => {
  const root = freshRoot();
  process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x22).toString('base64');
  clearCustodyCache(root);
  try {
    vaultSet('secret://user/guarded', 'original', undefined, opts(root));
    // A stray different env key (agent env injection) must not silently
    // re-key the record — that would destroy the last copy under the
    // original key (no version history).
    process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x33).toString('base64');
    clearCustodyCache(root);
    let caught: unknown;
    assert.throws(
      () => vaultSet('secret://user/guarded', 'rotated', undefined, opts(root)),
      (error: unknown) => {
        caught = error;
        return true;
      },
    );
    assert.equal(vaultErrorCode(caught), 'VAULT_MASTER_KEY_MISMATCH');
    // The original value survives under the original key.
    process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x22).toString('base64');
    clearCustodyCache(root);
    assert.equal(vaultGet('secret://user/guarded', opts(root)).value, 'original');
  } finally {
    delete process.env.HW_VAULT_MASTER_KEY;
    clearCustodyCache(root);
  }
});

test('custody: VaultCustodyError is a VaultError (one catch family for consumers)', () => {
  const error = new VaultCustodyError('VAULT_CUSTODY_READ_FAILED', 'x');
  assert.ok(error instanceof VaultError);
  assert.equal(error.code, 'VAULT_CUSTODY_READ_FAILED');
});
