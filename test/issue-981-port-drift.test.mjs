import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyAutoRebind,
  buildDeployCheckScript,
  buildExposeRemediation,
  parseDeployCheckOutput,
  shouldAutoRebind,
} from '../plugins/huaweicloud-core/src/sandbox/session-manager.mjs';

const OSC = '\x1b]133;C\x07';
const oscLine = (s) => OSC + s;

const buildScript = (port = 8080) =>
  buildDeployCheckScript({
    port,
    project: 'myapp',
    outputPath: '/workspace/myapp/dist',
    isCrossPlatform: false,
  });

// --- execution-level harness -------------------------------------------------
// The drift branch is shell, so a string-contract test can pass while the branch
// is broken (awk syntax, quoting, PATH). These cases run the generated script for
// real against fake `ss` / `sudo` / `nginx` / `curl` binaries.
const canRunShell = process.platform !== 'win32';

function runScript({ port = 8080, listenPorts = [], nginxConf = null }) {
  const root = mkdtempSync(join(tmpdir(), 'dc981-'));
  const binDir = join(root, 'bin');
  const dist = join(root, 'myapp-dist');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<html></html>');

  const fake = (name, body) => {
    const file = join(binDir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  fake(
    'ss',
    `echo '${listenPorts.map((p) => `LISTEN 0 511 0.0.0.0:${p} 0.0.0.0:* users:(("nginx",pid=77,fd=6))`).join('\\n')}'`,
  );
  fake('sudo', 'exec "$@"');
  if (nginxConf === null) {
    fake('nginx', 'exit 1');
  } else {
    const confFile = join(root, 'nginx-T.txt');
    // `%DIST%` expands to the real (temp) output dir the script is told to match.
    writeFileSync(confFile, String(nginxConf).split('%DIST%').join(dist));
    fake('nginx', `cat "${confFile}"`);
  }
  // HTTP 200 for every probe; -o bodies stay empty so the fingerprint check SKIPs.
  fake('curl', `printf '%s' "$FAKE_CURL_CODE"`);

  const script = buildDeployCheckScript({
    port,
    project: 'myapp',
    outputPath: dist,
    isCrossPlatform: false,
  });
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_CURL_CODE: '200',
  };
  const res = spawnSync('bash', ['-c', script], { env, encoding: 'utf8', timeout: 30000 });
  rmSync(root, { recursive: true, force: true });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', dist };
}

const skipShell = canRunShell ? false : 'POSIX shell harness is not available on Windows';

test('#981: deploy_check script detects the actual nginx listen port read-only', () => {
  const script = buildScript();
  // Read-only sources: live listeners first, then the listening config.
  assert.match(script, /NGINX_LISTEN_PORTS=\$\(ss -tlnp/);
  assert.match(script, /grep -rhoE '\^\[\[:space:\]\]\*listen/);
  // The config whose root/alias is THIS deployment wins over an arbitrary port.
  assert.match(script, /sudo nginx -T/);
  assert.match(script, /awk -v want="\/workspace\/myapp\/dist"/);
  assert.match(script, /NGINX_LISTEN_PORT:/);
  assert.match(script, /PORT_DRIFT:none/);
  assert.match(script, /PORT_DRIFT:8080->\$ACTUAL_PORT/);
  // Review R3: attribution is path-boundary aware, never a raw substring match.
  assert.match(script, /index\(v, want "\/"\) == 1/);
  // Review: concurrent deploy_check calls must not share a fixed temp file.
  assert.match(script, /NGINX_T_FILE=\$\(mktemp \/tmp\/\.dc_nginx_T\.XXXXXX/);
  assert.match(script, /TUNNEL_BODY_FILE=\$\(mktemp \/tmp\/\.dc_tunnel_body\.XXXXXX/);
  // Every local probe follows the detected port, and defaults to the caller's.
  assert.match(script, /PROBE_PORT="\$\{ACTUAL_PORT:-8080\}"/);
  assert.match(script, /http:\/\/localhost:\$PROBE_PORT 2>\/dev\/null/);
  assert.match(script, /http:\/\/localhost:\$PROBE_PORT\/\.deploy_fingerprint/);
  // Drift note is emitted in the human-readable check detail.
  assert.match(script, /DRIFT_NOTE=", drift from 8080"/);
});

test('#981: a single unrelated listener is never preferred over an ambiguous set', () => {
  const script = buildScript();
  // Review R3: the old `first port wins` fallback is gone — multiple listeners with
  // no root match stay unknown (fail open) instead of blaming another site's port.
  assert.doesNotMatch(script, /elif \[ -n "\$NGINX_LISTEN_PORTS" \]; then/);
  assert.match(script, /elif \[ "\$PORT_COUNT" = "1" \]; then/);
  assert.match(script, /PORT_DRIFT_BASIS:unknown/);
});

test('#981: port-drift diagnostics never change the score', () => {
  const script = buildScript();
  const block = script.slice(script.indexOf('NGINX_T_FILE'), script.indexOf('NGINX_LISTEN_PORT:'));
  assert.ok(block.length > 0);
  assert.ok(!block.includes('TOTAL=$((TOTAL+1))'), 'drift detection must not add a scored check');
  assert.ok(!block.includes('PASS=$((PASS+1))'), 'drift detection must not pass a check');
});

test('#981: the remediation string never carries a global delete-all', () => {
  const msg = buildExposeRemediation(8081);
  // Review R2: the skill tells agents to run this string verbatim; delete-all would
  // wipe tunnels published by other sessions on a shared sandbox.
  assert.doesNotMatch(msg, /devbridge delete-all(?!")/);
  assert.match(msg, /devbridge delete <stale-tunnel-id>/);
  assert.match(msg, /never "devbridge delete-all"/);
  assert.match(msg, /huaweicloud_sandbox_expose_tunnel \{"port": 8081\}/);
  assert.match(msg, /-p 8081 --protocol http -a/);
});

test('#981: parseDeployCheckOutput reports portDrift and the actual nginx port', () => {
  const stdout = [
    '=== DEPLOY CHECK ===',
    'PORT_DRIFT:8080->8081',
    'PORT_DRIFT_BASIS:listening',
    'NGINX_LISTEN_PORT:8081',
    'nginx_serving:PASS (port 8081, HTTP 200, drift from 8080)',
    'output_dir:PASS (/workspace/myapp/dist)',
    'devbridge_tunnel:PASS',
    'tunnel_url_accessible:PASS (https://abc12345-8081.devbridge-s2.hwtunnel.com)',
    'SCORE:4/4',
    'TUNNEL_URL:https://abc12345-8081.devbridge-s2.hwtunnel.com',
    'VERDICT:COMPLETE',
  ].join('\n');
  const result = parseDeployCheckOutput(stdout, { port: 8080, isCrossPlatform: false });
  assert.equal(result.complete, true);
  assert.equal(result.requestedPort, 8080);
  assert.equal(result.nginxListenPort, 8081);
  assert.deepEqual(result.portDrift, {
    requested: 8080,
    actual: 8081,
    basis: 'listening',
    message: 'nginx listens on port 8081, not 8080 — checks probed port 8081; rebind the DevBridge tunnel to port 8081',
  });
  assert.equal(result.checks.PORT_DRIFT, undefined, 'drift markers must not be parsed as a check status');
  assert.equal(result.publicUrl, 'https://abc12345-8081.devbridge-s2.hwtunnel.com');
});

test('#981: configured-but-not-listening drift gets its own wording', () => {
  const stdout = [
    'PORT_DRIFT:8080->8081',
    'PORT_DRIFT_BASIS:configured',
    'NGINX_LISTEN_PORT:8081',
    'nginx_serving:FAIL (port 8081, no HTTP response)',
    'SCORE:0/1',
    'VERDICT:INCOMPLETE',
  ].join('\n');
  const result = parseDeployCheckOutput(stdout, { port: 8080, isCrossPlatform: false });
  assert.equal(result.portDrift.basis, 'configured');
  assert.match(result.portDrift.message, /config for this deployment listens on port 8081/);
  assert.match(result.portDrift.message, /reload\/restart nginx/);
});

test('#981: a drifted port drives the tunnel remediation to the ACTUAL port', () => {
  const stdout = [
    'PORT_DRIFT:8080->8081',
    'PORT_DRIFT_BASIS:listening',
    'NGINX_LISTEN_PORT:8081',
    'nginx_serving:PASS (port 8081, HTTP 200, drift from 8080)',
    'output_dir:PASS (/workspace/myapp/dist)',
    'devbridge_tunnel:PASS',
    'tunnel_url_accessible:FAIL (https://abc12345-8081.devbridge-s2.hwtunnel.com -> port not configured (URL port not registered on the tunnel), nginx listens on 8081 instead of 8080)',
    'SCORE:3/4',
    'VERDICT:INCOMPLETE',
  ].join('\n');
  const result = parseDeployCheckOutput(stdout, { port: 8080, isCrossPlatform: false });
  assert.equal(result.complete, false);
  assert.equal(result.nextStep, 'expose_via_devbridge');
  assert.match(result.remediation, /-p 8081/, 'remediation must name the actual port');
  assert.ok(!/-p 8080\b/.test(result.remediation), 'remediation must not repeat the stale port');
  assert.equal(result.portDrift.actual, 8081);
});

test('#981: no drift keeps the legacy response shape', () => {
  const stdout = [
    'PORT_DRIFT:none',
    'PORT_DRIFT_BASIS:listening',
    'NGINX_LISTEN_PORT:8080',
    'nginx_serving:PASS (port 8080, HTTP 200)',
    'output_dir:PASS (/workspace/myapp/dist)',
    'devbridge_tunnel:FAIL',
    'tunnel_url_accessible:FAIL (no tunnel)',
    'SCORE:2/4',
    'VERDICT:INCOMPLETE',
  ].join('\n');
  const result = parseDeployCheckOutput(stdout, { port: 8080, isCrossPlatform: false });
  assert.equal(result.portDrift, undefined);
  assert.equal(result.nginxListenPort, 8080);
  assert.match(result.remediation, /-p 8080/);
});

test('#981: undetectable listen port fails open (no drift claim, requested port kept)', () => {
  const stdout = [
    'PORT_DRIFT:unknown',
    'PORT_DRIFT_BASIS:unknown',
    'NGINX_LISTEN_PORT:unknown',
    'nginx_serving:PASS (port 8080, HTTP 200)',
    'output_dir:PASS (/workspace/myapp/dist)',
    'devbridge_tunnel:FAIL',
    'tunnel_url_accessible:FAIL (no tunnel)',
    'SCORE:2/4',
    'VERDICT:INCOMPLETE',
  ].join('\n');
  const result = parseDeployCheckOutput(stdout, { port: 8080, isCrossPlatform: false });
  assert.equal(result.portDrift, undefined);
  assert.equal(result.nginxListenPort, undefined);
  assert.match(result.remediation, /-p 8080/);
});

test('#981: drift markers survive OSC-133 wrapping and CRLF line endings', () => {
  const stdout = [
    oscLine('PORT_DRIFT:8080->8081'),
    oscLine('PORT_DRIFT_BASIS:listening'),
    oscLine('NGINX_LISTEN_PORT:8081'),
    oscLine('nginx_serving:PASS (port 8081, HTTP 200, drift from 8080)'),
    oscLine('output_dir:PASS (/workspace/myapp/dist)'),
    oscLine('devbridge_tunnel:PASS'),
    oscLine('tunnel_url_accessible:PASS (https://abc12345-8081.devbridge-s2.hwtunnel.com)'),
    oscLine('SCORE:4/4'),
    oscLine('TUNNEL_URL:https://abc12345-8081.devbridge-s2.hwtunnel.com'),
    oscLine('VERDICT:COMPLETE'),
  ].join('\r\n');
  const result = parseDeployCheckOutput(stdout, { port: 8080, isCrossPlatform: false });
  assert.equal(result.complete, true);
  assert.equal(result.portDrift.actual, 8081);
  assert.equal(result.nginxListenPort, 8081);
});

// --- auto_rebind (review R1) ------------------------------------------------

test('#981: auto_rebind only fires on drift + a failed tunnel probe', () => {
  const drifted = {
    complete: false,
    portDrift: { requested: 8080, actual: 8081 },
    checks: { tunnel_url_accessible: { status: 'FAIL', detail: 'port not configured' } },
  };
  assert.equal(shouldAutoRebind(drifted), true);
  // A complete check must never trigger a write.
  assert.equal(shouldAutoRebind({ ...drifted, complete: true }), false);
  // No drift => nothing to rebind.
  assert.equal(shouldAutoRebind({ ...drifted, portDrift: undefined }), false);
  // Drift but the tunnel already serves the actual port => no write.
  assert.equal(
    shouldAutoRebind({
      ...drifted,
      checks: { tunnel_url_accessible: { status: 'PASS', detail: '' } },
    }),
    false,
  );
  // Detector only reports missingSteps.
  assert.equal(
    shouldAutoRebind({
      complete: false,
      portDrift: { requested: 1, actual: 2 },
      missingSteps: 'tunnel_url_accessible',
    }),
    true,
  );
});

test('#981: a successful auto_rebind returns the re-checked URL while keeping the drift evidence', () => {
  const first = {
    complete: false,
    requestedPort: 8080,
    nginxListenPort: 8081,
    portDrift: { requested: 8080, actual: 8081, basis: 'listening', message: 'drifted' },
    checks: { tunnel_url_accessible: { status: 'FAIL', detail: 'port not configured' } },
    nextStep: 'expose_via_devbridge',
    remediation: 'rebind to 8081',
  };
  const recheck = {
    complete: true,
    requestedPort: 8081,
    nginxListenPort: 8081,
    checks: { tunnel_url_accessible: { status: 'PASS', detail: '' } },
    publicUrl: 'https://abc12345-8081.devbridge-s2.hwtunnel.com',
    nextStep: 'complete',
  };
  const merged = applyAutoRebind(first, { ok: true, publicUrl: recheck.publicUrl, port: 8081 }, recheck);
  assert.equal(merged.complete, true);
  assert.equal(merged.publicUrl, 'https://abc12345-8081.devbridge-s2.hwtunnel.com');
  assert.equal(merged.nextStep, 'complete');
  assert.equal(merged.requestedPort, 8080, 'the original requested port stays visible');
  assert.deepEqual(merged.portDrift, first.portDrift, 'drift evidence must survive the rebind');
  assert.equal(merged.nginxListenPort, 8081);
  assert.deepEqual(merged.autoRebind, {
    attempted: true,
    ok: true,
    from: 8080,
    to: 8081,
    publicUrl: 'https://abc12345-8081.devbridge-s2.hwtunnel.com',
  });
});

test('#981: a failed auto_rebind keeps the original result and reports why', () => {
  const first = {
    complete: false,
    requestedPort: 8080,
    portDrift: { requested: 8080, actual: 8081, basis: 'listening', message: 'drifted' },
    checks: { tunnel_url_accessible: { status: 'FAIL', detail: 'port not configured' } },
    nextStep: 'expose_via_devbridge',
    remediation: 'rebind to 8081',
  };
  const merged = applyAutoRebind(first, { ok: false, error: 'DevBridge authentication failed' }, null);
  assert.equal(merged.complete, false);
  assert.equal(merged.nextStep, 'expose_via_devbridge');
  assert.equal(merged.remediation, 'rebind to 8081');
  assert.deepEqual(merged.autoRebind, {
    attempted: true,
    ok: false,
    from: 8080,
    to: 8081,
    error: 'DevBridge authentication failed',
  });
});

// --- execution-level drift branches ----------------------------------------

test('#981 (shell): drift to the actual port passes nginx_serving and reports it', { skip: skipShell }, () => {
  const run = runScript({
    port: 8080,
    listenPorts: [8081],
    nginxConf: ['server {', '  listen 8081;', '  root %DIST%;', '}'].join('\n'),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^PORT_DRIFT:8080->8081$/m);
  assert.match(run.stdout, /^PORT_DRIFT_BASIS:listening$/m);
  assert.match(run.stdout, /^NGINX_LISTEN_PORT:8081$/m);
  assert.match(run.stdout, /nginx_serving:PASS \(port 8081, HTTP 200, drift from 8080\)/);
});

test('#981 (shell): a sibling root in a multi-site sandbox stays unknown', { skip: skipShell }, () => {
  const run = runScript({
    port: 8080,
    listenPorts: [8081, 9090],
    // `/workspace/myapp/dist-old` is a DIFFERENT deployment: the old substring
    // match attributed this project's drift to 8081.
    nginxConf: ['server {', '  listen 8081;', '  root %DIST%-old;', '}'].join('\n'),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^PORT_DRIFT:unknown$/m);
  assert.match(run.stdout, /^NGINX_LISTEN_PORT:unknown$/m);
  // Fail open: probes keep the caller's port instead of another site's.
  assert.match(run.stdout, /nginx_serving:PASS \(port 8080,/);
});

test('#981 (shell): a child path under the deployment root still matches', { skip: skipShell }, () => {
  const run = runScript({
    port: 8080,
    listenPorts: [8081, 9090],
    nginxConf: ['server {', '  listen 8081;', '  root %DIST%/sub;', '}'].join('\n'),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^PORT_DRIFT:8080->8081$/m);
  assert.match(run.stdout, /^PORT_DRIFT_BASIS:listening$/m);
});

test('#981 (shell): configured-but-not-listening drift keeps the basis', { skip: skipShell }, () => {
  const run = runScript({
    port: 8080,
    listenPorts: [9090],
    nginxConf: ['server {', '  listen 8081;', '  root %DIST%;', '}'].join('\n'),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^PORT_DRIFT:8080->8081$/m);
  assert.match(run.stdout, /^PORT_DRIFT_BASIS:configured$/m);
  assert.match(run.stdout, /\(configured, not listening\)/);
});
