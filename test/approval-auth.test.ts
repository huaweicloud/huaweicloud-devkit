import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { APPROVAL_SPECS } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import { APPROVAL_TOOLS } from '../plugins/huaweicloud-core/src/approval-roster.ts';
import { confirmApprovalToken } from '../plugins/huaweicloud-core/src/lib/approval-tokens.ts';
import {
  hasRuntimeCredentials,
  clearRuntimeCredentials,
  readGlobalCredentials,
  resolveCredentialsWithRuntime,
} from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { fingerprint } from '../plugins/huaweicloud-core/src/auth/reconcile.ts';
import { readConsentEvents } from '../plugins/huaweicloud-core/src/approval-ledger.ts';
import { AUTH_APPROVAL_SPECS } from '../plugins/huaweicloud-core/src/packs/auth/approval.ts';
import { vaultSet } from '../plugins/huaweicloud-core/src/lib/secret-vault/store.ts';
import { clearCustodyCache } from '../plugins/huaweicloud-core/src/lib/secret-vault/custody.ts';
import type {
  ElicitationSeam,
  ElicitFormRequest,
  ElicitOutcome,
} from '../plugins/huaweicloud-core/src/approval-types.ts';
import { withTempAuthHome } from './hcloud-cli-harness.ts';

// PR-3b's unit battery: the auth account-switch pair gates in both modes,
// the vendor gate fires first, and the account-aware summarize view holds.
// The two registrations answer one question — which account wins — through
// every confirmation surface, because the account switch is the step that
// can redirect every downstream approved write.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

const VENDOR = 'test: vendor established by the harness';
const AK = 'AKTESTACCOUNTSWITCH';
const SK = 'sk-test-secret-value-32chars-minimum!!';
const ACCOUNT = fingerprint(AK, SK);

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

// A fake confirmation client (the approval-gate battery's shape): `capable`
// may flip between calls, and every form the gate raises is captured.
function elicitingSeam(
  answer: ElicitOutcome | ((request: ElicitFormRequest) => ElicitOutcome),
  capable: boolean | (() => boolean) = true,
): { seam: ElicitationSeam; requests: ElicitFormRequest[] } {
  const requests: ElicitFormRequest[] = [];
  return {
    requests,
    seam: {
      get capable(): boolean {
        return typeof capable === 'function' ? capable() : capable;
      },
      async prompt(request) {
        requests.push(request);
        return typeof answer === 'function' ? answer(request) : answer;
      },
    },
  };
}

// A seam that must never be asked: used to prove a refusal floor runs
// BEFORE any confirmation surface exists (a raised form fails the test
// loudly instead of passing vacuously).
function neverSeam(): ElicitationSeam {
  return {
    capable: true,
    prompt: async () => {
      throw new Error('the confirmation form must never be raised for a refused shape');
    },
  };
}

function approvalsFile(home: string): string {
  return join(home, '.config', 'huaweicloud', 'approvals.json');
}

// Seed (and, for the swap probes, rewrite) the import channel under the
// isolated home — the shared preamble of every import-mode case below.
function importChannel(home: string): { write: (ak: string, sk: string, region?: string) => void; path: string } {
  const dir = join(home, '.config', 'huaweicloud');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'creds-import.json');
  return {
    path: file,
    write: (ak, sk, region) => {
      writeFileSync(file, JSON.stringify(region ? { ak, sk, region } : { ak, sk }));
    },
  };
}

function authInit(overrides: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
  return callTool('huaweicloud_auth_init', { vendorConfirmed: VENDOR, ak: AK, sk: SK, ...overrides }, opts);
}

function authSwitch(overrides: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
  return callTool(
    'huaweicloud_auth_switch',
    { vendorConfirmed: VENDOR, mode: 'memory', action: 'temporary', ak: AK, sk: SK, ...overrides },
    opts,
  );
}

// ── The roster and the registrations ────────────────────────────────────────

test('the auth pair joins the roster as always-gated gate-source registrations, and no other auth tool does', () => {
  // Membership and spec shape, never a roster COUNT or an exact roster
  // list (interrogate round 1, finding 7): the sibling registrations land
  // serially after this PR, and their rebases must only append, never
  // conflict here.
  assert.ok(APPROVAL_TOOLS.includes('huaweicloud_auth_init'), 'auth_init joins the roster');
  assert.ok(APPROVAL_TOOLS.includes('huaweicloud_auth_switch'), 'auth_switch joins the roster');
  assert.ok(APPROVAL_TOOLS.includes('huaweicloud_run_approved_command'), 'the run face stays on the roster');
  for (const name of ['huaweicloud_auth_init', 'huaweicloud_auth_switch'] as const) {
    const spec = APPROVAL_SPECS[name];
    assert.ok(spec, `${name} has a spec in the registry merge`);
    assert.equal(spec.flavor, 'always', `${name} gates every call`);
    assert.equal(spec.tokenSource, 'gate', `${name} mints at the gate, not a plan face`);
    assert.equal(spec.commandAnchor, undefined, `${name} executes no command line, so it declares no anchor`);
    assert.equal(spec.classify, undefined, `${name} is not classified: the human is required on every call`);
    assert.equal(
      typeof spec.assertArgsExecutable,
      'function',
      `${name} refuses the no-account and STS-persist shapes before any mint (NoDoomedToken)`,
    );
  }
  for (const unregistered of [
    'huaweicloud_auth_sync',
    'huaweicloud_auth_status',
    'huaweicloud_auth_confirm',
    'huaweicloud_check_account_type',
  ]) {
    assert.equal(
      (APPROVAL_SPECS as Partial<Record<string, unknown>>)[unregistered],
      undefined,
      `${unregistered} stays off the approval roster`,
    );
  }
});

// ── Token mode ──────────────────────────────────────────────────────────────

test('token mode: a no-token auth_init mints and returns USER_CONFIRMATION_REQUIRED with the account named, executing nothing', async () => {
  await withTempAuthHome(async (home) => {
    const result = (await authInit()) as {
      status: string;
      code: string;
      approvalToken?: string;
      userConfirmation?: { summary?: string; command?: string };
    };
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'USER_CONFIRMATION_REQUIRED');
    assert.match(result.approvalToken ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(
      (result.userConfirmation?.summary ?? '').includes(ACCOUNT),
      'the envelope summary names the target account fingerprint',
    );
    assert.match(result.userConfirmation?.command ?? '', /npx huaweicloud-devkit approve /);
    assert.equal(hasRuntimeCredentials(), false, 'the minted rejection set no runtime credentials');
    assert.equal(existsSync(approvalsFile(home)), true, 'the gate-source mint persists the token');
  });
});

test('token mode: confirm then retry with the token executes; the unconfirmed token refuses without burning', async () => {
  await withTempAuthHome(async () => {
    const minted = (await authInit()) as { approvalToken: string };
    const unconfirmed = (await authInit({ approvalToken: minted.approvalToken, approvedByUser: true })) as {
      status: string;
      code: string;
    };
    assert.equal(unconfirmed.code, 'USER_CONFIRMATION_REQUIRED', 'an unconfirmed token never executes');
    assert.equal(
      confirmApprovalToken(minted.approvalToken).status,
      'confirmed',
      'the refusal left the token confirmable',
    );
    const executed = (await authInit({ approvalToken: minted.approvalToken, approvedByUser: true })) as {
      status: string;
    };
    assert.equal(executed.status, 'ok');
    assert.equal(hasRuntimeCredentials(), true, 'the confirmed switch set the runtime credentials');
    const replay = (await authInit({ approvalToken: minted.approvalToken, approvedByUser: true })) as {
      outcome: string;
    };
    assert.equal(replay.outcome, 'already_processed', 'a consumed token reports already_processed');
  });
});

test('token mode: the same flow gates auth_switch, and the account swap on a confirmed token is refused', async () => {
  await withTempAuthHome(async () => {
    const minted = (await authSwitch({ action: 'persist', region: 'cn-north-4' })) as {
      approvalToken: string;
      userConfirmation: { summary: string };
    };
    assert.ok(minted.userConfirmation.summary.includes(ACCOUNT), 'the switch envelope names the account');
    assert.ok(
      minted.userConfirmation.summary.includes('session arguments'),
      'the switch envelope names the credential source',
    );
    assert.ok(minted.userConfirmation.summary.includes('persist'), 'the switch envelope names the apply scope');
    assert.equal(confirmApprovalToken(minted.approvalToken).status, 'confirmed');
    await assert.rejects(
      () =>
        authSwitch({
          action: 'persist',
          region: 'cn-north-4',
          approvalToken: minted.approvalToken,
          approvedByUser: true,
          ak: 'AKOTHERACCOUNT',
          sk: 'sk-other-account-value-32chars!!',
        }),
      /Provided args do not match the approved call|Secret values are pinned/,
      'a different account on the same approval never switches',
    );
    assert.equal(readGlobalCredentials()?.ak, undefined, 'the refused swap wrote nothing');
    // The mismatch refusal burns the consumed token (the claim precedes the
    // binding comparison), so the execution check mints its own.
    const second = (await authSwitch({ action: 'persist', region: 'cn-north-4' })) as { approvalToken: string };
    assert.equal(confirmApprovalToken(second.approvalToken).status, 'confirmed');
    const executed = (await authSwitch({
      action: 'persist',
      region: 'cn-north-4',
      approvalToken: second.approvalToken,
      approvedByUser: true,
    })) as { scope: string };
    assert.equal(executed.scope, 'persist', 'the exact approved call executes');
    // The KooCLI mirror leg spawns the real hcloud, so its completion is
    // environment-dependent ('ok' with a configured profile, 'partial'
    // without one); S1 — the switch's own effect — is the deterministic
    // evidence that the confirmed account landed.
    assert.equal(readGlobalCredentials()?.ak, AK, 'the confirmed switch wrote the approved account into S1');
    assert.equal(fingerprint(readGlobalCredentials()?.ak, readGlobalCredentials()?.sk), ACCOUNT);
  });
});

test('token mode: a missing approvedByUser attestation is refused before any mint or execution', async () => {
  await withTempAuthHome(async (home) => {
    await assert.rejects(
      () =>
        callTool('huaweicloud_auth_switch', {
          vendorConfirmed: VENDOR,
          mode: 'memory',
          action: 'persist',
          ak: AK,
          sk: SK,
          approvalToken: 'irrelevant-but-present',
        }),
      /approvedByUser must be true/,
    );
    assert.equal(existsSync(approvalsFile(home)), false, 'the attestation refusal mints nothing');
    assert.equal(hasRuntimeCredentials(), false);
  });
});

// ── Ask mode: the server-run ladder on both tiers ───────────────────────────

test('ask mode: a capable client answers the gate-raised form naming the account, and the accept executes with elicitation evidence', async () => {
  await withTempAuthHome(async () => {
    const { seam, requests } = elicitingSeam({ decision: 'accept', content: { confirm: true } });
    await withApprovalMode('ask', async () => {
      // The first ask-mode arrival carries no attestation: the gate, not a
      // prior chat, owns the confirmation.
      const result = (await authSwitch({ action: 'temporary' }, { elicitation: seam })) as { status: string };
      assert.equal(result.status, 'ok');
      assert.equal(hasRuntimeCredentials(), true, 'the accepted form executed the switch');
      assert.equal(requests.length, 1, 'exactly one form, raised by the gate');
      const form = requests[0]!;
      assert.ok(form.message.includes(ACCOUNT), 'the form body names the target account fingerprint');
      assert.ok(form.message.includes('session arguments'), 'the form body names the credential source');
      assert.ok(form.message.includes('temporary'), 'the form body names the apply scope');
      const events = readConsentEvents();
      assert.equal(events.length, 1);
      assert.equal(events[0]!.evidence, 'elicitation', 'the accept is recorded as elicitation evidence');
      assert.equal(events[0]!.tool, 'huaweicloud_auth_switch');
      assert.ok((events[0]!.command ?? '').includes(ACCOUNT), 'the consent row pins the account in its command line');
    });
  });
});

test('ask mode: a declined form refuses fail-closed — nothing executes, nothing recorded, nothing minted', async () => {
  await withTempAuthHome(async (home) => {
    const { seam, requests } = elicitingSeam({ decision: 'decline' });
    await withApprovalMode('ask', async () => {
      const result = (await authInit({}, { elicitation: seam })) as { status: string; code: string };
      assert.equal(result.status, 'rejected');
      assert.equal(result.code, 'ELICITATION_DECLINED');
      assert.equal(hasRuntimeCredentials(), false, 'nothing ran');
      assert.equal(readConsentEvents().length, 0, 'no consent row for a refusal');
      assert.equal(existsSync(approvalsFile(home)), false, 'ask mode mints nothing');
      assert.equal(requests.length, 1);
    });
  });
});

test('ask mode: a non-capable client gets the T3 envelope naming the account, and the attested retry executes on posture', async () => {
  await withTempAuthHome(async () => {
    const sessionId = `t3-auth-${Date.now()}`;
    await withApprovalMode('ask', async () => {
      const envelope = (await authInit({}, { sessionId })) as {
        status: string;
        code: string;
        userConfirmation: { command: string; summary: string };
        argsHash: string;
      };
      assert.equal(envelope.status, 'rejected');
      assert.equal(envelope.code, 'ASK_CONFIRMATION_REQUIRED');
      assert.ok(envelope.userConfirmation.command.includes(ACCOUNT), 'the envelope names the target account');
      assert.ok(envelope.userConfirmation.summary.includes(ACCOUNT), 'the envelope summary names the target account');
      // The ritual must precede the execution: an attested call whose line
      // was never shown gets the envelope again, not an execution.
      const premature = (await authInit({ approvedByUser: true }, { sessionId: `other-${sessionId}` })) as {
        code: string;
      };
      assert.equal(premature.code, 'ASK_CONFIRMATION_REQUIRED', 'a pre-attested first call never executes');
      const retried = (await authInit({ approvedByUser: true }, { sessionId })) as { status: string };
      assert.equal(retried.status, 'ok', 'the retry whose envelope was shown executes');
      assert.equal(hasRuntimeCredentials(), true);
      const events = readConsentEvents();
      assert.equal(events[0]!.evidence, 'posture', 'the chat round-trip retry is posture trust, labeled so');
      assert.ok((events[0]!.command ?? '').includes(ACCOUNT), 'the posture row carries the account line the user read');
    });
  });
});

test('ask mode: a caller-stuffed command field never becomes the confirmation line for a no-anchor tool', async () => {
  await withTempAuthHome(async () => {
    const { seam, requests } = elicitingSeam({ decision: 'decline' });
    await withApprovalMode('ask', async () => {
      await authInit({ command: 'rm -rf /tmp/innocent' }, { elicitation: seam });
      const form = requests[0]!;
      assert.ok(
        !form.message.includes('rm -rf'),
        'a stuffed command string must not pose as the approved action for a tool that executes no command',
      );
      assert.ok(form.message.includes(ACCOUNT), 'the form shows the account switch, the real effect');
    });
  });
});

test('ask mode: an import-mode switch binds the import file\u2019s account — a swapped file re-asks instead of executing on the old approval', async () => {
  await withTempAuthHome(async (home) => {
    const channel = importChannel(home);
    channel.write('AKIMPORTONE', 'sk-import-one-value-32-chars!!!', 'cn-north-4');
    const sessionId = `import-auth-${Date.now()}`;
    await withApprovalMode('ask', async () => {
      const first = (await authSwitch(
        { mode: 'import', action: 'temporary', ak: undefined, sk: undefined },
        { sessionId },
      )) as { userConfirmation: { command: string } };
      assert.ok(
        first.userConfirmation.command.includes(fingerprint('AKIMPORTONE', 'sk-import-one-value-32-chars!!!')),
        'the envelope names the import file\u2019s account, so the human sees which account wins',
      );
      channel.write('AKIMPORTTWO', 'sk-import-two-value-32-chars!!!', 'cn-north-4');
      const swapped = (await authSwitch(
        { mode: 'import', action: 'temporary', ak: undefined, sk: undefined, approvedByUser: true },
        { sessionId },
      )) as { code: string; userConfirmation: { command: string } };
      assert.equal(swapped.code, 'ASK_CONFIRMATION_REQUIRED', 'a swapped file invalidates the shown approval');
      assert.ok(
        swapped.userConfirmation.command.includes(fingerprint('AKIMPORTTWO', 'sk-import-two-value-32-chars!!!')),
        'the fresh envelope names the new account',
      );
    });
  });
});

// ── The shown account is the executed account (round 1, finding 2) ─────────

test('TOCTOU: a vault swap behind the init refs never executes — the shown account switches (round 2, the twin path)', async () => {
  // The r2 seat's exact drive: auth_init with secret:// refs mints showing
  // the fingerprint of the RESOLVED account (not the ref strings), the
  // vault values are swapped behind the same refs after the confirm, and
  // the retry with the token refuses — the refs are unchanged but the
  // binding hashes the resolved values, so the swapped vault invalidates
  // the approval and re-asks instead of executing an account that
  // appeared on no surface.
  const AK_REF = 'secret://user/r2-ak';
  const SK_REF = 'secret://user/r2-sk';
  const accountA = { ak: 'AKACCOUNTA', sk: 'sk-account-a-value-32-chars!!' };
  const accountB = { ak: 'AKACCOUNTB', sk: 'sk-account-b-value-32-chars!!' };
  const fpA = fingerprint(accountA.ak, accountA.sk);
  const fpB = fingerprint(accountB.ak, accountB.sk);
  const previousKey = process.env.HW_VAULT_MASTER_KEY;
  process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x55).toString('base64');
  clearCustodyCache();
  try {
    await withTempAuthHome(async (home) => {
      vaultSet(AK_REF, accountA.ak);
      vaultSet(SK_REF, accountA.sk);
      const minted = (await callTool('huaweicloud_auth_init', {
        vendorConfirmed: VENDOR,
        ak: AK_REF,
        sk: SK_REF,
        region: 'cn-north-4',
      })) as { code: string; approvalToken: string; userConfirmation: { summary: string } };
      assert.equal(minted.code, 'USER_CONFIRMATION_REQUIRED');
      assert.ok(
        minted.userConfirmation.summary.includes(fpA),
        'the envelope names the RESOLVED account\u2019s fingerprint, never the ref strings\u2019 hash',
      );
      assert.ok(!minted.userConfirmation.summary.includes(fpB));

      assert.equal(confirmApprovalToken(minted.approvalToken).status, 'confirmed');
      vaultSet(AK_REF, accountB.ak);
      vaultSet(SK_REF, accountB.sk);
      await assert.rejects(
        () =>
          callTool('huaweicloud_auth_init', {
            vendorConfirmed: VENDOR,
            ak: AK_REF,
            sk: SK_REF,
            region: 'cn-north-4',
            approvalToken: minted.approvalToken,
            approvedByUser: true,
          }),
        /do not match the approved call|Secret values are pinned/,
        'the vault swap behind the same refs invalidates the approval',
      );
      assert.equal(hasRuntimeCredentials(), false, 'the unseen account never executed');
      assert.equal(readGlobalCredentials()?.ak, undefined, 'S1 untouched');

      // The re-ask names the new account: a fresh call shows fpB, so the
      // human sees exactly which account the next approval would switch to.
      const reminted = (await callTool('huaweicloud_auth_init', {
        vendorConfirmed: VENDOR,
        ak: AK_REF,
        sk: SK_REF,
        region: 'cn-north-4',
      })) as { userConfirmation: { summary: string } };
      assert.ok(reminted.userConfirmation.summary.includes(fpB), 'the fresh envelope names the new account');
    });
  } finally {
    clearCustodyCache();
    if (previousKey === undefined) delete process.env.HW_VAULT_MASTER_KEY;
    else process.env.HW_VAULT_MASTER_KEY = previousKey;
  }
});

test('TOCTOU: the init ask-mode window closes the same way — a vault swap inside the form executes the shown account', async () => {
  const AK_REF = 'secret://user/r2c-ak';
  const SK_REF = 'secret://user/r2c-sk';
  const accountA = { ak: 'AKSHOWNAK', sk: 'sk-shown-value-32-chars!!!!' };
  const accountB = { ak: 'AKHIDDENK', sk: 'sk-hidden-value-32-chars!!!' };
  const fpA = fingerprint(accountA.ak, accountA.sk);
  const previousKey = process.env.HW_VAULT_MASTER_KEY;
  process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x55).toString('base64');
  clearCustodyCache();
  try {
    await withTempAuthHome(async () => {
      vaultSet(AK_REF, accountA.ak);
      vaultSet(SK_REF, accountA.sk);
      const seam: ElicitationSeam = {
        capable: true,
        prompt: async (request) => {
          assert.ok(request.message.includes(fpA), 'the form shows the resolved account A');
          vaultSet(AK_REF, accountB.ak);
          vaultSet(SK_REF, accountB.sk);
          return { decision: 'accept', content: { confirm: true } };
        },
      };
      await withApprovalMode('ask', async () => {
        await authInit({ ak: AK_REF, sk: SK_REF }, { elicitation: seam });
        const runtime = resolveCredentialsWithRuntime({}) as { ak?: string };
        assert.equal(runtime.ak, accountA.ak, 'the shown account executed, never the swapped one');
      });
    });
  } finally {
    clearCustodyCache();
    if (previousKey === undefined) delete process.env.HW_VAULT_MASTER_KEY;
    else process.env.HW_VAULT_MASTER_KEY = previousKey;
  }
});

test('no doomed mints: an unresolvable ref on auth_init refuses before any mint (the F4 class)', async () => {
  const previousKey = process.env.HW_VAULT_MASTER_KEY;
  process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x55).toString('base64');
  clearCustodyCache();
  try {
    await withTempAuthHome(async (home) => {
      await assert.rejects(
        () => authInit({ ak: 'secret://user/never-stored', sk: 'secret://user/also-never' }),
        (error: unknown) => {
          assert.match(error instanceof Error ? error.message : String(error), /secret|vault|resolve/i);
          return true;
        },
      );
      assert.equal(existsSync(approvalsFile(home)), false, 'the unresolvable ref mints nothing');
      assert.equal(readConsentEvents().length, 0, 'no consent row exists for the refused shape');
    });
  } finally {
    clearCustodyCache();
    if (previousKey === undefined) delete process.env.HW_VAULT_MASTER_KEY;
    else process.env.HW_VAULT_MASTER_KEY = previousKey;
  }
});

test('round 2 opportunistic: a regionless persist refuses before any consent, in both modes of the gate', async () => {
  await withTempAuthHome(async (home) => {
    await assert.rejects(
      () => authSwitch({ action: 'persist', region: undefined }),
      /region is required to persist credentials/,
    );
    assert.equal(existsSync(approvalsFile(home)), false, 'the regionless persist mints nothing');
    await withApprovalMode('ask', async () => {
      await assert.rejects(
        () => authSwitch({ action: 'persist', region: undefined }, { elicitation: neverSeam() }),
        /region is required to persist credentials/,
        'the ask-mode floor refuses before the form is ever raised',
      );
    });
    assert.equal(readConsentEvents().length, 0, 'the human was never asked');
  });
});

// ── The shown account is the executed account (round 1, finding 2) ─────────

test('TOCTOU: a file rewritten inside the form window never executes — the shown account switches', async () => {
  // The seat's exact repro: the form shows account A (the import file's
  // fingerprint), the attacker rewrites creds-import.json to account B
  // while the human reads the form, the accept executes — and what lands
  // is A, never B. The gate threads the PRE-FORM resolved snapshot into
  // the handler, so the handler never re-reads the file after consent.
  await withTempAuthHome(async (home) => {
    const channel = importChannel(home);
    const accountA = { ak: 'AKATTACKERA', sk: 'sk-attacker-a-value-32-chars!!' };
    const accountB = { ak: 'AKATTACKERB', sk: 'sk-attacker-b-value-32-chars!!' };
    const fpA = fingerprint(accountA.ak, accountA.sk);
    const fpB = fingerprint(accountB.ak, accountB.sk);
    channel.write(accountA.ak, accountA.sk, 'cn-north-4');

    const requests: Array<{ message: string }> = [];
    const seam: ElicitationSeam = {
      capable: true,
      prompt: async (request) => {
        // The rewrite lands INSIDE the prompt window — after the form was
        // raised with A on it, before the human answers.
        assert.ok(request.message.includes(fpA), 'the form shows account A');
        channel.write(accountB.ak, accountB.sk, 'cn-north-4');
        requests.push(request);
        return { decision: 'accept', content: { confirm: true } };
      },
    };
    await withApprovalMode('ask', async () => {
      const result = (await authSwitch(
        { mode: 'import', action: 'temporary', ak: undefined, sk: undefined },
        { elicitation: seam },
      )) as {
        status: string;
      };
      assert.equal(result.status, 'ok');
      const runtime = resolveCredentialsWithRuntime({}) as { ak?: string; sk?: string };
      assert.equal(runtime.ak, accountA.ak, 'the shown account A executed, never the rewritten B');
      assert.equal(runtime.sk, accountA.sk);
      const events = readConsentEvents();
      assert.ok((events[0]!.command ?? '').includes(fpA), 'the consent row pins the account the human read');
      assert.ok(!JSON.stringify(events[0]).includes(fpB), 'the rewritten account appears nowhere');
      assert.ok(requests.length === 1);
    });
  });
});

test('TOCTOU: the mcp-config channel has the same fix — an injected-config rewrite inside the form window executes the shown account', async () => {
  await withTempAuthHome(async (home) => {
    const codeartsDir = join(home, 'codearts', '.codeartsdoer', 'mcp');
    mkdirSync(codeartsDir, { recursive: true });
    const settingsFile = join(codeartsDir, 'mcp_settings.json');
    const writeSettings = (ak: string, sk: string): void => {
      writeFileSync(
        settingsFile,
        JSON.stringify({
          mcpServers: {
            'huaweicloud-devkit': { env: { HW_ACCESS_KEY: ak, HW_SECRET_KEY: sk, HW_REGION: 'cn-north-4' } },
          },
        }),
      );
    };
    const accountA = { ak: 'MCPSHOWNAK', sk: 'sk-mcp-shown-value-32-chars!!' };
    const accountB = { ak: 'MCPHIDDENK', sk: 'sk-mcp-hidden-value-32-cha!' };
    const fpA = fingerprint(accountA.ak, accountA.sk);
    writeSettings(accountA.ak, accountA.sk);
    const previousCodearts = process.env.CODEARTS_PROJECT_DIR;
    process.env.CODEARTS_PROJECT_DIR = join(home, 'codearts');

    const seam: ElicitationSeam = {
      capable: true,
      prompt: async (request) => {
        assert.ok(request.message.includes(fpA), 'the form shows the injected account A');
        writeSettings(accountB.ak, accountB.sk);
        return { decision: 'accept', content: { confirm: true } };
      },
    };
    try {
      await withApprovalMode('ask', async () => {
        await authSwitch(
          { mode: 'mcp-config', action: 'temporary', ak: undefined, sk: undefined },
          { elicitation: seam },
        );
        const runtime = resolveCredentialsWithRuntime({}) as { ak?: string };
        assert.equal(runtime.ak, accountA.ak, 'the shown account executed, never the rewritten one');
      });
    } finally {
      if (previousCodearts === undefined) delete process.env.CODEARTS_PROJECT_DIR;
      else process.env.CODEARTS_PROJECT_DIR = previousCodearts;
    }
  });
});

test('finding 3: the resolved region and STS ride the binding — a same-fingerprint region swap re-asks instead of executing', async () => {
  // Same account (fingerprint identical), different region: the binding
  // folds the resolved region, so the shown approval is invalidated and
  // the retry gets a fresh envelope naming the new region — never a
  // region switch under the old approval.
  await withTempAuthHome(async (home) => {
    const channel = importChannel(home);
    channel.write('AKREGIONBOUND', 'sk-region-bound-value-32!!', 'cn-north-4');
    const sessionId = `region-auth-${Date.now()}`;
    await withApprovalMode('ask', async () => {
      const first = (await authSwitch(
        { mode: 'import', action: 'temporary', ak: undefined, sk: undefined },
        { sessionId },
      )) as { userConfirmation: { command: string } };
      assert.ok(
        first.userConfirmation.command.includes('cn-north-4'),
        'the envelope names the resolved region, so the human sees where the switch lands',
      );
      channel.write('AKREGIONBOUND', 'sk-region-bound-value-32!!', 'ap-southeast-1');
      const swapped = (await authSwitch(
        { mode: 'import', action: 'temporary', ak: undefined, sk: undefined, approvedByUser: true },
        { sessionId },
      )) as { code: string; userConfirmation: { command: string } };
      assert.equal(swapped.code, 'ASK_CONFIRMATION_REQUIRED', 'a region swap invalidates the shown approval');
      assert.ok(swapped.userConfirmation.command.includes('ap-southeast-1'), 'the fresh envelope names the new region');
      assert.equal(hasRuntimeCredentials(), false, 'nothing executed on the stale approval');
    });
  });
});

// ── NoDoomedToken: no mint for shapes the execution would refuse (round 1, finding 4) ──

test('no doomed mints: an ak-less auth_init refuses before any mint and nothing is approved', async () => {
  await withTempAuthHome(async (home) => {
    await assert.rejects(
      () => authInit({ ak: undefined, sk: undefined }),
      /ak and sk are required to set runtime credentials/,
    );
    assert.equal(existsSync(approvalsFile(home)), false, 'the refused call mints nothing');
    assert.equal(readConsentEvents().length, 0, 'no consent row exists for a refused shape');
    assert.equal(hasRuntimeCredentials(), false);
  });
});

test('no doomed mints: a switch with no resolvable account refuses before any mint and the malformed import file survives', async () => {
  await withTempAuthHome(async (home) => {
    const channel = importChannel(home);
    writeFileSync(channel.path, '{not-valid-json', 'utf8');
    await assert.rejects(
      () => authSwitch({ mode: 'import', action: 'temporary', ak: undefined, sk: undefined }),
      /no resolvable target account/,
    );
    assert.equal(existsSync(approvalsFile(home)), false, 'the unresolvable switch mints nothing');
    assert.equal(
      existsSync(channel.path),
      true,
      'the gate peeks without wiping: a refused call never mutates the file',
    );
    assert.equal(hasRuntimeCredentials(), false);
  });
});

test('no doomed mints: an STS persist refuses before any consent (R3), in both channels', async () => {
  await withTempAuthHome(async (home) => {
    await assert.rejects(
      () => authSwitch({ action: 'persist', securityToken: 'STS-DOOMED-TOKEN', region: 'cn-north-4' }),
      /R3/,
    );
    assert.equal(existsSync(approvalsFile(home)), false, 'the unexecutable persist mints nothing');
    const channel = importChannel(home);
    channel.write('AKDOOMEDSTS', 'sk-doomed-sts-value-32-chars!', 'cn-north-4');
    // The STS token rides the import file the way the CLI accepts it.
    const stored = JSON.parse(readFileSync(channel.path, 'utf8')) as Record<string, unknown>;
    stored.securityToken = 'STS-DOOMED-2';
    writeFileSync(channel.path, JSON.stringify(stored));
    await assert.rejects(() => authSwitch({ mode: 'import', action: 'persist', ak: undefined, sk: undefined }), /R3/);
    assert.equal(readConsentEvents().length, 0, 'the human was never asked to approve an unexecutable switch');
  });
});

// ── The vendor gate stays first ─────────────────────────────────────────────

test('the vendor gate fires before every approval interaction: no quote, no challenge pass, nothing minted', async () => {
  await withTempAuthHome(async (home) => {
    // The challenge is ON for this test and the session is fresh, so the
    // first asserted call bounces on the quote challenge — the approval
    // gate never engages, no token is minted, no consent row exists.
    const previousChallenge = process.env.HUAWEICLOUD_VENDOR_CHALLENGE;
    delete process.env.HUAWEICLOUD_VENDOR_CHALLENGE;
    const sessionId = `vendor-first-${Date.now()}`;
    try {
      await assert.rejects(
        () => callTool('huaweicloud_auth_init', { vendorConfirmed: VENDOR, ak: AK, sk: SK }, { sessionId }),
        /Vendor challenge/,
      );
      assert.equal(existsSync(approvalsFile(home)), false, 'the vendor bounce mints nothing');
      assert.equal(readConsentEvents().length, 0, 'the vendor bounce records no consent');
      assert.equal(hasRuntimeCredentials(), false);
      await assert.rejects(
        () => callTool('huaweicloud_auth_switch', { ak: AK, sk: SK }, { sessionId: `noquote-${sessionId}` }),
        /Vendor gate/,
      );
      // The same challenged call completes on the retry: the bounce is the
      // decision-time interrupt, and the approval flow starts only after
      // the vendor question is settled (here it mints, proving the gate
      // was reached on the very next call).
      const minted = (await callTool(
        'huaweicloud_auth_init',
        { vendorConfirmed: VENDOR, ak: AK, sk: SK },
        { sessionId },
      )) as {
        code: string;
        approvalToken: string;
      };
      assert.equal(minted.code, 'USER_CONFIRMATION_REQUIRED', 'after the vendor question the approval gate engages');
    } finally {
      if (previousChallenge === undefined) process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';
      else process.env.HUAWEICLOUD_VENDOR_CHALLENGE = previousChallenge;
    }
  });
});

// ── The unregistered neighbors ──────────────────────────────────────────────

test('auth_confirm stays ungated: its pendingConfirms flow is the only confirmation it asks', async () => {
  await withTempAuthHome(async () => {
    const result = (await callTool('huaweicloud_auth_confirm', { token: 'never-minted', decision: 's1' })) as {
      status: string;
      code: string;
    };
    assert.deepEqual(result, { status: 'rejected', code: 'CONFIRM_TOKEN_NOT_FOUND' });
    // In ask mode with a capable seam the gate would have raised a form;
    // the seam records nothing because no approval gate covers this tool.
    const { seam, requests } = elicitingSeam({ decision: 'accept', content: { confirm: true } });
    await withApprovalMode('ask', async () => {
      const asked = (await callTool(
        'huaweicloud_auth_confirm',
        { token: 'never-minted', decision: 's1' },
        { elicitation: seam },
      )) as { code: string };
      assert.equal(asked.code, 'CONFIRM_TOKEN_NOT_FOUND');
      assert.equal(requests.length, 0, 'no approval surface for the unregistered confirm face');
    });
  });
});

test('auth_status stays ungated: no approval envelope, no attestation demand', async () => {
  await withTempAuthHome(async () => {
    const result = (await callTool('huaweicloud_auth_status', { vendorConfirmed: VENDOR })) as {
      credentialPanel?: unknown;
      status?: string;
      code?: string;
    };
    assert.equal(result.status, undefined, 'auth_status returns its normal shape, not an approval envelope');
    assert.equal(result.code, undefined);
    assert.ok(result.credentialPanel, 'auth_status answers with its credential panel');
  });
});

// ── The account-aware summarize view ────────────────────────────────────────

test('the summarize views name the account and the credential source, and never leak the raw credentials', () => {
  const initView = AUTH_APPROVAL_SPECS.huaweicloud_auth_init.summarize({
    ak: AK,
    sk: SK,
    region: 'cn-north-4',
    account: ACCOUNT,
  });
  assert.ok(initView.summary.includes(ACCOUNT));
  assert.ok(initView.summary.includes('cn-north-4'), 'the region rides the view when sent');
  assert.ok(!initView.summary.includes(SK), 'the summary never carries the secret key');
  assert.ok(!JSON.stringify(initView.pinView).includes(SK), 'the pin view never carries the secret key');

  const clearView = AUTH_APPROVAL_SPECS.huaweicloud_auth_init.summarize({ clear: true });
  assert.ok(clearView.summary.includes('clear'), 'the clear call says it clears');

  const switchView = AUTH_APPROVAL_SPECS.huaweicloud_auth_switch.summarize({
    mode: 'import',
    action: 'persist',
    ak: '',
    sk: '',
    account: 'deadbeef',
  });
  assert.ok(switchView.summary.includes('deadbeef'));
  assert.ok(switchView.summary.includes('creds-import.json'), 'the import source is named');
  assert.ok(switchView.summary.includes('persist'), 'the persist scope is named');
  assert.deepEqual(switchView.pinView, { account: 'deadbeef', source: 'import', scope: 'persist' });

  // The G1 shape: a foreign binding (the round-10 battery feeds every
  // registered spec a secret-bearing array) must neither crash nor leak.
  const foreign = AUTH_APPROVAL_SPECS.huaweicloud_auth_switch.summarize([
    'CSMS',
    'CreateSecret',
    '--secret_string=leak',
  ]);
  assert.ok(!JSON.stringify(foreign).includes('leak'), 'a foreign binding leaks nothing');
});

test('the normalizeArgs binding folds the consent plumbing away: an attested retry hashes as the arrival', () => {
  const init = AUTH_APPROVAL_SPECS.huaweicloud_auth_init;
  const arrival = init.normalizeArgs?.({ vendorConfirmed: VENDOR, ak: AK, sk: SK, region: 'cn-north-4' });
  const retry = init.normalizeArgs?.({
    vendorConfirmed: VENDOR,
    ak: AK,
    sk: SK,
    region: 'cn-north-4',
    approvedByUser: true,
  });
  assert.deepEqual(retry, arrival, 'the chat round-trip retry binds identically to the shown envelope');
  assert.ok(!('vendorConfirmed' in (retry as object)), 'the vendor quote never rides the binding');
});

test.afterEach(() => {
  clearRuntimeCredentials();
});
