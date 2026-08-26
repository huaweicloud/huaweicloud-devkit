import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  clearRuntimeCredentials,
  getParentCwd,
  globalCredentialsPath,
  obsConfigPath,
  readGlobalCredentials,
  resolveCredentials,
  resolveCredentialsWithRuntime,
  setRuntimeCredentials,
  writeGlobalCredentials,
  writeObsConfig,
} from '../plugins/huaweicloud-core/src/auth/credentials.mjs';
import { getAgentRegistrationStatuses } from '../plugins/huaweicloud-core/src/auth/agent-registration.mjs';
import { getAuthStatus, syncAuth } from '../plugins/huaweicloud-core/src/auth/service.mjs';

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-auth-'));
  const previous = {
    HUAWEICLOUD_HOME: process.env.HUAWEICLOUD_HOME,
    HW_ACCESS_KEY: process.env.HW_ACCESS_KEY,
    HW_SECRET_KEY: process.env.HW_SECRET_KEY,
    HW_SECURITY_TOKEN: process.env.HW_SECURITY_TOKEN,
    HW_REGION: process.env.HW_REGION,
    HUAWEICLOUD_REGION: process.env.HUAWEICLOUD_REGION,
    DSH_HOME: process.env.DSH_HOME,
  };
  process.env.HUAWEICLOUD_HOME = dir;
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  delete process.env.HW_SECURITY_TOKEN;
  delete process.env.HW_REGION;
  delete process.env.HUAWEICLOUD_REGION;
  delete process.env.DSH_HOME;
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
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'SYNC_AK', sk: 'SYNC_SK', region: 'cn-north-4' });
    const sync = syncAuth('all');
    assert.equal(sync.ok, true);
    assert.equal(sync.obs.configured, true);
    assert.ok(sync.agents.opencode !== undefined);
    assert.ok(sync.agents.codex !== undefined);
    assert.ok(sync.agents['codex-desktop'] !== undefined);
    assert.ok(sync.agents.codearts !== undefined);
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
        '    - id: mcp-huaweicloud',
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
        "id: mcp-huaweicloud\nname: '@deepseek-ai/dsh-mcp-client'\nserverName: huaweicloud\n",
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
