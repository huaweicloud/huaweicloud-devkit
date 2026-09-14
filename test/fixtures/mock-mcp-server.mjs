#!/usr/bin/env node
'use strict';

/**
 * Mock MCP Server — Harbor-style benchmark fixture for huaweicloud-devkit.
 *
 * Implements a minimal MCP stdio server that:
 * 1. Responds to initialize / tools/list / tools/call JSON-RPC methods
 * 2. Returns predefined responses per tool (scenarios define these)
 * 3. Writes every tools/call to an audit NDJSON file (verifier reads this)
 * 4. Simulates subprocess execution (fake hcloud) for CLI tools
 *
 * Protocol: newline-delimited JSON (same as devkit's real MCP server).
 *
 * Usage:
 *   node test/fixtures/mock-mcp-server.mjs --audit-file /tmp/hwc_audit.jsonl
 *
 * The server reads scenario responses from stdin as a JSON object on the
 * first line before MCP protocol begins (injected by the test harness).
 * If no scenario is injected, default mock responses are used.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse CLI args
let auditFile = '/tmp/hwc_audit.jsonl';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--audit-file' && args[i + 1]) auditFile = args[i + 1];
}

// Ensure audit directory exists
if (existsSync(dirname(auditFile))) {
  // ok
} else {
  try {
    mkdirSync(dirname(auditFile), { recursive: true });
  } catch {}
}

// Default mock responses (used when no scenario is injected)
const DEFAULT_RESPONSES = {
  huaweicloud_search_docs: {
    results: [
      { name: 'huawei-ecs', source: 'SKILL.md', score: 0.95, snippet: 'ECS instance management' },
      { name: 'huawei-obs', source: 'SKILL.md', score: 0.8, snippet: 'Object storage' },
    ],
  },
  huaweicloud_service_catalog: {
    recommendedSkills: ['huawei-sandbox', 'huawei-obs', 'huawei-ecs'],
    capabilitySources: ['sandbox', 'obs', 'ecs'],
  },
  huaweicloud_plan_cli_command: {
    command: 'hcloud ECS ListServersDetails --cli-region=cn-north-4',
    isWrite: false,
    classification: 'readonly',
  },
  huaweicloud_run_readonly_command: {
    exitCode: 0,
    stdout: '{"servers":[{"name":"ecs-01","status":"ACTIVE","id":"1d4e1234"}],"count":1}',
    stderr: '',
    retryCount: 0,
  },
  huaweicloud_run_approved_command: {
    exitCode: 0,
    stdout: '{"server":{"id":"new-ecs-id","status":"BUILD"}}',
    stderr: '',
    retryCount: 0,
  },
  huaweicloud_hook_check_command: {
    decision: 'deny',
    ok: false,
    findings: [{ ruleId: 'hwc-network-public-admin-port', severity: 'critical' }],
  },
  huaweicloud_hook_check_deploy_plan: {
    decision: 'warn',
    ok: true,
    findings: [{ ruleId: 'hwc-sandbox-missing-ttl', severity: 'medium' }],
  },
  huaweicloud_list_regions: {
    regions: [
      { id: 'cn-north-4', name: '华北-北京四' },
      { id: 'cn-east-3', name: '华东-上海一' },
    ],
  },
};

// Read scenario from first stdin line (before MCP protocol)
let scenarioResponses = {};
let scenarioLoaded = false;
let buffer = '';

function writeJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function writeAudit(toolName, args, result, ok) {
  const entry = {
    ts: new Date().toISOString(),
    tool: toolName,
    input: args,
    ok,
  };
  try {
    appendFileSync(auditFile, JSON.stringify(entry) + '\n');
  } catch {}
}

function getResponse(toolName, args) {
  // Check scenario-specific responses first, then defaults
  const scenario = scenarioResponses[toolName];
  if (scenario) {
    if (typeof scenario === 'function') return scenario(args);
    return scenario;
  }
  const def = DEFAULT_RESPONSES[toolName];
  if (def) return def;
  // Unknown tool — return a generic mock
  return { ok: true, mocked: true, tool: toolName };
}

function handleMethod(method, params) {
  if (method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'huaweicloud-devkit-mock', version: '1.0.0-benchmark' },
      capabilities: { tools: {} },
    };
  }

  if (method === 'tools/list') {
    return {
      tools: [
        {
          name: 'huaweicloud_search_docs',
          description: 'Search skill docs',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        },
        {
          name: 'huaweicloud_service_catalog',
          description: 'Get service catalog',
          inputSchema: { type: 'object', properties: { intent: { type: 'string' } } },
        },
        {
          name: 'huaweicloud_plan_cli_command',
          description: 'Plan CLI command',
          inputSchema: { type: 'object', properties: { args: { type: 'array' } } },
        },
        {
          name: 'huaweicloud_run_readonly_command',
          description: 'Run read-only command',
          inputSchema: { type: 'object', properties: { args: { type: 'array' } } },
        },
        {
          name: 'huaweicloud_run_approved_command',
          description: 'Run approved command',
          inputSchema: { type: 'object', properties: { args: { type: 'array' } } },
        },
        {
          name: 'huaweicloud_hook_check_command',
          description: 'Check command risk',
          inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
        },
        {
          name: 'huaweicloud_hook_check_deploy_plan',
          description: 'Check deploy plan',
          inputSchema: { type: 'object', properties: { plan: { type: 'object' } } },
        },
        { name: 'huaweicloud_list_regions', description: 'List regions', inputSchema: { type: 'object' } },
      ],
    };
  }

  if (method === 'tools/call') {
    const toolName = params.name;
    const toolArgs = params.arguments || {};
    const result = getResponse(toolName, toolArgs);
    writeAudit(toolName, toolArgs, result, true);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: false,
    };
  }

  throw new Error(`Unknown method: ${method}`);
}

// Process stdin
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;

    // First non-empty line: try to load scenario (if not yet loaded)
    if (!scenarioLoaded) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && !parsed.jsonrpc) {
          scenarioResponses = parsed;
          scenarioLoaded = true;
          continue;
        }
      } catch {}
      scenarioLoaded = true;
    }

    try {
      const msg = JSON.parse(line);
      if (msg.method) {
        try {
          const result = handleMethod(msg.method, msg.params || {});
          writeJson({ jsonrpc: '2.0', id: msg.id, result });
        } catch (error) {
          writeJson({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: error.message },
          });
        }
      }
    } catch {}
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
