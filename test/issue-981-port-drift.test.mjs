import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeployCheckScript,
  parseDeployCheckOutput,
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
  // Every local probe follows the detected port, and defaults to the caller's.
  assert.match(script, /PROBE_PORT="\$\{ACTUAL_PORT:-8080\}"/);
  assert.match(script, /http:\/\/localhost:\$PROBE_PORT 2>\/dev\/null/);
  assert.match(script, /http:\/\/localhost:\$PROBE_PORT\/\.deploy_fingerprint/);
  // Drift note is emitted in the human-readable check detail.
  assert.match(script, /DRIFT_NOTE=", drift from 8080"/);
});

test('#981: port-drift diagnostics never change the score', () => {
  const script = buildScript();
  const block = script.slice(script.indexOf('NGINX_T_FILE'), script.indexOf('NGINX_LISTEN_PORT:'));
  assert.ok(block.length > 0);
  assert.ok(!block.includes('TOTAL=$((TOTAL+1))'), 'drift detection must not add a scored check');
  assert.ok(!block.includes('PASS=$((PASS+1))'), 'drift detection must not pass a check');
});

test('#981: parseDeployCheckOutput reports portDrift and the actual nginx port', () => {
  const stdout = [
    '=== DEPLOY CHECK ===',
    'PORT_DRIFT:8080->8081',
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
    message: 'nginx listens on port 8081, not 8080 — checks probed port 8081; rebind the DevBridge tunnel to port 8081',
  });
  assert.equal(result.checks.PORT_DRIFT, undefined, 'drift markers must not be parsed as a check status');
  assert.equal(result.publicUrl, 'https://abc12345-8081.devbridge-s2.hwtunnel.com');
});

test('#981: a drifted port drives the tunnel remediation to the ACTUAL port', () => {
  const stdout = [
    'PORT_DRIFT:8080->8081',
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
