import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';

// The `secret` command family end-to-end through the real setup-cli entry
// (TypeScript source, type-stripped — the same fallback the safety hook
// uses). HW_VAULT_MASTER_KEY pins the env custody tier so the run never
// touches a real OS keychain and stays deterministic.

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'plugins', 'huaweicloud-core', 'src', 'setup-cli.ts');

const MASTER_KEY = Buffer.alloc(32, 0x5a).toString('base64');

function vaultHome(): string {
  return fixtureDir('secret-cli-');
}

function runSecret(home: string, args: string[]) {
  return spawnSync(process.execPath, [setupCli, 'secret', ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      HUAWEICLOUD_HOME: home,
      HW_VAULT_MASTER_KEY: MASTER_KEY,
    },
  });
}

test('secret CLI: set --file then get --stdout round-trips', () => {
  const home = vaultHome();
  const valueFile = join(home, 'value.txt');
  writeFileSync(valueFile, 'CLI-SECRET-value-123\n', 'utf8');
  const set = runSecret(home, ['set', 'secret://e2e/ak', '--file', valueFile]);
  assert.equal(set.status, 0, `set failed: ${set.stderr}`);
  assert.match(set.stdout, /stored \(version 1/);
  assert.doesNotMatch(set.stdout + set.stderr, /CLI-SECRET-value-123/);
  const get = runSecret(home, ['get', 'secret://e2e/ak', '--stdout']);
  assert.equal(get.status, 0, `get failed: ${get.stderr}`);
  assert.equal(get.stdout, 'CLI-SECRET-value-123\n');
});

test('secret CLI: get refuses to print without an explicit destination', () => {
  const home = vaultHome();
  const valueFile = join(home, 'value.txt');
  writeFileSync(valueFile, 'v\n', 'utf8');
  runSecret(home, ['set', 'secret://e2e/ak', '--file', valueFile]);
  const get = runSecret(home, ['get', 'secret://e2e/ak']);
  assert.equal(get.status, 2);
  assert.match(get.stderr, /refusing to print/i);
  assert.equal(get.stdout, '');
});

test('secret CLI: get --file writes 0600 and stays quiet on stdout', () => {
  const home = vaultHome();
  const valueFile = join(home, 'value.txt');
  const outFile = join(home, 'out.txt');
  writeFileSync(valueFile, 'file-channel-value\n', 'utf8');
  runSecret(home, ['set', 'secret://e2e/ak', '--file', valueFile]);
  const get = runSecret(home, ['get', 'secret://e2e/ak', '--file', outFile]);
  assert.equal(get.status, 0, get.stderr);
  assert.equal(get.stdout, '');
  assert.equal(readFileSync(outFile, 'utf8'), 'file-channel-value');
});

test('secret CLI: set --env reads the variable', () => {
  const home = vaultHome();
  const result = spawnSync(
    process.execPath,
    [setupCli, 'secret', 'set', 'secret://e2e/from-env', '--env', 'E2E_SECRET_VALUE'],
    {
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        HUAWEICLOUD_HOME: home,
        HW_VAULT_MASTER_KEY: MASTER_KEY,
        E2E_SECRET_VALUE: 'env-channel-value',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const get = runSecret(home, ['get', 'secret://e2e/from-env', '--stdout']);
  assert.equal(get.stdout, 'env-channel-value\n');
});

test('secret CLI: exec injects resolved refs into the child environment only', () => {
  const home = vaultHome();
  const valueFile = join(home, 'value.txt');
  writeFileSync(valueFile, 'exec-injected-value\n', 'utf8');
  runSecret(home, ['set', 'secret://e2e/token', '--file', valueFile]);
  const exec = runSecret(home, [
    'exec',
    '--env',
    'TOKEN=secret://e2e/token',
    '--',
    process.execPath,
    '-e',
    'process.stdout.write("token=" + process.env.TOKEN)',
  ]);
  assert.equal(exec.status, 0, exec.stderr);
  assert.equal(exec.stdout, 'token=exec-injected-value');
});

test('secret CLI: exec propagates the child exit code', () => {
  const home = vaultHome();
  const exec = runSecret(home, ['exec', '--', process.execPath, '-e', 'process.exit(7)']);
  assert.equal(exec.status, 7);
});

test('secret CLI: exec refuses hcloud children', () => {
  const home = vaultHome();
  const exec = runSecret(home, ['exec', '--env', 'K=secret://e2e/none', '--', 'hcloud', 'ECS', 'ListServers']);
  assert.equal(exec.status, 2);
  assert.match(exec.stderr, /approval chain/i);
});

test('secret CLI: list shows refs without values; rm reports counts', () => {
  const home = vaultHome();
  const valueFile = join(home, 'value.txt');
  writeFileSync(valueFile, 'listme\n', 'utf8');
  runSecret(home, ['set', 'secret://e2e/one', '--file', valueFile, '--note', 'first secret']);
  const list = runSecret(home, ['list']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /secret:\/\/e2e\/one\s+v1\s+\S+/);
  assert.doesNotMatch(list.stdout + list.stderr, /listme/);
  const scoped = runSecret(home, ['list', 'e2e']);
  assert.match(scoped.stdout, /secret:\/\/e2e\/one/);
  const rm = runSecret(home, ['rm', 'secret://e2e/one']);
  assert.equal(rm.status, 0);
  assert.equal(rm.stdout.trim(), 'removed: 1');
  const rmAgain = runSecret(home, ['rm', 'secret://e2e/one']);
  assert.equal(rmAgain.stdout.trim(), 'removed: 0');
  const listAfter = runSecret(home, ['list']);
  assert.match(listAfter.stdout, /no secrets stored/);
});

test('secret CLI: bad refs and missing channels are usage errors', () => {
  const home = vaultHome();
  const badRef = runSecret(home, ['set', 'secret://e2e/BAD', '--value', 'x']);
  assert.equal(badRef.status, 1);
  assert.match(badRef.stderr, /VAULT_BAD_REF/);
  const noChannel = runSecret(home, ['set', 'secret://e2e/ak']);
  assert.equal(noChannel.status, 2);
  assert.match(noChannel.stderr, /--file, --env, --stdin, --value/);
});

test('secret CLI: unresolvable refs in exec fail without leaking values', () => {
  const home = vaultHome();
  const exec = runSecret(home, [
    'exec',
    '--env',
    'TOKEN=secret://e2e/missing',
    '--',
    process.execPath,
    '-e',
    'process.stdout.write("never")',
  ]);
  assert.equal(exec.status, 1);
  assert.match(exec.stderr, /VAULT_REF_NOT_FOUND/);
  assert.equal(exec.stdout, '');
});

test('secret CLI: empty stdin is refused instead of destroying the secret', () => {
  const home = vaultHome();
  const valueFile = join(home, 'value.txt');
  writeFileSync(valueFile, 'keepme\n', 'utf8');
  runSecret(home, ['set', 'secret://e2e/guard', '--file', valueFile]);
  const empty = spawnSync(process.execPath, [setupCli, 'secret', 'set', 'secret://e2e/guard', '--stdin'], {
    input: '',
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      HUAWEICLOUD_HOME: home,
      HW_VAULT_MASTER_KEY: MASTER_KEY,
    },
  });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /VAULT_EMPTY_SECRET/);
  const get = runSecret(home, ['get', 'secret://e2e/guard', '--stdout']);
  assert.equal(get.stdout, 'keepme\n');
});

test('secret CLI: the --env channel refuses credential-family names', () => {
  const home = vaultHome();
  const harvest = spawnSync(process.execPath, [setupCli, 'secret', 'set', 'secret://e2e/x', '--env', 'HW_SECRET_KEY'], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      HUAWEICLOUD_HOME: home,
      HW_VAULT_MASTER_KEY: MASTER_KEY,
      HW_SECRET_KEY: 'HARVEST-TARGET',
    },
  });
  assert.equal(harvest.status, 2);
  assert.match(harvest.stderr, /dump gates/);
});

test('secret CLI: get rejects both destinations together and enforces 0600 on existing files', () => {
  const home = vaultHome();
  const valueFile = join(home, 'value.txt');
  writeFileSync(valueFile, 'mode-check\n', 'utf8');
  runSecret(home, ['set', 'secret://e2e/mode', '--file', valueFile]);
  const both = runSecret(home, ['get', 'secret://e2e/mode', '--file', join(home, 'o1.txt'), '--stdout']);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /exactly one destination/);
  const looseTarget = join(home, 'loose.txt');
  writeFileSync(looseTarget, 'stale 0644 content\n', { mode: 0o644 });
  chmodSync(looseTarget, 0o644);
  const get = runSecret(home, ['get', 'secret://e2e/mode', '--file', looseTarget]);
  assert.equal(get.status, 0, get.stderr);
  const mode = statSync(looseTarget).mode & 0o777;
  assert.equal(mode, 0o600, 'a pre-existing 0644 target must be tightened, not just reported as 0600');
});

test('auth reconcile exits 1 on an unresolvable S1 ref, before any interactive prompt', () => {
  const home = vaultHome();
  const valueFile = join(home, 'value.txt');
  writeFileSync(valueFile, 'ak-value\n', 'utf8');
  runSecret(home, ['set', 'secret://user/hw-ak', '--file', valueFile]);
  writeFileSync(
    join(home, '.config', 'huaweicloud', 'credentials.json'),
    JSON.stringify({ ak: 'secret://user/hw-ak', sk: 'secret://user/never-stored', region: 'cn-north-4' }),
    'utf8',
  );
  const result = spawnSync(process.execPath, [setupCli, 'auth', 'reconcile'], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      HUAWEICLOUD_HOME: home,
      HW_VAULT_MASTER_KEY: MASTER_KEY,
      // Non-TTY on purpose: the s1RefError gate sits BEFORE the interactive
      // check, so the broken-ref failure must surface even here.
    },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /secret ref the vault cannot resolve/);
  // And the mirrors were not poisoned with ref strings by a partial run.
  assert.equal(existsSync(join(home, '.obsutilconfig')), false);
});
