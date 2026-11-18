import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  consumeApprovalToken,
  createApprovalToken,
  inspectApprovalToken,
} from '../plugins/huaweicloud-core/src/lib/approval-tokens.ts';
import { E2E_VAULT_MASTER_KEY, startApprovalsWatcher } from './e2e/approvals-watcher.ts';
import { fixtureDir } from './fixture-dir.ts';

// The approvals watcher is the E2E's simulated user-terminal half of the
// token chain (the doctrine comment in approvals-watcher.ts). These pins
// prove the round trip the nightly case depends on: a token minted under
// the throwaway home gets confirmed by the watcher through the product's
// own confirmApprovalToken, and the grant it writes verifies on the
// CONSUME side — the same function the MCP server child runs — under the
// shared env-tier custody key.

// The product resolves state and custody from process.env at call time;
// the product calls in the run body must see the case home, and the env
// pin must outlive the awaits (the watcher's own tick re-pins the same
// home and restores to whatever it saw — the outer restore below is the
// only one that touches the true originals).
async function withCaseHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = fixtureDir('hwc-approvals-watch-');
  mkdirSync(join(home, '.config', 'huaweicloud'), { recursive: true });
  const savedHome = process.env.HUAWEICLOUD_HOME;
  const savedKey = process.env.HW_VAULT_MASTER_KEY;
  process.env.HUAWEICLOUD_HOME = home;
  process.env.HW_VAULT_MASTER_KEY = E2E_VAULT_MASTER_KEY;
  try {
    await run(home);
  } finally {
    if (savedHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = savedHome;
    if (savedKey === undefined) delete process.env.HW_VAULT_MASTER_KEY;
    else process.env.HW_VAULT_MASTER_KEY = savedKey;
  }
}

// Async polling over the watcher's own cadence: real yields (plain
// setTimeout) so the unref'd interval actually fires — a busy wait or an
// Atomics.wait would block the event loop and starve the timer forever.
async function waitForAsync(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('the watcher confirms a minted token and the grant verifies on consume', async () => {
  await withCaseHome(async (home) => {
    // The mint side: what the plan tool does under the token posture.
    const token = createApprovalToken(['VPC', 'CreateSecurityGroup', '--name=e2e-test-sg-01'], {
      secretsSubstitutable: false,
      argsPinView: ['VPC', 'CreateSecurityGroup', '--name=e2e-test-sg-01'],
    });
    assert.equal(inspectApprovalToken(token).state, 'valid', 'the token starts awaiting the user');
    const watcher = startApprovalsWatcher(home);
    try {
      // Two-plus poll periods (the watcher ticks every 200ms).
      const sawConfirm = await waitForAsync(() => inspectApprovalToken(token).entry?.state === 'user_confirmed', 2_000);
      assert.ok(sawConfirm, 'the watcher confirmed the awaiting token through the product confirm');
      // The consume side — the same call the MCP server child makes: the
      // grant MAC must verify under the shared env-tier key, and the
      // single-use claim must succeed.
      const consumed = consumeApprovalToken(token, { requireGrant: true });
      assert.equal(
        consumed.status,
        'consumed',
        `the grant verifies and the token consumes: ${JSON.stringify(consumed)}`,
      );
      // Single-use: the second consume of the same token reports gone.
      const again = consumeApprovalToken(token, { requireGrant: true });
      assert.notEqual(again.status, 'consumed');
    } finally {
      watcher.stop();
    }
  });
});

test('the watcher restores the runner env after each tick over an empty store', async () => {
  const home = fixtureDir('hwc-approvals-empty-');
  mkdirSync(join(home, '.config', 'huaweicloud'), { recursive: true });
  const savedHome = process.env.HUAWEICLOUD_HOME;
  const savedKey = process.env.HW_VAULT_MASTER_KEY;
  const watcher = startApprovalsWatcher(home);
  try {
    // Let at least two ticks fire (400ms) with no store file at all.
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(process.env.HUAWEICLOUD_HOME, savedHome, 'HUAWEICLOUD_HOME is restored after each tick');
    assert.equal(process.env.HW_VAULT_MASTER_KEY, savedKey, 'the custody env is restored after each tick');
  } finally {
    watcher.stop();
  }
  rmSync(home, { recursive: true, force: true });
});
