import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  resolveEnabledPacks,
  clearRuntimePacksOverride,
  runtimePacksOverride,
} from '../plugins/huaweicloud-core/src/packs/enable.ts';
import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { createLinkedDevkitServers } from '../plugins/huaweicloud-core/src/mcp-protocol.ts';
import type { PackId } from '../plugins/huaweicloud-core/src/lib/pack-types.ts';

// node --test runs each file in its own process, so env mutation cannot leak
// into the other suites; the try/finally still keeps this file's later tests
// honest when one fails mid-flight, and drops the session override both
// before and after the body.
function withEnv(devkitPacks: string | undefined, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const previous = process.env.DEVKIT_PACKS;
    if (devkitPacks === undefined) delete process.env.DEVKIT_PACKS;
    else process.env.DEVKIT_PACKS = devkitPacks;
    clearRuntimePacksOverride();
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env.DEVKIT_PACKS;
      else process.env.DEVKIT_PACKS = previous;
      clearRuntimePacksOverride();
    }
  };
}

async function withClient(
  options: Parameters<typeof createLinkedDevkitServers>[0],
  fn: (_client: Client) => Promise<void>,
): Promise<void> {
  const { server, transport } = await createLinkedDevkitServers(options);
  const client = new Client({ name: 'packs-configure-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<ToolPayload> {
  const res = (await client.callTool({ name, arguments: args })) as ClientToolResult;
  const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '{}';
  if (res.isError) throw new Error(`MCP tool error from ${name}: ${text}`);
  return JSON.parse(typeof text === 'string' ? text : '{}') as ToolPayload;
}

// Loose payload shape for the JSON the tools return; assertions stay
// narrow via the fields they read.
interface ToolPayload {
  ok?: boolean;
  changed?: boolean;
  override?: string | null;
  effectivePacks?: string[];
  error?: string;
  note?: string;
  packs?: Array<{ id: PackId; enabled: boolean }>;
}

interface ListPacksPayload {
  packs: Array<{ id: PackId; enabled: boolean; tools: string[] }>;
}

interface ClientToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function toolNames(client: Client): Promise<string[]> {
  const listed = await client.listTools();
  return listed.tools.map((tool) => tool.name);
}

const noopSync = (): void => {};

test(
  'session enable widens disclosure beyond the operator env posture',
  withEnv('core', () =>
    withClient({ runtimePacks: true }, async (client) => {
      const before = await toolNames(client);
      assert.ok(before.includes('huaweicloud_packs_configure'), 'the toggle tool is registered on the stdio surface');
      assert.ok(!before.includes('huaweicloud_setup_obs_config'), 'obs tool starts hidden under DEVKIT_PACKS=core');

      const result = await callJson(client, 'huaweicloud_packs_configure', { enable: ['obs'] });
      assert.equal(result.ok, true);
      assert.equal(result.changed, true);
      assert.equal(result.override, 'core,obs', 'the override stores the seed in PACK_IDS order');
      assert.deepEqual(result.effectivePacks, ['core', 'obs']);

      const after = await toolNames(client);
      assert.ok(after.includes('huaweicloud_setup_obs_config'), 'client re-list shows the newly enabled pack tool');
      assert.ok(after.includes('huaweicloud_obs_set_website_config'), 'both obs tools re-disclose together');

      const listed = await callJson(client, 'huaweicloud_list_packs', {});
      const flags = new Map((listed.packs ?? []).map((pack) => [pack.id, pack.enabled]));
      assert.equal(flags.get('obs'), true, 'list_packs reflects the session override');

      const skill = await callJson(client, 'huaweicloud_retrieve_skill', { name: 'huawei-obs' });
      assert.equal(skill.ok, true, 'a session-enabled pack loads its skills immediately');
    }),
  ),
);

test(
  'session disable removes the tools and gates the skills again',
  withEnv('core,obs', () =>
    withClient({ runtimePacks: true }, async (client) => {
      const before = await toolNames(client);
      assert.ok(before.includes('huaweicloud_setup_obs_config'), 'obs starts enabled via env');

      const result = await callJson(client, 'huaweicloud_packs_configure', { disable: ['obs'] });
      assert.equal(result.ok, true);
      assert.equal(result.changed, true);
      assert.equal(result.override, 'core', 'disabling the only optional pack floors the override at core');

      const after = await toolNames(client);
      assert.ok(!after.includes('huaweicloud_setup_obs_config'), 'the disabled pack tool leaves the client list');

      const denied = await callJson(client, 'huaweicloud_retrieve_skill', { name: 'huawei-obs' });
      assert.equal(denied.ok, false);
      assert.match(denied.error ?? '', /belongs to pack "obs" which is not enabled/);
      assert.match(denied.error ?? '', /huaweicloud_packs_configure/, 'the error names the in-session way out');
    }),
  ),
);

test(
  'reset restores the operator env posture',
  withEnv('core', () =>
    withClient({ runtimePacks: true }, async (client) => {
      await callJson(client, 'huaweicloud_packs_configure', { enable: ['obs', 'sandbox'] });
      const result = await callJson(client, 'huaweicloud_packs_configure', { reset: true });
      assert.equal(result.ok, true);
      assert.equal(result.changed, true);
      assert.equal(result.override, null, 'reset drops the override entirely');
      assert.deepEqual(result.effectivePacks, ['core']);

      const names = await toolNames(client);
      assert.ok(!names.includes('huaweicloud_sandbox_connect'), 'env posture rules again after reset');

      const again = await callJson(client, 'huaweicloud_packs_configure', { reset: true });
      assert.equal(again.changed, false, 'reset without an override is a noop');
    }),
  ),
);

test(
  'enable with the full default surface is a noop and keeps env unset',
  withEnv(undefined, () =>
    withClient({ runtimePacks: true }, async (client) => {
      const result = await callJson(client, 'huaweicloud_packs_configure', { enable: ['obs'] });
      assert.equal(result.ok, true);
      assert.equal(result.changed, false, 'nothing to enable when the surface is already full');
      assert.equal(result.override, null, 'no override is stored for a noop');
      assert.equal(runtimePacksOverride(), null);
    }),
  ),
);

test(
  'disable from the full surface stores the shrunk seed, floor core',
  withEnv(undefined, () =>
    withClient({ runtimePacks: true }, async (client) => {
      const result = await callJson(client, 'huaweicloud_packs_configure', {
        disable: [
          'huaweicloud-cli',
          'sandbox',
          'auth',
          'obs',
          'voucher',
          'update',
          'discovery',
          'huaweicloud-open-mcp',
          'secrets',
        ],
      });
      assert.equal(result.ok, true);
      assert.equal(result.changed, true);
      assert.equal(result.override, 'core', 'disabling every optional pack lands on the core floor');
      assert.deepEqual(result.effectivePacks, ['core']);
      assert.equal(resolveEnabledPacks().size, 1);
    }),
  ),
);

test(
  'enable and disable compose in one call',
  withEnv('core,sandbox', () =>
    withClient({ runtimePacks: true }, async (client) => {
      const result = await callJson(client, 'huaweicloud_packs_configure', { disable: ['sandbox'], enable: ['obs'] });
      assert.equal(result.ok, true);
      assert.equal(result.override, 'core,obs', 'disable applies to the base before enable unions in');
      assert.deepEqual(result.effectivePacks, ['core', 'obs']);
    }),
  ),
);

test('disable core is refused and nothing changes', () =>
  withEnv('core,obs', async () => {
    const refused = (await callTool(
      'huaweicloud_packs_configure',
      { disable: ['core'] },
      { onPacksChanged: noopSync },
    )) as ToolPayload;
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', /core is always enabled/);
    assert.equal(runtimePacksOverride(), null, 'the refusal must not leave an override behind');
  })());

test('unknown ids are named with the valid list', () =>
  withEnv('core', async () => {
    const refused = (await callTool(
      'huaweicloud_packs_configure',
      { enable: ['bogus'] },
      { onPacksChanged: noopSync },
    )) as ToolPayload;
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', /Unknown pack id\(s\): bogus/);
    assert.match(refused.error ?? '', /core, huaweicloud-cli, sandbox/);
    assert.equal(runtimePacksOverride(), null);
  })());

test('missing every verb is a usage error', () =>
  withEnv('core', async () => {
    const refused = (await callTool('huaweicloud_packs_configure', {}, { onPacksChanged: noopSync })) as ToolPayload;
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', /at least one of enable, disable, or reset/);
  })());

test(
  'the stateless remote surface never registers the toggle and cannot mutate shared state',
  withEnv('core', () =>
    withClient({}, async (client) => {
      const names = await toolNames(client);
      assert.ok(!names.includes('huaweicloud_packs_configure'), 'the default surface omits the toggle tool');

      const refused = (await callTool(
        'huaweicloud_packs_configure',
        { enable: ['obs'] },
        { sessionId: 'remote' },
      )) as ToolPayload;
      assert.equal(refused.ok, false);
      assert.match(refused.error ?? '', /stdio agent sessions only/);
      assert.equal(runtimePacksOverride(), null, 'a refused direct call must not mutate process-shared pack state');
    }),
  ),
);

test('sequential calls accumulate over the same session override', () =>
  withEnv('core', async () => {
    await callTool('huaweicloud_packs_configure', { enable: ['obs'] }, { onPacksChanged: noopSync });
    const second = (await callTool(
      'huaweicloud_packs_configure',
      { enable: ['auth'] },
      { onPacksChanged: noopSync },
    )) as ToolPayload;
    assert.equal(second.ok, true);
    assert.equal(second.override, 'core,auth,obs', 'the second call unions onto the first override');
    assert.deepEqual(second.effectivePacks, ['core', 'auth', 'obs']);
  })());

test(
  'a disable then re-enable cycle converges through the same client',
  withEnv('core', () =>
    withClient({ runtimePacks: true }, async (client) => {
      const enabled = await callJson(client, 'huaweicloud_packs_configure', { enable: ['obs'] });
      assert.equal(enabled.changed, true);
      let names = await toolNames(client);
      assert.ok(names.includes('huaweicloud_setup_obs_config'));

      const disabled = await callJson(client, 'huaweicloud_packs_configure', { disable: ['obs'] });
      assert.equal(disabled.changed, true);
      names = await toolNames(client);
      assert.ok(!names.includes('huaweicloud_setup_obs_config'), 'disable removes the tool from the client list');

      const again = await callJson(client, 'huaweicloud_packs_configure', { enable: ['obs'] });
      assert.equal(again.changed, true);
      names = await toolNames(client);
      assert.ok(
        names.includes('huaweicloud_setup_obs_config'),
        're-registering the same tool name after removal must work',
      );
      const obsSkill = await callJson(client, 'huaweicloud_retrieve_skill', { name: 'huawei-obs' });
      assert.equal(obsSkill.ok, true, 'the skill gate follows the cycled override');
    }),
  ),
);

test('reset combined with enable or disable is refused', () =>
  withEnv('core', async () => {
    const refused = (await callTool(
      'huaweicloud_packs_configure',
      { reset: true, enable: ['obs'] },
      { onPacksChanged: noopSync },
    )) as ToolPayload;
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', /cannot be combined/);
    assert.equal(runtimePacksOverride(), null);
  })());

test('enabling an already-enabled pack is a noop', () =>
  withEnv('core,obs', async () => {
    const result = (await callTool(
      'huaweicloud_packs_configure',
      { enable: ['obs'] },
      { onPacksChanged: noopSync },
    )) as ToolPayload;
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(result.override, null, 'no override is stored when env already carries the pack');
  })());

test('a duplicated DEVKIT_PACKS id does not eat a real enable', () =>
  withEnv('core,core', async () => {
    const result = (await callTool(
      'huaweicloud_packs_configure',
      { enable: ['obs'] },
      { onPacksChanged: noopSync },
    )) as ToolPayload;
    assert.equal(result.ok, true);
    assert.equal(result.changed, true, 'enable must apply even when env requested ids repeat');
    assert.equal(result.override, 'core,obs');
    assert.ok(resolveEnabledPacks().has('obs'), 'obs must actually be enabled');
  })());

test('enabling closure-pulled core is a noop', () =>
  withEnv('obs', async () => {
    const result = (await callTool(
      'huaweicloud_packs_configure',
      { enable: ['core'] },
      { onPacksChanged: noopSync },
    )) as ToolPayload;
    assert.equal(result.ok, true);
    assert.equal(result.changed, false, 'core is already effectively enabled via the closure');
    assert.equal(result.override, null);
  })());

test('the same pack in enable and disable is refused', () =>
  withEnv('core', async () => {
    const refused = (await callTool(
      'huaweicloud_packs_configure',
      { enable: ['obs'], disable: ['obs'] },
      { onPacksChanged: noopSync },
    )) as ToolPayload;
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', /cannot be both enabled and disabled/);
    assert.equal(runtimePacksOverride(), null);
  })());

test('list_packs advertises the toggle only on session-carrying surfaces', () =>
  withEnv('core', async () => {
    const plain = (await callTool('huaweicloud_list_packs', {})) as ListPacksPayload;
    const coreEntry = plain.packs.find((pack) => pack.id === 'core');
    assert.ok(!coreEntry!.tools.includes('huaweicloud_packs_configure'), 'no opts means no session surface');

    const toggling = (await callTool('huaweicloud_list_packs', {}, { onPacksChanged: noopSync })) as ListPacksPayload;
    const togglingCore = toggling.packs.find((pack) => pack.id === 'core');
    assert.ok(
      togglingCore!.tools.includes('huaweicloud_packs_configure'),
      'the seam present means the toggle is registered',
    );
  })());
