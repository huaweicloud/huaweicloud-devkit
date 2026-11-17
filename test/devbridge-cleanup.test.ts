import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _setOneShotForTests,
  buildDevbridgeCleanupApplyScript,
  buildDevbridgeCleanupLockScript,
  buildDevbridgeCleanupStateScript,
  cleanupDevbridgeTunnels,
  normalizeCleanupMode,
  parseDevbridgeHostProcesses,
  parseDevbridgePortQueries,
  parseDevbridgeTunnelList,
  planDevbridgeCleanup,
  type DevbridgeHostProcess,
  type DevbridgeTunnelRecord,
} from '../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts';
import type { KeepaliveTunnel } from '../plugins/huaweicloud-core/src/sandbox/devbridge-keepalive.ts';

// The selective-cleanup acceptance suite, ported from dev's session-manager
// tests (97c4bc8a + 43fa459e) to the v2 module surface. The four contract
// behaviors the port must prove:
//   1. two live tunnels on one workspace survive a second cleanup (the
//      connect-twice scenario — connect cleans orphans only, never live ports)
//   2. keepalive-protected tunnels are never cleaned
//   3. orphan records (and orphan hosts) ARE cleaned
//   4. a failed list skips the cleanup entirely — never a guess-based delete

test('cleanup: parses tunnel list and host processes behind OSC/CRLF noise', () => {
  const list =
    '\u001b]133;C\u0007Tunnel ID  Name              Description  Tunnel Expiration  Port Count\r\n' +
    '\u001b]133;C\u0007ncwa54gr   tunnel-18082-6097               30 days            1\r\n' +
    'tun0l1s9   tunnel-18086-111                29 days            1\r\n' +
    'up5kfkbb   tunnel-18084-789                23 hours           1\r\n' +
    // The expiry read is column-anchored: a description that itself reads like
    // a duration (1minute — descriptions reject spaces, so the zero-space form
    // is legal) must not poison the expirySeconds (interrogate port-pr4 B-F2).
    'aaaa9999   my-app            1minute         29 days            1\r\n' +
    'No tunnels found.\r\n';
  const tunnels = parseDevbridgeTunnelList(list);
  assert.equal(tunnels.length, 4);
  assert.deepEqual(
    tunnels.map((t) => ({ id: t.id, port: t.port, expirySeconds: t.expirySeconds })),
    [
      { id: 'ncwa54gr', port: 18082, expirySeconds: 30 * 86400 },
      // IDs may contain 0/1/8/9; parsing must not assume the base32 subset.
      { id: 'tun0l1s9', port: 18086, expirySeconds: 29 * 86400 },
      { id: 'up5kfkbb', port: 18084, expirySeconds: 23 * 3600 },
      // The true expiry column wins over the duration-shaped description.
      { id: 'aaaa9999', port: null, expirySeconds: 29 * 86400 },
    ],
  );
  assert.equal(tunnels[3]!.expiryText, '29 days');

  const hosts =
    '\u001b]133;C\u00077962 devbridge host -p 18085 -e 1\r\n' +
    '\u001b]133;C\u00071234 devbridge host ncwa54gr\r\n' +
    '5678 /usr/bin/devbridge host up5kfkbb -p 18084 -e 72\r\n' +
    '9999 /bin/bash -c "devbridge host -p 18085" \r\n' +
    '7777 devbridge host -e 72\r\n';
  assert.deepEqual(
    parseDevbridgeHostProcesses(hosts).map((h) => ({ pid: h.pid, id: h.id, port: h.port })),
    [
      { pid: 7962, id: null, port: 18085 },
      { pid: 1234, id: 'ncwa54gr', port: null },
      { pid: 5678, id: 'up5kfkbb', port: 18084 },
      // The wrapper shell is never a real host process; the no-id/no-port
      // host is unattributable and must be ignored, never killed blindly.
    ],
  );
});

// The shared plan-fixture world: a keepalive-protected tunnel on 18082, a
// live tunnel on 18083, an orphan record (no host), and an orphan host whose
// record is gone — the scene the stale/quota/connect-twice cases all judge.
const PLAN_KEEPALIVE: KeepaliveTunnel[] = [
  { tunnelId: 'aaaa2345', url: 'https://aaaa2345-18082.devbridge-s2.hwtunnel.com' },
];
function planWorld(
  extraTunnels: DevbridgeTunnelRecord[] = [],
  extraHosts: DevbridgeHostProcess[] = [],
): { keepalive: KeepaliveTunnel[]; tunnels: DevbridgeTunnelRecord[]; hosts: DevbridgeHostProcess[] } {
  return {
    keepalive: PLAN_KEEPALIVE,
    tunnels: [
      { id: 'aaaa2345', name: 'tunnel-18082-1', port: 18082, expirySeconds: 30 * 86400, expiryText: '30 days' },
      { id: 'bbbb2345', name: 'tunnel-18083-2', port: 18083, expirySeconds: 29 * 86400, expiryText: '29 days' },
      { id: 'cccc2345', name: 'old-tunnel', port: null, expirySeconds: null, expiryText: '' },
      ...extraTunnels,
    ],
    hosts: [
      { pid: 100, id: 'aaaa2345', port: null },
      { pid: 200, id: null, port: 18083 },
      { pid: 300, id: 'dddd2345', port: null }, // host for a tunnel record that no longer exists
      ...extraHosts,
    ],
  };
}

test('cleanup: stale mode removes orphans but preserves protected/other-port tunnels', () => {
  const { keepalive, tunnels, hosts } = planWorld();

  // The connect-time shape: mode stale, no samePort — a live tunnel on another
  // port survives every cleanup pass.
  const stale = planDevbridgeCleanup({ tunnels, hosts, keepalive, mode: 'stale' });
  assert.deepEqual(stale.deleteIds, ['cccc2345']);
  assert.deepEqual(stale.killPids, [300]);

  // Expose on another port replaces only that port's tunnel (+ orphans).
  const sameOtherPort = planDevbridgeCleanup({ tunnels, hosts, keepalive, mode: 'stale', samePort: 18083 });
  assert.deepEqual(
    sameOtherPort.deleteIds.sort((a, b) => a.localeCompare(b)),
    ['bbbb2345', 'cccc2345'],
  );
  assert.deepEqual(
    sameOtherPort.killPids.sort((a, b) => a - b),
    [200, 300],
  );

  // Same-port replacement is the one documented exception: a keepalive-protected
  // tunnel on the target port is replaced (a port cannot have two tunnels).
  const sameProtectedPort = planDevbridgeCleanup({ tunnels, hosts, keepalive, mode: 'stale', samePort: 18082 });
  assert.deepEqual(
    sameProtectedPort.deleteIds.sort((a, b) => a.localeCompare(b)),
    ['aaaa2345', 'cccc2345'],
  );
  assert.deepEqual(
    sameProtectedPort.killPids.sort((a, b) => a - b),
    [100, 300],
  );

  const none = planDevbridgeCleanup({ tunnels, hosts, keepalive, mode: 'none' });
  assert.deepEqual(none, { deleteIds: [], killPids: [] });

  const all = planDevbridgeCleanup({ tunnels, hosts, keepalive, mode: 'all' });
  assert.deepEqual(
    all.deleteIds.sort((a, b) => a.localeCompare(b)),
    ['aaaa2345', 'bbbb2345', 'cccc2345'],
  );
  assert.deepEqual(
    all.killPids.sort((a, b) => a - b),
    [100, 200, 300],
  );
});

test('cleanup: quota mode removes all orphans then the oldest non-protected live tunnel', () => {
  const { keepalive, tunnels, hosts } = planWorld(
    [
      { id: 'eeee2345', name: 'tunnel-18086-3', port: 18086, expirySeconds: 30 * 86400, expiryText: '30 days' },
    ],
    [{ pid: 400, id: null, port: 18086 }],
  );
  const quota = planDevbridgeCleanup({ tunnels, hosts, keepalive, mode: 'quota', maxExtra: 1 });
  assert.deepEqual(
    quota.deleteIds.sort((a, b) => a.localeCompare(b)),
    ['bbbb2345', 'cccc2345'],
  );
  // pid 300 is the orphan host (its record is gone) — quota mode removes it
  // alongside the freed record's host.
  assert.deepEqual(
    quota.killPids.sort((a, b) => a - b),
    [200, 300],
  );

  const quotaMore = planDevbridgeCleanup({ tunnels, hosts, keepalive, mode: 'quota', maxExtra: 2 });
  assert.deepEqual(
    quotaMore.deleteIds.sort((a, b) => a.localeCompare(b)),
    ['bbbb2345', 'cccc2345', 'eeee2345'],
  );
  assert.deepEqual(
    quotaMore.killPids.sort((a, b) => a - b),
    [200, 300, 400],
  );
});

test('cleanup: quota ordering keys on the true expiry column, never a duration-shaped description', () => {
  // The poison shape (interrogate port-pr4 B-F2): a description like `1minute`
  // (legal — descriptions reject spaces) must not flip the oldest-first
  // targeting, or the quota retry deletes the FRESHER live tunnel and a
  // still-live developer tunnel loses its URL.
  const keepalive = [{ tunnelId: 'zzzz1111', url: 'https://zzzz1111-18099.devbridge-s2.hwtunnel.com' }];
  const tunnels = parseDevbridgeTunnelList(
    [
      'Tunnel ID  Name              Description  Tunnel Expiration  Port Count',
      'aaa11111   tunnel-18081-1     1minute         29 days            1',
      'bbb22222   tunnel-18082-2     app             2 hours           1',
    ].join('\r\n'),
  );
  const hosts = [
    { pid: 10, id: 'aaa11111', port: null },
    { pid: 20, id: 'bbb22222', port: null },
  ];
  const quota = planDevbridgeCleanup({ tunnels, hosts, keepalive, mode: 'quota', maxExtra: 1 });
  assert.deepEqual(quota.deleteIds, ['bbb22222'], 'the true oldest (2h) goes first; the 29-day tunnel survives');
});

test('cleanup: port queries parse behind OSC noise, multi-port rows, and junk tokens', () => {
  const parsed = parseDevbridgePortQueries(
    [
      '\x1b]133;C\x07TUNNEL_PORTS_lw3bmxny=8787,9090,',
      'TUNNEL_PORTS_ncwa54gr=18082,',
      'TUNNEL_PORTS_junk=notaport,99999,',
      'garbage line with no field shape',
    ].join('\r\n'),
  );
  assert.deepEqual([...parsed.entries()], [
    ['lw3bmxny', [8787, 9090]],
    ['ncwa54gr', [18082]],
    ['junk', []], // out-of-range tokens drop; the entry stays (empty port list)
  ]);
  assert.deepEqual([...parseDevbridgePortQueries('').entries()], []);
});

test('cleanup: same-port targeting keys on the queried port list — a custom-named, non-enrolled tunnel is replaced (B-R2-3)', () => {
  // The list table has no port column; the name-shape read (`tunnel-<port>-`)
  // and the keepalive-URL read both miss a custom-named, non-enrolled tunnel.
  // Only the state script's per-tunnel port query sees it — without the ports
  // attribution, every later expose on that port fails on a port conflict.
  const tunnels: DevbridgeTunnelRecord[] = [
    { id: 'lw3bmxny', name: 'kanban-board', port: null, expiryText: '30 days', expirySeconds: 30 * 86400, ports: [8787] },
  ];
  const hosts: DevbridgeHostProcess[] = [{ pid: 4242, id: 'lw3bmxny', port: 8787 }];
  const plan = planDevbridgeCleanup({ tunnels, hosts, keepalive: [], mode: 'stale', samePort: 8787 });
  assert.deepEqual(plan.deleteIds, ['lw3bmxny']);
  assert.deepEqual(plan.killPids, [4242]);
  // Multi-port tunnels: a same-port match on ANY queried port deletes the record.
  const multiPort = planDevbridgeCleanup({
    tunnels: [{ ...tunnels[0]!, ports: [9090, 8787] }],
    hosts,
    keepalive: [],
    mode: 'stale',
    samePort: 8787,
  });
  assert.deepEqual(multiPort.deleteIds, ['lw3bmxny']);
  // No query result: the fallback reads keep the tunnel (the gap-closing is
  // the query, never an over-delete on a guess).
  const fallback = planDevbridgeCleanup({
    tunnels: [{ ...tunnels[0]!, ports: undefined, port: null }],
    hosts,
    keepalive: [],
    mode: 'stale',
    samePort: 8787,
  });
  assert.deepEqual(fallback.deleteIds, []);
});

test('cleanup: a host mapped to a KEPT record is never a kill target, even when a deleted record claims its port', () => {
  // The two-records-one-port co-state the gateway's own doctrine says cannot
  // exist; the structural guard makes the live-host invariant hold regardless
  // (a one-record port claim must not kill another record's live host).
  const tunnels: DevbridgeTunnelRecord[] = [
    { id: 'lw3bmxny', name: 'kanban-board', port: 8787, expiryText: '30 days', expirySeconds: 30 * 86400, ports: [8787] },
    { id: 'ppcq44gr', name: 'tunnel-8787-2', port: 8787, expiryText: '1 day', expirySeconds: 86400, ports: [8787] }, // orphan record, same port claim
  ];
  const hosts: DevbridgeHostProcess[] = [{ pid: 23073, id: 'lw3bmxny', port: 8787 }];
  const plan = planDevbridgeCleanup({ tunnels, hosts, keepalive: [], mode: 'stale' });
  assert.ok(plan.deleteIds.includes('ppcq44gr'), 'the orphan record goes');
  assert.ok(!plan.deleteIds.includes('lw3bmxny'), 'the live record stays');
  assert.ok(!plan.killPids.includes(23073), 'the LIVE record\'s host is never killed by a same-port claim');
  assert.deepEqual(plan.killPids, []);

  // The port-only host form (the expose launch form, no tunnel id): a
  // surviving record's port claim shields it too — the host cannot be
  // attributed, so it is never killed on a guess.
  const portOnlyHosts: DevbridgeHostProcess[] = [{ pid: 500, id: null, port: 8787 }];
  const quotaPlan = planDevbridgeCleanup({
    tunnels,
    hosts: portOnlyHosts,
    keepalive: [],
    mode: 'quota',
    maxExtra: 1,
  });
  assert.ok(quotaPlan.deleteIds.includes('ppcq44gr'), 'quota frees the oldest non-protected record');
  assert.ok(!quotaPlan.deleteIds.includes('lw3bmxny'), 'the protected/oldest survivor stays');
  assert.deepEqual(quotaPlan.killPids, [], 'the unattributable port-only host is shielded by the survivor\'s port claim');

  // The same-port replacement doctrine still kills: expose replaces EVERY
  // same-port record, so no survivor claims the port and the launch-form host
  // on it dies with them.
  const exposePlan = planDevbridgeCleanup({
    tunnels,
    hosts: portOnlyHosts,
    keepalive: [],
    mode: 'stale',
    samePort: 8787,
  });
  assert.ok(exposePlan.deleteIds.includes('lw3bmxny') && exposePlan.deleteIds.includes('ppcq44gr'));
  assert.deepEqual(exposePlan.killPids, [500], 'with no survivor on the port, the launch-form host is killed');
});

test('cleanup: apply script validates IDs/PIDs and re-checks the process before killing', () => {
  const script = buildDevbridgeCleanupApplyScript({ deleteIds: ['aaaa2345'], killPids: [100, 200] });
  // state→apply can take minutes: a recycled PID must not hit an unrelated
  // process, so every kill is guarded by an identity re-check.
  assert.match(script, /if ps -p 100 -o args= 2>\/dev\/null \| grep -q "devbridge host"; then kill 100/);
  assert.match(script, /if ps -p 200 -o args= 2>\/dev\/null \| grep -q "devbridge host"; then kill 200/);
  assert.match(script, /devbridge delete aaaa2345/);
  assert.match(script, /DB_CLEANUP_DELETED=aaaa2345/);
  assert.match(script, /DB_CLEANUP_KILLED=100,200/);
  assert.throws(() => buildDevbridgeCleanupApplyScript({ deleteIds: ['bad;id'] }), /invalid tunnel id/);
  assert.throws(() => buildDevbridgeCleanupApplyScript({ killPids: ['1; rm -rf /'] as unknown as number[] }), /invalid pid/);
});

test('cleanup: state script refreshes the CLI token (40100) before listing', () => {
  const script = buildDevbridgeCleanupStateScript();
  // A valid API key can coexist with an expired CLI token; without this refresh
  // `devbridge list` returns 40100 and the cleanup silently skips even though
  // the key is usable. Re-login from keyring/file only — never creates a key.
  assert.match(script, /hwcloud keyring get HW_DEVBRIDGE_API_KEY 2>&1 \|\| true/);
  assert.match(script, /"devbridge_"\*\) : ;; \*\) DB_KEY="";; esac/);
  assert.match(script, /devbridge auth login --api-key "\$DB_KEY" >\/dev\/null 2>&1 \|\| true/);
  assert.match(script, /source \/tmp\/hw_api_key/);
  // The sections the orchestration parses.
  assert.match(script, /echo "DB_CLEANUP_TUNNELS_BEGIN"/);
  assert.match(script, /devbridge list 2>&1 \|\| true/);
  assert.match(script, /echo "DB_CLEANUP_TUNNELS_END"/);
  assert.match(script, /pgrep -af "devbridge host" 2>&1 \|\| true/);
  assert.match(script, /echo "DB_CLEANUP_HOSTS_END"/);
  // The installed-watchdog read rides the same exec.
  assert.match(script, /DB_KEEPALIVE_TUNNELS=/);
  // The authoritative port-attribution section (B-R2-3): per-tunnel port-list
  // queries, emitted between the TUNNELS and HOSTS sections, OSC-stripped —
  // the list table has no port column, and a name-shape read misses the
  // custom-named tunnels the remediation's own flow creates.
  assert.match(script, /echo "DB_CLEANUP_PORTS_BEGIN"/);
  assert.match(script, /TUNNEL_PORTS_\$T=\$\(devbridge port list "\$T"/);
  assert.match(script, /echo "DB_CLEANUP_PORTS_END"/);
  // The candidate filter carries the OSC 133 strip (#946): integration-enabled
  // shells wrap every line, and a raw extraction hands the CLI glued IDs it
  // rejects — the delete would silently no-op (B-R2-1's shell-side sibling).
  assert.match(script, /gsub\(\/\\033\\\]133;C\\007\/, ""\)/);
  // #999 anchor doctrine: the PATH export rides the token-refresh init line —
  // a standalone export first line is byte-identical to the auth probe's.
  assert.match(
    script,
    /^export PATH="\/workspace\/\.local\/bin:\$HOME\/\.huawei\/bin:\$PATH"; DB_KEY=""$/m,
  );
});

test('cleanup: lock script uses the 10-minute stale threshold', () => {
  const script = buildDevbridgeCleanupLockScript();
  assert.match(script, /^LOCK=\/tmp\/devbridge-cleanup\.lock$/m);
  // The stale threshold sits above the worst-case hold (~450s) so a live
  // cleanup cannot be preempted.
  assert.match(script, /-mmin \+10 /);
  assert.match(script, /echo LOCK_OK/);
  assert.match(script, /echo LOCK_BUSY/);
});

test('cleanup: normalizeCleanupMode maps garbage to stale', () => {
  assert.equal(normalizeCleanupMode('stale'), 'stale');
  assert.equal(normalizeCleanupMode('all'), 'all');
  assert.equal(normalizeCleanupMode('none'), 'none');
  assert.equal(normalizeCleanupMode('quota'), 'stale');
  assert.equal(normalizeCleanupMode(undefined), 'stale');
  assert.equal(normalizeCleanupMode('nonsense'), 'stale');
});

// ── orchestration contract (lock → state → apply → keepalive sync → unlock) ──

interface CleanupState {
  tunnels: string;
  hosts: string;
  keepalive: string;
  // Per-tunnel port-list queries (the state script's PORTS section) — the
  // authoritative port attribution; omit for the fallback world.
  ports?: string;
}

const TWO_PORT_STATE: CleanupState = {
  // Two live tunnels on one workspace (ports 18082/18084), one orphan record
  // (cccc2345, no host), one orphan host (300, its record is gone).
  tunnels:
    'Tunnel ID  Name              Description  Tunnel Expiration  Port Count\r\n' +
    'aaaa2345   tunnel-18082-6097               30 days            1\r\n' +
    'bbbb2345   tunnel-18084-789                23 hours           1\r\n' +
    'cccc2345   old-tunnel                      5 days             1\r\n',
  hosts:
    '100 devbridge host aaaa2345\r\n' +
    '200 devbridge host -p 18084 -e 72\r\n' +
    '300 devbridge host dddd2345\r\n',
  keepalive: 'aaaa2345:https://aaaa2345-18082.devbridge-s2.hwtunnel.com:18082',
};

function cleanupStateStdout(state: CleanupState): string {
  return [
    'DB_CLEANUP_TUNNELS_BEGIN',
    state.tunnels,
    'DB_CLEANUP_TUNNELS_END',
    'DB_CLEANUP_PORTS_BEGIN',
    ...(state.ports ? [state.ports] : []),
    'DB_CLEANUP_PORTS_END',
    'DB_CLEANUP_HOSTS_BEGIN',
    state.hosts,
    'DB_CLEANUP_HOSTS_END',
    `DB_KEEPALIVE_TUNNELS=${state.keepalive}`,
  ].join('\n');
}

function cleanupSeam(state: CleanupState) {
  const commands: string[] = [];
  const seam = async (_ws: string, command: string) => {
    commands.push(command);
    if (command.startsWith('LOCK=')) {
      return { stdout: 'LOCK_OK\n', exitCode: 0 };
    }
    if (command.includes('DB_CLEANUP_TUNNELS_BEGIN')) {
      return { stdout: cleanupStateStdout(state), exitCode: 0 };
    }
    if (command.startsWith('LINE=')) {
      return { stdout: `DB_KEEPALIVE_TUNNELS=${state.keepalive}\n`, exitCode: 0 };
    }
    if (command.includes('DB_CLEANUP_APPLY')) {
      return { stdout: 'DB_CLEANUP_DELETED=\nDB_CLEANUP_KILLED=\n', exitCode: 0 };
    }
    if (command.startsWith('rmdir /tmp/devbridge-cleanup.lock')) {
      return { stdout: '', exitCode: 0 };
    }
    if (command.includes('cat > /tmp/tunnel-keepalive.sh')) {
      return { stdout: 'DB_KEEPALIVE_SYNTAX=0\nDB_KEEPALIVE_PID=4242\n', exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  };
  return { commands, seam };
}

async function runCleanup(seam: Parameters<typeof _setOneShotForTests>[0], options: Parameters<typeof cleanupDevbridgeTunnels>[1] = {}) {
  _setOneShotForTests(seam);
  try {
    return await cleanupDevbridgeTunnels('ws-1', options);
  } finally {
    _setOneShotForTests(null);
  }
}

test('cleanup: connect-twice keeps both live tunnels, prunes only the orphan (flow)', async () => {
  const { commands, seam } = cleanupSeam(TWO_PORT_STATE);
  const first = await runCleanup(seam, { mode: 'stale' });
  assert.equal(first.ok, true);
  assert.deepEqual(first.deleteIds, ['cccc2345']);
  assert.deepEqual(first.killPids, [300]);

  // The second connect-time cleanup sees the same world minus the orphan:
  // neither live tunnel — keepalive-protected or merely live — is ever deleted.
  const afterFirst: CleanupState = {
    ...TWO_PORT_STATE,
    tunnels: TWO_PORT_STATE.tunnels.replace(/cccc2345.*\r\n/, ''),
    hosts: TWO_PORT_STATE.hosts.replace(/300 devbridge host dddd2345\r\n/, ''),
  };
  const { commands: commands2, seam: seam2 } = cleanupSeam(afterFirst);
  const second = await runCleanup(seam2, { mode: 'stale' });
  assert.equal(second.ok, true);
  assert.deepEqual(second.deleteIds, [], 'the first port’s tunnel must survive the second connect');
  assert.deepEqual(second.killPids, []);

  const applyCommands = commands
    .concat(commands2)
    .filter((c) => c.includes('DB_CLEANUP_APPLY'));
  assert.equal(applyCommands.length, 1, 'only the first pass deletes the orphan');
  assert.match(applyCommands[0] ?? '', /devbridge delete cccc2345/);
  assert.doesNotMatch(applyCommands[0] ?? '', /devbridge delete aaaa2345/);
  assert.doesNotMatch(applyCommands[0] ?? '', /devbridge delete bbbb2345/);
  assert.doesNotMatch(applyCommands[0] ?? '', /kill 100/);
  assert.doesNotMatch(applyCommands[0] ?? '', /kill 200/);
  // The orphan host is killed; the keepalive-protected tunnel's host is not.
  assert.match(applyCommands[0] ?? '', /kill 300/);

  // The keepalive roster is unchanged by the first pass (the orphan had no
  // watchdog entry), so no re-install runs — the protected tunnel's coverage
  // is not even touched.
  const installCommands = commands
    .concat(commands2)
    .filter((c) => c.includes('cat > /tmp/tunnel-keepalive.sh'));
  assert.equal(installCommands.length, 0);
});

test('cleanup: a failed list skips the cleanup, never deletes on a guess (flow)', async () => {
  const { commands, seam } = cleanupSeam({
    ...TWO_PORT_STATE,
    tunnels: 'Error: 40100 unauthorized (expired CLI token)',
    hosts: '',
    keepalive: '',
  });
  const result = await runCleanup(seam, { mode: 'stale' });
  assert.equal(result.ok, false);
  assert.equal(result.listFailed, true);
  assert.deepEqual(result.deleteIds, []);
  assert.deepEqual(result.killPids, []);
  assert.equal(
    commands.filter((c) => c.includes('DB_CLEANUP_APPLY')).length,
    0,
    'no apply script may run when the list failed',
  );
});

test('cleanup: a busy lock skips the cleanup without touching the sandbox (flow)', async () => {
  const busy: Parameters<typeof _setOneShotForTests>[0] = async (_ws, command) => {
    assert.ok(!command.includes('DB_CLEANUP_APPLY'), 'no apply may run while the lock is held');
    assert.ok(!command.includes('devbridge list'), 'no state read may run while the lock is held');
    return { stdout: command.startsWith('LOCK=') ? 'LOCK_BUSY\n' : '', exitCode: 0 };
  };
  const result = await runCleanup(busy, { mode: 'stale' });
  assert.equal(result.ok, false);
  assert.equal(result.locked, true);
  assert.deepEqual(result.deleteIds, []);
  assert.deepEqual(result.killPids, []);
});

test('cleanup: ghost keepalive entries (deleted records) are pruned from the watchdog (flow)', async () => {
  // The watchdog still lists the deleted orphan cccc2345 — the sync must prune
  // it so it is not re-hosted and renewed forever.
  const ghostState: CleanupState = {
    ...TWO_PORT_STATE,
    tunnels: TWO_PORT_STATE.tunnels.replace(/cccc2345.*\r\n/, ''),
    hosts: TWO_PORT_STATE.hosts.replace(/300 devbridge host dddd2345\r\n/, ''),
    keepalive: `${TWO_PORT_STATE.keepalive} cccc2345:https://cccc2345-18099.devbridge-s2.hwtunnel.com:18099`,
  };
  const { commands, seam } = cleanupSeam(ghostState);
  const result = await runCleanup(seam, { mode: 'stale' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.deleteIds, []);
  const install = commands.find((c) => c.includes('cat > /tmp/tunnel-keepalive.sh'));
  assert.ok(install, 'the watchdog is re-installed with the pruned roster');
  assert.match(install ?? '', /aaaa2345:https:\/\/aaaa2345-18082\.devbridge-s2\.hwtunnel\.com:18082/);
  assert.doesNotMatch(install ?? '', /cccc2345/, 'the ghost entry is pruned');
  // Round-trip pin (interrogate port-pr4 A-F1): the re-installed entry carries
  // the generated three-field shape exactly — a parsed URL that kept its
  // :port tail would grow one field per roster rewrite.
  assert.doesNotMatch(install ?? '', /:18082:18082/, 'the port tail must not double through the sync round trip');
});

test('cleanup: same-port replacement deletes only that port before an expose (flow)', async () => {
  // Expose on port 18084 replaces bbbb2345 only; the keepalive-protected
  // aaaa2345 on 18082 stays.
  const { commands, seam } = cleanupSeam(TWO_PORT_STATE);
  const result = await runCleanup(seam, { mode: 'stale', samePort: 18084 });
  assert.equal(result.ok, true);
  assert.deepEqual(
    (result.deleteIds as string[]).sort((a, b) => a.localeCompare(b)),
    ['bbbb2345', 'cccc2345'],
  );
  const apply = commands.find((c) => c.includes('DB_CLEANUP_APPLY'));
  assert.match(apply ?? '', /devbridge delete bbbb2345/);
  assert.match(apply ?? '', /devbridge delete cccc2345/);
  assert.doesNotMatch(apply ?? '', /devbridge delete aaaa2345/);
  assert.match(apply ?? '', /kill 200/);
  assert.doesNotMatch(apply ?? '', /kill 100/);
});

test('cleanup: the state script port queries drive the merge — custom-named same-port tunnel replaced (B-R2-3, flow)', async () => {
  // The remediation's own flow creates custom-named tunnels (devbridge create
  // <name>) and does not enroll them; the name-shape and roster reads cannot
  // see them. The state script's TUNNEL_PORTS_ queries must carry the port so
  // the plan replaces the tunnel — or every later expose fails on the taken
  // port.
  const { commands, seam } = cleanupSeam({
    tunnels:
      'Tunnel ID  Name              Description  Tunnel Expiration  Port Count\r\n' +
      'lw3bmxny   kanban-board      dev             30 days            1\r\n',
    hosts: '4242 devbridge host lw3bmxny -p 8787\r\n',
    keepalive: '',
    ports: 'TUNNEL_PORTS_lw3bmxny=8787,',
  });
  const result = await runCleanup(seam, { mode: 'stale', samePort: 8787 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.deleteIds, ['lw3bmxny']);
  assert.deepEqual(result.killPids, [4242]);
  const apply = commands.find((c) => c.includes('DB_CLEANUP_APPLY'));
  assert.match(apply ?? '', /devbridge delete lw3bmxny/);
  assert.match(apply ?? '', /kill 4242/);
});

test('cleanup: the lock is released even when the state exec fails (flow)', async () => {
  const commands: string[] = [];
  const seam = async (_ws: string, command: string) => {
    commands.push(command);
    if (command.startsWith('LOCK=')) return { stdout: 'LOCK_OK\n', exitCode: 0 };
    if (command.includes('DB_CLEANUP_TUNNELS_BEGIN')) throw new Error('ws-exec timeout (124)');
    return { stdout: '', exitCode: 0 };
  };
  await assert.rejects(
    runCleanup(seam as unknown as Parameters<typeof _setOneShotForTests>[0], { mode: 'stale' }),
    /ws-exec timeout/,
  );
  assert.ok(
    commands.some((c) => c.startsWith('rmdir /tmp/devbridge-cleanup.lock')),
    'the finally block releases the lock',
  );
});
