import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  consumeApprovalToken,
  createApprovalToken,
  hashArgs,
  inspectApprovalToken,
  runHcloud,
  type HcloudPlan,
  type HcloudRunResult,
} from '../plugins/huaweicloud-core/src/hcloud-cli.ts';
import { confirmApprovalToken } from '../plugins/huaweicloud-core/src/lib/approval-tokens.ts';
import { clearCustodyCache } from '../plugins/huaweicloud-core/src/lib/secret-vault/custody.ts';
import { fakeHcloudExecutable, withTempAuthHome, type ApprovedRunResult } from './hcloud-cli-harness.ts';
import { callTool, type ToolArgs } from '../plugins/huaweicloud-core/src/tools.ts';

// Deterministic-tier seam: disable the once-per-session first-assertion
// vendor challenge (HUAWEICLOUD_VENDOR_CHALLENGE=off, the installer-override
// pattern). Set before the src imports: the gate captures the env at module
// load, so the harness import's seam is order-dependent — this line is not.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

test('inspectApprovalToken classifies a fresh token as valid', async () => {
  await withTempAuthHome(() => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'valid');
    assert.ok(inspection.entry, 'valid state carries the stored entry');
    assert.equal(inspection.entry.argsHash, hashArgs(['ECS', 'ListServersDetails']));
  });
});

// Backdate a stored token past the 5-minute TTL.
function backdateToken(home: string, token: string): void {
  const file = join(home, '.config', 'huaweicloud', 'approvals.json');
  const map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { createdAt: number }>;
  map[token]!.createdAt = Date.now() - 6 * 60_000;
  writeFileSync(file, JSON.stringify(map), 'utf8');
}

test('inspectApprovalToken classifies an expired token as expired', async () => {
  await withTempAuthHome((home) => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    backdateToken(home, token);

    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'expired');
    assert.equal(inspection.entry, undefined, 'expired state does not leak the entry');
  });
});

test('inspectApprovalToken classifies an already-consumed token as already_consumed', async () => {
  await withTempAuthHome(() => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const first = consumeApprovalToken(token);
    assert.ok(first, 'first consume returns the stored entry');

    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'already_consumed');
  });
});

test('inspectApprovalToken classifies an unknown token as not_found', async () => {
  await withTempAuthHome(() => {
    const inspection = inspectApprovalToken('never-created-uuid');
    assert.equal(inspection.state, 'not_found');
  });
});

test('the plan tool path mints awaiting_user entries with no grant', async () => {
  await withTempAuthHome(async () => {
    const token = await planApproval();
    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'valid');
    assert.ok(inspection.entry);
    assert.equal(
      inspection.entry.state,
      'awaiting_user',
      'the tool-layer mint carries the confirmation state through the store',
    );
    assert.equal(inspection.entry.confirmGrant, undefined, 'planning never confirms anything');
  });
});

test('consumeApprovalToken keeps a tombstone so the second call is distinguishable from not_found', async () => {
  await withTempAuthHome(() => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const first = consumeApprovalToken(token);
    assert.ok(first);
    // Second consume still returns null (backward compatible), but
    // inspectApprovalToken must report already_consumed, not not_found.
    assert.equal(consumeApprovalToken(token), null);
    assert.equal(inspectApprovalToken(token).state, 'already_consumed');
  });
});

// D4-24 drivers: plan an approval and run it under a fake HCLOUD_BIN, with
// the env restored either way.
async function withFakeHcloudBin<T>(fn: () => Promise<T>): Promise<T> {
  const fake = fakeHcloudExecutable('console.log(JSON.stringify({ ok: true }));');
  const prevBin = process.env.HCLOUD_BIN;
  process.env.HCLOUD_BIN = fake;
  try {
    return await fn();
  } finally {
    if (prevBin === undefined) delete process.env.HCLOUD_BIN;
    else process.env.HCLOUD_BIN = prevBin;
  }
}

// The confirmation battery needs a deterministic custody tier: the fixed env
// master key the sibling approval tests use, layered over the fresh per-test
// home. The custody cache is cleared on both ends so a key swap inside one
// test can never observe a stale tier.
const TEST_MASTER_KEY = Buffer.alloc(32, 0x33).toString('base64');

async function withVaultAuthHome(fn: (home: string) => Promise<void> | void): Promise<void> {
  const previousKey = process.env.HW_VAULT_MASTER_KEY;
  process.env.HW_VAULT_MASTER_KEY = TEST_MASTER_KEY;
  clearCustodyCache();
  try {
    await withTempAuthHome(fn);
  } finally {
    clearCustodyCache();
    if (previousKey === undefined) delete process.env.HW_VAULT_MASTER_KEY;
    else process.env.HW_VAULT_MASTER_KEY = previousKey;
  }
}

async function planApproval(): Promise<string> {
  const plan = (await callTool('huaweicloud_plan_cli_command', {
    args: ['ECS', 'ListServersDetails'],
    vendorConfirmed: 'test: vendor established by the harness',
  })) as HcloudPlan;
  assert.ok(plan.approvalToken);
  return plan.approvalToken;
}

async function runApproved(token: string): Promise<ToolArgs> {
  return (await callTool('huaweicloud_run_approved_command', {
    args: ['ECS', 'ListServersDetails'],
    approvalToken: token,
    approvedByUser: true,
    maxRetries: 0,
    vendorConfirmed: 'test: vendor established by the harness',
  })) as ToolArgs;
}

test('runApprovedCommand: expired token returns {status:rejected, code:CONFIRM_TOKEN_EXPIRED}', async () => {
  await withTempAuthHome(async (home) => {
    await withFakeHcloudBin(async () => {
      const token = await planApproval();
      backdateToken(home, token);

      const result = (await runApproved(token)) as { status: string; code: string };
      assert.equal(result.status, 'rejected');
      assert.equal(result.code, 'CONFIRM_TOKEN_EXPIRED');
    });
  });
});

test('runApprovedCommand: same token submitted twice returns {status:ok, outcome:already_processed}', async () => {
  await withTempAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const token = await planApproval();

      const first = (await runApproved(token)) as ApprovedRunResult;
      assert.equal(first.approved, true, 'first call executes the command');

      const second = (await runApproved(token)) as { status: string; outcome: string };
      assert.equal(second.status, 'ok');
      assert.equal(second.outcome, 'already_processed');
    });
  });
});

test('runApprovedCommand: unknown token returns {status:rejected, code:CONFIRM_TOKEN_NOT_FOUND}', async () => {
  await withTempAuthHome(async () => {
    const result = (await callTool('huaweicloud_run_approved_command', {
      args: ['ECS', 'ListServersDetails'],
      approvalToken: 'never-created-uuid',
      approvedByUser: true,
      maxRetries: 0,
      vendorConfirmed: 'test: vendor established by the harness',
    })) as { status: string; code: string };
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'CONFIRM_TOKEN_NOT_FOUND');
  });
});

test('tombstones age out: an aged tombstone inspects as not_found, not already_consumed', async () => {
  await withTempAuthHome(async (home) => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    assert.ok(consumeApprovalToken(token), 'first consume wins');

    // Age the TOMBSTONE past the TTL (createdAt is the original mint time).
    backdateToken(home, token);
    const inspection = inspectApprovalToken(token);
    assert.equal(
      inspection.state,
      'not_found',
      'an aged tombstone must read as not_found — the same answer the next mint prune gives',
    );

    // And the next unrelated mint prunes it from the store entirely.
    createApprovalToken(['OBS', 'ls']);
    const file = join(home, '.config', 'huaweicloud', 'approvals.json');
    const map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.ok(!(token in map), 'the aged tombstone is pruned by the mint');
  });
});

// ── #921: CLI ok-judgment holes ─────────────────────────────────────────────

// ── Leading-bin normalization seam (2026-11-05 UX report #6) ────────────────
// The token binds the plan's EFFECTIVE args, so a run call that echoes the
// plan verbatim and one that sends the cleaned args both verify, while any
// real argument change still rejects. Before the seam, a prefixed plan
// followed by a self-corrected run burned the single-use token on a mismatch.

test('runApprovedCommand: a prefixed plan and a cleaned run verify against one approval', async () => {
  await withTempAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const plan = (await callTool('huaweicloud_plan_cli_command', {
        args: ['hcloud', 'ECS', 'ListServersDetails'],
        vendorConfirmed: 'test: vendor established by the harness',
      })) as HcloudPlan;
      assert.equal(plan.command, 'hcloud ECS ListServersDetails', 'the echoed command must be the effective one');
      assert.ok(plan.warnings.some((w) => String(w).includes('Leading executable/wrapper token')));

      const result = (await callTool('huaweicloud_run_approved_command', {
        args: ['ECS', 'ListServersDetails'],
        approvalToken: plan.approvalToken,
        approvedByUser: true,
        maxRetries: 0,
        vendorConfirmed: 'test: vendor established by the harness',
      })) as ApprovedRunResult;
      assert.equal(result.approved, true, 'the cleaned run matches the prefixed plan after normalization');
    });
  });
});

test('runApprovedCommand: a cleaned plan and a prefixed run verify against one approval', async () => {
  await withTempAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const token = await planApproval();
      const result = (await callTool('huaweicloud_run_approved_command', {
        args: ['hcloud', 'ECS', 'ListServersDetails'],
        approvalToken: token,
        approvedByUser: true,
        maxRetries: 0,
        vendorConfirmed: 'test: vendor established by the harness',
      })) as ApprovedRunResult;
      assert.equal(result.approved, true, 'the prefixed run normalizes to the approved effective args');
    });
  });
});

// ── Secret-value pinning (2026-11-06 loop round 2) ──────────────────────────
// The redacted-equality branch cannot tell a changed real secret from the
// documented placeholder→real substitution flow. The distinction lives at
// plan time: placeholder-bearing plans keep the substitution flow; plans with
// real secret values pin them.

// Shared callTool wrappers for the pinning battery (write-plan + run): the
// four cases differ only in the args arrays.
async function planWrite(args: string[]): Promise<HcloudPlan> {
  return (await callTool('huaweicloud_plan_cli_command', {
    args,
    allowWrites: true,
    vendorConfirmed: 'test: vendor established by the harness',
  })) as HcloudPlan;
}

// The user's terminal confirm, driven programmatically: plan a write, then
// record the confirmation the run gate requires. Write tests read as
// plan → confirm → run through this one seam.
async function planConfirmedWrite(args: string[]): Promise<string> {
  const plan = await planWrite(args);
  const token = plan.approvalToken;
  assert.ok(token);
  assert.equal(confirmApprovalToken(token).status, 'confirmed');
  return token;
}

function runWith(token: string, args: string[]): Promise<unknown> {
  return callTool('huaweicloud_run_approved_command', {
    args,
    approvalToken: token,
    approvedByUser: true,
    maxRetries: 0,
    vendorConfirmed: 'test: vendor established by the harness',
  });
}

test('runApprovedCommand: a placeholder-bearing plan accepts the real secret at run time', async () => {
  await withVaultAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const token = await planConfirmedWrite(['RDS', 'CreateInstance', '--password=<password>', '--name=db1']);
      const result = (await runWith(token, [
        'RDS',
        'CreateInstance',
        '--password=RealPass99Aa',
        '--name=db1',
      ])) as ApprovedRunResult;
      assert.equal(result.approved, true, 'the documented placeholder→real substitution flow must execute');
    });
  });
});

test('runApprovedCommand: a plan with a real secret pins it — a different real secret rejects', async () => {
  await withVaultAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const token = await planConfirmedWrite(['RDS', 'CreateInstance', '--password=FirstSecret99Aa', '--name=db1']);
      await assert.rejects(
        () => runWith(token, ['RDS', 'CreateInstance', '--password=DifferentSecret77Bb', '--name=db1']),
        /Secret values are pinned/,
      );
    });
  });
});

test('runApprovedCommand: the same real secret verifies through the exact hash', async () => {
  await withVaultAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const token = await planConfirmedWrite(['RDS', 'CreateInstance', '--password=FirstSecret99Aa', '--name=db1']);
      const result = (await runWith(token, [
        'RDS',
        'CreateInstance',
        '--password=FirstSecret99Aa',
        '--name=db1',
      ])) as ApprovedRunResult;
      assert.equal(result.approved, true, 'an unchanged real secret matches the minted hash');
    });
  });
});

// ── Loop round 3: pinning vocabulary and placeholder forms ──────────────────

test('runApprovedCommand: redactor-folded keys outside the middle arm pin too (loop round 3 S1-B1)', async () => {
  // user_data/private_key/authorization/AK/SK live in redactString's arm 1/3;
  // only the middle arm was mirrored in round 2, so real secrets under these
  // keys stayed substitutable.
  for (const key of ['private_key', 'user_data', 'authorization', 'AK', 'SK']) {
    await withVaultAuthHome(async () => {
      await withFakeHcloudBin(async () => {
        const token = await planConfirmedWrite(['ECS', 'CreateServers', `--server.${key}=RealKey123`, '--name=db1']);
        await assert.rejects(
          () => runWith(token, ['ECS', 'CreateServers', `--server.${key}=Different456`, '--name=db1']),
          /pinned|do not match/,
          `${key}: a changed real secret must reject`,
        );
      });
    });
  }
});

test('runApprovedCommand: two-token and glued placeholder forms reject instead of executing (loop round 3 S1-B2)', async () => {
  await withTempAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const plan = await planWrite(['RDS', 'CreateInstance', '--password', '<password>', '--name=db1']);
      const token = plan.approvalToken;
      assert.ok(token);
      await assert.rejects(
        () => runWith(token, ['RDS', 'CreateInstance', '--password', '<redacted>', '--name=db1']),
        /placeholder secret value/,
        'the two-token placeholder form must reject',
      );
      const glued = await planWrite(['RDS', 'CreateInstance', '--password <password>', '--name=db1']);
      const gluedToken = glued.approvalToken;
      assert.ok(gluedToken);
      await assert.rejects(
        () => runWith(gluedToken, ['RDS', 'CreateInstance', '--password <redacted>', '--name=db1']),
        /placeholder secret value/,
        'the glued single-token placeholder form must reject',
      );
    });
  });
});

test('runApprovedCommand: a placeholder rejection does not burn the token (loop round 3 S1-B3)', async () => {
  await withVaultAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const plan = await planWrite(['RDS', 'CreateInstance', '--password=<password>', '--name=db1']);
      const token = plan.approvalToken;
      assert.ok(token);
      // First run still carries the placeholder → reject with guidance,
      // WITHOUT consuming the token (the two-token form is covered by the
      // dedicated placeholder-forms test above).
      await assert.rejects(
        () => runWith(token, ['RDS', 'CreateInstance', '--password=<redacted>', '--name=db1']),
        /replace <redacted> with the actual value the user approved, then re-run with the same approval token/,
      );
      // The still-live token accepts the user's terminal confirmation, and
      // following the guidance on the SAME token must now execute.
      assert.equal(confirmApprovalToken(token).status, 'confirmed');
      const result = (await runWith(token, [
        'RDS',
        'CreateInstance',
        '--password=RealPass99Aa',
        '--name=db1',
      ])) as ApprovedRunResult;
      assert.equal(result.approved, true, 'the guidance must be followable on the same approval token');
    });
  });
});

// ── Loop round 8-9: quote-adjacent and segment-model edges ──────────────────

test('runApprovedCommand: a quote-glued real secret pins (loop round 8 S1-B3)', async () => {
  await withVaultAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const token = await planConfirmedWrite(['RDS', 'CreateInstance', '--password' + '"RealPw1"', '--name=db1']);
      await assert.rejects(
        () => runWith(token, ['RDS', 'CreateInstance', '--password' + '"EVILPw99"', '--name=db1']),
        /pinned/,
        'the quote-glued form must be visible to the pinning detector',
      );
    });
  });
});

test('runApprovedCommand: a quote-glued placeholder at run time rejects (loop round 8 S1-B4)', async () => {
  await withTempAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const plan = await planWrite(['RDS', 'CreateInstance', '--password <password>', '--name=db1']);
      const token = plan.approvalToken;
      assert.ok(token);
      await assert.rejects(
        () => runWith(token, ['RDS', 'CreateInstance', '--password' + '"<redacted>"', '--name=db1']),
        /placeholder secret value/,
        'the quote-glued placeholder form must not reach the child',
      );
    });
  });
});

// ── Terminal confirmation gate: the run-side check (Unit BC) ───────────────
// The user authorizes a pending approval in their own terminal; the run tool
// verifies that grant server-side before consuming the token.

test('plan: userConfirmation names the approve line for writes, stays quiet for reads', async () => {
  await withVaultAuthHome(async () => {
    // Planned with the agent-supplied allowWrites attestation: the verdict
    // must come from the strict view, not weaken with the option.
    const writePlan = await planWrite(['ECS', 'DeleteServer', '--server_id=i-123']);
    assert.ok(writePlan.approvalToken, 'the approve line names a token the plan minted');
    assert.equal(writePlan.userConfirmation.needed, true, 'a write waits on the terminal confirmation');
    assert.equal(
      writePlan.userConfirmation.command,
      `npx huaweicloud-devkit approve ${writePlan.approvalToken}`,
      'command is the exact line the user runs in their own terminal',
    );

    const readPlan = (await callTool('huaweicloud_plan_cli_command', {
      args: ['ECS', 'ListServersDetails'],
      vendorConfirmed: 'test: vendor established by the harness',
    })) as HcloudPlan;
    assert.equal(readPlan.userConfirmation.needed, false, 'a read never waits on a confirmation');
    assert.equal(readPlan.userConfirmation.command, undefined);
  });
});

test('runApprovedCommand: an unconfirmed write rejects USER_CONFIRMATION_REQUIRED without burning the token', async () => {
  await withVaultAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const plan = await planWrite(['ECS', 'DeleteServer', '--server_id=i-123']);
      const token = plan.approvalToken;
      assert.ok(token);
      assert.equal(inspectApprovalToken(token).entry?.state, 'awaiting_user', 'the plan mints unconfirmed');

      const refused = (await runWith(token, ['ECS', 'DeleteServer', '--server_id=i-123'])) as {
        status: string;
        code: string;
        nextStep?: string;
      };
      assert.equal(refused.status, 'rejected');
      assert.equal(refused.code, 'USER_CONFIRMATION_REQUIRED');
      assert.match(refused.nextStep ?? '', /npx huaweicloud-devkit approve/, 'the rejection teaches the terminal step');

      // The refusal must not burn the token: the same token still accepts
      // the user's confirmation and executes afterwards.
      assert.equal(confirmApprovalToken(token).status, 'confirmed', 'the refusal left the token confirmable');
      const executed = (await runWith(token, ['ECS', 'DeleteServer', '--server_id=i-123'])) as ApprovedRunResult;
      assert.equal(executed.approved, true, 'the same token executes after the user confirms');
    });
  });
});

test('runApprovedCommand: a confirmed write executes and its result plan mints no fresh token', async () => {
  await withVaultAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const token = await planConfirmedWrite(['ECS', 'DeleteServer', '--server_id=i-123']);

      const result = (await runWith(token, ['ECS', 'DeleteServer', '--server_id=i-123'])) as ApprovedRunResult;
      assert.equal(result.approved, true);
      assert.ok(result.plan, 'the approved result embeds the strict plan');
      assert.equal('approvalToken' in result.plan, false, 'the embedded plan carries no fresh approvalToken');
      assert.equal(result.plan.userConfirmation.command, undefined, 'a run-path plan names no approve line');
    });
  });
});

test('runApprovedCommand: a read-classified command executes on an unconfirmed token', async () => {
  await withVaultAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const token = await planApproval();
      assert.equal(inspectApprovalToken(token).entry?.state, 'awaiting_user', 'the read runs without any confirmation');
      const result = (await runApproved(token)) as ApprovedRunResult;
      assert.equal(result.approved, true, 'the gate scopes to non-read commands only');
    });
  });
});

test('run paths never mint: engine results and the readonly tool carry no approvalToken', async () => {
  await withVaultAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const engine = await runHcloud(['ECS', 'DeleteServer', '--server_id=i-123'], {
        allowWrites: true,
        maxRetries: 0,
      });
      assert.ok(engine.plan, 'the engine result embeds its live plan');
      assert.equal('approvalToken' in engine.plan, false, 'the write engine path mints nothing');

      const readonly = (await callTool('huaweicloud_run_readonly_command', {
        args: ['ECS', 'ListServersDetails'],
        maxRetries: 0,
        vendorConfirmed: 'test: vendor established by the harness',
      })) as HcloudRunResult;
      assert.ok(readonly.plan, 'the readonly tool embeds its live plan');
      assert.equal('approvalToken' in readonly.plan, false, 'the readonly path mints nothing');
    });
  });
});
