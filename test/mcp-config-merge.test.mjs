import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeCommandStyle,
  mergeArgsStyle,
  mergeMcpServersFile,
  extractUserDelta,
  applyUserDelta,
  inheritPeerUserEnv,
} from '../plugins/huaweicloud-core/src/mcp-config-merge.mjs';

const MCP_PATH = '/home/u/.config/opencode/huaweicloud-plugins/src/mcp-server.mjs';

test('mergeCommandStyle: identical entry reports unchanged', () => {
  const existing = { type: 'local', command: ['node', MCP_PATH], enabled: true, timeout: 300000 };
  const { entry, changed } = mergeCommandStyle(existing, { mcpPath: MCP_PATH });
  assert.equal(changed, false);
  assert.deepEqual(entry, existing);
});

test('mergeCommandStyle: preserves user extra args, env, timeout, enabled=false', () => {
  const existing = {
    type: 'local',
    command: ['node', MCP_PATH, '--hdkitservice-endpoint', 'http://test-env'],
    env: { FOO: 'bar' },
    timeout: 600000,
    enabled: false,
  };
  // Merged result equals the existing entry, so nothing needs rewriting.
  const { entry, changed } = mergeCommandStyle(existing, { mcpPath: MCP_PATH });
  assert.equal(changed, false);
  assert.deepEqual(entry, existing);
  assert.deepEqual(entry.command, ['node', MCP_PATH, '--hdkitservice-endpoint', 'http://test-env']);
  assert.deepEqual(entry.env, { FOO: 'bar' });
  assert.equal(entry.timeout, 600000);
  assert.equal(entry.enabled, false);
});

test('mergeCommandStyle: path drift rewrites but keeps user extras', () => {
  const existing = {
    type: 'local',
    command: ['node', '/old/path/mcp-server.mjs', '--hdkitservice-endpoint', 'http://test-env'],
    env: { FOO: 'bar' },
    timeout: 600000,
    enabled: false,
  };
  const { entry, changed } = mergeCommandStyle(existing, { mcpPath: MCP_PATH });
  assert.equal(changed, true);
  assert.deepEqual(entry.command, ['node', MCP_PATH, '--hdkitservice-endpoint', 'http://test-env']);
  assert.deepEqual(entry.env, { FOO: 'bar' });
  assert.equal(entry.timeout, 600000);
  assert.equal(entry.enabled, false);
});

test('mergeCommandStyle: path drift updates path but keeps user args', () => {
  const existing = { type: 'local', command: ['node', '/old/path/mcp-server.mjs', '--flag'], timeout: 300000 };
  const { entry, changed } = mergeCommandStyle(existing, { mcpPath: MCP_PATH });
  assert.equal(changed, true);
  assert.deepEqual(entry.command, ['node', MCP_PATH, '--flag']);
});

test('mergeCommandStyle: fills missing defaults on drifted entry', () => {
  const existing = { command: ['node', MCP_PATH] };
  const { entry, changed } = mergeCommandStyle(existing, { mcpPath: MCP_PATH });
  assert.equal(changed, true);
  assert.equal(entry.type, 'local');
  assert.equal(entry.timeout, 300000);
  assert.equal(entry.enabled, true);
});

test('mergeCommandStyle: missing entry produces default', () => {
  const { entry, changed } = mergeCommandStyle(undefined, { mcpPath: MCP_PATH });
  assert.equal(changed, true);
  assert.deepEqual(entry, { type: 'local', command: ['node', MCP_PATH], enabled: true, timeout: 300000 });
});

test('mergeCommandStyle: foreign wrapper keeps overwrite behavior', () => {
  const existing = { type: 'local', command: ['bash', '/wrapper.sh'], timeout: 300000 };
  const { entry, changed } = mergeCommandStyle(existing, { mcpPath: MCP_PATH });
  assert.equal(changed, true);
  assert.deepEqual(entry.command, ['node', MCP_PATH]);
});

test('mergeArgsStyle: identical entry reports unchanged', () => {
  const existing = { command: 'node', args: [MCP_PATH], env: { A: '1' }, timeout: 300000 };
  const { entry, changed } = mergeArgsStyle(existing, { mcpPath: MCP_PATH, env: { A: '1' } });
  assert.equal(changed, false);
  assert.deepEqual(entry, existing);
});

test('mergeArgsStyle: user values win over required env keys', () => {
  const existing = {
    command: 'node',
    args: [MCP_PATH, '--x'],
    env: { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'custom', HCLOUD_BIN: '/my/hcloud' },
    timeout: 300000,
  };
  const { entry } = mergeArgsStyle(existing, {
    mcpPath: MCP_PATH,
    env: { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local', HCLOUD_BIN: '/found/hcloud' },
  });
  assert.equal(entry.env.HUAWEICLOUD_AGENT_TOOLKIT_MODE, 'custom');
  assert.equal(entry.env.HCLOUD_BIN, '/my/hcloud');
  assert.deepEqual(entry.args, [MCP_PATH, '--x']);
});

test('mergeArgsStyle: adds missing required env keys', () => {
  const existing = { command: 'node', args: [MCP_PATH], timeout: 300000 };
  const { entry, changed } = mergeArgsStyle(existing, { mcpPath: MCP_PATH, env: { MODE: 'local' } });
  assert.equal(changed, true);
  assert.equal(entry.env.MODE, 'local');
});

test('mergeArgsStyle: missing entry produces default with env', () => {
  const { entry, changed } = mergeArgsStyle(undefined, { mcpPath: MCP_PATH, env: { MODE: 'local' } });
  assert.equal(changed, true);
  assert.deepEqual(entry, { command: 'node', args: [MCP_PATH], env: { MODE: 'local' }, timeout: 300000 });
});

test('mergeMcpServersFile: creates entry in empty config without timeout field', () => {
  const { config, changed } = mergeMcpServersFile(undefined, { mcpPath: MCP_PATH, env: { MODE: 'local' } });
  assert.equal(changed, true);
  assert.deepEqual(config.mcpServers['huaweicloud-devkit'], {
    command: 'node',
    args: [MCP_PATH],
    env: { MODE: 'local' },
  });
});

test('mergeMcpServersFile: preserves other servers and user fields', () => {
  const config = {
    mcpServers: {
      'other-server': { command: 'foo' },
      'huaweicloud-devkit': { command: 'node', args: ['/old/mcp-server.mjs', '--keep'], env: { X: 'y' } },
    },
  };
  const { config: next, changed } = mergeMcpServersFile(config, { mcpPath: MCP_PATH, env: { MODE: 'local' } });
  assert.equal(changed, true);
  assert.deepEqual(next.mcpServers['other-server'], { command: 'foo' });
  const entry = next.mcpServers['huaweicloud-devkit'];
  assert.deepEqual(entry.args, [MCP_PATH, '--keep']);
  assert.equal(entry.env.X, 'y');
  assert.equal(entry.env.MODE, 'local');
});

test('extractUserDelta + applyUserDelta roundtrip (command style)', () => {
  const entry = {
    type: 'local',
    command: ['node', MCP_PATH, '--hdkitservice-endpoint', 'http://test'],
    env: { FOO: '1' },
    timeout: 600000,
    enabled: false,
  };
  const delta = extractUserDelta(entry, 'command');
  assert.ok(delta);
  assert.deepEqual(delta.commandExtra, ['--hdkitservice-endpoint', 'http://test']);
  assert.deepEqual(delta.env, { FOO: '1' });
  assert.equal(delta.timeout, 600000);
  assert.equal(delta.enabled, false);

  const fresh = { type: 'local', command: ['node', '/new/path/mcp-server.mjs'], enabled: true, timeout: 300000 };
  const restored = applyUserDelta(fresh, delta, 'command');
  assert.deepEqual(restored.command, ['node', '/new/path/mcp-server.mjs', '--hdkitservice-endpoint', 'http://test']);
  assert.deepEqual(restored.env, { FOO: '1' });
  assert.equal(restored.timeout, 600000);
  assert.equal(restored.enabled, false);
});

test('extractUserDelta returns null for default entry', () => {
  const entry = {
    command: 'node',
    args: [MCP_PATH],
    env: { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local', HCLOUD_BIN: '/bin/hcloud' },
    timeout: 300000,
  };
  // Managed env keys and default fields are program-owned, not user assets.
  assert.equal(extractUserDelta(entry, 'args'), null);
});

test('extractUserDelta keeps non-managed env keys as user assets', () => {
  const entry = {
    command: 'node',
    args: [MCP_PATH],
    env: { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local', FOO: 'bar' },
    timeout: 300000,
  };
  const delta = extractUserDelta(entry, 'args');
  assert.deepEqual(delta, { env: { FOO: 'bar' } });
});

test('applyUserDelta ignores non-object input', () => {
  const fresh = { command: 'node', args: [MCP_PATH] };
  assert.deepEqual(applyUserDelta(fresh, null, 'args'), fresh);
});

test('inheritPeerUserEnv collects user STS env from marketplace-preset peer keys', () => {
  const mcpMap = {
    'huaweicloud-devkit_1': {
      command: ['npx', '-y', '-p', 'huaweicloud-devkit@latest', 'huaweicloud-devkit-mcp'],
      environment: {
        HW_ACCESS_KEY: 'AK_FROM_MARKET',
        HW_SECRET_KEY: 'SK_FROM_MARKET',
        HW_SECURITY_TOKEN: 'TOKEN_FROM_MARKET',
        HW_REGION: 'cn-south-1',
      },
    },
    'huaweicloud-devkit': { command: ['node', MCP_PATH], environment: { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local' } },
  };
  const inherited = inheritPeerUserEnv(mcpMap);
  assert.deepEqual(inherited, {
    HW_ACCESS_KEY: 'AK_FROM_MARKET',
    HW_SECRET_KEY: 'SK_FROM_MARKET',
    HW_SECURITY_TOKEN: 'TOKEN_FROM_MARKET',
    HW_REGION: 'cn-south-1',
  });
});

test('inheritPeerUserEnv ignores installer-managed keys and self entry', () => {
  const mcpMap = {
    'huaweicloud-devkit_1': {
      environment: { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local', HCLOUD_BIN: '/x/hcloud', HW_ACCESS_KEY: 'AK' },
    },
  };
  const inherited = inheritPeerUserEnv(mcpMap);
  assert.deepEqual(inherited, { HW_ACCESS_KEY: 'AK' });
});

test('inheritPeerUserEnv handles .env style peers and returns null when nothing to inherit', () => {
  assert.equal(inheritPeerUserEnv({}), null);
  assert.equal(inheritPeerUserEnv(null), null);
  const envStyle = { 'huaweicloud-devkit_1': { env: { HW_ACCESS_KEY: 'AK2' } } };
  assert.deepEqual(inheritPeerUserEnv(envStyle), { HW_ACCESS_KEY: 'AK2' });
});
