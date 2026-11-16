// Issue #1055 — D1-68: region resolution contract drift (SPEC-MISMATCH).
// Contract: when both variables are set, the official name `HUAWEICLOUD_REGION`
// wins over the short alias `HW_REGION`, at EVERY auth entry point:
//   1. process env            -> resolveCredentials()
//   2. CodeArts project       -> readCodeArtsCredentials()  (.codeartsdoer/mcp/mcp_settings.json env)
//   3. CodeArts Work          -> readWorkEnvironmentEntry() (~/.codearts/mcp/mcp_settings.json environment)
//   4. `auth init` default    -> setup-cli.mjs cmdAuthInit()
// An empty official name must never mask a populated alias (`||`, not `??`).
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  clearRuntimeCredentials,
  isCodeArtsContext,
  readCodeArtsCredentials,
  resolveCredentials,
} from '../plugins/huaweicloud-core/src/auth/credentials.mjs';

const SOURCE_DIR = fileURLToPath(new URL('../plugins/huaweicloud-core/src/', import.meta.url));

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-1055-'));
  const emptyProject = join(dir, 'empty-project');
  mkdirSync(emptyProject, { recursive: true });
  const previous = {};
  for (const key of [
    'HUAWEICLOUD_HOME',
    'HOME',
    'HCLOUD_CONFIG_PATH',
    'HCLOUD_OBS_CONFIG_PATH',
    'CODEARTS_PROJECT_DIR',
    'HW_ACCESS_KEY',
    'HW_SECRET_KEY',
    'HW_SECURITY_TOKEN',
    'HW_REGION',
    'HUAWEICLOUD_REGION',
  ]) {
    previous[key] = process.env[key];
  }
  process.env.HUAWEICLOUD_HOME = dir;
  process.env.HOME = dir;
  process.env.HCLOUD_CONFIG_PATH = join(dir, '.hcloud', 'config.json');
  process.env.HCLOUD_OBS_CONFIG_PATH = join(dir, '.obsutilconfig');
  process.env.CODEARTS_PROJECT_DIR = emptyProject;
  for (const key of ['HW_ACCESS_KEY', 'HW_SECRET_KEY', 'HW_SECURITY_TOKEN', 'HW_REGION', 'HUAWEICLOUD_REGION']) {
    delete process.env[key];
  }
  try {
    return fn(dir);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('D1-68: process env prefers HUAWEICLOUD_REGION over HW_REGION', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    process.env.HW_ACCESS_KEY = 'ENV_AK';
    process.env.HW_SECRET_KEY = 'ENV_SK';
    process.env.HUAWEICLOUD_REGION = 'cn-north-4';
    process.env.HW_REGION = 'cn-south-1';

    assert.equal(resolveCredentials().region, 'cn-north-4');
  });
});

test('D1-68: process env still honors HW_REGION alone (backward compatible alias)', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    process.env.HW_ACCESS_KEY = 'ENV_AK';
    process.env.HW_SECRET_KEY = 'ENV_SK';
    process.env.HW_REGION = 'cn-south-1';

    assert.equal(resolveCredentials().region, 'cn-south-1');
  });
});

test('D1-68: an empty HUAWEICLOUD_REGION does not mask a populated HW_REGION', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    process.env.HW_ACCESS_KEY = 'ENV_AK';
    process.env.HW_SECRET_KEY = 'ENV_SK';
    process.env.HUAWEICLOUD_REGION = '';
    process.env.HW_REGION = 'cn-south-1';

    assert.equal(resolveCredentials().region, 'cn-south-1');
  });
});

test('D1-68: CodeArts project mcp_settings.json prefers HUAWEICLOUD_REGION', () => {
  withTempHome(() => {
    const project = process.env.CODEARTS_PROJECT_DIR;
    mkdirSync(join(project, '.codeartsdoer', 'mcp'), { recursive: true });
    writeFileSync(
      join(project, '.codeartsdoer', 'mcp', 'mcp_settings.json'),
      JSON.stringify({
        mcpServers: {
          'huaweicloud-devkit': {
            env: {
              HW_ACCESS_KEY: 'CODEARTS_AK',
              HW_SECRET_KEY: 'CODEARTS_SK',
              HUAWEICLOUD_REGION: 'cn-north-4',
              HW_REGION: 'cn-south-1',
            },
          },
        },
      }),
      'utf8',
    );

    assert.equal(readCodeArtsCredentials()?.region, 'cn-north-4');
  });
});

test('D1-68: CodeArts Work mcp_settings.json prefers HUAWEICLOUD_REGION', () => {
  withTempHome((home) => {
    assert.equal(isCodeArtsContext(), true, 'HOME/.codearts must be detected as a CodeArts context');
    mkdirSync(join(home, '.codearts', 'mcp'), { recursive: true });
    writeFileSync(
      join(home, '.codearts', 'mcp', 'mcp_settings.json'),
      JSON.stringify({
        mcp: {
          'huaweicloud-devkit_1': {
            type: 'local',
            command: ['npx', '-y', '-p', 'huaweicloud-devkit@latest', 'huaweicloud-devkit-mcp'],
            environment: {
              HW_ACCESS_KEY: 'WORK_AK',
              HW_SECRET_KEY: 'WORK_SK',
              HUAWEICLOUD_REGION: 'cn-north-4',
              HW_REGION: 'cn-south-1',
            },
          },
        },
      }),
      'utf8',
    );

    clearRuntimeCredentials();
    const creds = resolveCredentials();
    assert.equal(creds.ak, 'WORK_AK');
    assert.equal(creds.region, 'cn-north-4');
  });
});

test('D1-68: no auth entry point resolves region with HW_REGION first (regression guard)', () => {
  for (const file of ['auth/credentials.mjs', 'setup-cli.mjs']) {
    const source = readFileSync(join(SOURCE_DIR, file), 'utf8');
    assert.doesNotMatch(
      source,
      /HW_REGION\s*\|\|[^;\n]*HUAWEICLOUD_REGION/,
      `${file} resolves region with HW_REGION ahead of HUAWEICLOUD_REGION`,
    );
  }
});
