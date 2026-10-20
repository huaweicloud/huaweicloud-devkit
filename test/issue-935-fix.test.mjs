import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveNginxConfigPath,
  parseDeployNginxVerifyOutput,
  evaluateDeployNginxVerify,
  buildDevbridgeExposeScript,
  parseDevbridgeProbeSequence,
  formatTunnelReachabilityWarning,
  parseDevbridgeExposeOutput,
} from '../plugins/huaweicloud-core/src/sandbox/session-manager.mjs';
import { stripKooCliUpdateBanner, runHcloud } from '../plugins/huaweicloud-core/src/hcloud-cli.mjs';
import { callTool } from '../plugins/huaweicloud-core/src/tools.mjs';
import { getKooCliVersion } from '../plugins/huaweicloud-core/src/koocli-version.mjs';

// ---------------------------------------------------------------------------
// A1 (#935): deploy_nginx configName basename sanitation + write verification
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
  const verify = parseDeployNginxVerifyOutput('DB_NGINX_T=PASS\n');
  assert.equal(verify.configMissing, false);
  assert.equal(verify.nginxTest, 'PASS');
});

test('evaluateDeployNginxVerify returns ok:false with explicit error on tee write failure (#935 A1)', () => {
  const result = { exitCode: 0 };
  const verify = parseDeployNginxVerifyOutput('DB_NGINX_CONFIG_MISSING=1\n');
  const verdict = evaluateDeployNginxVerify(result, verify, '/etc/nginx/conf.d/xxx.conf');
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /tee write failed/);
  assert.match(verdict.error, /\/etc\/nginx\/conf\.d\/xxx\.conf/);
});

test('evaluateDeployNginxVerify returns ok:false with explicit error on nginx -t failure (#935 A1)', () => {
  const result = { exitCode: 0 };
  const verify = parseDeployNginxVerifyOutput('DB_NGINX_T=FAIL\nDB_NGINX_T_OUTPUT: nginx: [emerg] bad config\n');
  const verdict = evaluateDeployNginxVerify(result, verify, '/etc/nginx/conf.d/xxx.conf');
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /nginx -t did not pass/);
  assert.match(verdict.error, /bad config/);
});

test('evaluateDeployNginxVerify returns ok:false on non-zero deploy exit (#935 A1)', () => {
  const verdict = evaluateDeployNginxVerify(
    { exitCode: 1 },
    parseDeployNginxVerifyOutput(''),
    '/etc/nginx/conf.d/x.conf',
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /exited with code 1/);
});

test('evaluateDeployNginxVerify returns ok:true for a verified write (#935 A1)', () => {
  const result = { exitCode: 0 };
  const verify = parseDeployNginxVerifyOutput('DB_NGINX_T=PASS\n');
  assert.equal(evaluateDeployNginxVerify(result, verify, '/etc/nginx/conf.d/x.conf').ok, true);
});

// ---------------------------------------------------------------------------
// A2 (#935): exposeTunnel health-check retries + final-status verdict
// ---------------------------------------------------------------------------

test('buildDevbridgeExposeScript probes with a retry loop, not a fixed single curl (#935 A2)', () => {
  const script = buildDevbridgeExposeScript(80);
  // Retry loop with multiple probes.
  assert.match(script, /for i in 1 2 3 4/, 'health check must loop over multiple probes');
  assert.match(script, /DB_PROBE_\$i=/, 'each probe must be echoed as DB_PROBE_n');
  // The old fixed `sleep 12` + single curl is gone.
  assert.ok(!script.includes('sleep 12'), 'the fixed sleep 12 must be replaced by retries');
  assert.match(script, /DB_HTTP_CODE=\$HTTP_CODE/, 'the final code must be emitted');
});

test('parseDevbridgeProbeSequence takes the final probe as the verdict (#935 A2)', () => {
  const { probes, finalHttpCode } = parseDevbridgeProbeSequence(
    ['DB_PROBE_1=502', 'DB_PROBE_2=000', 'DB_PROBE_3=200', 'DB_HTTP_CODE=200'].join('\n'),
  );
  assert.equal(probes.length, 3);
  assert.equal(probes[0].httpCode, '502');
  assert.equal(probes[1].httpCode, '000');
  assert.equal(probes[2].httpCode, '200');
  // The final verdict comes from the LAST probe, not the first.
  assert.equal(finalHttpCode, '200');
});

test('a 502/000 → 200 probe sequence produces NO reachability warning (#935 A2)', () => {
  // Regression from report 2 problem 8: the old single-shot check warned
  // "Tunnel reachable check returned HTTP (expected 200/304)" while the same
  // log showed DB_HTTP_CODE=200 and a manual retry returned 200.
  const { finalHttpCode } = parseDevbridgeProbeSequence(
    ['DB_PROBE_1=502', 'DB_PROBE_2=000', 'DB_PROBE_3=200', 'DB_HTTP_CODE=200'].join('\n'),
  );
  assert.equal(formatTunnelReachabilityWarning(finalHttpCode), undefined);
});

test('a final non-200/304 probe still surfaces the reachability warning (#935 A2)', () => {
  const warning = formatTunnelReachabilityWarning('502');
  assert.match(warning, /HTTP 502/);
  assert.match(warning, /expected 200\/304/);
  assert.equal(formatTunnelReachabilityWarning('000'), formatTunnelReachabilityWarning(''));
  assert.match(formatTunnelReachabilityWarning(''), /HTTP 000/);
  // 304 is a success-equivalent (cached response) — no warning.
  assert.equal(formatTunnelReachabilityWarning('304'), undefined);
});

test('parseDevbridgeExposeOutput reports the final probe HTTP code (#935 A2)', () => {
  const stdout = [
    'DB_HOST_LOG=',
    'Tunnel URL: https://c4rdv7bv-80.devbridge-s2.hwtunnel.com',
    'DB_PROBE_1=502',
    'DB_PROBE_2=000',
    'DB_PROBE_3=200',
    'DB_TUNNEL_URL=https://c4rdv7bv-80.devbridge-s2.hwtunnel.com',
    'DB_HTTP_CODE=200',
    'DB_EXPIRY_HOURS=72',
    'DB_QUOTA_ERROR=0',
  ].join('\n');
  const parsed = parseDevbridgeExposeOutput(stdout);
  assert.equal(parsed.httpCode, '200');
  assert.equal(parsed.tunnelUrl, 'https://c4rdv7bv-80.devbridge-s2.hwtunnel.com');
  assert.equal(parsed.quotaError, false);
});

// ---------------------------------------------------------------------------
// A3 (#935): new error-code mappings in huaweicloud_explain_error
// ---------------------------------------------------------------------------

test('huaweicloud_explain_error maps Ecs.0019 to on-sale flavor re-listing (#935 A3)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0019',
    message: 'the flavor does not exist',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0019/);
  assert.match(text, /ListFlavors/, 'must direct at hcloud ECS ListFlavors');
  assert.match(text, /replacement|替代/, 'must point at switching to a replacement flavor');
  assert.match(text, /flavors\.md/, 'must reference the flavors.md status field rules');
});

test('huaweicloud_explain_error maps Ecs.0319 to AZ-capacity guidance (#935 A3)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0319',
    message: 'insufficient capacity',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0319/);
  assert.match(text, /availability zone|AZ/i, 'must suggest changing the AZ');
  assert.match(text, /replacement|替代|ListFlavors/, 'must suggest switching the flavor and retrying');
});

test('huaweicloud_explain_error maps Ecs.0067 to cash-balance/recharge guidance (#935 A3)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0067',
    message: 'insufficient account balance',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0067/);
  assert.match(text, /ShowCustomerAccountBalances/, 'must direct at the BSS cash balance query');
  assert.match(text, /top up|充值/i, 'must instruct topping up');
  assert.match(text, /代金券|voucher/i, 'must explain vouchers do not count in order risk control');
});

test('huaweicloud_explain_error adds a Kps service entry mapping KPS.9004 (#935 A3)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'KPS',
    errorCode: 'KPS.9004',
    message: 'keypair creation restricted',
  });
  const text = JSON.stringify(result);
  assert.match(text, /KPS\.9004/);
  assert.match(text, /ShowCustomerAccountBalances/, 'must direct at the BSS cash balance query');
  assert.match(text, /arrears|欠费|historical/i, 'must mention settling historical arrears');
  // Lowercase service alias resolves to the same mapping.
  const lower = await callTool('huaweicloud_explain_error', {
    service: 'kps',
    errorCode: 'KPS.9004',
    message: 'keypair creation restricted',
  });
  assert.match(JSON.stringify(lower), /KPS\.9004/);
});

// ---------------------------------------------------------------------------
// A4 (#935): KooCLI 7.2.x update-banner stripping from hcloud output
// ---------------------------------------------------------------------------

test('stripKooCliUpdateBanner removes the KooCLI 7.2.x upgrade banner line (#935 A4)', () => {
  const raw = ['可执行 hcloud update 更新至 7.3.12', '{', '  "servers": []', '}'].join('\n');
  const cleaned = stripKooCliUpdateBanner(raw);
  assert.ok(!cleaned.includes('可执行 hcloud update 更新至 7.3.12'), 'banner line must be removed');
  assert.match(cleaned, /servers/, 'the real output must survive');
});

test('stripKooCliUpdateBanner keeps real output and the DevKit one-shot upgrade hint (#935 A4)', () => {
  // The version-mismatch hint DevKit itself emits (check_cli/doctor soft hint)
  // must NOT be stripped — only the per-command KooCLI banner is.
  const hint =
    'KooCLI version mismatch: installed 7.2.12, paired ' +
    getKooCliVersion() +
    '. Run "npx huaweicloud-devkit update" to upgrade.';
  const cleaned = stripKooCliUpdateBanner(hint);
  assert.equal(cleaned, hint, 'the DevKit upgrade hint must be preserved verbatim');

  const normal = 'ListVpcs有多个版本,默认使用该API版本v3\n{"vpcs":[]}';
  assert.equal(stripKooCliUpdateBanner(normal), normal, 'normal multi-version prefix lines are untouched here');
});

test('runHcloud strips the KooCLI update banner from command output (#935 A4)', async () => {
  const dir = (await import('node:fs')).mkdtempSync(
    (await import('node:path')).join((await import('node:os')).tmpdir(), 'huaweicloud-banner-'),
  );
  const script = `${dir}/fake-hcloud.mjs`;
  (await import('node:fs')).writeFileSync(
    script,
    'console.log("可执行 hcloud update 更新至 7.3.12");\nconsole.log(\'{"result":"ok"}\');\n',
    'utf8',
  );
  try {
    const result = await runHcloud(['ECS', 'ListServersDetails'], {
      executable: process.execPath,
      executableArgs: [script],
    });
    assert.ok(!String(result.stdout).includes('hcloud update 更新至'), 'banner must not reach tool output');
    assert.match(String(result.stdout), /result/, 'real output must survive');
  } finally {
    (await import('node:fs')).rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E2E-B1 (#935 round 2): explain_error errorCode-only routing gap
// ---------------------------------------------------------------------------

test('explain_error with errorCode only (no service) hits Ecs.0019 mapping (#935 E2E-B1)', async () => {
  // MCP probe evidence: errorCode-only call returned "No known error-code
  // pattern matched", service: unknown — the service-keyed table was never hit.
  const result = await callTool('huaweicloud_explain_error', { errorCode: 'Ecs.0019' });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0019/);
  assert.match(text, /taken offline/, 'must hit the Ecs.0019 flavor-offline mapping');
  assert.match(text, /ListFlavors/, 'must direct at hcloud ECS ListFlavors');
});

test('explain_error with errorCode only (no service) hits Ecs.0319 mapping (#935 E2E-B1)', async () => {
  const result = await callTool('huaweicloud_explain_error', { errorCode: 'Ecs.0319' });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0319/);
  assert.match(text, /availability zone/i, 'must hit the Ecs.0319 AZ-capacity mapping');
});

test('explain_error with errorCode only (no service) hits Ecs.0067 mapping (#935 E2E-B1)', async () => {
  const result = await callTool('huaweicloud_explain_error', { errorCode: 'Ecs.0067' });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0067/);
  assert.match(text, /ShowCustomerAccountBalances/, 'must hit the Ecs.0067 cash-balance mapping');
});

test('explain_error with errorCode only (no service) hits KPS.9004 mapping (#935 E2E-B1)', async () => {
  const result = await callTool('huaweicloud_explain_error', { errorCode: 'KPS.9004' });
  const text = JSON.stringify(result);
  assert.match(text, /KPS\.9004/);
  assert.match(text, /ShowCustomerAccountBalances/, 'must hit the KPS.9004 restriction mapping');
});

test('explain_error with errorCode only (no service) hits existing Ecs.0707 mapping (#935 E2E-B1)', async () => {
  const result = await callTool('huaweicloud_explain_error', { errorCode: 'Ecs.0707' });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0707/);
  assert.match(text, /flavors\.md/, 'must hit the pre-existing Ecs.0707 mapping');
});

test('explain_error with service=unknown + dotted errorCode hits the mapping (MCP-equivalent shape) (#935 E2E-B1)', async () => {
  const result = await callTool('huaweicloud_explain_error', { service: 'unknown', errorCode: 'Ecs.0019' });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0019/);
  assert.match(text, /taken offline/, 'service:unknown + dotted code must derive the service key');
});

test('explain_error with explicit service=ECS keeps behavior unchanged (#935 E2E-B1 regression)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0019',
    message: 'the flavor does not exist',
  });
  assert.equal(result.service, 'ECS', 'the echoed service field must stay as passed');
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0019/);
  assert.match(text, /taken offline/, 'explicit-service mapping hit must be preserved');
});

test('explain_error with dot-less errorCode and no service keeps the fallback behavior (#935 E2E-B1)', async () => {
  const result = await callTool('huaweicloud_explain_error', { errorCode: '0019' });
  const text = JSON.stringify(result);
  assert.match(text, /No known error-code pattern matched/, 'dot-less code must not be mis-routed');
  assert.ok(!text.includes('taken offline'), 'must not hit the Ecs.0019 mapping');
});
