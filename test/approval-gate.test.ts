import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { APPROVAL_SPECS } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import { APPROVAL_TOOLS } from '../plugins/huaweicloud-core/src/approval-roster.ts';
import {
  createApprovalToken,
  hashArgs,
  inspectApprovalToken,
  pinViewArgs,
} from '../plugins/huaweicloud-core/src/hcloud-cli.ts';
import { confirmApprovalToken } from '../plugins/huaweicloud-core/src/lib/approval-tokens.ts';
import { clearCustodyCache } from '../plugins/huaweicloud-core/src/lib/secret-vault/custody.ts';
import { createLinkedDevkitServers } from '../plugins/huaweicloud-core/src/mcp-protocol.ts';
import { readConsentEvents } from '../plugins/huaweicloud-core/src/approval-ledger.ts';
import { runApprovalGate, NO_SESSION_SEAM_ERROR } from '../plugins/huaweicloud-core/src/approval-gate.ts';
import type { ApprovalSpec } from '../plugins/huaweicloud-core/src/approval-types.ts';
import type { ToolName } from '../plugins/huaweicloud-core/src/tool-definitions.ts';
import { fakeHcloudExecutable, withTempAuthHome, type ApprovedRunResult } from './hcloud-cli-harness.ts';

// The generalized approval gate's unit battery: the envelope for each mode,
// the roster-driven _meta, and the packs_configure seam-ordering rule. The
// trunk hcloud behaviors (token lifecycle, pin-view binding, ask-mode
// execution) stay pinned where they already live — test/hcloud-cli-approval.test.ts,
// unmodified, which is this migration's acceptance.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

const VENDOR = 'test: vendor established by the harness';
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

async function withApprovalMode<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.DEVKIT_APPROVAL_MODE;
  if (value === undefined) delete process.env.DEVKIT_APPROVAL_MODE;
  else process.env.DEVKIT_APPROVAL_MODE = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.DEVKIT_APPROVAL_MODE;
    else process.env.DEVKIT_APPROVAL_MODE = previous;
  }
}

function runApproved(token: string | undefined, args: string[]) {
  return callTool('huaweicloud_run_approved_command', {
    args,
    ...(token !== undefined ? { approvalToken: token } : {}),
    approvedByUser: true,
    maxRetries: 0,
    vendorConfirmed: VENDOR,
  });
}

test('token mode: a no-token call returns the trunk CONFIRM_TOKEN_NOT_FOUND envelope and mints nothing', async () => {
  await withTempAuthHome(async (home) => {
    const result = (await runApproved(undefined, ['ECS', 'ListServersDetails'])) as {
      status: string;
      code: string;
    };
    assert.deepEqual(result, { status: 'rejected', code: 'CONFIRM_TOKEN_NOT_FOUND' });
    assert.equal(
      existsSync(join(home, '.config', 'huaweicloud', 'approvals.json')),
      false,
      'a plan-face no-token refusal must mint nothing',
    );
  });
});

test('token mode: the attestation rejection precedes every gate effect', async () => {
  await withTempAuthHome(async (home) => {
    await assert.rejects(
      () =>
        callTool('huaweicloud_run_approved_command', {
          args: ['ECS', 'DeleteServer', '--server_id=i-1'],
          vendorConfirmed: VENDOR,
        } as never),
      /approvedByUser must be true/,
    );
    assert.equal(
      existsSync(join(home, '.config', 'huaweicloud', 'approvals.json')),
      false,
      'a call that fails the attestation mints and records nothing',
    );
  });
});

test('token mode: an unknown token returns the trunk not-found classification', async () => {
  await withTempAuthHome(async () => {
    const result = (await runApproved('never-created-uuid', ['ECS', 'ListServersDetails'])) as {
      status: string;
      code: string;
    };
    assert.deepEqual(result, { status: 'rejected', code: 'CONFIRM_TOKEN_NOT_FOUND' });
  });
});

test('token mode: the gate mints nothing for the plan-face tool — only the plan face does', async () => {
  // ApprovalCoreMint GateNeverMintsForPlanFace: every token in the store
  // after a rejected run call traces back to a plan mint.
  await withVaultAuthHome(async (home) => {
    await runApproved(undefined, ['ECS', 'DeleteServer', '--server_id=i-1']);
    const file = join(home, '.config', 'huaweicloud', 'approvals.json');
    assert.equal(existsSync(file), false, 'the gate must not mint for a plan-face tool');
  });
});

test('ask mode: the gate routes to the handler with no token and records a posture-tier consent event', async () => {
  await withTempAuthHome(async (home) => {
    const fake = fakeHcloudExecutable('console.log(JSON.stringify({ ok: true }));');
    const prevBin = process.env.HCLOUD_BIN;
    process.env.HCLOUD_BIN = fake;
    try {
      await withApprovalMode('ask', async () => {
        const result = (await runApproved(undefined, ['ECS', 'DeleteServer', '--server_id=i-1'])) as ApprovedRunResult;
        assert.equal(result.approved, true, 'ask mode executes on the harness prompt as the confirmation');

        const events = readConsentEvents();
        assert.equal(events.length, 1, 'one ask-mode arrival, one consent event');
        assert.equal(events[0]!.evidence, 'posture');
        assert.equal(events[0]!.tool, 'huaweicloud_run_approved_command');
        assert.equal(events[0]!.outcome, 'granted');
        assert.equal(events[0]!.argsHash, hashArgs(['ECS', 'DeleteServer', '--server_id=i-1']));
        assert.equal(events[0]!.sessionId, 'default');
      });
    } finally {
      if (prevBin === undefined) delete process.env.HCLOUD_BIN;
      else process.env.HCLOUD_BIN = prevBin;
    }
  });
});

test('ask mode: a placeholder secret rejects with the ask wording and records no consent', async () => {
  await withTempAuthHome(async () => {
    await withApprovalMode('ask', async () => {
      await assert.rejects(
        () => runApproved(undefined, ['ECS', 'CreateServers', '--server.adminPass=<redacted>', '--server.flavorRef=x']),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /placeholder secret value/);
          assert.ok(!message.includes('approval token'), 'ask-mode wording must not reference the token flow');
          return true;
        },
      );
      assert.deepEqual(readConsentEvents(), [], 'a rejected call is not a consent arrival');
    });
  });
});

// A synthetic gate-source spec for exercising the mint and consume faces
// without registering a real tool in PR-1: classify keys on the content,
// the pin view is the raw binding value, and the summary names it.
function syntheticGateSpec(flavor: 'always' | 'classified'): ApprovalSpec {
  return {
    domain: 'test',
    flavor,
    tokenSource: 'gate',
    normalizeArgs: (args) => (Array.isArray(args.args) ? (args.args as string[]) : []),
    classify: (value) => {
      const list = value as string[];
      return list.includes('DeleteServer') ? 'required' : 'none';
    },
    summarize: (value) => {
      const list = value as string[];
      return { summary: `test-tool: ${list.join(' ')}`, argsHash: hashArgs(list), pinView: list };
    },
  };
}

test('a gate-source spec mints on the first no-token call and returns the confirmation envelope', async () => {
  // The PR-3 mint face, exercised through the gate directly with a
  // synthetic spec so no real tool joins the roster in PR-1. Classification
  // runs before the mint (ApprovalCoreMint NoDoomedToken): destructive
  // content is a disabled guard at the gate face.
  await withTempAuthHome(async () => {
    const spec = syntheticGateSpec('classified');

    const benign = await runApprovalGate(
      'huaweicloud_list_regions',
      spec,
      { approvedByUser: true, args: ['ECS', 'ListServersDetails'] },
      {},
    );
    assert.equal(benign, 'pass', 'classified content the classifier passes needs no consent');

    const gated = (await runApprovalGate(
      'huaweicloud_list_regions',
      spec,
      { approvedByUser: true, args: ['ECS', 'DeleteServer', '--server_id=i-1'] },
      {},
    )) as { envelope: Record<string, unknown> };
    assert.equal(gated.envelope.code, 'USER_CONFIRMATION_REQUIRED');
    assert.equal(gated.envelope.status, 'rejected');
    const token = gated.envelope.approvalToken as string;
    assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.match(
      (gated.envelope.userConfirmation as Record<string, unknown>).command as string,
      new RegExp(`npx huaweicloud-devkit approve ${token}`),
    );
    assert.equal(
      (gated.envelope.userConfirmation as Record<string, unknown>).argsHash,
      hashArgs(['ECS', 'DeleteServer', '--server_id=i-1']),
      'the envelope carries the pin-view binding line',
    );
    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'valid', 'the gate minted the token the envelope names');

    // The approve→run cycle completes on the gate's binding: confirm in the
    // terminal, retry with the token, the consume verifies the grant and
    // the hash binding passes.
    assert.equal(confirmApprovalToken(token).status, 'confirmed');
    const consumed = await runApprovalGate(
      'huaweicloud_list_regions',
      spec,
      { approvedByUser: true, args: ['ECS', 'DeleteServer', '--server_id=i-1'], approvalToken: token },
      {},
    );
    assert.equal(consumed, 'pass', 'a confirmed, byte-identical retry spends its token at the gate');
    assert.equal(inspectApprovalToken(token).state, 'already_consumed');
  });
});

test('a gate-source retry with changed args rejects on the binding and never executes', async () => {
  await withTempAuthHome(async () => {
    const spec = syntheticGateSpec('always');
    const minted = (await runApprovalGate(
      'huaweicloud_list_regions',
      spec,
      { approvedByUser: true, args: ['ECS', 'DeleteServer', '--server_id=victim-1'] },
      {},
    )) as { envelope: Record<string, unknown> };
    const token = minted.envelope.approvalToken as string;
    assert.equal(confirmApprovalToken(token).status, 'confirmed');
    await assert.rejects(
      () =>
        runApprovalGate(
          'huaweicloud_list_regions',
          spec,
          { approvedByUser: true, args: ['ECS', 'DeleteServer', '--server_id=attacker-2'], approvalToken: token },
          {},
        ),
      /do not match the approved plan/,
    );
  });
});

test('a plan-face gate-source mix: the hcloud spec classifies the grant requirement content-dependently', async () => {
  // The read-relaxation is the trunk contract: a read-classified command
  // executes on an unconfirmed token; a write demands the terminal grant.
  await withVaultAuthHome(async () => {
    const readToken = createApprovalToken(['ECS', 'ListServersDetails']);
    const consumed = await runApprovalGate(
      'huaweicloud_run_approved_command',
      APPROVAL_SPECS.huaweicloud_run_approved_command,
      { approvedByUser: true, args: ['ECS', 'ListServersDetails'], approvalToken: readToken },
      {},
    );
    assert.equal(consumed, 'pass', 'a read needs no grant');

    const writeToken = createApprovalToken(['ECS', 'DeleteServer', '--server_id=i-1']);
    const refused = (await runApprovalGate(
      'huaweicloud_run_approved_command',
      APPROVAL_SPECS.huaweicloud_run_approved_command,
      { approvedByUser: true, args: ['ECS', 'DeleteServer', '--server_id=i-1'], approvalToken: writeToken },
      {},
    )) as { envelope: Record<string, unknown> };
    assert.equal(refused.envelope.code, 'USER_CONFIRMATION_REQUIRED');
    assert.equal(inspectApprovalToken(writeToken).state, 'valid', 'the refusal burned nothing');
  });
});

// The packs_configure seam spec, shared by the ordering tests: the gate
// mirrors the handler's stdio-only refusal, so the spec carries
// requiresSessionSeam and the gate consults it before engaging.
const seamGateSpec: ApprovalSpec = {
  domain: 'packs',
  flavor: 'always',
  tokenSource: 'gate',
  requiresSessionSeam: true,
  summarize: (value) => ({ summary: 'packs_configure', argsHash: hashArgs(value), pinView: value }),
};

test('the packs_configure ordering rule: a no-seam call refuses before any mint or ledger entry', async () => {
  // ApprovalCoreMint GateMintSeam's disabled-guard posture: the gate checks
  // the stdio seam BEFORE engaging, mirroring the handler's own refusal —
  // the gate cannot sit after a refusal that lives inside the handler.
  await withTempAuthHome(async (home) => {
    const refused = (await runApprovalGate(
      'huaweicloud_packs_configure',
      seamGateSpec,
      { approvedByUser: true },
      {},
    )) as {
      envelope: Record<string, unknown>;
    };
    assert.deepEqual(refused.envelope, { ok: false, error: NO_SESSION_SEAM_ERROR });
    assert.equal(
      existsSync(join(home, '.config', 'huaweicloud', 'approvals.json')),
      false,
      'a no-seam refusal mints no token',
    );
    assert.deepEqual(readConsentEvents(), [], 'a no-seam refusal writes no ledger entry');

    // The same call through callTool reaches the handler's own identical
    // refusal when the gate spec is not registered — packs_configure joins
    // the roster in PR-3c, and until then the handler's refusal stands
    // unchanged. Both refusals carry the same load-bearing text.
    const handlerRefusal = (await callTool('huaweicloud_packs_configure', { enable: ['sandbox'] })) as {
      ok: boolean;
      error: string;
    };
    assert.equal(handlerRefusal.ok, false);
    assert.equal(handlerRefusal.error, NO_SESSION_SEAM_ERROR);
  });
});

test('the seam precheck precedes the attestation and the mode branch', async () => {
  await withApprovalMode('ask', async () => {
    await withTempAuthHome(async (home) => {
      const refused = (await runApprovalGate(
        'huaweicloud_packs_configure',
        seamGateSpec,
        { enable: ['sandbox'] },
        {},
      )) as {
        envelope: Record<string, unknown>;
      };
      assert.deepEqual(refused.envelope, { ok: false, error: NO_SESSION_SEAM_ERROR });
      assert.deepEqual(readConsentEvents(), [], 'the seam refusal wins even in ask mode with no attestation');
      assert.equal(existsSync(join(home, '.config', 'huaweicloud')), false);
    });
  });
});

test('the roster-driven _meta: ask mode declares user interaction for roster tools only', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const previous = process.env.DEVKIT_APPROVAL_MODE;

  const listMeta = async (mode: string | undefined) => {
    if (mode === undefined) delete process.env.DEVKIT_APPROVAL_MODE;
    else process.env.DEVKIT_APPROVAL_MODE = mode;
    const { server, transport } = await createLinkedDevkitServers();
    const client = new Client({ name: 'approval-gate-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
      const metaFor = (name: string) => (byName.get(name) as { _meta?: Record<string, unknown> } | undefined)?._meta;
      return {
        roster: APPROVAL_TOOLS.map((name) => metaFor(name)),
        offRoster: metaFor('huaweicloud_plan_cli_command'),
      };
    } finally {
      await client.close();
      await server.close();
    }
  };

  try {
    const ask = await listMeta('ask');
    for (const meta of ask.roster) {
      assert.deepEqual(
        meta,
        { 'anthropic/requiresUserInteraction': true },
        'every roster tool declares it in ask mode',
      );
    }
    assert.equal(ask.offRoster, undefined, 'a non-roster tool declares no _meta');

    const token = await listMeta(undefined);
    for (const meta of token.roster) {
      assert.equal(meta, undefined, 'token mode declares no _meta');
    }
  } finally {
    if (previous === undefined) delete process.env.DEVKIT_APPROVAL_MODE;
    else process.env.DEVKIT_APPROVAL_MODE = previous;
  }
});

test('the gate keeps the trunk already-processed envelope for a replayed token', async () => {
  await withVaultAuthHome(async () => {
    const fake = fakeHcloudExecutable('console.log(JSON.stringify({ ok: true }));');
    const prevBin = process.env.HCLOUD_BIN;
    process.env.HCLOUD_BIN = fake;
    try {
      const token = createApprovalToken(['ECS', 'ListServersDetails']);
      const first = (await runApproved(token, ['ECS', 'ListServersDetails'])) as ApprovedRunResult;
      assert.equal(first.approved, true);
      const second = (await runApproved(token, ['ECS', 'ListServersDetails'])) as {
        status: string;
        outcome: string;
      };
      assert.deepEqual(second, { status: 'ok', outcome: 'already_processed' });
    } finally {
      if (prevBin === undefined) delete process.env.HCLOUD_BIN;
      else process.env.HCLOUD_BIN = prevBin;
    }
  });
});

test('the pin-view binding: a substituted real secret executes on a placeholder-bearing plan', async () => {
  await withVaultAuthHome(async () => {
    const fake = fakeHcloudExecutable('console.log(JSON.stringify({ ok: true }));');
    const prevBin = process.env.HCLOUD_BIN;
    process.env.HCLOUD_BIN = fake;
    try {
      const planArgs = ['RDS', 'CreateInstance', '--password=<password>', '--name=db1'];
      const token = createApprovalToken(planArgs, {
        secretsSubstitutable: true,
        argsPinView: pinViewArgs(planArgs),
      });
      assert.equal(confirmApprovalToken(token).status, 'confirmed');
      const result = (await runApproved(token, [
        'RDS',
        'CreateInstance',
        '--password=Real' + 'Pass99Aa',
        '--name=db1',
      ])) as ApprovedRunResult;
      assert.equal(result.approved, true, 'the documented substitution flow still executes through the gate');
    } finally {
      if (prevBin === undefined) delete process.env.HCLOUD_BIN;
      else process.env.HCLOUD_BIN = prevBin;
    }
  });
});

test('a hand-edited pin view on the confirmed entry still fails the grant, not the binding', async () => {
  // F1 parity through the gate: approvals.json is same-user editable, and
  // the grant mac binds the pin view — the edited entry can neither execute
  // nor burn the token.
  await withVaultAuthHome(async (home) => {
    const token = createApprovalToken(['ECS', 'DeleteServer', '--server_id=i-1']);
    assert.equal(confirmApprovalToken(token).status, 'confirmed');
    const file = join(home, '.config', 'huaweicloud', 'approvals.json');
    const map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    map[token] = { ...map[token]!, argsPinView: pinViewArgs(['ECS', 'DeleteServer', '--server_id=victim-9']) };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(map));

    const refused = (await runApprovalGate(
      'huaweicloud_run_approved_command',
      APPROVAL_SPECS.huaweicloud_run_approved_command,
      { approvedByUser: true, args: ['ECS', 'DeleteServer', '--server_id=victim-9'], approvalToken: token },
      {},
    )) as { envelope: Record<string, unknown> };
    assert.equal(refused.envelope.code, 'USER_CONFIRMATION_REQUIRED');
    assert.equal(inspectApprovalToken(token).state, 'valid', 'the refusal burned nothing');
  });
});

test('every roster entry resolves a spec and the roster names real tools', () => {
  for (const name of APPROVAL_TOOLS) {
    assert.ok(
      Object.hasOwn(APPROVAL_SPECS, name as ToolName),
      `roster tool ${name} has no ApprovalSpec — the registry satisfies check should have failed the build`,
    );
  }
  const names = new Set<string>(APPROVAL_TOOLS);
  for (const name of Object.keys(APPROVAL_SPECS)) {
    assert.ok(names.has(name), `spec for ${name} is not on the roster`);
  }
});
