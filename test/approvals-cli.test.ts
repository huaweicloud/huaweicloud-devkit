import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';

import { runApproveCommand, type ApproveIo } from '../plugins/huaweicloud-core/src/approvals-cli.ts';
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
    assert.ok(consumeApprovalToken(token));

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
  'first approval enrolls a PIN after a mismatched re-type, then confirms',
  withVaultHome(async () => {
    const token = createApprovalToken(['ECS', 'DeleteServer', '--server_id=x']);
    // Choose, re-type wrong (retry), choose, re-type right.
    const terminal = scriptedIo(['first-choice', 'typo-re-type', ENROLLED_PIN, ENROLLED_PIN]);

    assert.equal(await runApproveCommand([token], terminal.io), 0);
    assert.match(terminal.output(), /PINs did not match, try again/);
    assert.ok(isApprovalsPinEnrolled(), 'the second pair enrolls the PIN');
    assert.equal(verifyApprovalsPin(ENROLLED_PIN).ok, true);
    assert.equal(entryState(token), 'user_confirmed');
    assert.ok(inspectApprovalToken(token).entry?.confirmGrant, 'the confirmation carries a grant');
    assert.match(terminal.output(), /The agent may now run this command once/);
  }),
);

test(
  'two mismatched re-types abort the enrollment without confirming',
  withVaultHome(async () => {
    const token = createApprovalToken(['ECS', 'DeleteServer']);
    const terminal = scriptedIo(['first-choice', 'typo-one', 'second-choice', 'typo-two']);

    assert.equal(await runApproveCommand([token], terminal.io), 1);
    assert.equal(isApprovalsPinEnrolled(), false);
    assert.equal(entryState(token), 'awaiting_user');
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
