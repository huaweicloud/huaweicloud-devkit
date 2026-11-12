import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPROVAL_MODE_ENV,
  approvalModeFromEnv,
  type ApprovalMode,
} from '../plugins/huaweicloud-core/src/lib/approval-mode.ts';

// The resolver is pure: every case feeds a fake env record, so this suite
// never mutates process.env and never depends on the ambient value. The
// operator-facing contract (the env var name) is pinned once here because
// the tests build their records from the exported constant.

test('APPROVAL_MODE_ENV pins the operator-facing variable name', () => {
  assert.equal(APPROVAL_MODE_ENV, 'DEVKIT_APPROVAL_MODE');
});

test('approvalModeFromEnv: unset env keeps the token default', () => {
  assert.equal<ApprovalMode>(approvalModeFromEnv({}), 'token');
  assert.equal<ApprovalMode>(approvalModeFromEnv({ UNRELATED: 'ask' }), 'token');
});

test('approvalModeFromEnv: empty string keeps the token default', () => {
  assert.equal<ApprovalMode>(approvalModeFromEnv({ [APPROVAL_MODE_ENV]: '' }), 'token');
});

test('approvalModeFromEnv: ask and token resolve to themselves', () => {
  assert.equal<ApprovalMode>(approvalModeFromEnv({ [APPROVAL_MODE_ENV]: 'ask' }), 'ask');
  assert.equal<ApprovalMode>(approvalModeFromEnv({ [APPROVAL_MODE_ENV]: 'token' }), 'token');
});

test('approvalModeFromEnv: any other value throws fail-loud with the env name and the bad value', () => {
  for (const bad of ['bogus', 'ASK', 'on']) {
    assert.throws(
      () => approvalModeFromEnv({ [APPROVAL_MODE_ENV]: bad }),
      new RegExp(`DEVKIT_APPROVAL_MODE must be "ask" or "token" \\(got "${bad}"\\)`),
      `${bad} must throw with the env name and the bad value`,
    );
  }
});
