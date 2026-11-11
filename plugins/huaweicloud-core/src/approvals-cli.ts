import { confirmApprovalToken, inspectApprovalToken, type ApprovalEntry } from './lib/approval-tokens.ts';
import { enrollApprovalsPin, isApprovalsPinEnrolled, verifyApprovalsPin } from './lib/approvals-pin.ts';
import { readSecret } from './lib/cli-io.ts';

// The human half of the approval gate: `npx huaweicloud-devkit approve <token>`
// is the only channel that writes a user confirmation, so it must be driven
// by a person at a terminal. The command refuses every non-interactive
// caller (an agent piping into Bash cannot pass), and it refuses to record
// the confirmation without the PIN. The door has no flags, because a flag
// would be an escape hatch for the caller the gate is built to stop.
//
// PIN enrollment is its own verb (`pin`): approve refuses outright on a
// machine with no enrolled PIN instead of enrolling inline — an inline
// first-use enroll would let any pseudo-terminal caller choose the PIN.
//
// The token lifecycle and the PIN record are pure state/crypto modules
// (lib/approval-tokens.ts, lib/approvals-pin.ts); this file owns prompts and
// exit codes, and takes its terminal as an injected ApproveIo so tests can
// drive both the refusal and the interactive paths without a real TTY.

const USAGE = 'Usage: npx huaweicloud-devkit approve <token>';
const PIN_USAGE = 'Usage: npx huaweicloud-devkit pin';

const PIN_ATTEMPTS = 3;
const ENROLL_ATTEMPTS = 2;

export interface ApproveIo {
  isTTY: boolean;
  write(text: string): void;
  readLine(): Promise<string>;
}

export function createProcessApproveIo(): ApproveIo {
  return {
    // Both ends must be terminals: stdout-only TTY (agent captures output)
    // and stdin-only TTY (agent feeds input) are both agent-shaped pipes.
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    write: (text) => {
      process.stdout.write(text);
    },
    readLine: () => readSecret(''),
  };
}

function renderCommand(argsRedacted: unknown): string {
  if (Array.isArray(argsRedacted)) {
    const rendered = argsRedacted.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)));
    return `hcloud ${rendered.join(' ')}`;
  }
  return JSON.stringify(argsRedacted);
}

function printRefusal(io: ApproveIo, inspectionState: string): number {
  if (inspectionState === 'not_found') {
    io.write('No pending approval matches that token.\n');
  } else if (inspectionState === 'expired') {
    io.write(
      'That approval expired. A confirmation must happen within 5 minutes of the plan; ask the agent to plan the command again.\n',
    );
  } else {
    io.write('This approval was already used.\n');
  }
  return inspectionState === 'already_consumed' ? 0 : 1;
}

async function enrollPin(io: ApproveIo): Promise<boolean> {
  io.write('Choose a PIN of at least 6 characters.\n');
  for (let attempt = 1; attempt <= ENROLL_ATTEMPTS; attempt++) {
    io.write('Choose a PIN: ');
    const first = await io.readLine();
    io.write('Re-type the PIN: ');
    const second = await io.readLine();
    if (first !== second) {
      io.write(attempt < ENROLL_ATTEMPTS ? 'The PINs did not match, try again.\n' : 'The PINs did not match.\n');
      continue;
    }
    const enrolled = enrollApprovalsPin(first);
    if (!enrolled.ok) {
      io.write(`Cannot enroll the approvals PIN: ${enrolled.reason ?? 'unknown error'}.\n`);
      return false;
    }
    io.write('Approvals PIN enrolled.\n');
    return true;
  }
  return false;
}

async function verifyPin(io: ApproveIo): Promise<boolean> {
  for (let attempt = 1; attempt <= PIN_ATTEMPTS; attempt++) {
    io.write('PIN: ');
    const pin = await io.readLine();
    if (verifyApprovalsPin(pin).ok) return true;
    if (attempt < PIN_ATTEMPTS) io.write(`Incorrect PIN (${attempt}/${PIN_ATTEMPTS}), try again.\n`);
  }
  io.write('Too many incorrect PIN attempts.\n');
  return false;
}

function printConfirmResult(
  io: ApproveIo,
  status: ReturnType<typeof confirmApprovalToken>['status'],
  reason: string | undefined,
): number {
  switch (status) {
    case 'confirmed':
      io.write('Confirmed. The agent may now run this command once.\n');
      return 0;
    case 'already_confirmed':
      io.write('This approval was already confirmed. The agent may run this command once.\n');
      return 0;
    case 'already_consumed':
      io.write('This approval was already used.\n');
      return 0;
    case 'expired':
      io.write(
        'That approval expired. A confirmation must happen within 5 minutes of the plan; ask the agent to plan the command again.\n',
      );
      return 1;
    case 'custody_unavailable':
      io.write(`Cannot record the confirmation: ${reason ?? 'the vault master key is unavailable'}.\n`);
      return 1;
    case 'not_found':
      io.write('No pending approval matches that token.\n');
      return 1;
  }
}

export async function runApproveCommand(argv: string[], io: ApproveIo): Promise<number> {
  const token = argv[0];
  // No flags: any extra argv is a caller trying to steer the confirmation.
  if (!token || token.startsWith('-') || argv.length > 1) {
    io.write(`${USAGE}\n`);
    return 1;
  }

  const inspection = inspectApprovalToken(token);
  if (inspection.state !== 'valid') return printRefusal(io, inspection.state);

  const entry: ApprovalEntry | undefined = inspection.entry;
  if (!entry) {
    io.write('No pending approval matches that token.\n');
    return 1;
  }

  io.write(`Confirming: ${renderCommand(entry.argsRedacted)}\n`);
  io.write('This authorizes ONE execution of exactly this command.\n');

  // The TTY gate sits after the description so a human sees what would have
  // been confirmed, and before any prompt so no pipe can answer one.
  if (!io.isTTY) {
    io.write('Approvals must be confirmed in your own interactive terminal.\n');
    return 1;
  }

  // Enrollment is a deliberate separate step, never an inline fallback: a
  // first confirm that mints its own PIN would enroll whatever the current
  // caller typed, and a pseudo-terminal makes even an agent "interactive".
  if (!isApprovalsPinEnrolled()) {
    io.write(
      'No approvals PIN is enrolled yet. Run "npx huaweicloud-devkit pin" in your own terminal once, then confirm plans with "approve".\n',
    );
    return 1;
  }
  if (!(await verifyPin(io))) {
    return 1;
  }

  const result = confirmApprovalToken(token);
  return printConfirmResult(io, result.status, result.reason);
}

// `npx huaweicloud-devkit pin`: the deliberate enrollment step the approve
// command refuses to perform inline. Same door shape as approve — no flags,
// TTY-gated, injected io — because it writes the credential the confirmation
// gate trusts.
export async function runPinCommand(argv: string[], io: ApproveIo): Promise<number> {
  // No flags: any extra argv is a caller trying to steer the enrollment.
  if (argv.length > 0) {
    io.write(`${PIN_USAGE}\n`);
    return 1;
  }
  if (!io.isTTY) {
    io.write('The approvals PIN must be enrolled in your own interactive terminal.\n');
    return 1;
  }
  return (await enrollPin(io)) ? 0 : 1;
}
