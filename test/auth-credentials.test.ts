import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  backupGlobalCredentials,
  clearRuntimeCredentials,
  getParentCwd,
  globalCredentialsPath,
  obsConfigPath,
  parseStsExpiry,
  pickDevkitMcpServer,
  readGlobalCredentials,
  readLastSync,
  resolveCredentials,
  resolveCredentialsWithRuntime,
  restoreGlobalCredentialsBackup,
  setRuntimeCredentials,
  writeGlobalCredentials,
  writeLastSync,
  writeObsConfig,
} from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { getAgentRegistrationStatuses } from '../plugins/huaweicloud-core/src/auth/agent-registration.ts';
import { getAuthStatus, syncAuth } from '../plugins/huaweicloud-core/src/auth/service.ts';

const FAKE_HCLOUD = fileURLToPath(new URL('./fixtures/fake-hcloud.ts', import.meta.url));

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-auth-'));
  const previous = {
    HUAWEICLOUD_HOME: process.env.HUAWEICLOUD_HOME,
    HCLOUD_CONFIG_PATH: process.env.HCLOUD_CONFIG_PATH,
    HCLOUD_OBS_CONFIG_PATH: process.env.HCLOUD_OBS_CONFIG_PATH,
    HW_ACCESS_KEY: process.env.HW_ACCESS_KEY,
    HW_SECRET_KEY: process.env.HW_SECRET_KEY,
    HW_SECURITY_TOKEN: process.env.HW_SECURITY_TOKEN,
    HW_REGION: process.env.HW_REGION,
    HUAWEICLOUD_REGION: process.env.HUAWEICLOUD_REGION,
    DSH_HOME: process.env.DSH_HOME,
    HCLOUD_BIN: process.env.HCLOUD_BIN,
    HCLOUD_BIN_ARGS_JSON: process.env.HCLOUD_BIN_ARGS_JSON,
    HCLOUD_FAKE_LOG: process.env.HCLOUD_FAKE_LOG,
  };
  process.env.HUAWEICLOUD_HOME = dir;
  process.env.HCLOUD_CONFIG_PATH = join(dir, '.hcloud', 'config.json');
  process.env.HCLOUD_OBS_CONFIG_PATH = join(dir, '.obsutilconfig');
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  delete process.env.HW_SECURITY_TOKEN;
  delete process.env.HW_REGION;
  delete process.env.HUAWEICLOUD_REGION;
  delete process.env.DSH_HOME;
  delete process.env.HCLOUD_BIN;
  delete process.env.HCLOUD_BIN_ARGS_JSON;
  delete process.env.HCLOUD_FAKE_LOG;
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

test('global credentials round-trip with secure file path', () => {
  withTempHome((home) => {
    const path = writeGlobalCredentials({ ak: 'AK123', sk: 'SK456', region: 'cn-north-4' });
    assert.equal(path, globalCredentialsPath());
    assert.equal(readGlobalCredentials().ak, 'AK123');
    assert.equal(readGlobalCredentials().sk, 'SK456');
    assert.equal(readGlobalCredentials().region, 'cn-north-4');
    assert.ok(globalCredentialsPath().startsWith(home));
  });
});

test('resolveCredentials prefers environment and falls back to vault', () => {
  withTempHome((home) => {
    writeGlobalCredentials({ ak: 'VAULT_AK', sk: 'VAULT_SK', region: 'cn-north-4' });
    const fromVault = resolveCredentials();
    assert.equal(fromVault.ak, 'VAULT_AK');
    assert.equal(fromVault.sk, 'VAULT_SK');
    assert.equal(fromVault.region, 'cn-north-4');

    process.env.HW_ACCESS_KEY = 'ENV_AK';
    process.env.HW_SECRET_KEY = 'ENV_SK';
    const fromEnv = resolveCredentials();
    assert.equal(fromEnv.ak, 'ENV_AK');
    assert.equal(fromEnv.sk, 'ENV_SK');
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;

    rmSync(globalCredentialsPath(), { force: true });
    assert.throws(() => resolveCredentials({}), /auth init/);
    assert.ok(!home.includes('\0'));
  });
});

test('writeObsConfig creates obsutilconfig content from vault', () => {
  withTempHome(() => {
    const result = writeObsConfig({ ak: 'OBS_AK', sk: 'OBS_SK', region: 'cn-north-4' });
    assert.equal(result.endpoint, 'https://obs.cn-north-4.myhuaweicloud.com');
    const content = readFileSync(obsConfigPath(), 'utf8');
    assert.match(content, /ak=OBS_AK/);
    assert.match(content, /sk=OBS_SK/);
    assert.match(content, /endpoint=https:\/\/obs\.cn-north-4\.myhuaweicloud\.com/);
  });
});

test('auth sync writes OBS and reports all agent registration targets', () => {
  withTempHome((home) => {
    process.env.HCLOUD_BIN = process.execPath;
    process.env.HCLOUD_BIN_ARGS_JSON = JSON.stringify([FAKE_HCLOUD]);
    process.env.HCLOUD_FAKE_LOG = join(home, 'hcloud.log');
    mkdirSync(join(home, '.hcloud'), { recursive: true });
    writeFileSync(
      join(home, '.hcloud', 'config.json'),
      JSON.stringify({
        current: 'deploy',
        profiles: [
          { name: 'deploy', accessKeyId: 'SYNC_OLD_AK', secretAccessKey: 'SYNC_OLD_SK', region: 'cn-north-4' },
        ],
      }),
      'utf8',
    );
    writeGlobalCredentials({ ak: 'SYNC_AK', sk: 'SYNC_SK', region: 'cn-north-4' });
    const sync = syncAuth('all');
    assert.equal(sync.ok, true);
    assert.equal(sync.profile, 'deploy');
    assert.equal(sync.obs.configured, true);
    assert.ok(sync.agents.opencode !== undefined);
    assert.ok(sync.agents.codex !== undefined);
    assert.ok(sync.agents['codex-desktop'] !== undefined);
    assert.ok(sync.agents.codearts !== undefined);
    assert.ok(sync.agents['codearts-work'] !== undefined);
    assert.ok(sync.agents.workbuddy !== undefined);
    assert.ok(sync.agents.dsh !== undefined);
  });
});

test('agent registration detects OpenCode MCP config', () => {
  withTempHome((home) => {
    const cfgDir = join(home, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'opencode.jsonc'),
      JSON.stringify({ mcp: { 'huaweicloud-devkit': { enabled: true } } }),
      'utf8',
    );
    const status = getAgentRegistrationStatuses('opencode');
    assert.equal(status.agents.opencode.configured, true);
  });
});

test('agent registration detects DSH cordis patch config', () => {
  withTempHome((home) => {
    const profileDir = join(home, '.dsh', 'profiles', 'web');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'cordis.patch.yml'),
      [
        '- insert:',
        '    - id: mcp-huaweicloud', // legacy id written by older releases
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: huaweicloud',
        '',
      ].join('\n'),
      'utf8',
    );
    const status = getAgentRegistrationStatuses('dsh');
    assert.equal(status.agents.dsh.configured, true);
  });
});

test('agent registration detects DSH_HOME cordis patch config', () => {
  withTempHome((home) => {
    const previousDshHome = process.env.DSH_HOME;
    const dshHome = join(home, 'custom-dsh');
    try {
      process.env.DSH_HOME = dshHome;
      const profileDir = join(dshHome, 'profiles', 'web');
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(
        join(profileDir, 'cordis.patch.yml'),
        "id: huaweicloud-devkit\nname: '@deepseek-ai/dsh-mcp-client'\nserverName: huaweicloud\n",
        'utf8',
      );
      const status = getAgentRegistrationStatuses('dsh');
      assert.equal(status.agents.dsh.configured, true);
    } finally {
      if (previousDshHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousDshHome;
    }
  });
});

test('resolveCredentialsWithRuntime prioritizes runtime > env > vault', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    writeGlobalCredentials({ ak: 'VAULT_AK', sk: 'VAULT_SK', region: 'cn-north-4' });

    setRuntimeCredentials('RT_AK', 'RT_SK', '', 'cn-north-1');
    const fromRuntime = resolveCredentialsWithRuntime();
    assert.equal(fromRuntime.ak, 'RT_AK');
    assert.equal(fromRuntime.sk, 'RT_SK');
    assert.equal(fromRuntime.region, 'cn-north-1');

    clearRuntimeCredentials();
    process.env.HW_ACCESS_KEY = 'ENV_AK';
    process.env.HW_SECRET_KEY = 'ENV_SK';
    const fromEnv = resolveCredentialsWithRuntime();
    assert.equal(fromEnv.ak, 'ENV_AK');
    assert.equal(fromEnv.sk, 'ENV_SK');
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;

    const fromVault = resolveCredentialsWithRuntime();
    assert.equal(fromVault.ak, 'VAULT_AK');
    assert.equal(fromVault.sk, 'VAULT_SK');
  });
});

test('resolveCredentialsWithRuntime set and clear workflow', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    writeGlobalCredentials({ ak: 'VAULT_AK', sk: 'VAULT_SK' });

    const before = resolveCredentialsWithRuntime();
    assert.equal(before.ak, 'VAULT_AK');

    setRuntimeCredentials('SWITCH_AK', 'SWITCH_SK');
    const after = resolveCredentialsWithRuntime();
    assert.equal(after.ak, 'SWITCH_AK');

    clearRuntimeCredentials();
    const reverted = resolveCredentialsWithRuntime();
    assert.equal(reverted.ak, 'VAULT_AK');
  });
});

test('resolveCredentials reads CodeArts project mcp_settings.json', () => {
  withTempHome((_home) => {
    clearRuntimeCredentials();
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;

    const codeartsDir = join(process.cwd(), '.codeartsdoer', 'mcp');
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

    try {
      const creds = resolveCredentials();
      assert.equal(creds.ak, 'CODEARTS_AK');
      assert.equal(creds.sk, 'CODEARTS_SK');
      assert.equal(creds.region, 'cn-south-1');
    } finally {
      rmSync(codeartsDir, { recursive: true, force: true });
    }
  });
});

test('resolveCredentials uses env vars over CodeArts mcp_settings.json', () => {
  withTempHome((_home) => {
    clearRuntimeCredentials();
    process.env.HW_ACCESS_KEY = 'ENV_AK';
    process.env.HW_SECRET_KEY = 'ENV_SK';

    const codeartsDir = join(process.cwd(), '.codeartsdoer', 'mcp');
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

    try {
      const creds = resolveCredentials();
      assert.equal(creds.ak, 'ENV_AK');
    } finally {
      delete process.env.HW_ACCESS_KEY;
      delete process.env.HW_SECRET_KEY;
      rmSync(codeartsDir, { recursive: true, force: true });
    }
  });
});

test('auth status is redacted and reflects vault/OBS state', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'STATUS_AK', sk: 'STATUS_SK', region: 'cn-north-4' });
    writeObsConfig({ ak: 'STATUS_AK', sk: 'STATUS_SK', region: 'cn-north-4' });
    const status = getAuthStatus('all');
    assert.equal(status.credentialsConfigured, true);
    assert.equal(status.obsConfigured, true);
    assert.ok(status.agents.opencode !== undefined);
    assert.ok(status.agents.dsh !== undefined);
    assert.doesNotMatch(JSON.stringify(status), /STATUS_AK|STATUS_SK/);
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
    assert.equal(creds.ak, 'VAULT_AK');
    assert.equal(creds.sk, 'VAULT_SK');
    assert.equal(creds.securityToken, '');
    assert.equal(creds.region, 'cn-north-4');
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
    assert.equal(creds.ak, 'STS_AK');
    assert.equal(creds.sk, 'STS_SK');
    assert.equal(creds.securityToken, 'STS_TOKEN');
    assert.equal(creds.region, 'cn-south-1');
  });
});

test('resolveCredentials keeps permanent env over vault (no security token)', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    writeGlobalCredentials({ ak: 'VAULT_AK', sk: 'VAULT_SK', region: 'cn-north-4' });
    process.env.HW_ACCESS_KEY = 'ENV_PERM_AK';
    process.env.HW_SECRET_KEY = 'ENV_PERM_SK';

    const creds = resolveCredentials();
    assert.equal(creds.ak, 'ENV_PERM_AK');
    assert.equal(creds.sk, 'ENV_PERM_SK');
  });
});

test('resolveCredentials reads CodeArts credentials from CODEARTS_PROJECT_DIR', () => {
  withTempHome((_home) => {
    clearRuntimeCredentials();
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;

    const projectDir = join(process.cwd(), 'fake-project');

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

      const prev = process.env.CODEARTS_PROJECT_DIR;
      process.env.CODEARTS_PROJECT_DIR = projectDir;

      try {
        const creds = resolveCredentials();
        assert.equal(creds.ak, 'PROJECT_DIR_AK');
        assert.equal(creds.sk, 'PROJECT_DIR_SK');
        assert.equal(creds.region, 'cn-east-3');
      } finally {
        if (prev === undefined) delete process.env.CODEARTS_PROJECT_DIR;
        else process.env.CODEARTS_PROJECT_DIR = prev;
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

test('last_sync write/read round-trip', () => {
  withTempHome((_home) => {
    assert.equal(readLastSync(), null);
    writeLastSync({ kooCliProfile: 'deploy', s1Fingerprint: 'fp123456' });
    const sync = readLastSync();
    assert.ok(sync && typeof sync.ts === 'number');
    assert.equal(sync.kooCliProfile, 'deploy');
    assert.equal(sync.s1Fingerprint, 'fp123456');
    assert.ok(Date.now() - sync.ts < 5000);
  });
});

test('last_sync old timestamp-only format remains readable', () => {
  withTempHome((_home) => {
    mkdirSync(join(process.env.HUAWEICLOUD_HOME, '.config', 'huaweicloud'), { recursive: true });
    writeFileSync(join(process.env.HUAWEICLOUD_HOME, '.config', 'huaweicloud', '.last_sync'), '{"ts":12345}', 'utf8');
    assert.deepEqual(readLastSync(), { ts: 12345 });
  });
});

test('writeGlobalCredentials persists configuredBySession flag', () => {
  withTempHome((_home) => {
    writeGlobalCredentials({ ak: 'AK1', sk: 'SK1', configuredBySession: true });
    assert.equal(readGlobalCredentials().configuredBySession, true);
    writeGlobalCredentials({ ak: 'AK1', sk: 'SK1' });
    assert.equal(readGlobalCredentials().configuredBySession, undefined);
  });
});

test('getAuthStatus reports reconciliation inconsistencies', () => {
  withTempHome((_home) => {
    writeGlobalCredentials({ ak: 'AK1', sk: 'SK1', region: 'cn-north-4' });
    const status = getAuthStatus('all');
    assert.ok('reconciled' in status);
    assert.equal(typeof status.reconciled.inconsistent, 'boolean');
    assert.equal(status.reconciled.runtimeActive, false);
  });
});

test('backup and restore global credentials', () => {
  withTempHome((_home) => {
    writeGlobalCredentials({ ak: 'AK_ORIG', sk: 'SK_ORIG', region: 'cn-north-4' });
    const bak = backupGlobalCredentials();
    assert.ok(bak && bak.endsWith('credentials.json.bak'));
    writeGlobalCredentials({ ak: 'AK_NEW', sk: 'SK_NEW' });
    assert.equal(readGlobalCredentials().ak, 'AK_NEW');
    assert.equal(restoreGlobalCredentialsBackup(), true);
    assert.equal(readGlobalCredentials().ak, 'AK_ORIG');
  });
});

test('43 getAuthStatus onboarding scenario1: S1 only, no env → use S1', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'OB_AK_1', sk: 'OB_SK_1', region: 'cn-north-4' });
    const { onboarding } = getAuthStatus('all');
    assert.equal(onboarding.scenario, 1);
    assert.equal(onboarding.reason, 's1-only');
    assert.equal(onboarding.needsSetup, true);
    assert.equal(onboarding.steps.length, 2);
    assert.equal(onboarding.steps[0].action, 'use-s1');
  });
});

test('44 getAuthStatus onboarding scenario2: conflict S1 vs env', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'OB_AK_2', sk: 'OB_SK_2', region: 'cn-north-4' });
    process.env.HW_ACCESS_KEY = 'OB_ENV_AK';
    process.env.HW_SECRET_KEY = 'OB_ENV_SK';
    // no token → env creds, not platform triplet → scenario 2 conflict
    const { onboarding } = getAuthStatus('all');
    assert.equal(onboarding.scenario, 2);
    assert.equal(onboarding.reason, 'conflict');
    assert.equal(onboarding.needsSetup, true);
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
  });
});

test('45 getAuthStatus onboarding scenario3: nothing configured → auth-init/import steps', () => {
  withTempHome(() => {
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
    delete process.env.HW_SECURITY_TOKEN;
    const { onboarding } = getAuthStatus('all');
    assert.equal(onboarding.scenario, 3);
    assert.equal(onboarding.reason, 's1-missing');
    assert.equal(onboarding.needsSetup, true);
    assert.ok(onboarding.steps.length >= 2);
    assert.equal(onboarding.steps[0].action, 'obtain-aksk');
  });
});

test('46 getAuthStatus onboarding scenario4: no S1 but env creds present → import', () => {
  withTempHome(() => {
    process.env.HW_ACCESS_KEY = 'OB_ENV_AK';
    process.env.HW_SECRET_KEY = 'OB_ENV_SK';
    delete process.env.HW_SECURITY_TOKEN;
    const { onboarding } = getAuthStatus('all');
    assert.equal(onboarding.scenario, 4);
    assert.equal(onboarding.reason, 'import-injected');
    assert.equal(onboarding.needsSetup, true);
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
  });
});

test('47 getAuthStatus onboarding: platform triplet + no S1 → needsSetup=false', () => {
  withTempHome(() => {
    process.env.HW_ACCESS_KEY = 'OB_PLATFORM_AK';
    process.env.HW_SECRET_KEY = 'OB_PLATFORM_SK';
    process.env.HW_SECURITY_TOKEN = 'OB_PLATFORM_TOKEN';
    const { onboarding } = getAuthStatus('all');
    assert.equal(onboarding.needsSetup, false);
    assert.equal(onboarding.scenario, 0);
    assert.equal(onboarding.reason, 'platform-injected');
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
    delete process.env.HW_SECURITY_TOKEN;
  });
});

test('48 getAuthStatus onboarding runtime active → needsSetup=false, no leak', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    setRuntimeCredentials('OB_RT_AK', 'OB_RT_SK');
    const { onboarding } = getAuthStatus('all');
    assert.equal(onboarding.needsSetup, false);
    assert.equal(onboarding.scenario, 0);
    assert.equal(onboarding.reason, 'runtime-active');
    assert.equal(onboarding.accountHint, null);
    assert.doesNotMatch(JSON.stringify(onboarding), /OB_RT_AK|OB_RT_SK/);
    clearRuntimeCredentials();
  });
});

test('49 huaweicloud_auth_status onboarding does not leak AK (fingerprint only)', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'OB_SECRET_AK', sk: 'OB_SECRET_SK', region: 'cn-north-4' });
    const status = getAuthStatus('all');
    assert.doesNotMatch(JSON.stringify(status), /OB_SECRET_AK|OB_SECRET_SK/);
    assert.match(status.onboarding.accountHint, /^[0-9a-f]{8}$/);
  });
});

test('50 onboarding scenario1: S1 exists + platform triplet → use S1 (not s1-missing)', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'OB_S1_AK', sk: 'OB_S1_SK', region: 'cn-north-4' });
    process.env.HW_ACCESS_KEY = 'OB_PLATFORM_AK';
    process.env.HW_SECRET_KEY = 'OB_PLATFORM_SK';
    process.env.HW_SECURITY_TOKEN = 'OB_PLATFORM_TOKEN';
    const { onboarding } = getAuthStatus('all');
    assert.equal(onboarding.scenario, 1, JSON.stringify(onboarding));
    assert.equal(onboarding.needsSetup, true);
    assert.equal(onboarding.steps[0].action, 'use-s1');
    assert.notEqual(onboarding.reason, 's1-missing');
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
    delete process.env.HW_SECURITY_TOKEN;
  });
});

test('resolveCredentials reads CodeArts Work new layout ~/.codearts with prefixed key', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
    delete process.env.HW_SECURITY_TOKEN;

    const workDir = join(homedir(), '.codearts', 'mcp');
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

    try {
      const creds = resolveCredentials();
      assert.equal(creds.ak, 'NEW_WORK_AK');
      assert.equal(creds.sk, 'NEW_WORK_SK');
      assert.equal(creds.securityToken, 'NEW_WORK_TOKEN');
    } finally {
      rmSync(join(homedir(), '.codearts'), { recursive: true, force: true });
    }
  });
});

test('resolveCredentials falls back to legacy ~/.codeartswork when new ~/.codearts absent', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
    delete process.env.HW_SECURITY_TOKEN;

    const legacyDir = join(homedir(), '.codeartswork', 'mcp');
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

    try {
      const creds = resolveCredentials();
      assert.equal(creds.ak, 'LEGACY_WORK_AK');
      assert.equal(creds.sk, 'LEGACY_WORK_SK');
    } finally {
      rmSync(join(homedir(), '.codeartswork'), { recursive: true, force: true });
    }
  });
});

test('auth_status reports mcpSettingsConfigured and mcp-settings-injected onboarding', () => {
  withTempHome(() => {
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
    delete process.env.HW_SECURITY_TOKEN;
    const workDir = join(homedir(), '.codearts', 'mcp');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      join(workDir, 'mcp_settings.json'),
      JSON.stringify({
        mcp: {
          'huaweicloud-devkit_1': {
            environment: { HW_ACCESS_KEY: 'S4_AK', HW_SECRET_KEY: 'S4_SK', HW_SECURITY_TOKEN: 'S4_TOKEN' },
          },
        },
      }),
      'utf8',
    );
    try {
      const status = getAuthStatus('all');
      assert.equal(status.credentialsConfigured, false);
      assert.equal(status.mcpSettingsConfigured, true);
      assert.equal(status.onboarding.reason, 'mcp-settings-injected');
      assert.equal(status.onboarding.needsSetup, false);
    } finally {
      rmSync(join(homedir(), '.codearts'), { recursive: true, force: true });
    }
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

test('pickDevkitMcpServer prefers canonical key over prefixed instances (R4)', () => {
  const map = {
    'huaweicloud-devkit_2': { environment: { HW_ACCESS_KEY: 'K2' } },
    'huaweicloud-devkit': { environment: { HW_ACCESS_KEY: 'K0' } },
    'huaweicloud-devkit_1': { environment: { HW_ACCESS_KEY: 'K1' } },
  };
  assert.equal(pickDevkitMcpServer(map).environment.HW_ACCESS_KEY, 'K0');
});

test('pickDevkitMcpServer falls back to HuaweiCloud DevKit then lowest _N (R4)', () => {
  const map = {
    'huaweicloud-devkit_3': { env: { HW_ACCESS_KEY: 'K3' } },
    'HuaweiCloud DevKit': { env: { HW_ACCESS_KEY: 'KDK' } },
  };
  assert.equal(pickDevkitMcpServer(map).env.HW_ACCESS_KEY, 'KDK');
  const map2 = {
    'huaweicloud-devkit_3': { env: { HW_ACCESS_KEY: 'K3' } },
    'huaweicloud-devkit_1': { env: { HW_ACCESS_KEY: 'K1' } },
  };
  assert.equal(pickDevkitMcpServer(map2).env.HW_ACCESS_KEY, 'K1');
});

test('pickDevkitMcpServer is order-independent and returns null for empty/non-object', () => {
  const a = { 'huaweicloud-devkit_1': { environment: { HW_ACCESS_KEY: 'A' } } };
  const b = { 'huaweicloud-devkit_1': { environment: { HW_ACCESS_KEY: 'A' } } };
  assert.equal(pickDevkitMcpServer(a).environment.HW_ACCESS_KEY, pickDevkitMcpServer(b).environment.HW_ACCESS_KEY);
  assert.equal(pickDevkitMcpServer({}), null);
  assert.equal(pickDevkitMcpServer(null), null);
  assert.equal(pickDevkitMcpServer(undefined), null);
});
