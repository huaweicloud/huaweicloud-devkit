import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import {
  globalCredentialsPath,
  readGlobalCredentials,
  writeGlobalCredentials,
  clearRuntimeCredentials,
  getParentCwd,
  parseStsExpiry,
  pickDevkitMcpServer,
  resolveCredentials,
  resolveCredentialsWithRuntime,
  setRuntimeCredentials,
} from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { withCodeArtsHome, withCodeArtsProject, withTempHome } from './auth-credentials-harness.ts';

test('resolveCredentials prefers environment and falls back to vault', () => {
  withTempHome((home) => {
    writeGlobalCredentials({ ak: 'VAULT_AK', sk: 'VAULT_SK', region: 'cn-north-4' });
    const fromVault = resolveCredentials();
    assert.equal(fromVault?.ak, 'VAULT_AK');
    assert.equal(fromVault?.sk, 'VAULT_SK');
    assert.equal(fromVault?.region, 'cn-north-4');

    process.env.HW_ACCESS_KEY = 'ENV_AK';
    process.env.HW_SECRET_KEY = 'ENV_SK';
    const fromEnv = resolveCredentials();
    assert.equal(fromEnv?.ak, 'ENV_AK');
    assert.equal(fromEnv?.sk, 'ENV_SK');
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;

    rmSync(globalCredentialsPath(), { force: true });
    // #900: HDKIT_CRED_MISSING now carries the unified Chinese messageZh.
    assert.throws(() => resolveCredentials({}), /未配置华为云凭证/);
    assert.ok(!home.includes('\0'));
  });
});

test('resolveCredentialsWithRuntime prioritizes runtime > env > vault', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    writeGlobalCredentials({ ak: 'VAULT_AK', sk: 'VAULT_SK', region: 'cn-north-4' });

    setRuntimeCredentials('RT_AK', 'RT_SK', '', 'cn-north-1');
    const fromRuntime = resolveCredentialsWithRuntime();
    assert.equal(fromRuntime?.ak, 'RT_AK');
    assert.equal(fromRuntime?.sk, 'RT_SK');
    assert.equal(fromRuntime?.region, 'cn-north-1');

    clearRuntimeCredentials();
    process.env.HW_ACCESS_KEY = 'ENV_AK';
    process.env.HW_SECRET_KEY = 'ENV_SK';
    const fromEnv = resolveCredentialsWithRuntime();
    assert.equal(fromEnv?.ak, 'ENV_AK');
    assert.equal(fromEnv?.sk, 'ENV_SK');
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;

    const fromVault = resolveCredentialsWithRuntime();
    assert.equal(fromVault?.ak, 'VAULT_AK');
    assert.equal(fromVault?.sk, 'VAULT_SK');
  });
});

test('resolveCredentialsWithRuntime set and clear workflow', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    writeGlobalCredentials({ ak: 'VAULT_AK', sk: 'VAULT_SK' });

    const before = resolveCredentialsWithRuntime();
    assert.equal(before?.ak, 'VAULT_AK');

    setRuntimeCredentials('SWITCH_AK', 'SWITCH_SK');
    const after = resolveCredentialsWithRuntime();
    assert.equal(after?.ak, 'SWITCH_AK');

    clearRuntimeCredentials();
    const reverted = resolveCredentialsWithRuntime();
    assert.equal(reverted?.ak, 'VAULT_AK');
  });
});

test('resolveCredentials reads CodeArts project mcp_settings.json', () => {
  withTempHome((_home) => {
    clearRuntimeCredentials();
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;

    withCodeArtsProject((projectDir) => {
      const codeartsDir = join(projectDir, '.codeartsdoer', 'mcp');
      mkdirSync(codeartsDir, { recursive: true });
      writeFileSync(
        join(codeartsDir, 'mcp_settings.json'),
        JSON.stringify({
          mcpServers: {
            'huaweicloud-devkit': {
              env: {
                HW_ACCESS_KEY: 'CODEARTS_AK',
                HW_SECRET_KEY: 'CODEARTS_SK',
                HW_REGION: 'cn-south-1',
              },
            },
          },
        }),
        'utf8',
      );

      const creds = resolveCredentials();
      assert.equal(creds?.ak, 'CODEARTS_AK');
      assert.equal(creds?.sk, 'CODEARTS_SK');
      assert.equal(creds?.region, 'cn-south-1');
    });
  });
});

test('resolveCredentials uses env vars over CodeArts mcp_settings.json', () => {
  withTempHome((_home) => {
    clearRuntimeCredentials();
    process.env.HW_ACCESS_KEY = 'ENV_AK';
    process.env.HW_SECRET_KEY = 'ENV_SK';

    withCodeArtsProject((projectDir) => {
      const codeartsDir = join(projectDir, '.codeartsdoer', 'mcp');
      mkdirSync(codeartsDir, { recursive: true });
      writeFileSync(
        join(codeartsDir, 'mcp_settings.json'),
        JSON.stringify({
          mcpServers: {
            'huaweicloud-devkit': {
              env: {
                HW_ACCESS_KEY: 'CODEARTS_AK',
                HW_SECRET_KEY: 'CODEARTS_SK',
              },
            },
          },
        }),
        'utf8',
      );

      const creds = resolveCredentials();
      assert.equal(creds?.ak, 'ENV_AK');
    });
  });
});

test('getParentCwd returns a string on Linux and does not throw', () => {
  const cwd = getParentCwd();
  if (process.platform === 'linux') {
    assert.ok(typeof cwd === 'string' && cwd.length > 0);
  }
  // Never throws on any platform
  assert.ok(cwd === null || (typeof cwd === 'string' && cwd.length > 0));
});

test('resolveCredentials prefers auth-init vault over env STS temporary credentials', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    writeGlobalCredentials({ ak: 'VAULT_AK', sk: 'VAULT_SK', region: 'cn-north-4' });

    process.env.HW_ACCESS_KEY = 'STS_AK';
    process.env.HW_SECRET_KEY = 'STS_SK';
    process.env.HW_SECURITY_TOKEN = 'STS_TOKEN';
    process.env.HW_REGION = 'cn-south-1';

    const creds = resolveCredentials();
    assert.equal(creds?.ak, 'VAULT_AK');
    assert.equal(creds?.sk, 'VAULT_SK');
    assert.equal(creds?.securityToken, '');
    assert.equal(creds?.region, 'cn-north-4');
  });
});

test('resolveCredentials keeps env STS when no auth-init vault exists', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    process.env.HW_ACCESS_KEY = 'STS_AK';
    process.env.HW_SECRET_KEY = 'STS_SK';
    process.env.HW_SECURITY_TOKEN = 'STS_TOKEN';
    process.env.HW_REGION = 'cn-south-1';

    const creds = resolveCredentials();
    assert.equal(creds?.ak, 'STS_AK');
    assert.equal(creds?.sk, 'STS_SK');
    assert.equal(creds?.securityToken, 'STS_TOKEN');
    assert.equal(creds?.region, 'cn-south-1');
  });
});

test('resolveCredentials keeps permanent env over vault (no security token)', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    writeGlobalCredentials({ ak: 'VAULT_AK', sk: 'VAULT_SK', region: 'cn-north-4' });
    process.env.HW_ACCESS_KEY = 'ENV_PERM_AK';
    process.env.HW_SECRET_KEY = 'ENV_PERM_SK';

    const creds = resolveCredentials();
    assert.equal(creds?.ak, 'ENV_PERM_AK');
    assert.equal(creds?.sk, 'ENV_PERM_SK');
  });
});

test('resolveCredentials reads CodeArts credentials from CODEARTS_PROJECT_DIR', () => {
  withTempHome((_home) => {
    clearRuntimeCredentials();
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;

    // The project dir is distinct from the process cwd: CODEARTS_PROJECT_DIR
    // must carry the lookup on its own, the way an explicitly configured
    // project does inside a CodeArts workspace.
    const projectDir = mkdtempSync(join(tmpdir(), 'huaweicloud-codearts-project-'));
    const cwdDir = mkdtempSync(join(tmpdir(), 'huaweicloud-codearts-cwd-'));
    const prevCwd = process.cwd();
    const prevProjectDir = process.env.CODEARTS_PROJECT_DIR;
    try {
      const codeartsDir = join(projectDir, '.codeartsdoer', 'mcp');
      mkdirSync(codeartsDir, { recursive: true });
      writeFileSync(
        join(codeartsDir, 'mcp_settings.json'),
        JSON.stringify({
          mcpServers: {
            'huaweicloud-devkit': {
              env: {
                HW_ACCESS_KEY: 'PROJECT_DIR_AK',
                HW_SECRET_KEY: 'PROJECT_DIR_SK',
                HW_REGION: 'cn-east-3',
              },
            },
          },
        }),
        'utf8',
      );

      // CodeArts context marker sits in the process cwd (marker only, no
      // mcp_settings.json there), credentials live under CODEARTS_PROJECT_DIR.
      mkdirSync(join(cwdDir, '.codeartsdoer'), { recursive: true });
      process.env.CODEARTS_PROJECT_DIR = projectDir;
      process.chdir(cwdDir);

      const creds = resolveCredentials();
      assert.equal(creds?.ak, 'PROJECT_DIR_AK');
      assert.equal(creds?.sk, 'PROJECT_DIR_SK');
      assert.equal(creds?.region, 'cn-east-3');
    } finally {
      process.chdir(prevCwd);
      if (prevProjectDir === undefined) delete process.env.CODEARTS_PROJECT_DIR;
      else process.env.CODEARTS_PROJECT_DIR = prevProjectDir;
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(cwdDir, { recursive: true, force: true });
    }
  });
});

test('resolveCredentials reads CodeArts Work new layout ~/.codearts with prefixed key', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
    delete process.env.HW_SECURITY_TOKEN;

    withCodeArtsHome((home) => {
      const workDir = join(home, '.codearts', 'mcp');
      mkdirSync(workDir, { recursive: true });
      writeFileSync(
        join(workDir, 'mcp_settings.json'),
        JSON.stringify({
          mcp: {
            'huaweicloud-devkit_1': {
              type: 'local',
              command: ['npx', '-y', '-p', 'huaweicloud-devkit@latest', 'huaweicloud-devkit-mcp'],
              environment: {
                HW_ACCESS_KEY: 'NEW_WORK_AK',
                HW_SECRET_KEY: 'NEW_WORK_SK',
                HW_SECURITY_TOKEN: 'NEW_WORK_TOKEN',
                HW_REGION: 'cn-north-4',
              },
            },
          },
        }),
        'utf8',
      );

      const creds = resolveCredentials();
      assert.equal(creds?.ak, 'NEW_WORK_AK');
      assert.equal(creds?.sk, 'NEW_WORK_SK');
      assert.equal(creds?.securityToken, 'NEW_WORK_TOKEN');
    });
  });
});

test('resolveCredentials falls back to legacy ~/.codeartswork when new ~/.codearts absent', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
    delete process.env.HW_SECURITY_TOKEN;

    withCodeArtsHome((home) => {
      const legacyDir = join(home, '.codeartswork', 'mcp');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(
        join(legacyDir, 'mcp_settings.json'),
        JSON.stringify({
          mcp: {
            'huaweicloud-devkit': { environment: { HW_ACCESS_KEY: 'LEGACY_WORK_AK', HW_SECRET_KEY: 'LEGACY_WORK_SK' } },
          },
        }),
        'utf8',
      );

      const creds = resolveCredentials();
      assert.equal(creds?.ak, 'LEGACY_WORK_AK');
      assert.equal(creds?.sk, 'LEGACY_WORK_SK');
    });
  });
});

test('parseStsExpiry reads HW_STS_EXPIRES_AT (epoch seconds and ISO8601)', () => {
  assert.equal(parseStsExpiry({ expiresAtEnv: '1750000000' }), 1750000000 * 1000);
  assert.equal(parseStsExpiry({ expiresAtEnv: '1750000000000' }), 1750000000000);
  const iso = new Date('2026-10-01T00:00:00Z').getTime();
  assert.equal(parseStsExpiry({ expiresAtEnv: '2026-10-01T00:00:00Z' }), iso);
  assert.equal(parseStsExpiry({ expiresAtEnv: '' }), null);
});

test('parseStsExpiry decodes JWT payload exp', () => {
  const exp = 1750000000;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const token = [header, payload, 'sig'].join('.');
  assert.equal(parseStsExpiry({ securityToken: token }), exp * 1000);
});

test('parseStsExpiry decodes bare URL-safe base64 JSON blob (timeout_at)', () => {
  const timeoutAt = 1750000000;
  const token = Buffer.from(JSON.stringify({ timeout_at: timeoutAt })).toString('base64url');
  assert.equal(parseStsExpiry({ securityToken: token }), timeoutAt * 1000);
});

test('parseStsExpiry supports issued_at + duration fields', () => {
  const issued = 1750000000;
  const duration = 3600;
  const token = Buffer.from(JSON.stringify({ issued_at: issued, duration })).toString('base64url');
  assert.equal(parseStsExpiry({ securityToken: token }), (issued + duration) * 1000);
});

test('parseStsExpiry returns null for unparseable input', () => {
  assert.equal(parseStsExpiry({}), null);
  assert.equal(parseStsExpiry({ securityToken: 'not-a-token!' }), null);
  assert.equal(parseStsExpiry({ securityToken: '' }), null);
  assert.equal(parseStsExpiry({ securityToken: null }), null);
});

type EnvironmentServerEntry = { environment: { HW_ACCESS_KEY: string } };
type EnvServerEntry = { env: { HW_ACCESS_KEY: string } };

test('pickDevkitMcpServer prefers canonical key over prefixed instances (R4)', () => {
  const map = {
    'huaweicloud-devkit_2': { environment: { HW_ACCESS_KEY: 'K2' } },
    'huaweicloud-devkit': { environment: { HW_ACCESS_KEY: 'K0' } },
    'huaweicloud-devkit_1': { environment: { HW_ACCESS_KEY: 'K1' } },
  };
  const server = pickDevkitMcpServer(map) as EnvironmentServerEntry | null;
  assert.equal(server?.environment.HW_ACCESS_KEY, 'K0');
});

test('pickDevkitMcpServer falls back to HuaweiCloud DevKit then lowest _N (R4)', () => {
  const map = {
    'huaweicloud-devkit_3': { env: { HW_ACCESS_KEY: 'K3' } },
    'HuaweiCloud DevKit': { env: { HW_ACCESS_KEY: 'KDK' } },
  };
  const server = pickDevkitMcpServer(map) as EnvServerEntry | null;
  assert.equal(server?.env.HW_ACCESS_KEY, 'KDK');
  const map2 = {
    'huaweicloud-devkit_3': { env: { HW_ACCESS_KEY: 'K3' } },
    'huaweicloud-devkit_1': { env: { HW_ACCESS_KEY: 'K1' } },
  };
  const server2 = pickDevkitMcpServer(map2) as EnvServerEntry | null;
  assert.equal(server2?.env.HW_ACCESS_KEY, 'K1');
});

test('pickDevkitMcpServer is order-independent and returns null for empty/non-object', () => {
  const a = { 'huaweicloud-devkit_1': { environment: { HW_ACCESS_KEY: 'A' } } };
  const b = { 'huaweicloud-devkit_1': { environment: { HW_ACCESS_KEY: 'A' } } };
  const serverA = pickDevkitMcpServer(a) as EnvironmentServerEntry | null;
  const serverB = pickDevkitMcpServer(b) as EnvironmentServerEntry | null;
  assert.ok(serverA && serverB);
  assert.equal(serverA.environment.HW_ACCESS_KEY, serverB.environment.HW_ACCESS_KEY);
  assert.equal(pickDevkitMcpServer({}), null);
  assert.equal(pickDevkitMcpServer(null), null);
  assert.equal(pickDevkitMcpServer(undefined), null);
});

// ── #900 failure-path regression guards (ported from main's guidance tests) ──

test('S1 reads the legacy config tree only when the state tree has no credentials', () => {
  const previousHome = process.env.HUAWEICLOUD_HOME;
  const previousState = process.env.HUAWEICLOUD_STATE_DIR;
  const home = mkdtempSync(join(tmpdir(), 'hwc-legacy-home-'));
  const state = mkdtempSync(join(tmpdir(), 'hwc-state-dir-'));
  const legacyPath = join(home, '.config', 'huaweicloud', 'credentials.json');
  mkdirSync(dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, JSON.stringify({ ak: 'LEGACY_AK', sk: 'LEGACY_SK', region: 'cn-north-4' }));
  process.env.HUAWEICLOUD_HOME = home;
  process.env.HUAWEICLOUD_STATE_DIR = state;
  try {
    assert.equal(globalCredentialsPath(), join(state, 'credentials.json'));
    assert.equal(readGlobalCredentials()?.ak, 'LEGACY_AK', 'the pre-provisioned read-only store still resolves');
    writeGlobalCredentials({ ak: 'STATE_AK', sk: 'STATE_SK', region: 'cn-north-4' });
    assert.equal(readGlobalCredentials()?.ak, 'STATE_AK', 'the writable state tree wins once written');
    assert.equal(readGlobalCredentials()?.sk, 'STATE_SK');
  } finally {
    if (previousHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = previousHome;
    if (previousState === undefined) delete process.env.HUAWEICLOUD_STATE_DIR;
    else process.env.HUAWEICLOUD_STATE_DIR = previousState;
    rmSync(home, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
