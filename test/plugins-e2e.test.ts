import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';

import { countSkills, invokeMcpSequence, listTools, makeEnv, runCli } from './plugins-e2e-harness.ts';
import { assertTrimmedToolsList, PER_PACK_TOOLS, REQUIRED_TOOLS, targets } from './plugins-e2e-roster.ts';

test('MCP tools/list includes all required core tools with valid schemas', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-tools-schema-'));
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-tools-schema-proj-'));
  try {
    const install = runCli(home, cwd, ['install', '--target', 'opencode']);
    assert.equal(install.status, 0, install.stderr);

    const mcpServerPath = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js');
    const responses = await invokeMcpSequence(mcpServerPath, makeEnv(home, cwd), listTools);
    const tools = responses[1].result.tools;
    const toolNames = tools.map((t) => t.name);

    // Verify all required tools are present (aligned with tools.test.mjs)
    for (const required of REQUIRED_TOOLS) {
      assert.ok(toolNames.includes(required), `Missing tool: ${required}`);
    }
    // Plus every optional-pack tool: tools/list must carry the full 55
    // (the P2 packs' 53, +1 for the async-exec claim protocol's
    // huaweicloud_sandbox_exec_poll, +1 for the port-pr6 shutdown).
    const perPackNames = Object.values(PER_PACK_TOOLS).flat();
    for (const name of perPackNames) {
      assert.ok(toolNames.includes(name), `Missing tool: ${name}`);
    }
    assert.equal(
      REQUIRED_TOOLS.length + perPackNames.length,
      55,
      'always-on + per-pack lists must cover the full registry',
    );
    assert.ok(toolNames.length >= 25, `Expected >= 25 tools, got ${toolNames.length}`);

    // Verify every tool has valid schema fields
    for (const tool of tools) {
      assert.ok(tool.name, `tool must have name`);
      assert.ok(tool.description, `${tool.name} must have description`);
      assert.ok(tool.inputSchema, `${tool.name} must have inputSchema`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} inputSchema.type must be object`);
    }

    // Verify run tools expose cwd parameter (aligned with tools.test.mjs)
    const readonlyTool = tools.find((t) => t.name === 'huaweicloud_run_readonly_command');
    assert.ok(Object.hasOwn(readonlyTool!.inputSchema.properties, 'cwd'), 'run_readonly_command should have cwd param');

    const approvedTool = tools.find((t) => t.name === 'huaweicloud_run_approved_command');
    assert.ok(Object.hasOwn(approvedTool!.inputSchema.properties, 'cwd'), 'run_approved_command should have cwd param');

    // Verify proactive hook check tools are present (aligned with tools.test.mjs)
    const nameSet = new Set(toolNames);
    assert.ok(nameSet.has('huaweicloud_hook_check_command'));
    assert.ok(nameSet.has('huaweicloud_hook_check_artifacts'));
    assert.ok(nameSet.has('huaweicloud_hook_check_deploy_plan'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Shared trim-scenario driver: install, spawn with DEVKIT_PACKS=<pack>, then
// assert the trimmed tool count and the membership semantics (core survives,
// the opted-in pack registers fully, every other pack is absent). Extracted
// because the sandbox and open-mcp scenarios are token-identical otherwise.

test('DEVKIT_PACKS=sandbox trims tools/list to core 12 + sandbox 17', async () => {
  await assertTrimmedToolsList('sandbox', 29, 'core 12 + sandbox 17');
});

test('DEVKIT_PACKS=huaweicloud-open-mcp trims tools/list to core 12 + gateway 3', async () => {
  await assertTrimmedToolsList('huaweicloud-open-mcp', 15, 'core 12 + gateway 3');
});

for (const target of targets) {
  test(`${target.name}: install copies skills, MCP server, and safety policy`, () => {
    const home = mkdtempSync(join(tmpdir(), `${target.name}-home-`));
    const cwd = mkdtempSync(join(tmpdir(), `${target.name}-proj-`));
    try {
      const res = runCli(home, cwd, ['install', '--target', target.name]);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, target.banner);
      assert.match(res.stdout, /Installation complete!/);

      const pluginDir = target.pluginsDir(home);
      assert.ok(existsSync(join(pluginDir, 'dist', 'mcp-server.js')), `${target.name}: mcp-server.js installed`);
      assert.ok(existsSync(join(pluginDir, 'safety', 'policy.json')), `${target.name}: safety policy installed`);
      assert.ok(
        existsSync(join(pluginDir, 'rules', 'huawei-agent-rules.mdc')),
        `${target.name}: agent rules installed`,
      );
      assert.ok(existsSync(join(pluginDir, '.installed')), `${target.name}: .installed marker present`);
      assert.ok(countSkills(target.skillsDir(home)) >= 6, `${target.name}: expected >= 6 skills`);
      assert.ok(target.hasServer(target.configPath(home)), `${target.name}: MCP server registered`);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test(`${target.name}: uninstall removes skills, plugins, and MCP config`, () => {
    const home = mkdtempSync(join(tmpdir(), `${target.name}-home-`));
    const cwd = mkdtempSync(join(tmpdir(), `${target.name}-proj-`));
    try {
      const install = runCli(home, cwd, ['install', '--target', target.name]);
      assert.equal(install.status, 0, install.stderr);

      const res = runCli(home, cwd, ['uninstall', '--target', target.name]);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Uninstall complete\./);

      assert.equal(countSkills(target.skillsDir(home)), 0, `${target.name}: skills removed`);
      assert.ok(!existsSync(target.pluginsDir(home)), `${target.name}: plugins dir removed`);
      assert.ok(!target.hasServer(target.configPath(home)), `${target.name}: MCP config cleaned`);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test(`${target.name}: MCP server responds to initialize and tools/list`, async () => {
    const home = mkdtempSync(join(tmpdir(), `${target.name}-mcp-`));
    const cwd = mkdtempSync(join(tmpdir(), `${target.name}-mcp-proj-`));
    try {
      const install = runCli(home, cwd, ['install', '--target', target.name]);
      assert.equal(install.status, 0, install.stderr);

      const mcpServerPath = join(target.pluginsDir(home), 'dist', 'mcp-server.js');
      assert.ok(existsSync(mcpServerPath), `${target.name}: MCP server file exists`);

      const responses = await invokeMcpSequence(mcpServerPath, makeEnv(home, cwd), listTools);

      assert.ok(responses[0].result, `${target.name}: initialize returned result`);
      assert.equal(responses[0].result.serverInfo.name, 'huaweicloud-devkit', `${target.name}: server name correct`);

      assert.ok(responses[1].result, `${target.name}: tools/list returned result`);
      const tools = responses[1].result.tools;
      assert.ok(tools.length > 0, `${target.name}: tools array not empty`);
      assert.ok(
        tools.every((t) => t.name.startsWith('huaweicloud_')),
        `${target.name}: all tools have huaweicloud_ prefix`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
