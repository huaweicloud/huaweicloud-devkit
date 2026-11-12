import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

import {
  devkitStateBase,
  ensurePackState,
  huaweiConfigBase,
  isInsideProtectedTree,
  packStateDir,
  protectedTreeRoots,
} from '../plugins/huaweicloud-core/src/lib/pack-state.ts';
import {
  _resetStateDirCache,
  displayStatePath,
  stateDirNotice,
} from '../plugins/huaweicloud-core/src/lib/state-dir.ts';
import { fixtureDir } from './fixture-dir.ts';

// The pack state space and the protected-tree guard: one resolver for the
// devkit config tree, idempotent provisioning with per-pass permission
// enforcement, and the write-mirror resolution that closes the planted-
// symlink and relative-path porosity the round-2 review found in a lexical
// prefix check.

function tempHome(): string {
  return fixtureDir('pack-state-home-');
}

test('huaweiConfigBase honors HUAWEICLOUD_HOME over the platform home', () => {
  const home = tempHome();
  assert.equal(huaweiConfigBase({ HUAWEICLOUD_HOME: home }), join(home, '.config', 'huaweicloud'));
  assert.equal(
    huaweiConfigBase({ HUAWEICLOUD_HOME: '' }),
    join(homedir(), '.config', 'huaweicloud'),
    'empty string must fall back to the platform home',
  );
});

test('packStateDir nests one directory per pack id under packs/', () => {
  const home = tempHome();
  assert.equal(
    packStateDir('huaweicloud-open-mcp', { HUAWEICLOUD_HOME: home }),
    join(home, '.config', 'huaweicloud', 'packs', 'huaweicloud-open-mcp'),
  );
});

test('devkitStateBase defaults to the config tree and honors the explicit state dir', () => {
  const home = tempHome();
  _resetStateDirCache();
  assert.equal(devkitStateBase({ HUAWEICLOUD_HOME: home }), join(home, '.config', 'huaweicloud'));
  assert.equal(
    devkitStateBase({ HUAWEICLOUD_HOME: home, HUAWEICLOUD_STATE_DIR: join(home, 'state') }),
    join(home, 'state'),
  );
  assert.throws(
    () => devkitStateBase({ HUAWEICLOUD_HOME: home, HUAWEICLOUD_STATE_DIR: 'relative/state' }),
    /HUAWEICLOUD_STATE_DIR must be an absolute path/,
  );
});

test('devkitStateBase falls back to an agent state dir on an unwritable config tree', () => {
  const home = tempHome();
  _resetStateDirCache();
  mkdirSync(join(home, '.codeartswork'));
  // Cross-platform read-only simulation: the config parent is a FILE, so the
  // probe's mkdir fails with ENOTDIR on every platform.
  writeFileSync(join(home, '.config'), 'not a directory');
  const env = { HUAWEICLOUD_HOME: home };
  const state = join(home, '.codeartswork', 'devkit-state');
  assert.equal(devkitStateBase(env), state);
  assert.equal(packStateDir('huaweicloud-open-mcp', env), join(state, 'packs', 'huaweicloud-open-mcp'));

  const layout = ensurePackState('huaweicloud-open-mcp', ['policy'], env);
  assert.equal(layout.dir, join(state, 'packs', 'huaweicloud-open-mcp'));
  assert.ok(existsSync(layout.files.policy), 'the policy is provisioned in the fallback tree');

  const roots = protectedTreeRoots(env);
  assert.ok(
    roots?.some((root) => root.includes('.codeartswork') && root.endsWith('devkit-state')),
    'the fallback state root joins the protected tree',
  );
  assert.ok(isInsideProtectedTree(layout.files.policy, env));

  assert.equal(displayStatePath(state, env), '~/.codeartswork/devkit-state', 'display paths are home-relative');
  assert.match(stateDirNotice(env) ?? '', /not writable; set HUAWEICLOUD_STATE_DIR/);
});

test('ensurePackState creates 0700/0600 idempotently and repairs loose permissions', () => {
  const home = tempHome();
  const env = { HUAWEICLOUD_HOME: home };
  const first = ensurePackState('huaweicloud-open-mcp', ['policy'], env);
  assert.ok(existsSync(first.files.policy), 'the policy file exists after provisioning');
  assert.equal(first.files.policy, join(first.dir, 'policy'));

  if (process.platform !== 'win32') {
    assert.equal(statSync(first.dir).mode & 0o777, 0o700);
    assert.equal(statSync(first.files.policy).mode & 0o777, 0o600);
  }

  // Idempotent: a second pass keeps content (empty) and does not throw.
  const second = ensurePackState('huaweicloud-open-mcp', ['policy'], env);
  assert.equal(second.files.policy, first.files.policy);

  // Per-pass repair: a pre-existing file with loose bits is re-chmodded.
  if (process.platform !== 'win32') {
    chmodSync(first.files.policy, 0o644);
    chmodSync(first.dir, 0o755);
    ensurePackState('huaweicloud-open-mcp', ['policy'], env);
    assert.equal(statSync(first.files.policy).mode & 0o777, 0o600, 'loose file bits are repaired');
    assert.equal(statSync(first.dir).mode & 0o777, 0o700, 'loose dir bits are repaired');
  }

  // No staging residue: the tmp+rename create leaves nothing behind.
  for (const name of ['policy.0.tmp', `policy.${process.pid}.tmp`]) {
    assert.ok(!existsSync(join(first.dir, name)), `no staging file ${name} may survive`);
  }
});

test('ensurePackState fails closed with a devkit-authored error on an unwritable tree', () => {
  if (process.platform === 'win32') return; // chmod-based read-only is a POSIX affordance
  if (typeof process.getuid === 'function' && process.getuid() === 0) return; // chmod 0500 cannot stop root
  const home = tempHome();
  const configRoot = join(home, '.config');
  mkdirSync(configRoot, { recursive: true });
  chmodSync(configRoot, 0o500);
  try {
    assert.throws(
      () => ensurePackState('huaweicloud-open-mcp', ['policy'], { HUAWEICLOUD_HOME: home }),
      /cannot provision pack state directory/,
      'the error names the provisioning step, not a gateway FileNotFoundError',
    );
  } finally {
    chmodSync(configRoot, 0o700);
  }
});

test('the protected tree contains the config tree and the operator policy/audit paths', () => {
  const home = tempHome();
  const operatorPolicy = join(home, 'operator-policy');
  writeFileSync(operatorPolicy, '', { mode: 0o600 });
  const env = { HUAWEICLOUD_HOME: home, HUAWEICLOUD_MCP_POLICY_FILE: operatorPolicy };

  const config = join(home, '.config', 'huaweicloud');
  assert.ok(isInsideProtectedTree(join(config, 'approvals.json'), env), 'global approvals are protected');
  assert.ok(
    isInsideProtectedTree(join(config, 'packs', 'huaweicloud-open-mcp', 'policy'), env),
    'the pack policy file is protected',
  );
  assert.ok(isInsideProtectedTree(operatorPolicy, env), 'the operator policy path is protected');
  assert.ok(isInsideProtectedTree(join(home, 'unrelated', 'out.csv'), env) === false, 'outside stays outside');

  // Sibling-prefix containment: .config/huaweicloud-extra must NOT
  // prefix-match .config/huaweicloud.
  assert.equal(
    isInsideProtectedTree(join(home, '.config', 'huaweicloud-extra', 'out.csv'), env),
    false,
    'separator-terminated containment, not a raw startsWith',
  );

  // The protected tree without operator envs does not include the operator path.
  const plainEnv = { HUAWEICLOUD_HOME: home };
  assert.equal(isInsideProtectedTree(operatorPolicy, plainEnv), false);
});

test('relative targets resolve against the gateway child cwd (tmpdir), not this process cwd', () => {
  const home = tempHome();
  const env = { HUAWEICLOUD_HOME: home };
  // The guard anchors relative paths at tmpdir(), the parent of every
  // per-child scratch cwd; a relative name that would collide with the
  // protected layout is over-denied by design (never under-denied).
  const config = join(home, '.config', 'huaweicloud');
  const rel = relative(tmpdir(), join(config, 'approvals.json'));
  assert.ok(!rel.startsWith('/'), 'precondition: the relative path is actually relative');
  assert.ok(isInsideProtectedTree(rel, env), 'relative writes onto the tree are denied');
  assert.equal(isInsideProtectedTree('plain-scratch.csv', env), false, 'plain relative scratch writes pass');
});

test('dotdot composition through a planted symlink is denied (kernel-order resolution)', () => {
  if (process.platform === 'win32') return; // symlink creation needs privileges there
  const home = tempHome();
  const env = { HUAWEICLOUD_HOME: home };
  const scratch = fixtureDir('pack-state-scratch-');

  // The round-3 attack shape: path.resolve() collapses 'link/..' lexically
  // to the scratch dir, but the kernel resolves '..' AFTER the symlink
  // substitution — an open() through this string lands INSIDE the
  // protected tree (probe-verified by two independent reviewers). The
  // guard must refuse the '..' segment outright.
  const packsDir = join(home, '.config', 'huaweicloud', 'packs');
  mkdirSync(packsDir, { recursive: true });
  const link = join(scratch, 'link');
  symlinkSync(packsDir, link);
  assert.ok(
    isInsideProtectedTree(`${link}/../stolen.csv`, env),
    'dotdot through a planted symlink must be denied, not lexically collapsed',
  );

  // Without symlinks the same refusal applies: no legitimate scratch write
  // needs a '..' segment.
  assert.ok(isInsideProtectedTree('scratch/../../escape', env), 'relative climbs are denied');
  assert.ok(
    isInsideProtectedTree(`${home}/safe/../stolen.csv`, env),
    'absolute paths with dotdot segments are denied too',
  );

  // The dotdot-free path through the same link still resolves normally.
  assert.ok(
    isInsideProtectedTree(`${link}/huaweicloud-open-mcp/policy`, env),
    'a direct symlink into the tree is denied via realpath',
  );
});

test('planted symlinks resolve through to their targets in both directions', () => {
  if (process.platform === 'win32') return; // symlink creation needs privileges there
  const home = tempHome();
  const env = { HUAWEICLOUD_HOME: home };
  const scratch = fixtureDir('pack-state-scratch-');

  // Outside link pointing IN: the classic round-2 plant. Writing through it
  // modifies the protected file, so it must be denied.
  const config = join(home, '.config', 'huaweicloud');
  mkdirSync(config, { recursive: true });
  const approvals = join(config, 'approvals.json');
  writeFileSync(approvals, '{}', { mode: 0o600 });
  const planted = join(scratch, 'innocent.csv');
  symlinkSync(approvals, planted);
  assert.ok(isInsideProtectedTree(planted, env), 'a symlink planted outside pointing in is denied');

  // Link inside the tree pointing OUT: the write lands outside; protected
  // state is untouched, so allowing is correct.
  const packDir = join(config, 'packs', 'huaweicloud-open-mcp');
  mkdirSync(packDir, { recursive: true });
  const elsewhere = join(scratch, 'elsewhere.csv');
  writeFileSync(elsewhere, '', { mode: 0o600 });
  const outLink = join(packDir, 'out-link');
  symlinkSync(elsewhere, outLink);
  assert.equal(isInsideProtectedTree(outLink, env), false, 'a link inside pointing out resolves to the target');
});

test('dangling symlinks fail closed: unresolvable writes are protected', () => {
  if (process.platform === 'win32') return;
  const home = tempHome();
  const scratch = fixtureDir('pack-state-scratch-');
  const dangling = join(scratch, 'dangling-link');
  symlinkSync(join(home, '.config', 'huaweicloud', 'approvals.json'), dangling); // target does not exist

  // The write through a dangling link CREATES the target, so the guard must
  // treat the unresolvable path as protected.
  assert.ok(isInsideProtectedTree(dangling, { HUAWEICLOUD_HOME: home }), 'dangling link into the tree is denied');

  // An unresolvable ROOT (HUAWEICLOUD_HOME itself dangling) denies everything.
  assert.equal(protectedTreeRoots({ HUAWEICLOUD_HOME: dangling }), null, 'roots report unresolvable');
  assert.equal(
    isInsideProtectedTree(join(scratch, 'unrelated.csv'), { HUAWEICLOUD_HOME: dangling }),
    true,
    'unresolvable base fails closed: deny all',
  );
});
