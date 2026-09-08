import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getKooCliVersion,
  parseHcloudVersion,
  compareVersion,
  kooCliDownloadBase,
} from '../plugins/huaweicloud-core/src/koocli-version.mjs';

test('kooCliVersion is declared in package.json and is semver', () => {
  const v = getKooCliVersion();
  assert.match(v, /^\d+\.\d+\.\d+$/);
});

test('parseHcloudVersion extracts version from both output formats', () => {
  assert.equal(parseHcloudVersion('当前KooCLI版本:7.2.12'), '7.2.12');
  assert.equal(parseHcloudVersion('KooCLI Fake 7.2.12'), '7.2.12');
  assert.equal(parseHcloudVersion('Current KooCLI version:7.2.12'), '7.2.12');
  assert.equal(parseHcloudVersion('no version here'), null);
  assert.equal(parseHcloudVersion(''), null);
});

test('compareVersion orders correctly', () => {
  assert.equal(compareVersion('7.2.12', '7.2.12'), 0);
  assert.equal(compareVersion('7.2.11', '7.2.12'), -1);
  assert.equal(compareVersion('7.3.0', '7.2.12'), 1);
  assert.equal(compareVersion('7.2.12', '7.2.9'), 1);
  assert.equal(compareVersion('6.9.0', '7.0.0'), -1);
});

test('kooCliDownloadBase pins to the paired version', () => {
  assert.equal(
    kooCliDownloadBase(),
    `https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/${getKooCliVersion()}`,
  );
  assert.ok(!kooCliDownloadBase().includes('/latest'));
});
