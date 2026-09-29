import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');

function makeEnv(home, _cwd) {
  return {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
  };
}

function runCli(home, cwd, args) {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd,
    env: makeEnv(home, cwd),
    encoding: 'utf8',
    timeout: 60000,
  });
}

function countSkills(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
}

function invokeMcpTools(mcpServerPath, env, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpServerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      timeout,
    });
    let buffer = '';
    const responses = [];
    let seq = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP timeout'));
    }, timeout);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && msg.id !== null) {
              responses.push(msg);
              if (responses.length === 1) {
                child.stdin.write(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'tools/list',
                    params: {},
                    id: ++seq,
                  }) + '\n',
                );
              } else if (responses.length === 2) {
                clearTimeout(timer);
                child.kill();
                resolve(responses);
              }
            }
          } catch {}
        }
      }
    });

    child.stderr.on('data', () => {});
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-test', version: '1.0' } },
        id: ++seq,
      }) + '\n',
    );
  });
}

function invokeMcpToolCall(mcpServerPath, env, toolName, toolArgs, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpServerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      timeout,
    });
    let buffer = '';
    const responses = [];
    let seq = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP timeout'));
    }, timeout);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && msg.id !== null) {
              responses.push(msg);
              if (responses.length === 1) {
                child.stdin.write(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'tools/call',
                    params: { name: toolName, arguments: toolArgs },
                    id: ++seq,
                  }) + '\n',
                );
              } else if (responses.length === 2) {
                clearTimeout(timer);
                child.kill();
                resolve(responses);
              }
            }
          } catch {}
        }
      }
    });

    child.stderr.on('data', () => {});
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-test', version: '1.0' } },
        id: ++seq,
      }) + '\n',
    );
  });
}

// Core tools that must always be present. Keep in sync with tools.ts TOOL_DEFINITIONS.
// When a new tool is added to tools.ts, add it here too.
const REQUIRED_TOOLS = [
  'huaweicloud_check_cli',
  'huaweicloud_plan_cli_command',
  'huaweicloud_run_readonly_command',
  'huaweicloud_list_operations',
  'huaweicloud_run_approved_command',
  'huaweicloud_show_profile_redacted',
  'huaweicloud_service_catalog',
  'huaweicloud_explain_error',
  'huaweicloud_search_docs',
  'huaweicloud_retrieve_skill',
  'huaweicloud_list_regions',
  'huaweicloud_get_regional_availability',
  'huaweicloud_search_marketplace',
  'huaweicloud_setup_obs_config',
  'huaweicloud_auth_status',
  'huaweicloud_auth_sync',
  'huaweicloud_sandbox_exec_with_session',
  'huaweicloud_sandbox_upload_file',
  'huaweicloud_sandbox_close_session',
  'huaweicloud_sandbox_check_user',
  'huaweicloud_sandbox_sign_agreement',
  'huaweicloud_sandbox_connect',
  'huaweicloud_sandbox_credentials',
  'huaweicloud_voucher_status',
  'huaweicloud_voucher_claim',
];

const targets = [
  {
    name: 'opencode',
    banner: /\[OpenCode\]/,
    pluginsDir: (h) => join(h, '.config', 'opencode', 'huaweicloud-plugins'),
    skillsDir: (h) => join(h, '.config', 'opencode', 'skills'),
    configPath: (h) => join(h, '.config', 'opencode', 'opencode.json'),
    hasServer: (p) => {
      if (!existsSync(p)) return false;
      try {
        return Boolean(JSON.parse(readFileSync(p, 'utf8')).mcp?.['huaweicloud-devkit']);
      } catch {
        return false;
      }
    },
  },
  {
    name: 'codex-desktop',
    banner: /\[Codex Desktop\]/,
    pluginsDir: (h) => join(h, 'plugins', 'huaweicloud-devkit'),
    skillsDir: (h) => join(h, 'plugins', 'huaweicloud-devkit', 'skills'),
    configPath: (h) => join(h, '.agents', 'plugins', 'marketplace.json'),
    hasServer: (p) => {
      if (!existsSync(p)) return false;
      try {
        const mp = JSON.parse(readFileSync(p, 'utf8'));
        return mp.plugins && mp.plugins.some((e) => e.name === 'huaweicloud-devkit');
      } catch {
        return false;
      }
    },
  },
  {
    name: 'workbuddy',
    banner: /\[WorkBuddy\]/,
    pluginsDir: (h) => join(h, '.workbuddy', 'huaweicloud-plugins'),
    skillsDir: (h) => join(h, '.workbuddy', 'skills'),
    configPath: (h) => join(h, '.workbuddy', 'mcp.json'),
    hasServer: (p) => {
      if (!existsSync(p)) return false;
      try {
        return Boolean(JSON.parse(readFileSync(p, 'utf8')).mcpServers?.['huaweicloud-devkit']);
      } catch {
        return false;
      }
    },
  },
];

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

      const responses = await invokeMcpTools(mcpServerPath, makeEnv(home, cwd));

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

test('MCP tools/list includes all required core tools with valid schemas', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-tools-schema-'));
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-tools-schema-proj-'));
  try {
    const install = runCli(home, cwd, ['install', '--target', 'opencode']);
    assert.equal(install.status, 0, install.stderr);

    const mcpServerPath = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js');
    const responses = await invokeMcpTools(mcpServerPath, makeEnv(home, cwd));
    const tools = responses[1].result.tools;
    const toolNames = tools.map((t) => t.name);

    // Verify all required tools are present (aligned with tools.test.mjs)
    for (const required of REQUIRED_TOOLS) {
      assert.ok(toolNames.includes(required), `Missing tool: ${required}`);
    }
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
    assert.ok(Object.hasOwn(readonlyTool.inputSchema.properties, 'cwd'), 'run_readonly_command should have cwd param');

    const approvedTool = tools.find((t) => t.name === 'huaweicloud_run_approved_command');
    assert.ok(Object.hasOwn(approvedTool.inputSchema.properties, 'cwd'), 'run_approved_command should have cwd param');

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

test('huaweicloud_search_docs returns relevant skill results', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-search-'));
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-search-proj-'));
  try {
    const install = runCli(home, cwd, ['install', '--target', 'opencode']);
    assert.equal(install.status, 0, install.stderr);

    const mcpServerPath = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js');

    // Search for ECS skills — should return results containing ECS-related content
    const responses = await invokeMcpToolCall(mcpServerPath, makeEnv(home, cwd), 'huaweicloud_search_docs', {
      query: 'ECS',
    });

    assert.ok(responses[0].result, 'initialize returned result');
    assert.ok(responses[1].result, 'tools/call returned result');
    assert.ok(!responses[1].error, `tools/call should not error: ${JSON.stringify(responses[1].error)}`);

    const content = responses[1].result.content;
    assert.ok(Array.isArray(content), 'content should be an array');
    assert.ok(content.length > 0, 'content array should not be empty');

    const text = content.map((c) => c.text || '').join('');
    assert.ok(text.length > 0, 'search results text should not be empty');

    // Verify response is valid JSON with results (relaxed: check structure, not specific skill text)
    const parsed = JSON.parse(text);
    assert.ok(parsed, 'search response should be valid JSON');
    // Query echo: the response should reflect what was searched
    if (parsed.query !== undefined) {
      assert.match(String(parsed.query), /ECS/i, 'response should echo the query');
    }
    // Results count: should have at least one result
    const resultCount = parsed.results?.length ?? parsed.length ?? (Array.isArray(parsed) ? parsed.length : 0);
    assert.ok(resultCount > 0, `search for ECS should return > 0 results, got ${resultCount}`);

    // Search for OBS — verify different query also returns results
    const obsResponses = await invokeMcpToolCall(mcpServerPath, makeEnv(home, cwd), 'huaweicloud_search_docs', {
      query: 'OBS',
    });
    assert.ok(!obsResponses[1].error, `OBS search should not error: ${JSON.stringify(obsResponses[1].error)}`);
    const obsText = obsResponses[1].result.content.map((c) => c.text || '').join('');
    const obsParsed = JSON.parse(obsText);
    const obsCount = obsParsed.results?.length ?? obsParsed.length ?? (Array.isArray(obsParsed) ? obsParsed.length : 0);
    assert.ok(obsCount > 0, `search for OBS should return > 0 results, got ${obsCount}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('huaweicloud_service_catalog returns capability recommendations', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-catalog-'));
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-catalog-proj-'));
  try {
    const install = runCli(home, cwd, ['install', '--target', 'opencode']);
    assert.equal(install.status, 0, install.stderr);

    const mcpServerPath = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js');

    // Verify English intent: deploy a static website recommends sandbox first
    const enResponses = await invokeMcpToolCall(mcpServerPath, makeEnv(home, cwd), 'huaweicloud_service_catalog', {
      intent: 'deploy a static website',
    });
    assert.ok(!enResponses[1].error, `English intent should not error: ${JSON.stringify(enResponses[1].error)}`);
    const enText = enResponses[1].result.content.map((c) => c.text || '').join('');
    const enResult = JSON.parse(enText);
    assert.ok(enResult.recommendedSkills, 'result should have recommendedSkills');
    assert.ok(
      enResult.recommendedSkills.includes('huawei-sandbox'),
      'static website deployment should recommend sandbox',
    );
    assert.ok(
      enResult.recommendedSkills.includes('huawei-obs'),
      'static website deployment should include OBS as an option',
    );

    // Verify Chinese intent: 部署静态网站到华为云
    const zhResponses = await invokeMcpToolCall(mcpServerPath, makeEnv(home, cwd), 'huaweicloud_service_catalog', {
      intent: '部署静态网站到华为云',
    });
    assert.ok(!zhResponses[1].error, `Chinese intent should not error: ${JSON.stringify(zhResponses[1].error)}`);
    const zhText = zhResponses[1].result.content.map((c) => c.text || '').join('');
    const zhResult = JSON.parse(zhText);
    assert.ok(
      zhResult.recommendedSkills.includes('huawei-sandbox'),
      'Chinese static website intent should also recommend sandbox',
    );

    // Verify storage routing for pure storage intent (aligned with tools.test.mjs)
    const storageResponses = await invokeMcpToolCall(mcpServerPath, makeEnv(home, cwd), 'huaweicloud_service_catalog', {
      intent: 'store files in an obs bucket',
    });
    assert.ok(
      !storageResponses[1].error,
      `Storage intent should not error: ${JSON.stringify(storageResponses[1].error)}`,
    );
    const storageText = storageResponses[1].result.content.map((c) => c.text || '').join('');
    const storageResult = JSON.parse(storageText);
    assert.ok(storageResult.recommendedSkills.includes('huawei-obs'), 'storage intent should include OBS');
    assert.notEqual(
      storageResult.recommendedSkills[0],
      'huawei-sandbox',
      'storage intent should not recommend sandbox first',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('MCP tools/call with unknown tool name returns error', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-error-'));
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-error-proj-'));
  try {
    const install = runCli(home, cwd, ['install', '--target', 'opencode']);
    assert.equal(install.status, 0, install.stderr);

    const mcpServerPath = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js');
    const responses = await invokeMcpToolCall(mcpServerPath, makeEnv(home, cwd), 'huaweicloud_nonexistent_tool', {});

    assert.ok(responses[0].result, 'initialize returned result');
    // Unknown tool should return JSON-RPC error (code -32603), not crash the server
    assert.ok(responses[1].error, 'unknown tool name should return JSON-RPC error');
    assert.match(responses[1].error.message, /Unknown tool/i, 'error message should mention "Unknown tool"');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
