import assert from 'node:assert/strict';
import test from 'node:test';

import { runHcloud, redactOutput, stripKooCliUpdateBanner } from '../plugins/huaweicloud-core/src/hcloud-cli.ts';
import { fakeHcloudScript } from './hcloud-cli-harness.ts';
import { getKooCliVersion } from '../plugins/huaweicloud-core/src/koocli-version.ts';

// Deterministic-tier seam: disable the once-per-session first-assertion
// vendor challenge (HUAWEICLOUD_VENDOR_CHALLENGE=off, the installer-override
// pattern). Set before the src imports: the gate captures the env at module
// load, so the harness import's seam is order-dependent — this line is not.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

test('#921: exit 0 with a KooCLI parameter error reports ok:false with PARAM_ERROR', async () => {
  const script = fakeHcloudScript(`
console.error("[USE_ERROR]: unknown parameter delete_ip");
process.exit(0);
`);
  const result = await runHcloud(['ECS', 'ListServersDetails', '--delete_ip=x'], {
    executable: process.execPath,
    executableArgs: [script],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, false, 'a parameter error must never read as success');
  assert.equal(result.errorCode, 'PARAM_ERROR');
  assert.match(result.errorMessage ?? '', /unknown parameter delete_ip/);
});

test('#921: exit 0 with a Chinese parameter error is caught too', async () => {
  const script = fakeHcloudScript(`
    console.error("[USE_ERROR]: 参数错误: 不正确的参数 delete_ip");
    process.exit(0);
  `);
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: process.execPath,
    executableArgs: [script],
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PARAM_ERROR');
});

test('#921: value-validation errors (must match) never read as success', async () => {
  // Live sample, KooCLI 7.3.12, 2026-11-26: NovaStartServer's empty-body
  // `os-start` param has no inline spelling — `--os-start={}` / `--os-start=[]`
  // both exit 0 with this marker on stdout and the command never executes.
  const script = fakeHcloudScript(`
    console.log("[USE_ERROR]The value of os-start must match [].");
    process.exit(0);
  `);
  const result = await runHcloud(['ECS', 'NovaStartServer', '--server_id=i-123', '--os-start={}'], {
    executable: process.execPath,
    executableArgs: [script],
    allowWrites: true,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, false, 'a value-validation error must never read as success');
  assert.equal(result.errorCode, 'PARAM_ERROR');
  assert.match(result.errorMessage ?? '', /The value of os-start must match/);
});

test('#921: "successfully" heuristic applies ONLY to OBS commands without error indicators', async () => {
  // Non-OBS command, non-zero exit, "successfully" in output: NOT ok.
  const nonObs = fakeHcloudScript(`
console.log("Warning: fallback succeeded but 3 objects were NOT deleted successfully");
process.exit(1);
`);
  const bad = await runHcloud(['ECS', 'ListServersDetails', '--limit=1'], {
    executable: process.execPath,
    executableArgs: [nonObs],
  });
  assert.equal(bad.exitCode, 1);
  assert.equal(bad.ok, false, 'a failing non-OBS command mentioning "successfully" must not pass');

  // OBS obsutil-style command: known to exit non-zero on success (#57).
  const obs = fakeHcloudScript(`
console.log("List bucket objects successfully");
process.exit(1);
`);
  const good = await runHcloud(['obs', 'ls', 'obs://bucket/'], {
    executable: process.execPath,
    executableArgs: [obs],
  });
  assert.equal(good.ok, true, 'OBS success output with a non-zero exit stays ok');

  // OBS command with an error indicator: NOT ok.
  const obsErr = fakeHcloudScript(`
console.log("List bucket objects successfully");
console.error("error: 2 objects failed");
process.exit(1);
`);
  const bad2 = await runHcloud(['obs', 'ls', 'obs://bucket/'], {
    executable: process.execPath,
    executableArgs: [obsErr],
  });
  assert.equal(bad2.ok, false, 'OBS output carrying error indicators must not pass');
});

test('#921: timeout and spawn-error results carry exitCode/signal fields', async () => {
  // Timeout path (from the existing timeout test's shape, now asserting the
  // exitCode/signal fields exist).
  const script = fakeHcloudScript('setTimeout(() => {}, 10_000);');
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: process.execPath,
    executableArgs: [script],
    timeoutMs: 300,
  });
  assert.equal(result.code, 'TIMEOUT');
  // The close-path TIMEOUT carries the child's exitCode/signal (or null on
  // the settle backstop) — the fields must always be present.
  assert.equal('exitCode' in result, true, 'timeout results must carry exitCode');
  assert.equal('signal' in result, true, 'timeout results must carry signal');
});

test('#921 D3-B7: spawn-error results carry exitCode:null, signal:null, and the SPAWN_ERROR code', async () => {
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: '/nonexistent/hcloud-binary-xyz',
    maxRetries: 0,
  });
  assert.equal(result.code, 'SPAWN_ERROR');
  assert.equal('exitCode' in result, true, 'spawn-error results must carry exitCode');
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
});

test('#921 residual: obsutil zero-count summaries do not veto a successful OBS run', async () => {
  const obs = fakeHcloudScript(`
console.log("List bucket objects successfully");
console.log("Failed count: 0");
process.exit(1);
`);
  const result = await runHcloud(['obs', 'ls', 'obs://bucket/'], {
    executable: process.execPath,
    executableArgs: [obs],
  });
  assert.equal(result.ok, true, 'a "Failed count: 0" summary line is not an error');

  const obsRealFail = fakeHcloudScript(`
console.log("List bucket objects successfully");
console.log("Failed count: 2");
process.exit(1);
`);
  const failed = await runHcloud(['obs', 'ls', 'obs://bucket/'], {
    executable: process.execPath,
    executableArgs: [obsRealFail],
  });
  assert.equal(failed.ok, false, 'a non-zero failure count still vetoes');
});

test('stripKooCliUpdateBanner removes the KooCLI 7.2.x upgrade banner line (#935 A4)', () => {
  const raw = ['可执行 hcloud update 更新至 7.3.12', '{', '  "servers": []', '}'].join('\n');
  const cleaned = stripKooCliUpdateBanner(raw);
  assert.ok(!cleaned.includes('可执行 hcloud update 更新至 7.3.12'), 'banner line must be removed');
  assert.match(cleaned, /servers/, 'the real output must survive');
  // The bare form (no 可执行 lead-in) is also the banner.
  assert.equal(stripKooCliUpdateBanner('hcloud update 更新至 7.3.12\n{"ok":true}'), '{"ok":true}');
});

test('stripKooCliUpdateBanner keeps JSON values, error remediation, and help text that mention the phrase (#935 A4)', () => {
  // Single-line JSON whose value echoes the banner — kept verbatim (a
  // line-granular fragment match would annihilate it).
  const jsonBody =
    '{"error_code":"CMD.0212","error_msg":"当前KooCLI版本过低，请执行 hcloud update 更新至 7.3.12 后重试"}';
  assert.equal(stripKooCliUpdateBanner(jsonBody), jsonBody, 'a JSON body line must never be stripped');
  // An actionable stderr diagnostic — kept.
  const diagnostic = '此功能需要新版CLI: 可执行 hcloud update 更新至 7.3.12 后重试';
  assert.equal(stripKooCliUpdateBanner(diagnostic), diagnostic);
  // Help text for the update command — kept.
  const help = '  update      Update the CLI: run hcloud update to upgrade to the newest release';
  assert.equal(stripKooCliUpdateBanner(help), help);
  // Legitimately blank lines survive (only the banner's own line drops).
  assert.equal(stripKooCliUpdateBanner('a\n\nb'), 'a\n\nb');
});

test('stripKooCliUpdateBanner salvages same-line banner+JSON by prefix removal (#935 A4)', () => {
  // The whole line is NOT dropped — the banner prefix is removed and the
  // trailing JSON survives for redactOutput's bracket-slice.
  const cleaned = stripKooCliUpdateBanner('可执行 hcloud update 更新至 7.3.12{"result":"ok"}');
  assert.equal(cleaned, '{"result":"ok"}');
});

test('stripKooCliUpdateBanner keeps the DevKit one-shot upgrade hint and multi-version prefixes (#935 A4)', () => {
  // The version-mismatch hint DevKit itself emits (check_cli/doctor soft hint)
  // must NOT be stripped — only the per-command KooCLI banner is.
  const hint = `KooCLI version mismatch: installed 7.2.12, paired ${getKooCliVersion()}. Run "npx huaweicloud-devkit update" to upgrade.`;
  assert.equal(stripKooCliUpdateBanner(hint), hint, 'the DevKit upgrade hint must be preserved verbatim');

  const normal = 'ListVpcs有多个版本,默认使用该API版本v3\n{"vpcs":[]}';
  assert.equal(stripKooCliUpdateBanner(normal), normal, 'normal multi-version prefix lines are untouched here');
});

test('redactOutput strips the banner before JSON extraction (#935 A4 wiring)', () => {
  // The banner precedes the JSON body — redactOutput's bracket-slice must see
  // output whose first line is already the real content.
  const cleaned = redactOutput('可执行 hcloud update 更新至 7.3.12\n{"result":"ok"}');
  assert.ok(!cleaned.includes('hcloud update'), 'the banner must be gone');
  assert.match(cleaned, /"result"/);
});
