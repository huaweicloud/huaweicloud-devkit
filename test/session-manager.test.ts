import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { fixtureDir } from './fixture-dir.ts';
import {
  resolveWsExecIndexUrl,
  splitBase64Chunks,
  UPLOAD_CHUNK_SIZE,
  getCurrentWorkspaceId,
  setWorkspaceId,
  formatPortConflictWarning,
  formatPortDriftWarning,
  resolveProxyNodePort,
  buildExposeRemediation,
  TUNNEL_URL_PATTERN,
  resolveNginxConfigPath,
  parseDeployNginxVerifyOutput,
  evaluateDeployNginxVerify,
  _setSessionConnectorForTests,
  execWithSession,
  closeAllSessions,
  classifyLocalUploadPath,
  buildUploadResetCommand,
  uploadFileWithSession,
} from '../plugins/huaweicloud-core/src/sandbox/session-manager.ts';

function escapeRegExp(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Models the real HwlinkTerminalExecSession failure surface: once the
// transport dies (state 'closed'), every exec rejects with the
// closed-before-marker error until the entry is evicted from the cache.
class FakeSession {
  state: 'opening' | 'ready' | 'closed' = 'ready';
  execCalls: string[] = [];
  close() {}
  async exec(command: string): Promise<{ stdout: string; exitCode: number }> {
    if (this.state === 'closed') {
      throw new Error('hwlink terminal closed before completion marker');
    }
    this.execCalls.push(command);
    return { stdout: command, exitCode: 0 };
  }
}

test('a dead cached session is evicted and replaced on the next exec', async () => {
  const made: FakeSession[] = [];
  _setSessionConnectorForTests(async () => {
    const session = new FakeSession();
    made.push(session);
    return session;
  });
  try {
    const first = await execWithSession('ws-evict-test', 'echo one', 'root');
    assert.equal(first.stdout, 'echo one');
    made[0].state = 'closed';
    const second = await execWithSession('ws-evict-test', 'echo two', 'root');
    assert.equal(second.stdout, 'echo two');
    assert.equal(made.length, 2, 'a closed session must not be reused');
    assert.deepEqual(made[1].execCalls, ['echo two']);
  } finally {
    _setSessionConnectorForTests(null);
    closeAllSessions();
  }
});

test('a live cached session is reused without reconnecting', async () => {
  const made: FakeSession[] = [];
  _setSessionConnectorForTests(async () => {
    const session = new FakeSession();
    made.push(session);
    return session;
  });
  try {
    await execWithSession('ws-reuse-test', 'echo one', 'root');
    await execWithSession('ws-reuse-test', 'echo two', 'root');
    assert.equal(made.length, 1, 'a live session must be cached, not recreated');
    assert.deepEqual(made[0].execCalls, ['echo one', 'echo two']);
  } finally {
    _setSessionConnectorForTests(null);
    closeAllSessions();
  }
});

test('ws-exec dynamic import uses file:// URL (Windows-safe)', async () => {
  const wsExecIndexUrl = resolveWsExecIndexUrl();
  assert.ok(wsExecIndexUrl.startsWith('file://'), `expected file:// URL, got: ${wsExecIndexUrl}`);
  const mod = await import(wsExecIndexUrl);
  assert.equal(typeof mod.connectHwlinkTerminalSession, 'function');
  assert.equal(typeof mod.executeHwlinkCommand, 'function');
});

test('splitBase64Chunks splits into chunks no larger than the limit and reassembles losslessly', () => {
  const base64 = Buffer.from('x'.repeat(100000)).toString('base64');
  const chunks = splitBase64Chunks(base64);
  assert.ok(chunks.length > 1, 'expected multiple chunks');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= UPLOAD_CHUNK_SIZE, `chunk exceeds limit: ${chunk.length}`);
  }
  assert.equal(chunks.join(''), base64);
});

test('splitBase64Chunks returns a single chunk for small inputs', () => {
  const base64 = Buffer.from('hello').toString('base64');
  const chunks = splitBase64Chunks(base64);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], base64);
});

test('currentWorkspaceId defaults to null without env or setter', () => {
  assert.equal(getCurrentWorkspaceId(), null);
});

test('setWorkspaceId caches and updates env var', () => {
  const testId = 'test-workspace-123';
  setWorkspaceId(testId);
  assert.equal(getCurrentWorkspaceId(), testId);
  assert.equal(process.env.HW_WORKSPACE_ID, testId);
  setWorkspaceId(null);
});

test('formatPortConflictWarning returns undefined when port is unchanged', () => {
  assert.equal(formatPortConflictWarning(80, 80), undefined);
});

test('formatPortConflictWarning reports the real auto-assigned port', () => {
  assert.equal(formatPortConflictWarning(80, 81), 'Port 80 is in use — auto-assigned port 81');
});

test('formatPortDriftWarning is undefined without drift', () => {
  assert.equal(formatPortDriftWarning(80, 80), undefined);
});

test('formatPortDriftWarning names both ports and the re-bind command', () => {
  const msg = formatPortDriftWarning(80, 81);
  assert.match(msg!, /nginx now listens on port 81/);
  assert.match(msg!, /devbridge port create <tunnelId> -p 81 --protocol http -a/);
});

test('buildExposeRemediation includes credential sourcing and host command with port', () => {
  const msg = buildExposeRemediation(82);
  assert.match(msg, /source \/tmp\/hw_creds\.sh/);
  assert.match(msg, /source \/tmp\/hw_api_key/);
  assert.match(msg, /devbridge port create <tunnelId> -p 82 --protocol http -a/);
  assert.match(msg, /use THAT port instead/);
});

test('TUNNEL_URL_PATTERN matches a real tunnel URL', () => {
  const m = 'TUNNEL_URL:https://c4rdv7bv-80.devbridge-s2.hwtunnel.com'.match(TUNNEL_URL_PATTERN);
  assert.ok(m, 'valid URL should match');
  assert.equal(m[1], 'https://c4rdv7bv-80.devbridge-s2.hwtunnel.com');
});

test('TUNNEL_URL_PATTERN rejects URL with empty tunnel prefix', () => {
  assert.equal('TUNNEL_URL:https://-80.devbridge-s2.hwtunnel.com'.match(TUNNEL_URL_PATTERN), null);
});

test('TUNNEL_URL_PATTERN no longer matches the migrated legacy domain', () => {
  assert.equal('TUNNEL_URL:https://c4rdv7bv-80.cn-north-4-bridge.myhuaweicloud.com'.match(TUNNEL_URL_PATTERN), null);
});

test('resolveProxyNodePort defaults to nginxListenPort + 1 when no nodePort is given', async () => {
  const port = await resolveProxyNodePort(undefined, 80, async () => false);
  assert.equal(port, 81);
});

test('resolveProxyNodePort keeps the explicit nodePort when it differs from the nginx listen port', async () => {
  const port = await resolveProxyNodePort(82, 80, async () => false);
  assert.equal(port, 82);
});

test('resolveProxyNodePort falls back to nginxListenPort + 1 when nodePort collides with the nginx listen port', async () => {
  const port = await resolveProxyNodePort(80, 80, async () => false);
  assert.equal(port, 81);
});

test('resolveProxyNodePort re-probes upward when the default candidate is in use', async () => {
  const used = new Set([81]);
  const port = await resolveProxyNodePort(undefined, 80, async (p) => used.has(p));
  assert.equal(port, 82);
});

test('resolveProxyNodePort re-probes upward when the explicit nodePort is in use', async () => {
  const used = new Set([82]);
  const port = await resolveProxyNodePort(82, 80, async (p) => used.has(p));
  assert.equal(port, 83);
});

test('resolveProxyNodePort re-probes past targetPort + 1 when it is occupied', async () => {
  const used = new Set([81, 82]);
  const port = await resolveProxyNodePort(undefined, 80, async (p) => used.has(p));
  assert.equal(port, 83);
});

// ---------------------------------------------------------------------------
// A1 (#935): deploy_nginx configName basename sanitation + write verification
// (ported from main's 1.1.10 issue-935 battery; the doc claim in the sandbox
// skill — 配置写入后自动回验存在性与 nginx -t — is backed by these paths).
// ---------------------------------------------------------------------------

test('resolveNginxConfigPath strips path separators from configName (#935 A1)', () => {
  // Regression input from report 3 problem 2: a path-shaped configName used to
  // produce `/etc/nginx/conf.d//root/hc-activity.conf` (broken path, tunnel 502).
  const path = resolveNginxConfigPath('/root/xxx.conf', 'myapp');
  assert.equal(path, '/etc/nginx/conf.d/xxx.conf');
  assert.ok(!path.includes('//'), `config path must not contain "//": ${path}`);
});

test('resolveNginxConfigPath takes the basename of nested relative paths (#935 A1)', () => {
  assert.equal(resolveNginxConfigPath('./x/y.conf', 'myapp'), '/etc/nginx/conf.d/y.conf');
  assert.equal(resolveNginxConfigPath('dir/sub/site.conf', 'myapp'), '/etc/nginx/conf.d/site.conf');
});

test('resolveNginxConfigPath strips Windows-style separators too (#935 A1)', () => {
  assert.equal(resolveNginxConfigPath('C:\\root\\a.conf', 'myapp'), '/etc/nginx/conf.d/a.conf');
});

test('resolveNginxConfigPath keeps pure-filename behavior unchanged (#935 A1 constraint)', () => {
  assert.equal(resolveNginxConfigPath('webapp', 'myapp'), '/etc/nginx/conf.d/webapp.conf');
  assert.equal(resolveNginxConfigPath('webapp.conf', 'myapp'), '/etc/nginx/conf.d/webapp.conf');
  // Empty configName falls back to the project name (previous behavior).
  assert.equal(resolveNginxConfigPath('', 'myapp'), '/etc/nginx/conf.d/myapp.conf');
});

test('parseDeployNginxVerifyOutput detects a missing config file (tee write failed) (#935 A1)', () => {
  const stdout = ['some deploy output', 'DB_NGINX_CONFIG_MISSING=1'].join('\n');
  const verify = parseDeployNginxVerifyOutput(stdout);
  assert.equal(verify.configMissing, true);
});

test('parseDeployNginxVerifyOutput captures a failing nginx -t (#935 A1)', () => {
  const stdout = [
    'deploy output',
    'DB_NGINX_CONFIG_OK=1',
    'DB_NGINX_T=FAIL',
    'DB_NGINX_T_OUTPUT: nginx: [emerg] unknown directive "foo" in /etc/nginx/conf.d/x.conf:1',
    'DB_NGINX_T_OUTPUT: nginx: configuration file /etc/nginx/nginx.conf test failed',
  ].join('\n');
  const verify = parseDeployNginxVerifyOutput(stdout);
  assert.equal(verify.configMissing, false);
  assert.equal(verify.nginxTest, 'FAIL');
  assert.match(verify.nginxTestOutput, /unknown directive/);
});

test('parseDeployNginxVerifyOutput reports PASS for a clean nginx -t (#935 A1)', () => {
  const verify = parseDeployNginxVerifyOutput('DB_NGINX_CONFIG_OK=1\nDB_NGINX_T=PASS\n');
  assert.equal(verify.configMissing, false);
  assert.equal(verify.nginxTest, 'PASS');
});

test('parseDeployNginxVerifyOutput survives OSC/CSI-wrapped output (#946 shell shape, port-v2defects)', () => {
  // Integration-enabled shells wrap EVERY line in OSC 133 markers (the
  // devbridge-auth/devbridge-expose comment testimony): the anchored
  // ^DB_NGINX_T= lookup read empty, so every SUCCESSFUL deploy_nginx
  // returned ok:false "nginx -t did not pass" with an empty diagnosis
  // (DB_NGINX_T_OUTPUT equally blinded) — fail-closed toward false
  // failure, but the tool was broken on a real shell class. The parser
  // folds stripTerminalEscapes in like every sandbox-output parser.
  const osc = '\x1b]133;C\x07';
  const pass = parseDeployNginxVerifyOutput(
    ['deploy output', `${osc}DB_NGINX_CONFIG_OK=1`, `${osc}DB_NGINX_T=PASS`].join('\r\n'),
  );
  assert.equal(pass.configMissing, false);
  assert.equal(pass.nginxTest, 'PASS', 'OSC-wrapped PASS marker must be stripped and read');
  // ST-terminated OSC (tmux passthrough emits \x1b\\ instead of BEL) — the
  // OSC regex's second alternative, pinned so a BEL-only "simplification"
  // cannot pass the suite (interrogate round 1).
  assert.equal(
    parseDeployNginxVerifyOutput('\x1b]133;C\x1b\\DB_NGINX_T=PASS').nginxTest,
    'PASS',
    'ST-terminated OSC must be stripped and read',
  );
  // Residual whitespace around a marker line (a shell variant appending a
  // space after the terminator, an indented echo) — the per-line trim
  // (deploy-check sibling doctrine) must keep the anchored lookups reading
  // (interrogate round 1; the pre-trim parser read nginxTest "" here).
  // Both halves pinned: the trailing space on the T= line, the leading
  // spaces on the MISSING line (interrogate round 2), and the configMissing
  // read on this very input (previously exercised but unasserted).
  const residual = parseDeployNginxVerifyOutput('DB_NGINX_T=PASS \r\n  DB_NGINX_CONFIG_MISSING=1\n');
  assert.equal(residual.nginxTest, 'PASS', 'a trailing space after the value must not blind the T= anchor');
  assert.equal(residual.configMissing, true, 'a leading-space indented MISSING marker must still read');
  assert.equal(
    parseDeployNginxVerifyOutput('  DB_NGINX_T=PASS\n').nginxTest,
    'PASS',
    'an indented T= marker must still read',
  );
  const fail = parseDeployNginxVerifyOutput(
    [
      `${osc}DB_NGINX_CONFIG_OK=1`,
      `${osc}DB_NGINX_T=FAIL`,
      `${osc}DB_NGINX_T_OUTPUT: nginx: [emerg] unknown directive "foo"`,
    ].join('\r\n'),
  );
  assert.equal(fail.nginxTest, 'FAIL');
  assert.match(fail.nginxTestOutput, /unknown directive/);
  const missing = parseDeployNginxVerifyOutput(`\x1b[?2026h${osc}DB_NGINX_CONFIG_MISSING=1\r\n`);
  assert.equal(missing.configMissing, true, 'OSC/CSI-wrapped missing marker must be read');
  // The selective-swallow repro (interrogate round 2): an OSC hyperlink-style
  // sequence opened before the MISSING line and BEL-closed after it swallows
  // the marker wholesale while the T=PASS line survives. Pre-inversion this
  // composed to ok:true — the #935 false success resurrected; with every
  // marker presence-required, the swallowed MISSING plus the absent OK read
  // as the failure direction.
  const swallowed = parseDeployNginxVerifyOutput(
    '\x1b]8;;id=x\r\nDB_NGINX_CONFIG_MISSING=1\x07\r\nDB_NGINX_T=PASS\r\n',
  );
  assert.equal(swallowed.nginxTest, 'PASS');
  assert.equal(swallowed.configMissing, true, 'a swallowed MISSING marker must read as missing (OK absent)');
  assert.equal(
    evaluateDeployNginxVerify({ exitCode: 0 }, swallowed, '/etc/nginx/conf.d/x.conf').ok,
    false,
    'the selective-swallow shape must not compose to a false success',
  );
  // The verdict composes: a wrapped-but-successful deploy must be ok:true.
  const verdict = evaluateDeployNginxVerify(
    { exitCode: 0 },
    parseDeployNginxVerifyOutput(`${osc}DB_NGINX_CONFIG_OK=1\r\n${osc}DB_NGINX_T=PASS`),
    '/etc/nginx/conf.d/x.conf',
  );
  assert.equal(verdict.ok, true, 'a successful OSC-shell deploy must not read as failed');
});

test('evaluateDeployNginxVerify returns ok:false with explicit error on tee write failure (#935 A1)', () => {
  const result = { exitCode: 0 };
  const verify = parseDeployNginxVerifyOutput('DB_NGINX_CONFIG_MISSING=1\n');
  const verdict = evaluateDeployNginxVerify(result, verify, '/etc/nginx/conf.d/xxx.conf');
  assert.equal(verdict.ok, false);
  assert.match(verdict.error ?? '', /tee write failed/);
  assert.match(verdict.error ?? '', /\/etc\/nginx\/conf\.d\/xxx\.conf/);
});

test('evaluateDeployNginxVerify returns ok:false with explicit error on nginx -t failure (#935 A1)', () => {
  const result = { exitCode: 0 };
  const verify = parseDeployNginxVerifyOutput(
    'DB_NGINX_CONFIG_OK=1\nDB_NGINX_T=FAIL\nDB_NGINX_T_OUTPUT: nginx: [emerg] bad config\n',
  );
  const verdict = evaluateDeployNginxVerify(result, verify, '/etc/nginx/conf.d/xxx.conf');
  assert.equal(verdict.ok, false);
  assert.match(verdict.error ?? '', /nginx -t did not pass/);
  assert.match(verdict.error ?? '', /bad config/);
});

test('evaluateDeployNginxVerify returns ok:false on non-zero deploy exit (#935 A1)', () => {
  const verdict = evaluateDeployNginxVerify(
    { exitCode: 1 },
    parseDeployNginxVerifyOutput(''),
    '/etc/nginx/conf.d/x.conf',
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.error ?? '', /exited with code 1/);
});

test('evaluateDeployNginxVerify returns ok:true for a verified write (#935 A1)', () => {
  const result = { exitCode: 0 };
  const verify = parseDeployNginxVerifyOutput('DB_NGINX_CONFIG_OK=1\nDB_NGINX_T=PASS\n');
  assert.equal(evaluateDeployNginxVerify(result, verify, '/etc/nginx/conf.d/x.conf').ok, true);
});

// --- 953: upload local-path classification + remote mkdir ---
// (ported from main's 1.1.10 battery; the report case was an agent handing
// the MCP server a path from another machine — the old error said "file not
// found" even when the whole parent tree was absent.)

test('953: buildUploadResetCommand mkdirs the remote parent before any chunk writes', () => {
  const cmd = buildUploadResetCommand('/workspace/game2048/index.html', '/workspace/game2048/index.html.b64tmp');
  assert.match(cmd, /^mkdir -p "\$\(dirname "\/workspace\/game2048\/index\.html"\)" && /);
  assert.match(cmd, /rm -f "\/workspace\/game2048\/index\.html\.b64tmp"$/);
});

test('953: buildUploadResetCommand quotes paths containing spaces', () => {
  const cmd = buildUploadResetCommand('/workspace/my site/index .html', '/tmp/x y.b64tmp');
  assert.ok(cmd.includes('"/workspace/my site/index .html"'));
  assert.ok(cmd.includes('"/tmp/x y.b64tmp"'));
});

test('953: classifyLocalUploadPath distinguishes missing file vs missing parent directory', () => {
  const dir = fixtureDir('upload-classify-');
  const existingFile = join(dir, 'exists.txt');
  writeFileSync(existingFile, 'x');

  // Existing file with existing parent -> pass.
  assert.equal(classifyLocalUploadPath(existingFile, 'file'), null);
  // Existing directory as file -> type mismatch keeps the old semantics.
  assert.match((classifyLocalUploadPath(dir, 'file') as Error).message, /path is not a regular file/);

  // Missing file, existing parent -> accurate "not found".
  const missingFile = join(dir, 'missing.txt');
  assert.match((classifyLocalUploadPath(missingFile, 'file') as Error).message, /local regular file not found/);

  // Missing file AND missing parent -> names the parent + tmp hint (the #953 report case).
  const deepMissing = join(dir, 'no', 'such', 'dir', 'file.txt');
  const err = classifyLocalUploadPath(deepMissing, 'file') as Error;
  assert.match(err.message, /directory not found/);
  assert.match(err.message, new RegExp(escapeRegExp(dir + sep + 'no')));
  assert.match(err.message, /temp directory/);
  assert.ok(err.message.includes(tmpdir()), 'the hint must name the real OS temp dir');

  // Directory kind mirrors the three states for upload_project — including
  // the file-as-local_dir type error uploadProjectWithSession throws.
  assert.equal(classifyLocalUploadPath(dir, 'directory'), null);
  assert.match((classifyLocalUploadPath(existingFile, 'directory') as Error).message, /path is not a directory/);
  assert.match((classifyLocalUploadPath(join(dir, 'no', 'dir'), 'directory') as Error).message, /directory not found/);
});

test('953: uploadFileWithSession creates the remote parent directory on the reset step', async () => {
  // Drive uploadFileWithSession through the session seam: the reset command
  // must be the mkdir+rm compound, not the old bare rm.
  const dir = fixtureDir('upload-reset-');
  const local = join(dir, 'payload.txt');
  writeFileSync(local, 'hello-953');
  const seen: string[] = [];
  class ResetRecordingSession {
    state: 'opening' | 'ready' | 'closed' = 'ready';
    close() {}
    async exec(command: string): Promise<{ stdout: string; exitCode: number }> {
      seen.push(command);
      if (command.includes('md5sum')) {
        return { stdout: 'f68f65ea754053a8fcf100233c26ce95', exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    }
  }
  _setSessionConnectorForTests(() => new ResetRecordingSession() as never);
  try {
    await uploadFileWithSession('ws-953', local, '/workspace/game2048/index.html');
  } finally {
    _setSessionConnectorForTests(null);
    closeAllSessions();
  }
  const reset = seen.find((c) => c.includes('b64tmp'));
  assert.ok(reset, 'a reset command targeting the b64tmp file must have run');
  assert.match(
    reset ?? '',
    /^mkdir -p "\$\(dirname "\/workspace\/game2048\/index\.html"\)" && rm -f /,
    'the reset must mkdir the remote parent before any chunk writes',
  );
});
