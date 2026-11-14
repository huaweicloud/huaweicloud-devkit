// The e2e-style harness for the built-plugin MCP tests, extracted from
// plugins-e2e.test.ts: fake-home env, CLI runner, MCP sequence driver, and
// the tool-roster tables. Both suite parts import it, so the env seams and
// the spawned-server contract stay identical across them.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { npmCacheEnv } from './npm-cache.ts';

// Deterministic-tier seam: disable the once-per-session first-assertion
// vendor challenge (HUAWEICLOUD_VENDOR_CHALLENGE=off, the installer-override
// pattern) so cold-attested calls in this file dispatch without the
// challenge bounce. The challenge itself is pinned where it is the subject
// (tools.test.ts's gate test drives the dance; the selfcheck drives it on
// the wire); the real-model e2e tier never sets this seam.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const setupCli = join(root, 'bin', 'setup.cjs');

export function makeEnv(home: string, _cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL: '1',
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    // The update-warmup child (npm view) outlives the killed MCP server and
    // writes into the fake HOME's cold .npm — racing the test's rmSync
    // teardown into ENOTEMPTY flakes. The skip switch kills the warmup.
    HUAWEICLOUD_DEVKIT_SKIP_UPDATE: '1',
    ...npmCacheEnv(),
  };
  // cleanupNativeDirs() runs inside every install and reconciles EVERY
  // target's native dir (not just the installed one), each resolved from
  // its own ambient override — the full clear list applies. HUAWEICLOUD_HOME
  // additionally keys takeAgentDelta's pending-backup reads.
  for (const key of [
    'XDG_CONFIG_HOME',
    'CODEX_HOME',
    'HERMES_HOME',
    'DSH_HOME',
    'ATOMCODE_HOME',
    'OFFICE_CLAW_CONFIG_ROOT',
    'HUAWEICLOUD_HOME',
    'DEVKIT_PACKS',
  ]) {
    delete env[key];
  }
  return env;
}

export function runCli(home: string, cwd: string, args: string[]) {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd,
    env: makeEnv(home, cwd),
    encoding: 'utf8',
    timeout: 240000,
  });
}

export function countSkills(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown> };
}

interface JsonRpcResponse {
  id?: number | string | null;
  result: {
    serverInfo: { name: string };
    tools: McpTool[];
    content: Array<{ text?: string }>;
    isError: boolean;
  };
  error?: unknown;
}

// One MCP handshake harness: spawn the server over newline JSON-RPC, send
// initialize, then the caller's second request (tools/list or a tools/call),
// resolving with both responses.
export function invokeMcpSequence(
  mcpServerPath: string,
  env: NodeJS.ProcessEnv,
  secondRequest: { method: string; params: unknown },
  timeout = 15000,
): Promise<JsonRpcResponse[]> {
  return new Promise<JsonRpcResponse[]>((resolve, reject) => {
    const child = spawn(process.execPath, [mcpServerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      timeout,
    });
    let buffer = '';
    const responses: JsonRpcResponse[] = [];
    let seq = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP timeout'));
    }, timeout);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line) as JsonRpcResponse;
            if (msg.id !== undefined && msg.id !== null) {
              responses.push(msg);
              if (responses.length === 1) {
                child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...secondRequest, id: ++seq }) + '\n');
              } else if (responses.length === 2) {
                clearTimeout(timer);
                child.kill();
                resolve(responses);
              }
            }
          } catch {
            // skip a non-JSON stdout line; only the counted responses drive the handshake
          }
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

export const listTools = { method: 'tools/list', params: {} } as const;
export const callTool = (name: string, args: Record<string, unknown>) => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

// Core-pack tools that must always be present, including the pack meta tools
// (both registered in the core pack). Keep in sync with tool-definitions.ts
// TOOL_DEFINITIONS (re-exported by tools.ts) and packs/registry.ts. When a
// new tool is added to tool-definitions.ts, add it here or under its pack
// below.
