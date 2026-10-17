import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { createLinkedDevkitServers } from '../plugins/huaweicloud-core/src/mcp-protocol.ts';
import { fixtureDir } from './fixture-dir.ts';
import { clearCustodyCache } from '../plugins/huaweicloud-core/src/lib/secret-vault/custody.ts';

// The secrets pack through the real callTool dispatch and the real MCP
// disclosure path. The invariant under test is the design's headline: no tool
// result ever contains a plaintext secret value, and the unauthenticated
// remote surface never registers the vault mutation tools.

const PLAINTEXT = 'MCP-PACK-SECRET-4b1e';

function vaultEnv(): string {
  return fixtureDir('packs-secrets-');
}

interface SetResult {
  ref: string;
  status: string;
  version: number;
  fingerprint: string;
}

test('secrets pack: set/list/delete through callTool, values never in results', async () => {
  const home = vaultEnv();
  process.env.HUAWEICLOUD_HOME = home;
  process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x33).toString('base64');
  clearCustodyCache();
  try {
    const set = (await callTool('huaweicloud_secret_set', {
      ref: 'secret://mcp/one',
      channel: 'value',
      value: PLAINTEXT,
      note: 'first',
    })) as SetResult;
    assert.equal(set.status, 'set');
    assert.equal(set.version, 1);
    assert.match(set.fingerprint, /^[0-9a-f]{16}$/);
    assert.equal(JSON.stringify(set).includes(PLAINTEXT), false);

    const again = (await callTool('huaweicloud_secret_set', {
      ref: 'secret://mcp/one',
      channel: 'value',
      value: PLAINTEXT,
    })) as SetResult;
    assert.equal(again.status, 'unchanged');
    assert.equal(again.version, 1);

    const rotated = (await callTool('huaweicloud_secret_set', {
      ref: 'secret://mcp/one',
      channel: 'value',
      value: 'rotated-value',
    })) as SetResult;
    assert.equal(rotated.status, 'set');
    assert.equal(rotated.version, 2);

    const list = (await callTool('huaweicloud_secret_list', {})) as {
      count: number;
      secrets: Array<{ ref: string; version: number; note: string }>;
    };
    assert.equal(list.count, 1);
    assert.equal(list.secrets[0]!.ref, 'secret://mcp/one');
    assert.equal(list.secrets[0]!.version, 2);
    assert.equal(JSON.stringify(list).includes(PLAINTEXT), false);
    assert.equal(JSON.stringify(list).includes('rotated-value'), false);

    const removed = (await callTool('huaweicloud_secret_delete', { ref: 'secret://mcp/one' })) as {
      removed: number;
    };
    assert.equal(removed.removed, 1);
    const removedAgain = (await callTool('huaweicloud_secret_delete', { ref: 'secret://mcp/one' })) as {
      removed: number;
    };
    assert.equal(removedAgain.removed, 0);
  } finally {
    delete process.env.HUAWEICLOUD_HOME;
    delete process.env.HW_VAULT_MASTER_KEY;
    clearCustodyCache();
  }
});

test('secrets pack: bad refs and missing channels are boundary errors', async () => {
  const home = vaultEnv();
  process.env.HUAWEICLOUD_HOME = home;
  process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x33).toString('base64');
  clearCustodyCache();
  try {
    await assert.rejects(
      callTool('huaweicloud_secret_set', { ref: 'secret://mcp/BAD', channel: 'value', value: 'x' }),
      /VAULT_BAD_REF|valid secret ref/,
    );
    await assert.rejects(callTool('huaweicloud_secret_set', { ref: 'secret://mcp/one' }), /channel/);
    await assert.rejects(
      callTool('huaweicloud_secret_set', { ref: 'secret://mcp/one', channel: 'value', value: '' }),
      /empty secret/,
    );
  } finally {
    delete process.env.HUAWEICLOUD_HOME;
    delete process.env.HW_VAULT_MASTER_KEY;
    clearCustodyCache();
  }
});

test('secrets pack: the remote surface withholds the vault tools; stdio registers them', async () => {
  const { server, transport } = await createLinkedDevkitServers({ remoteSurface: true });
  const client = new Client({ name: 'secrets-remote-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const remoteTools = await client.listTools();
    const remoteNames = remoteTools.tools.map((tool) => tool.name);
    assert.equal(
      remoteNames.some((name) => name.startsWith('huaweicloud_secret_')),
      false,
    );
    assert.equal(remoteNames.includes('huaweicloud_packs_configure'), false);
  } finally {
    await client.close();
    await server.close();
  }

  const { server: stdioServer, transport: stdioTransport } = await createLinkedDevkitServers();
  const stdioClient = new Client({ name: 'secrets-stdio-test', version: '0.0.0' });
  await stdioClient.connect(stdioTransport);
  try {
    const stdioTools = await stdioClient.listTools();
    const stdioNames = new Set(stdioTools.tools.map((tool) => tool.name));
    assert.equal(stdioNames.has('huaweicloud_secret_set'), true);
    assert.equal(stdioNames.has('huaweicloud_secret_list'), true);
    assert.equal(stdioNames.has('huaweicloud_secret_delete'), true);
  } finally {
    await stdioClient.close();
    await stdioServer.close();
  }
});

test('secrets pack: the envVar channel refuses credential-family names', async () => {
  const home = vaultEnv();
  process.env.HUAWEICLOUD_HOME = home;
  process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x33).toString('base64');
  process.env.HW_SECRET_KEY = 'HARVEST-TARGET';
  clearCustodyCache();
  try {
    for (const name of [
      'HW_SECRET_KEY',
      'hw_access_key',
      'HUAWEICLOUD_ACCESS_KEY',
      'OS_SECRET_KEY',
      'HCLOUD_SOMETHING',
    ]) {
      await assert.rejects(
        callTool('huaweicloud_secret_set', { ref: 'secret://mcp/harvest', channel: 'envVar', envVar: name }),
        /credential environment variable|dump gates/i,
        name,
      );
    }
    // Non-credential names keep working.
    process.env.E2E_BENIGN_VALUE = 'fine';
    const set = (await callTool('huaweicloud_secret_set', {
      ref: 'secret://mcp/benign',
      channel: 'envVar',
      envVar: 'E2E_BENIGN_VALUE',
    })) as SetResult;
    assert.equal(set.status, 'set');
    await callTool('huaweicloud_secret_delete', { ref: 'secret://mcp/benign' });
  } finally {
    delete process.env.HW_SECRET_KEY;
    delete process.env.E2E_BENIGN_VALUE;
    delete process.env.HUAWEICLOUD_HOME;
    delete process.env.HW_VAULT_MASTER_KEY;
    clearCustodyCache();
  }
});

test('secrets pack: the remote face refuses a DIRECT tools/call to the withheld vault tools', async () => {
  const { server, transport } = await createLinkedDevkitServers({ remoteSurface: true });
  const client = new Client({ name: 'secrets-remote-call-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    // The SDK routes unknown tools into a resolved isError result
    // ("MCP error -32602: Tool … not found") — the same registered-tool
    // routing that backs the packs_configure refusal. Asserting the CALL,
    // not just tools/list, pins the withholding at dispatch, so a refactor
    // that filtered only the list response cannot re-open unauthenticated
    // local-state mutation on the remote.
    const withheld = [
      'huaweicloud_secret_set',
      'huaweicloud_auth_sync',
      'huaweicloud_auth_init',
      'huaweicloud_auth_switch',
      'huaweicloud_auth_confirm',
      'huaweicloud_setup_obs_config',
    ];
    for (const name of withheld) {
      const called = (await client.callTool({ name, arguments: {} })) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      assert.equal(called.isError, true, name);
      assert.match(called.content[0]!.text, /not found/i, name);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('secrets pack: the file channel refuses protected credential paths', async () => {
  const home = vaultEnv();
  process.env.HUAWEICLOUD_HOME = home;
  process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x33).toString('base64');
  clearCustodyCache();
  try {
    // The Bash face denies `cat ~/.hcloud/config.json` via
    // credentialFilePatterns; the MCP face must not launder the same read
    // into the vault — including quote-mangled path spellings.
    await assert.rejects(
      callTool('huaweicloud_secret_set', {
        ref: 'secret://mcp/launder',
        channel: 'file',
        file: '/home/u/.hcloud/config.json',
      }),
      /protected credential-file/,
    );
    await assert.rejects(
      callTool('huaweicloud_secret_set', {
        ref: 'secret://mcp/launder',
        channel: 'file',
        file: "/home/u/.hclou'd'/config.json",
      }),
      /protected credential-file/,
    );
    await assert.rejects(
      callTool('huaweicloud_secret_set', {
        ref: 'secret://mcp/launder',
        channel: 'file',
        file: '/home/u/.config/huaweicloud/secrets/.master-key',
      }),
      /protected credential-file/,
    );
  } finally {
    delete process.env.HUAWEICLOUD_HOME;
    delete process.env.HW_VAULT_MASTER_KEY;
    clearCustodyCache();
  }
});
