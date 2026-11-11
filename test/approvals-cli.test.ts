import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';

import { runApproveCommand, runPinCommand, type ApproveIo } from '../plugins/huaweicloud-core/src/approvals-cli.ts';
import {
  confirmApprovalToken,
  consumeApprovalToken,
  createApprovalToken,
  inspectApprovalToken,
} from '../plugins/huaweicloud-core/src/lib/approval-tokens.ts';
import {
  enrollApprovalsPin,
  isApprovalsPinEnrolled,
  verifyApprovalsPin,
} from '../plugins/huaweicloud-core/src/lib/approvals-pin.ts';
import { clearCustodyCache } from '../plugins/huaweicloud-core/src/lib/secret-vault/custody.ts';
import { fixtureDir } from './fixture-dir.ts';

// The terminal confirm command is the human half of the approval gate: it
// refuses non-interactive callers and records a user confirmation only after
// the PIN check. These tests drive the real command body through an injected
// terminal, so the refusal and the PIN paths are observable without a TTY.

const TEST_MASTER_KEY = Buffer.alloc(32, 0x33).toString('base64');
const ENROLLED_PIN = 'pin-correct-42';

// A fresh vault-backed home per test: no token and no PIN survive across
// cases, and the fixed env master key keeps the custody tier deterministic.
function withVaultHome(fn: () => void | Promise<unknown>): () => Promise<void> {
  return async () => {
    const previousHome = process.env.HUAWEICLOUD_HOME;
    const previousKey = process.env.HW_VAULT_MASTER_KEY;
    process.env.HUAWEICLOUD_HOME = fixtureDir('approvals-cli-home-');
    process.env.HW_VAULT_MASTER_KEY = TEST_MASTER_KEY;
    clearCustodyCache();
    try {
      await fn();
    } finally {
      clearCustodyCache();
      if (previousHome === undefined) delete process.env.HUAWEICLOUD_HOME;
      else process.env.HUAWEICLOUD_HOME = previousHome;
      if (previousKey === undefined) delete process.env.HW_VAULT_MASTER_KEY;
      else process.env.HW_VAULT_MASTER_KEY = previousKey;
    }
  };
}

interface ScriptedIo {
  io: ApproveIo;
  output: () => string;
}

function scriptedIo(responses: string[], opts: { isTTY?: boolean } = {}): ScriptedIo {
  const chunks: string[] = [];
  let index = 0;
  const io: ApproveIo = {
    isTTY: opts.isTTY ?? true,
    write: (text) => {
      chunks.push(text);
    },
    readLine: async () => responses[index++] ?? '',
  };
  return {
    io,
    output: () => chunks.join(''),
  };
}

function approvalsFile(): string {
  return join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud', 'approvals.json');
}

function entryState(token: string): string | undefined {
  return inspectApprovalToken(token).entry?.state;
}

test(
  'approve with no token prints the usage line and exits 1',
  withVaultHome(async () => {
    const terminal = scriptedIo([]);
    assert.equal(await runApproveCommand([], terminal.io), 1);
    assert.match(terminal.output(), /Usage: npx huaweicloud-devkit approve <token>/);
  }),
);

test(
  'approve refuses positional extras and flag-shaped tokens',
  withVaultHome(async () => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const extra = scriptedIo([ENROLLED_PIN]);
    assert.equal(await runApproveCommand([token, '--yes'], extra.io), 1);
    assert.match(extra.output(), /Usage:/);
    assert.equal(entryState(token), 'awaiting_user', 'a rejected invocation records nothing');

    const flag = scriptedIo([ENROLLED_PIN]);
    assert.equal(await runApproveCommand(['--pin', '123456'], flag.io), 1);
    assert.match(flag.output(), /Usage:/);
  }),
);

test(
  'approve reports an unknown token without touching any state',
  withVaultHome(async () => {
    const terminal = scriptedIo([]);
    assert.equal(await runApproveCommand([randomUUID()], terminal.io), 1);
    assert.match(terminal.output(), /No pending approval matches that token/);
    assert.equal(isApprovalsPinEnrolled(), false, 'the refusal happens before any PIN prompt');
  }),
);

test(
  'approve reports an expired token and asks for a re-plan',
  withVaultHome(async () => {
    const token = createApprovalToken(['ECS', 'DeleteServer', '--server_id=x']);
    const store = JSON.parse(readFileSync(approvalsFile(), 'utf8')) as Record<string, { createdAt: number }>;
    store[token]!.createdAt = Date.now() - 6 * 60_000;
    writeFileSync(approvalsFile(), JSON.stringify(store));

    const terminal = scriptedIo([]);
    assert.equal(await runApproveCommand([token], terminal.io), 1);
    assert.match(terminal.output(), /expired/);
    assert.match(terminal.output(), /plan the command again/);
  }),
);

test(
  'approve treats an already-consumed token as a non-error for the human',
  withVaultHome(async () => {
    const token = createApprovalToken(['ECS', 'DeleteServer']);
    assert.equal(consumeApprovalToken(token).status, 'consumed');

    const terminal = scriptedIo([]);
    assert.equal(await runApproveCommand([token], terminal.io), 0);
    assert.match(terminal.output(), /already used/);
  }),
);

test(
  'approve refuses a non-TTY without prompting and leaves the entry awaiting',
  withVaultHome(async () => {
    const token = createApprovalToken(['ECS', 'DeleteServer', '--server_id=x']);
    const terminal = scriptedIo([ENROLLED_PIN], { isTTY: false });

    assert.equal(await runApproveCommand([token], terminal.io), 1);
    const output = terminal.output();
    assert.match(output, /Confirming: hcloud ECS DeleteServer --server_id=x/);
    assert.match(output, /authorizes ONE execution of exactly this command/);
    assert.match(output, /must be confirmed in your own interactive terminal/);
    assert.doesNotMatch(output, /PIN/, 'no prompt may reach a non-TTY caller');
    assert.equal(entryState(token), 'awaiting_user', 'the refused entry is not confirmed');
    assert.equal(isApprovalsPinEnrolled(), false);
  }),
);

test(
  'approve renders a non-array payload as JSON and still refuses a non-TTY',
  withVaultHome(async () => {
    const token = createApprovalToken({ tool: 'execute_api', toolArgs: { product: 'ECS' } });
    const terminal = scriptedIo([], { isTTY: false });
    assert.equal(await runApproveCommand([token], terminal.io), 1);
    assert.match(terminal.output(), /Confirming: \{.*execute_api/);
    assert.doesNotMatch(terminal.output(), /Confirming: hcloud/);
  }),
);

test(
  'F3: approve refuses when no PIN is enrolled, teaches the pin command, and records nothing',
  withVaultHome(async () => {
    const token = createApprovalToken(['ECS', 'DeleteServer', '--server_id=x']);
    // No flags, no prompts: the refusal must point the human at the separate
    // enrollment step before anything is asked or written.
    const terminal = scriptedIo([]);
    assert.equal(await runApproveCommand([token], terminal.io), 1);
    assert.match(terminal.output(), /npx huaweicloud-devkit pin/, 'the refusal names the enrollment command');
    assert.doesNotMatch(terminal.output(), /Choose a PIN/, 'the refusal never prompts');
    assert.equal(isApprovalsPinEnrolled(), false, 'the refusal enrolls nothing');
    assert.equal(entryState(token), 'awaiting_user', 'the entry is not confirmed');

    // After the user enrolls via the pin command, the same approval confirms.
    const enroll = scriptedIo([ENROLLED_PIN, ENROLLED_PIN]);
    assert.equal(await runPinCommand([], enroll.io), 0);
    const confirm = scriptedIo([ENROLLED_PIN]);
    assert.equal(await runApproveCommand([token], confirm.io), 0);
    assert.equal(entryState(token), 'user_confirmed');
  }),
);

test(
  'the pin command enrolls through the injected io: a mismatched re-type retries, then enrolls',
  withVaultHome(async () => {
    const terminal = scriptedIo(['first-choice', 'typo-re-type', ENROLLED_PIN, ENROLLED_PIN]);
    assert.equal(await runPinCommand([], terminal.io), 0);
    assert.match(terminal.output(), /PINs did not match, try again/);
    assert.ok(isApprovalsPinEnrolled(), 'the second pair enrolls the PIN');
    assert.equal(verifyApprovalsPin(ENROLLED_PIN).ok, true);
    assert.match(terminal.output(), /Approvals PIN enrolled/);
  }),
);

test(
  'the pin command refuses a non-TTY without prompting',
  withVaultHome(async () => {
    const terminal = scriptedIo([ENROLLED_PIN], { isTTY: false });
    assert.equal(await runPinCommand([], terminal.io), 1);
    assert.match(terminal.output(), /own interactive terminal/);
    assert.doesNotMatch(terminal.output(), /Choose a PIN/, 'no prompt may reach a non-TTY caller');
    assert.equal(isApprovalsPinEnrolled(), false, 'a refused enrollment persists nothing');
  }),
);

test(
  'the pin command refuses flags and extra argv, then two mismatched re-types abort without persisting',
  withVaultHome(async () => {
    const flagged = scriptedIo([]);
    assert.equal(await runPinCommand(['--pin', '123456'], flagged.io), 1);
    assert.match(flagged.output(), /Usage: npx huaweicloud-devkit pin/);

    const terminal = scriptedIo(['first-choice', 'typo-one', 'second-choice', 'typo-two']);
    assert.equal(await runPinCommand([], terminal.io), 1);
    assert.equal(isApprovalsPinEnrolled(), false, 'the aborted enrollment persists nothing');
  }),
);

test(
  'the pin command re-enrolls: the old pin stops verifying, the new one starts',
  withVaultHome(async () => {
    const first = scriptedIo(['first-pin-99', 'first-pin-99']);
    assert.equal(await runPinCommand([], first.io), 0);
    const second = scriptedIo(['second-pin-77', 'second-pin-77']);
    assert.equal(await runPinCommand([], second.io), 0);
    assert.equal(verifyApprovalsPin('first-pin-99').ok, false, 're-enroll overwrites (the recovery path)');
    assert.equal(verifyApprovalsPin('second-pin-77').ok, true);
  }),
);

test(
  'an enrolled PIN confirms on the first correct attempt',
  withVaultHome(async () => {
    assert.equal(enrollApprovalsPin(ENROLLED_PIN).ok, true);
    const token = createApprovalToken(['OBS', 'rm', 'obs://bucket/key']);
    const terminal = scriptedIo([ENROLLED_PIN]);

    assert.equal(await runApproveCommand([token], terminal.io), 0);
    assert.equal(entryState(token), 'user_confirmed');
    assert.match(terminal.output(), /The agent may now run this command once/);
  }),
);

test(
  'three wrong PIN attempts exit 1 and leave the entry unconfirmed',
  withVaultHome(async () => {
    assert.equal(enrollApprovalsPin(ENROLLED_PIN).ok, true);
    const token = createApprovalToken(['ECS', 'DeleteServer']);
    const terminal = scriptedIo(['wrong-one', 'wrong-two', 'wrong-three']);

    assert.equal(await runApproveCommand([token], terminal.io), 1);
    assert.match(terminal.output(), /Too many incorrect PIN attempts/);
    assert.equal(entryState(token), 'awaiting_user', 'exhausted PIN attempts never confirm');
    assert.equal(inspectApprovalToken(token).entry?.confirmGrant, undefined);
  }),
);

test(
  'a correct PIN after earlier mistakes still confirms',
  withVaultHome(async () => {
    assert.equal(enrollApprovalsPin(ENROLLED_PIN).ok, true);
    const token = createApprovalToken(['ECS', 'DeleteServer']);
    const terminal = scriptedIo(['wrong-one', 'wrong-two', ENROLLED_PIN]);

    assert.equal(await runApproveCommand([token], terminal.io), 0);
    assert.equal(entryState(token), 'user_confirmed');
  }),
);

test(
  'a token already confirmed is reported and exits 0 without a second grant',
  withVaultHome(async () => {
    assert.equal(enrollApprovalsPin(ENROLLED_PIN).ok, true);
    const token = createApprovalToken(['ECS', 'DeleteServer']);
    assert.equal(confirmApprovalToken(token).status, 'confirmed');
    const before = readFileSync(approvalsFile(), 'utf8');

    const terminal = scriptedIo([ENROLLED_PIN]);
    assert.equal(await runApproveCommand([token], terminal.io), 0);
    assert.match(terminal.output(), /already confirmed/);
    assert.equal(readFileSync(approvalsFile(), 'utf8'), before, 'an idempotent confirm rewrites nothing');
  }),
);
