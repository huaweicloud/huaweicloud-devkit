// The opencode saved-permission store reader: db resolution (XDG,
// OPENCODE_DB, channel suffix), the project join (worktree match, sha1
// fallback, the conservative any-project fallback), action wildcard matching,
// and the degrade-don't-fail contracts (missing db reads as pass, unreadable
// and corrupt read as warn-only). Every fixture store lives in TMPDIR; the
// machine's live store is never opened.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';
import {
  seedStoreAt,
  seedStoreIn,
  withStoreDir,
  writeCorruptStore,
  type SeedStore,
} from './opencode-saved-perms-harness.ts';
import { APPROVAL_TOOLS } from '../plugins/huaweicloud-core/src/approval-roster.ts';
import { allowRuleActions } from '../plugins/huaweicloud-core/src/lib/opencode-ask-rule.ts';
import {
  opencodeDataDir,
  opencodeDbCandidates,
  scanSavedAllowRows,
  savedAllowAction,
  savedAllowActions,
  wildcardMatch,
  type SavedAllowScan,
} from '../plugins/huaweicloud-core/src/lib/opencode-saved-perms.ts';

const ACTION = 'huaweicloud-devkit_huaweicloud_run_approved_command';

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

// The ok-scope assertions every join case makes: narrow the union once, then
// state the scope and the row ids, so no case repeats the ternaries.
function okScan(scan: SavedAllowScan): Extract<SavedAllowScan, { status: 'ok' }> {
  assert.equal(scan.status, 'ok');
  return scan as Extract<SavedAllowScan, { status: 'ok' }>;
}

// One project-scoped scan: seed the store under a pinned root, ask the gate's
// question for `cwd`, and hand back the resolved scope plus the row ids, so a
// join case states only its fixture and its expectation.
async function scanProject(seed: SeedStore, cwd: string): Promise<{ scope: string; ids: string[] }> {
  let outcome: { scope: string; ids: string[] } | undefined;
  await withStoreDir(async (dir) => {
    seedStoreIn(dir, seed);
    const scan = okScan(scanSavedAllowRows({ scope: 'project', cwd }));
    outcome = { scope: scan.scope, ids: scan.rows.map((row) => row.id) };
  });
  assert.ok(outcome, 'the project scan completed');
  return outcome;
}

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const keys = Object.keys(overrides);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the roster action comes from the roster leaf and matches the allow rule the installer writes', () => {
  assert.deepEqual(savedAllowActions(), [savedAllowAction()]);
  assert.equal(savedAllowAction(), ACTION);
  assert.equal(APPROVAL_TOOLS.length, 1, 'PR-1.5 registers only the hcloud run face');
  // The client-rule writer and the saved-store reader must name the same
  // grant; a drift here would let the doctor hunt a row the client never
  // writes, or a rule the client never evaluates.
  assert.deepEqual(
    allowRuleActions(),
    savedAllowActions(),
    'the writer and the saved-store reader name one action set',
  );
});

test('the data root follows XDG_DATA_HOME when absolute, else ~/.local/share', () => {
  assert.equal(
    opencodeDataDir({ XDG_DATA_HOME: '/xdg/data' } as NodeJS.ProcessEnv),
    join('/xdg/data', 'opencode'),
    'an absolute XDG_DATA_HOME wins',
  );
  // A relative XDG value is not a usable root (opencode ignores it), so the
  // home default applies — the resolved-cwd trap an inherited relative
  // XDG_CONFIG_HOME once caused.
  const relative = opencodeDataDir({ XDG_DATA_HOME: 'relative/dir' } as NodeJS.ProcessEnv);
  assert.equal(relative, join(homedir(), '.local', 'share', 'opencode'));
});

test('db candidates: the stable store first, and the V1 legacy db is never mistaken for the store', async () => {
  await withStoreDir(async (dir) => {
    const opencodeDir = join(dir, 'opencode');
    assert.deepEqual(opencodeDbCandidates(), [join(opencodeDir, 'opencode.db')], 'no stores yet: the stable path');
    assert.equal(scanSavedAllowRows({ scope: 'all' }).status, 'absent');

    // The V1 migration source is not this store: a lone opencode-next.db
    // must read as absent, not as a store to scan.
    seedStoreAt(join(opencodeDir, 'opencode-next.db'), {
      permissions: [{ id: 'row-legacy', projectId: 'p', action: ACTION }],
    });
    assert.deepEqual(opencodeDbCandidates(), [join(opencodeDir, 'opencode.db')]);
    assert.equal(scanSavedAllowRows({ scope: 'all' }).status, 'absent', 'the legacy db is not the permission store');
  });
});

test('db candidates: OPENCODE_DB wins, absolute or resolved against the data root, and :memory: persists nothing', async () => {
  await withStoreDir(async (dir) => {
    const absolute = join(dir, 'elsewhere.db');
    assert.deepEqual(opencodeDbCandidates({ ...process.env, OPENCODE_DB: absolute }), [absolute]);
    assert.deepEqual(
      opencodeDbCandidates({ ...process.env, OPENCODE_DB: 'custom.db' }),
      [resolve(join(dir, 'opencode'), 'custom.db')],
      'a relative override resolves against the data root, as opencode resolves it',
    );
    assert.deepEqual(opencodeDbCandidates({ ...process.env, OPENCODE_DB: ':memory:' }), []);
    assert.deepEqual(scanSavedAllowRows({ scope: 'all', env: { ...process.env, OPENCODE_DB: ':memory:' } }), {
      status: 'absent',
      dbPath: '',
    });
  });
});

test('db resolution: a channel-suffixed store is found, and the stable store still wins when both exist', async () => {
  await withStoreDir(async (dir) => {
    const opencodeDir = join(dir, 'opencode');
    // A channel install (dev/beta) names its store opencode-<channel>.db; the
    // channel is a build constant of the binary, so the reader looks it up.
    const channel = seedStoreAt(join(opencodeDir, 'opencode-dev.db'), {
      permissions: [{ id: 'row-channel', projectId: 'p', action: ACTION }],
    });
    seedStoreAt(join(opencodeDir, 'opencode-next.db'), {
      permissions: [{ id: 'row-legacy', projectId: 'p', action: ACTION }],
    });

    const channelScan = scanSavedAllowRows({ scope: 'all' });
    assert.equal(channelScan.status, 'ok');
    assert.equal(channelScan.dbPath, channel, 'the channel store is found');
    assert.deepEqual(
      channelScan.status === 'ok' ? channelScan.rows.map((row) => row.id) : [],
      ['row-channel'],
      'and the legacy opencode-next.db is never scanned',
    );

    seedStoreAt(join(opencodeDir, 'opencode.db'), {
      permissions: [{ id: 'row-stable', projectId: 'p', action: ACTION }],
    });
    const both = scanSavedAllowRows({ scope: 'all' });
    assert.equal(both.dbPath, join(opencodeDir, 'opencode.db'), 'the stable store is preferred');
    assert.deepEqual(both.status === 'ok' ? both.rows.map((row) => row.id) : [], ['row-stable']);
  });
});

test('a missing store reads as absent, with the path the client would have written', async () => {
  await withStoreDir(async (dir) => {
    const scan = scanSavedAllowRows({ scope: 'all' });
    assert.deepEqual(scan, { status: 'absent', dbPath: join(dir, 'opencode', 'opencode.db') });
  });
});

test('a corrupt store reads as unreadable, never as a refusal', async () => {
  await withStoreDir(async (dir) => {
    const dbPath = writeCorruptStore(dir);
    const scan = scanSavedAllowRows({ scope: 'all' });
    assert.equal(scan.status, 'unreadable');
    assert.equal(scan.dbPath, dbPath);
    assert.ok(scan.status === 'unreadable' && scan.detail.length > 0, 'the degradation names its cause');
  });
});

test(
  'an unreadable store (mode 000) reads as unreadable, never as a refusal',
  { skip: process.platform === 'win32' },
  async () => {
    await withStoreDir(async (dir) => {
      const dbPath = seedStoreIn(dir, { permissions: [{ id: 'row-1', projectId: 'p', action: ACTION }] });
      chmodSync(dbPath, 0o000);
      const scan = scanSavedAllowRows({ scope: 'all' });
      assert.equal(scan.status, 'unreadable');
      chmodSync(dbPath, 0o600);
    });
  },
);

test('the project join: the worktree match scopes to the current project only', async () => {
  const cwd = fixtureDir('hwc-saved-project-');
  const scan = await scanProject(
    {
      projects: [
        { id: 'p-this', worktree: cwd },
        { id: 'p-other', worktree: join(cwd, 'other') },
      ],
      permissions: [
        { id: 'row-this', projectId: 'p-this', action: ACTION },
        { id: 'row-other', projectId: 'p-other', action: ACTION },
      ],
    },
    cwd,
  );
  assert.equal(scan.scope, 'project');
  assert.deepEqual(scan.ids, ['row-this'], "another project's grant is not this project's");
});

test('the project join resolves through a spelling difference (resolved and dot-segment forms)', async () => {
  const cwd = fixtureDir('hwc-saved-spelling-');
  // The stored worktree is the canonical path; the cwd arrives with dot
  // segments and a trailing slash, which resolve to the same directory.
  const scan = await scanProject(
    {
      projects: [{ id: 'p-this', worktree: cwd }],
      permissions: [{ id: 'row-1', projectId: 'p-this', action: ACTION }],
    },
    `${join(cwd, '.', 'nested', '..')}/`,
  );
  assert.equal(scan.scope, 'project');
  assert.deepEqual(scan.ids, ['row-1']);
});

test('the project join falls back to sha1("directory:" + cwd) when no worktree row matches', async () => {
  const cwd = fixtureDir('hwc-saved-hash-');
  const projectId = sha1(`directory:${resolve(cwd)}`);
  const scan = await scanProject(
    {
      projects: [{ id: projectId, worktree: join(cwd, 'canonical-elsewhere') }],
      permissions: [{ id: 'row-hashed', projectId, action: ACTION }],
    },
    cwd,
  );
  assert.equal(scan.scope, 'project');
  assert.deepEqual(scan.ids, ['row-hashed']);
});

test('the conservative any-project fallback: an unattributable row still refuses', async () => {
  await withStoreDir(async (dir) => {
    const cwd = fixtureDir('hwc-saved-any-');
    seedStoreIn(dir, {
      projects: [{ id: 'p-unrelated', worktree: join(cwd, 'somewhere-else') }],
      permissions: [{ id: 'row-unrelated', projectId: 'p-unrelated', action: ACTION }],
    });
    const scan = okScan(scanSavedAllowRows({ scope: 'project', cwd }));
    assert.equal(scan.scope, 'any-project');
    assert.deepEqual(
      scan.rows.map((row) => row.id),
      ['row-unrelated'],
      'an unattributable grant still counts',
    );
  });
});

test('an empty project table joins nothing and falls back conservatively (an empty store still passes)', async () => {
  const scan = await scanProject({}, process.cwd());
  assert.equal(scan.scope, 'any-project');
  assert.deepEqual(scan.ids, [], 'no rows, no refusal');
});

test('the action matcher mirrors opencode wildcards and ignores the resource', async () => {
  await withStoreDir(async (dir) => {
    seedStoreIn(dir, {
      permissions: [
        { id: 'row-literal', projectId: 'p', action: ACTION, resource: 'a-specific-resource' },
        { id: 'row-prefix', projectId: 'p', action: 'huaweicloud-devkit_*' },
        { id: 'row-any', projectId: 'p', action: '*' },
        { id: 'row-pattern', projectId: 'p', action: 'huaweicloud-devkit_huaweicloud_run_approved_comm?nd' },
        { id: 'row-foreign', projectId: 'p', action: 'other-server_some_tool' },
        { id: 'row-ask-other', projectId: 'p', action: 'huaweicloud-devkit_huaweicloud_plan_cli_command' },
      ],
    });
    const scan = okScan(scanSavedAllowRows({ scope: 'all', actions: [ACTION] }));
    assert.deepEqual(
      scan.rows.map((row) => row.id).sort((a, b) => a.localeCompare(b)),
      ['row-any', 'row-literal', 'row-pattern', 'row-prefix'],
      'every pattern covering the action counts, whatever the row resource says',
    );
  });
  assert.equal(wildcardMatch(ACTION, 'huaweicloud-devkit_*'), true);
  assert.equal(wildcardMatch(ACTION, '*'), true);
  assert.equal(wildcardMatch(ACTION, 'huaweicloud-devkit_huaweicloud_run_approved_comm?nd'), true);
  assert.equal(wildcardMatch(ACTION, 'huaweicloud-devkit_huaweicloud_plan_cli_command'), false);
  assert.equal(wildcardMatch(ACTION, 'huaweicloud-devkit_huaweicloud_run*deny'), false);
  // The trailing-' *' fold opencode's matcher carries (pattern 'x *' also
  // matches bare 'x').
  assert.equal(wildcardMatch('echo hi', 'echo *'), true);
  assert.equal(wildcardMatch('echo', 'echo *'), true);
});

test('a scan never writes to the store (the connection is readOnly)', async () => {
  await withStoreDir(async (dir) => {
    const dbPath = seedStoreIn(dir, { permissions: [{ id: 'row-1', projectId: 'p', action: ACTION }] });
    const before = statSync(dbPath);
    const scan = scanSavedAllowRows({ scope: 'all' });
    assert.equal(scan.status, 'ok');
    const after = statSync(dbPath);
    assert.equal(after.size, before.size, 'the store file is untouched');
    assert.equal(after.mtimeMs, before.mtimeMs, 'no write reached the store');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const count = Number(db.prepare('SELECT COUNT(*) AS n FROM permission').get()?.['n']);
      assert.equal(count, 1, 'the seeded row survives the scan');
    } finally {
      db.close();
    }
  });
});

test('the reader is env-parameterized: the same call resolves whatever the caller passes', async () => {
  await withStoreDir(async (dir) => {
    seedStoreIn(dir, { permissions: [{ id: 'row-1', projectId: 'p', action: ACTION }] });
    const scan = scanSavedAllowRows({ scope: 'all', env: { XDG_DATA_HOME: dir } as NodeJS.ProcessEnv });
    assert.equal(scan.status, 'ok');
    const empty = scanSavedAllowRows({
      scope: 'all',
      env: { XDG_DATA_HOME: join(dir, 'nowhere') } as NodeJS.ProcessEnv,
    });
    assert.equal(empty.status, 'absent');
  });
});

test('the scan is env-live: a store that appears after a miss is seen on the next call', async () => {
  await withStoreDir(async (dir) => {
    assert.equal(scanSavedAllowRows({ scope: 'all' }).status, 'absent');
    seedStoreIn(dir, { permissions: [{ id: 'row-1', projectId: 'p', action: ACTION }] });
    assert.equal(okScan(scanSavedAllowRows({ scope: 'all' })).rows.length, 1);
  });
});

test('a relative XDG_DATA_HOME is ignored at resolution time (no cwd-dependent store)', async () => {
  await withStoreDir(async (dir) => {
    seedStoreIn(dir, { permissions: [{ id: 'row-1', projectId: 'p', action: ACTION }] });
    const home = fixtureDir('hwc-saved-relative-');
    const scan = withEnv({ XDG_DATA_HOME: 'relative-opencode-root', HOME: home }, () =>
      scanSavedAllowRows({ scope: 'all' }),
    );
    assert.equal(scan.status, 'absent', 'the relative root does not resolve the seeded store, and the home has none');
  });
});

test('the project join resolves a linked worktree through the worktree directory map', async () => {
  await withStoreDir(async (dir) => {
    const mainCheckout = fixtureDir('hwc-saved-main-');
    const linkedWorktree = fixtureDir('hwc-saved-linked-');
    // The dominant agent layout: the project's canonical worktree is the main
    // checkout, the server's cwd is a linked worktree, and opencode's own
    // directory map is what attributes the second path to the project.
    seedStoreIn(dir, {
      projects: [{ id: 'p-main', worktree: mainCheckout }],
      worktrees: [
        { projectId: 'p-main', directory: mainCheckout },
        { projectId: 'p-main', directory: linkedWorktree },
      ],
      permissions: [{ id: 'psv_main', projectId: 'p-main', action: ACTION }],
    });
    const scan = okScan(scanSavedAllowRows({ scope: 'project', cwd: linkedWorktree }));
    assert.equal(scan.scope, 'project');
    assert.deepEqual(
      scan.rows.map((row) => row.id),
      ['psv_main'],
      'the main grant covers its linked worktree',
    );
  });
});

test('a store without the worktree directory table still joins (older schema)', async () => {
  await withStoreDir(async (dir) => {
    const cwd = fixtureDir('hwc-saved-old-schema-');
    const dbPath = seedStoreIn(dir, {
      projects: [{ id: 'p-this', worktree: cwd }],
      permissions: [{ id: 'psv_old', projectId: 'p-this', action: ACTION }],
    });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('DROP TABLE worktree');
    } finally {
      db.close();
    }
    const scan = okScan(scanSavedAllowRows({ scope: 'project', cwd }));
    assert.equal(scan.scope, 'project');
    assert.equal(scan.rows.length, 1, 'the project join alone answers');
  });
});
