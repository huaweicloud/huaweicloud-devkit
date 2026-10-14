import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  classifyHcloudProbe,
  findHcloudBin,
  hcloudProbeNextStep,
  hcloudProbeRaw,
} from '../plugins/huaweicloud-core/src/hcloud-probe.mjs';
import { getKooCliVersion } from '../plugins/huaweicloud-core/src/koocli-version.mjs';

test('hcloud probe classifies matching KooCLI version as ok', () => {
  const result = classifyHcloudProbe({ status: 0, stdout: `当前KooCLI版本:${getKooCliVersion()}`, stderr: '' });
  assert.equal(result.status, 'ok');
  assert.equal(result.installed, true);
  assert.equal(result.ok, true);
  assert.equal(result.versionMismatch, false);
});

test('hcloud probe classifies version mismatch separately from not installed', () => {
  const result = classifyHcloudProbe({ status: 0, stdout: '当前KooCLI版本:7.0.0', stderr: '' }, '7.2.12');
  assert.equal(result.status, 'version_mismatch');
  assert.equal(result.installed, true);
  assert.equal(result.ok, true);
  assert.equal(result.versionMismatch, true);
  // #900: top-level nextStep is an executable command; English detail only in raw.
  assert.match(hcloudProbeNextStep(result), /^npx /);
  assert.match(hcloudProbeRaw(result), /version mismatch/i);
});

test('hcloud probe classifies privacy agreement pending', () => {
  const result = classifyHcloudProbe({ status: 1, stdout: '', stderr: '请阅读并同意隐私声明' });
  assert.equal(result.status, 'privacy_pending');
  assert.equal(result.installed, true);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'HCLOUD_PRIVACY_PENDING');
  assert.match(hcloudProbeNextStep(result), /^npx /);
  assert.match(hcloudProbeRaw(result), /privacy/i);
});

test('hcloud probe classifies Codex Windows sandbox home failures', () => {
  const result = classifyHcloudProbe({ status: 1, stdout: '', stderr: '获取当前用户家目录失败' });
  assert.equal(result.status, 'sandbox_home_failure');
  assert.equal(result.installed, true);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'HCLOUD_SANDBOX_HOME_FAILURE');
  assert.match(hcloudProbeNextStep(result), /^npx /);
  assert.match(hcloudProbeRaw(result), /HCLOUD_BIN|Codex|sandbox/i);
});

test('hcloud probe classifies executable not found', () => {
  const result = classifyHcloudProbe({ error: { code: 'ENOENT' }, stdout: '', stderr: '' });
  assert.equal(result.status, 'not_found');
  assert.equal(result.installed, false);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'HCLOUD_NOT_FOUND');
  assert.match(hcloudProbeNextStep(result), /install-hcloud/i);
});

test('not_found nextStep is an executable command routed through ERROR_TABLE (#900)', () => {
  const result = classifyHcloudProbe({ error: { code: 'ENOENT' }, stdout: '', stderr: '' });
  const msg = hcloudProbeNextStep(result);
  // d11-41-nextstep-actionable: nextStep must start with npx/hcloud, not English prose.
  assert.match(msg, /^(npx |hcloud )/);
  assert.equal(msg, 'npx huaweicloud-devkit install-hcloud');
  assert.doesNotMatch(msg, /KooCLI is not installed/); // no English sentence at top level
  // Verbose English guidance lives only in the raw side-channel.
  const raw = hcloudProbeRaw(result);
  assert.match(raw, /install-hcloud/i); // direct command present
  assert.match(raw, /auto/i);
  assert.match(raw, /koocli-install\.log/);
  assert.doesNotMatch(raw, /restart the agent/i);
  assert.doesNotMatch(raw, /~30s/); // install duration is network-dependent
});

test('ok probe nextStep is a directly callable tool name, not English prose (#900)', () => {
  const result = classifyHcloudProbe({ status: 0, stdout: `当前KooCli版本:${getKooCliVersion()}`, stderr: '' });
  assert.equal(hcloudProbeNextStep(result), 'huaweicloud_show_profile_redacted');
  assert.match(hcloudProbeRaw(result), /show_profile_redacted/);
});

test('findHcloudBin discovers the fixed install dir even when PATH lacks it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hcloud-dir-'));
  // Simulate install at ~/.local/bin/hcloud (linux) by temporarily replacing HCLOUD_BIN
  // to prove the resolution path honors explicit bin over PATH lookup.
  const fake = join(dir, 'hcloud');
  writeFileSync(fake, '#!/usr/bin/env node\nconsole.log("x")', 'utf8');
  const prev = process.env.HCLOUD_BIN;
  process.env.HCLOUD_BIN = fake;
  try {
    const found = findHcloudBin();
    assert.equal(found, fake);
  } finally {
    if (prev === undefined) delete process.env.HCLOUD_BIN;
    else process.env.HCLOUD_BIN = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
