import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mockServerPath = join(__dirname, 'fixtures', 'mock-mcp-server.mjs');
const fakeHcloudPath = join(__dirname, 'fixtures', 'fake-hcloud-benchmark.mjs');

// ── Harbor-style benchmark harness ──

/**
 * Run a benchmark scenario against the Mock MCP Server.
 *
 * @param {object} scenario - Test scenario definition
 * @param {string} scenario.name - Scenario name
 * @param {string} scenario.description - What this scenario tests
 * @param {Array<{method: string, params?: object}>} scenario.calls - MCP calls to make
 * @param {Array<{tool: string, args?: object}>} scenario.expectedCalls - Tools that should appear in audit
 * @param {string[]} scenario.forbiddenCalls - Tools that must NOT appear in audit
 * @param {number} [scenario.maxCalls] - Max allowed tool calls
 * @param {object} [scenario.mockResponses] - Override mock responses for this scenario
 * @returns {Promise<object>} - { audit, responses, verdict }
 */
async function runScenario(scenario) {
  const workDir = mkdtempSync(join(tmpdir(), `harbor-${scenario.name}-`));
  const auditFile = join(workDir, 'audit.jsonl');

  try {
    // Start Mock MCP Server with scenario-specific responses
    const child = spawn(process.execPath, [mockServerPath, '--audit-file', auditFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HCLOUD_BIN: fakeHcloudPath, // inject fake hcloud for subprocess calls
      },
    });

    // Inject scenario responses as first stdin line (before MCP protocol)
    const scenarioHeader = JSON.stringify(scenario.mockResponses || {});
    const responses = [];
    let buffer = '';
    let callIdx = 0;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.stdin.end();
        child.kill('SIGKILL');
        reject(new Error('Mock MCP timeout'));
      }, 15000);

      let resolved = false;
      function finish() {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        clearTimeout(finishTimer);
        child.stdin.end();
        child.kill();
      }

      let finishTimer;

      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && msg.id !== null) {
              responses.push(msg);
              // Send next call if available
              callIdx++;
              if (callIdx < scenario.calls.length) {
                sendCall(scenario.calls[callIdx]);
              } else {
                // All calls sent — close stdin so child exits, then resolve
                finishTimer = setTimeout(() => {
                  finish();
                  resolve();
                }, 200);
              }
            }
          } catch {}
        }
      });

      child.stderr.on('data', () => {});
      child.on('error', (e) => {
        finish();
        reject(e);
      });
      child.on('exit', () => {
        if (!resolved) {
          finish();
          resolve();
        }
      });

      function sendCall(call) {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            method: call.method,
            params: call.params || {},
            id: callIdx + 1,
          }) + '\n',
        );
      }

      // Send scenario header + first call
      child.stdin.write(scenarioHeader + '\n');
      sendCall(scenario.calls[0]);
    });

    // Read audit log
    const audit = [];
    if (existsSync(auditFile)) {
      const content = readFileSync(auditFile, 'utf8');
      for (const line of content.split('\n')) {
        if (line.trim()) {
          try {
            audit.push(JSON.parse(line));
          } catch {}
        }
      }
    }

    // Verify: check expected calls
    const auditTools = new Set(audit.map((a) => a.tool));
    const expectedMatches = [];
    for (const expected of scenario.expectedCalls) {
      const found = audit.some((a) => {
        if (a.tool !== expected.tool) return false;
        if (!expected.args) return true;
        // Check that all expected args are present in the actual call
        for (const [key, value] of Object.entries(expected.args)) {
          if (JSON.stringify(a.input?.[key]) !== JSON.stringify(value)) return false;
        }
        return true;
      });
      expectedMatches.push({ expected: expected.tool, found });
    }

    // Verify: check forbidden calls
    const forbiddenViolations = scenario.forbiddenCalls
      ? scenario.forbiddenCalls.filter((tool) => auditTools.has(tool))
      : [];

    // Verify: check max calls
    const maxCallsViolation = scenario.maxCalls && audit.length > scenario.maxCalls;

    const verdict = {
      passed: expectedMatches.every((m) => m.found) && forbiddenViolations.length === 0 && !maxCallsViolation,
      audit,
      responses,
      expectedMatches,
      forbiddenViolations,
      maxCallsViolation,
      totalCalls: audit.length,
    };

    return verdict;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ── Benchmark Scenarios ──

test('scenario: list ECS servers — progressive workflow (plan → execute)', async () => {
  const verdict = await runScenario({
    name: 'list-ecs',
    description: 'Agent should plan the CLI command first, then execute read-only',
    calls: [
      {
        method: 'tools/call',
        params: { name: 'huaweicloud_plan_cli_command', arguments: { args: ['ECS', 'ListServersDetails'] } },
      },
      {
        method: 'tools/call',
        params: {
          name: 'huaweicloud_run_readonly_command',
          arguments: { args: ['ECS', 'ListServersDetails', '--cli-region=cn-north-4'] },
        },
      },
    ],
    expectedCalls: [
      { tool: 'huaweicloud_plan_cli_command', args: { args: ['ECS', 'ListServersDetails'] } },
      { tool: 'huaweicloud_run_readonly_command' },
    ],
    forbiddenCalls: ['huaweicloud_run_approved_command'],
    maxCalls: 5,
  });

  assert.ok(verdict.passed, `Scenario failed: expected calls not matched`);
  assert.equal(verdict.totalCalls, 2);
  assert.equal(verdict.forbiddenViolations.length, 0);
});

test('scenario: search skills — retrieval capability', async () => {
  const verdict = await runScenario({
    name: 'search-skills',
    description: 'Agent should search for ECS-related skills',
    calls: [
      {
        method: 'tools/call',
        params: { name: 'huaweicloud_search_docs', arguments: { query: 'ECS' } },
      },
    ],
    expectedCalls: [{ tool: 'huaweicloud_search_docs', args: { query: 'ECS' } }],
    forbiddenCalls: ['huaweicloud_run_approved_command', 'huaweicloud_run_readonly_command'],
    maxCalls: 3,
  });

  assert.ok(verdict.passed);
  assert.equal(verdict.totalCalls, 1);
  // Verify response contains ECS results
  const responseText = verdict.responses[0]?.result?.content?.[0]?.text || '';
  const parsed = JSON.parse(responseText);
  assert.ok(parsed.results?.length > 0, 'search should return results');
});

test('scenario: service catalog — deployment intent routing', async () => {
  const verdict = await runScenario({
    name: 'service-catalog',
    description: 'Agent should query service catalog for deployment intent',
    calls: [
      {
        method: 'tools/call',
        params: { name: 'huaweicloud_service_catalog', arguments: { intent: 'deploy a static website' } },
      },
    ],
    expectedCalls: [{ tool: 'huaweicloud_service_catalog' }],
    forbiddenCalls: ['huaweicloud_run_approved_command'],
    maxCalls: 3,
  });

  assert.ok(verdict.passed);
  const responseText = verdict.responses[0]?.result?.content?.[0]?.text || '';
  const parsed = JSON.parse(responseText);
  assert.ok(parsed.recommendedSkills?.includes('huawei-sandbox'), 'should recommend sandbox');
});

test('scenario: safety hook — dangerous command must be denied', async () => {
  const verdict = await runScenario({
    name: 'safety-deny',
    description: 'Agent should check command risk before executing; dangerous commands must be denied',
    calls: [
      {
        method: 'tools/call',
        params: {
          name: 'huaweicloud_hook_check_command',
          arguments: {
            command:
              'hcloud VPC CreateSecurityGroupRule --security_group_rule.port_range_min=22 --security_group_rule.remote_ip_prefix=0.0.0.0/0',
          },
        },
      },
    ],
    expectedCalls: [{ tool: 'huaweicloud_hook_check_command' }],
    forbiddenCalls: ['huaweicloud_run_approved_command', 'huaweicloud_run_readonly_command'],
    maxCalls: 2,
  });

  assert.ok(verdict.passed);
  const responseText = verdict.responses[0]?.result?.content?.[0]?.text || '';
  const parsed = JSON.parse(responseText);
  assert.equal(parsed.decision, 'deny', 'public SSH port must be denied');
  assert.equal(parsed.ok, false);
});

test('scenario: deploy plan check — sandbox without TTL should warn', async () => {
  const verdict = await runScenario({
    name: 'deploy-plan-warn',
    description: 'Deploy plan without cleanup metadata should trigger a warning',
    calls: [
      {
        method: 'tools/call',
        params: {
          name: 'huaweicloud_hook_check_deploy_plan',
          arguments: {
            plan: {
              environment: 'preview',
              resources: [{ service: 'FunctionGraph', action: 'CreateFunction' }],
            },
          },
        },
      },
    ],
    expectedCalls: [{ tool: 'huaweicloud_hook_check_deploy_plan' }],
    forbiddenCalls: ['huaweicloud_run_approved_command'],
    maxCalls: 2,
  });

  assert.ok(verdict.passed);
  const responseText = verdict.responses[0]?.result?.content?.[0]?.text || '';
  const parsed = JSON.parse(responseText);
  assert.equal(parsed.decision, 'warn', 'sandbox without TTL should warn, not deny');
  assert.equal(parsed.ok, true);
});

test('scenario: full workflow — search → plan → execute → verify safety', async () => {
  const verdict = await runScenario({
    name: 'full-workflow',
    description: 'Complete agent workflow: search docs → plan CLI → execute read-only → check safety',
    calls: [
      {
        method: 'tools/call',
        params: { name: 'huaweicloud_search_docs', arguments: { query: 'ECS' } },
      },
      {
        method: 'tools/call',
        params: { name: 'huaweicloud_plan_cli_command', arguments: { args: ['ECS', 'ListServersDetails'] } },
      },
      {
        method: 'tools/call',
        params: {
          name: 'huaweicloud_run_readonly_command',
          arguments: { args: ['ECS', 'ListServersDetails', '--cli-region=cn-north-4'] },
        },
      },
      {
        method: 'tools/call',
        params: {
          name: 'huaweicloud_hook_check_command',
          arguments: { command: 'hcloud ECS ListServersDetails --cli-region=cn-north-4' },
        },
      },
    ],
    expectedCalls: [
      { tool: 'huaweicloud_search_docs' },
      { tool: 'huaweicloud_plan_cli_command' },
      { tool: 'huaweicloud_run_readonly_command' },
      { tool: 'huaweicloud_hook_check_command' },
    ],
    forbiddenCalls: ['huaweicloud_run_approved_command'],
    maxCalls: 6,
  });

  assert.ok(verdict.passed, `Full workflow failed: ${JSON.stringify(verdict.expectedMatches)}`);
  assert.equal(verdict.totalCalls, 4);
  assert.equal(verdict.forbiddenViolations.length, 0);
});

test('scenario: forbidden tool call — write operation without approval', async () => {
  const verdict = await runScenario({
    name: 'forbidden-write',
    description: 'Agent must not call run_approved_command without explicit approval token',
    calls: [
      {
        method: 'tools/call',
        params: { name: 'huaweicloud_run_approved_command', arguments: { args: ['ECS', 'CreateServers'] } },
      },
    ],
    expectedCalls: [],
    forbiddenCalls: ['huaweicloud_run_approved_command'],
    maxCalls: 1,
  });

  // The forbidden call WAS made (we sent it), so the verifier should catch it
  assert.equal(verdict.forbiddenViolations.length, 1, 'forbidden call should be detected');
  assert.equal(verdict.passed, false, 'scenario with forbidden call should fail');
});

test('scenario: initialize and tools/list — MCP protocol handshake', async () => {
  const verdict = await runScenario({
    name: 'handshake',
    description: 'MCP server must respond to initialize and tools/list',
    calls: [
      {
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'harbor-test', version: '1.0' },
        },
      },
      { method: 'tools/list', params: {} },
    ],
    expectedCalls: [],
    forbiddenCalls: [],
    maxCalls: 0,
  });

  // initialize response
  const initResp = verdict.responses[0];
  assert.ok(initResp?.result, 'initialize should return result');
  assert.equal(initResp.result.serverInfo.name, 'huaweicloud-devkit-mock');

  // tools/list response
  const listResp = verdict.responses[1];
  assert.ok(listResp?.result?.tools?.length > 0, 'tools/list should return tools');
  assert.ok(
    listResp.result.tools.every((t) => t.name.startsWith('huaweicloud_')),
    'all tools should have huaweicloud_ prefix',
  );
});
