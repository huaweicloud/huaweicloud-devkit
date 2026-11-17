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
    'No tunnels found.\r\n';
  const tunnels = parseDevbridgeTunnelList(list);
  assert.equal(tunnels.length, 3);
  assert.deepEqual(
    tunnels.map((t) => ({ id: t.id, port: t.port, expirySeconds: t.expirySeconds })),
    [
      { id: 'ncwa54gr', port: 18082, expirySeconds: 30 * 86400 },
      // IDs may contain 0/1/8/9; parsing must not assume the base32 subset.
      { id: 'tun0l1s9', port: 18086, expirySeconds: 29 * 86400 },
      { id: 'up5kfkbb', port: 18084, expirySeconds: 23 * 3600 },
    ],
  );

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
  assert.deepEqual(
    quota.killPids.sort((a, b) => a - b),
    [200],
  );

  const quotaMore = planDevbridgeCleanup({ tunnels, hosts, keepalive, mode: 'quota', maxExtra: 2 });
  assert.deepEqual(
    quotaMore.deleteIds.sort((a, b) => a.localeCompare(b)),
    ['bbbb2345', 'cccc2345', 'eeee2345'],
  );
  assert.deepEqual(
    quotaMore.killPids.sort((a, b) => a - b),
    [200, 400],
  );
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
