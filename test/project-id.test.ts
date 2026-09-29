import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveAndApplyProjectId } from '../plugins/huaweicloud-core/src/auth/project-id.ts';

function fakeHcloudScript(source) {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-project-id-'));
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(script, source, 'utf8');
  return script;
}

function withFakeHcloud(source, fn) {
  const previousBin = process.env.HCLOUD_BIN;
  process.env.HCLOUD_BIN = fakeHcloudScript(source);
  try {
    return fn();
  } finally {
    if (previousBin === undefined) delete process.env.HCLOUD_BIN;
    else process.env.HCLOUD_BIN = previousBin;
  }
}

test('resolveAndApplyProjectId picks the region project and writes cli-project-id', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'huaweicloud-project-id-log-')), 'hcloud.log');
  withFakeHcloud(
    `
    import { appendFileSync } from 'node:fs';
    if (process.argv[2] === 'IAM') {
      console.log(JSON.stringify({ projects: [{ id: 'proj-b', name: 'cn-east-3' }, { id: 'proj-a', name: 'cn-north-4' }] }));
    }
    if (process.argv[2] === 'configure') {
      appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
    }
    process.exit(0);
  `,
    () => {
      const result = resolveAndApplyProjectId({ region: 'cn-north-4', profile: 'deploy' });
      assert.equal(result.ok, true);
      assert.equal(result.projectId, 'proj-a');
      const logged = readFileSync(log, 'utf8');
      assert.match(logged, /"configure","set","--cli-profile=deploy","--cli-project-id=proj-a"/);
    },
  );
});

test('resolveAndApplyProjectId works without a profile', () => {
  withFakeHcloud(
    `
    if (process.argv[2] === 'IAM') {
      console.log(JSON.stringify({ projects: [{ id: 'proj-default', name: 'cn-north-4' }] }));
    }
    process.exit(0);
  `,
    () => {
      const result = resolveAndApplyProjectId({ region: 'cn-north-4' });
      assert.equal(result.ok, true);
      assert.equal(result.projectId, 'proj-default');
    },
  );
});

test('resolveAndApplyProjectId stays non-fatal on unparseable output', () => {
  withFakeHcloud(`process.exit(0);`, () => {
    const result = resolveAndApplyProjectId({ region: 'cn-north-4' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /parse|projects/i);
  });
});

test('resolveAndApplyProjectId stays non-fatal when hcloud exits non-zero', () => {
  withFakeHcloud(`process.exit(3);`, () => {
    const result = resolveAndApplyProjectId({ region: 'cn-north-4' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /exit 3/);
  });
});

test('resolveAndApplyProjectId requires a region', () => {
  const result = resolveAndApplyProjectId({});
  assert.equal(result.ok, false);
  assert.match(result.reason, /region/);
});
