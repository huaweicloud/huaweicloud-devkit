import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SANDBOX_TOOLS,
  SANDBOX_TIMEOUT_MS,
  type SandboxToolName,
} from '../plugins/huaweicloud-core/src/packs/sandbox/tools.ts';

// The schema text is the interface agents see on tools/list: it must
// document the default the handler actually applies, and it must not
// promise fallback behavior the implementation removed.
const TIMEOUT_TOOLS: Array<[SandboxToolName, number]> = [
  ['huaweicloud_sandbox_exec_with_session', SANDBOX_TIMEOUT_MS.exec_with_session],
  ['huaweicloud_sandbox_exec_one_shot', SANDBOX_TIMEOUT_MS.exec_one_shot],
  ['huaweicloud_sandbox_upload_file', SANDBOX_TIMEOUT_MS.upload_file],
  ['huaweicloud_sandbox_upload_project', SANDBOX_TIMEOUT_MS.upload_project],
  ['huaweicloud_sandbox_deploy_nginx', SANDBOX_TIMEOUT_MS.deploy_nginx],
  ['huaweicloud_sandbox_deploy_check', SANDBOX_TIMEOUT_MS.deploy_check],
  ['huaweicloud_sandbox_expose_tunnel', SANDBOX_TIMEOUT_MS.expose_tunnel],
];

test('sandbox schema text documents the handler timeout defaults', () => {
  const byName = new Map(SANDBOX_TOOLS.map((tool) => [tool.name, tool]));
  for (const [name, expected] of TIMEOUT_TOOLS) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} missing from SANDBOX_TOOLS`);
    const described = (tool.schema as { shape: { timeout_ms?: { description?: string } } }).shape.timeout_ms;
    assert.ok(described, `${name} schema has no timeout_ms field`);
    assert.match(
      described.description ?? '',
      new RegExp(`default: ${expected}\\)$`),
      `${name} schema text must document the applied default`,
    );
  }
});

test('sandbox tool descriptions drop the removed base64 fallback promise', () => {
  const uploadProject = SANDBOX_TOOLS.find((tool) => tool.name === 'huaweicloud_sandbox_upload_project');
  assert.ok(uploadProject);
  assert.doesNotMatch(uploadProject.description, /base64/);
});

test('sandbox port and expiry schemas accept the model-emitted string-number form', () => {
  // The 2026-11-03 e2e-nightly codex leg: the model emitted every port as a
  // JSON string ("port": "8080"), and the strict z.number() declarations
  // rejected the calls at the SDK boundary before callTool could normalize
  // them — the agent then abandoned the tools and improvised. The schema
  // layer now rides the repo's numericArg union (the timeout_ms doctrine):
  // zod is deliberately loose (a garbage string also parses — the union's
  // string arm), the real numeric validation lives in callTool's
  // normalizeNumericArgs, and the 1..720 expiry bound in
  // validateExpiryHours downstream.
  const byName = new Map(SANDBOX_TOOLS.map((tool) => [tool.name, tool]));
  const deployNginx = byName.get('huaweicloud_sandbox_deploy_nginx')?.schema as {
    safeParse: (input: unknown) => { success: boolean };
  };
  assert.ok(deployNginx);
  assert.ok(
    deployNginx.safeParse({
      nginx_type: 'spa',
      port: '8080',
      project: 'myproject',
      output_dir: 'dist',
      node_port: '8081',
      public_port: '80',
    }).success,
    'deploy_nginx must parse the string-number port family',
  );
  const deployCheck = byName.get('huaweicloud_sandbox_deploy_check')?.schema as {
    safeParse: (input: unknown) => { success: boolean };
  };
  assert.ok(deployCheck);
  assert.ok(
    deployCheck.safeParse({ port: '8080', project: 'myproject', output_dir: 'dist' }).success,
    'deploy_check must parse the string-number port',
  );
  const exposeTunnel = byName.get('huaweicloud_sandbox_expose_tunnel')?.schema as {
    safeParse: (input: unknown) => { success: boolean };
  };
  assert.ok(exposeTunnel);
  assert.ok(
    exposeTunnel.safeParse({ port: '8080', expiry_hours: '72' }).success,
    'expose_tunnel must parse the string-number port and expiry_hours',
  );
  const renewTunnel = byName.get('huaweicloud_sandbox_renew_tunnel')?.schema as {
    safeParse: (input: unknown) => { success: boolean };
  };
  assert.ok(renewTunnel);
  assert.ok(
    renewTunnel.safeParse({ tunnel_id: 'kag7rozs', expiry_hours: '720' }).success,
    'renew_tunnel must parse the string-number expiry_hours',
  );
});
