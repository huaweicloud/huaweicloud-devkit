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
