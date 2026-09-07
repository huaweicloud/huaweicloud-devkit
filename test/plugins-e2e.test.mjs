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
                child.stdin.write(JSON.stringify({
                  jsonrpc: '2.0', method: 'tools/list', params: {}, id: ++seq,
                }) + '\n');
              } else if (responses.length === 2) {
                child.kill();
                resolve(responses);
              }
            }
          } catch {}
        }
      }
    });

    child.stderr.on('data', () => {});
    child.on('error', reject);
    setTimeout(() => { child.kill(); reject(new Error('MCP timeout')); }, timeout);

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-test', version: '1.0' } },
      id: ++seq,
    }) + '\n');
  });
}

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
      assert.ok(existsSync(join(pluginDir, 'src', 'mcp-server.mjs')), `${target.name}: mcp-server.mjs installed`);
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

      const mcpServerPath = join(target.pluginsDir(home), 'src', 'mcp-server.mjs');
      assert.ok(existsSync(mcpServerPath), `${target.name}: MCP server file exists`);

      const responses = await invokeMcpTools(mcpServerPath, makeEnv(home, cwd));

      assert.ok(responses[0].result, `${target.name}: initialize returned result`);
      assert.equal(responses[0].result.serverInfo.name, 'huaweicloud-devkit', `${target.name}: server name correct`);

      assert.ok(responses[1].result, `${target.name}: tools/list returned result`);
      const tools = responses[1].result.tools;
      assert.ok(tools.length > 0, `${target.name}: tools array not empty`);
      assert.ok(tools.every((t) => t.name.startsWith('huaweicloud_')), `${target.name}: all tools have huaweicloud_ prefix`);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
