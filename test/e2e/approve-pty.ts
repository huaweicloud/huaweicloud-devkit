import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { E2E_VAULT_MASTER_KEY } from './approvals-watcher.ts';

// The PTY approvals seam: the E2E's simulation of the USER's terminal half
// of the token-mode approval, driven through the REAL TTY-gated CLI. The
// blind watcher (approvals-watcher.ts) plays the post-approval state
// through the product's own confirmApprovalToken — deliberately bypassing
// the PIN and TTY gates because the simulated user already decided. This
// seam does not bypass anything: it enrolls the approvals PIN through the
// real `pin` verb and answers the real `approve` prompt, both inside a
// pseudo-terminal (util-linux `script -qec <command> /dev/null`), so the
// CLI's own gates — both-ends TTY, the enrolled-PIN requirement, the PIN
// prompt, the custody grant — all run for real, and sandbox e2e cases can
// pass the token gate without a human (the plan's PR-3a e2e seam).
//
// The same env-tier key agreement as the blind watcher applies: the watcher
// process and the CLI child must resolve the SAME custody master key
// (HW_VAULT_MASTER_KEY, pinned to the throwaway home), or the grant MAC the
// CLI writes never verifies against what the MCP server consumes.
//
// POSIX-only by construction (script(1)); the nightly e2e lanes are ubuntu.

// The PIN the seam enrolls and answers with. Public by design: it guards
// only the throwaway home's approvals store, exactly like the pinned vault
// key beside it. Six characters is the CLI's floor.
const E2E_APPROVALS_PIN = 'e2e-pty-pin-2601';

const PTY_TIMEOUT_MS = 30_000;

interface PtyRun {
  ok: boolean;
  output: string;
}

// Run one CLI verb inside a pseudo-terminal, answering every PIN prompt it
// raises. The child's stdin/stdout are the PTY slave through `script`, so
// the CLI's isTTY gates read true; the seam writes the PIN when the
// prompt's text appears, and waits for the expected success marker.
function runInPty(command: string, home: string, expect: RegExp): Promise<PtyRun> {
  return new Promise<PtyRun>((resolve) => {
    const child = spawn('script', ['-qec', command, '/dev/null'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HUAWEICLOUD_HOME: home,
        HW_VAULT_MASTER_KEY: E2E_VAULT_MASTER_KEY,
      },
    });
    let output = '';
    let answered = 0;
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolve({ ok, output });
    };
    const timer = setTimeout(() => finish(false), PTY_TIMEOUT_MS);
    child.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      if (/PIN: |Choose a PIN: |Re-type the PIN: /.test(text) && answered < 3) {
        answered += 1;
        child.stdin!.write(`${E2E_APPROVALS_PIN}\n`);
      }
      if (expect.test(output)) finish(true);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code === 0 && expect.test(output));
    });
  });
}

// Enroll the approvals PIN in the case home through the real `pin` verb.
// Idempotent: re-enrollment overwrites the record, so a home that already
// carries one simply re-answers.
async function enrollApprovalsPinPty(bin: string, home: string): Promise<PtyRun> {
  return runInPty(`"${process.execPath}" "${bin}" pin`, home, /Approvals PIN enrolled\./);
}

// Confirm one approval token in the case home through the real `approve`
// verb — the exact line the gate's USER_CONFIRMATION_REQUIRED envelope
// taught the agent to relay to the user. Exported for the PTY dry run's
// terminal-line probe (the watcher consumes it internally too).
export async function approveTokenPty(bin: string, home: string, token: string): Promise<PtyRun> {
  return runInPty(`"${process.execPath}" "${bin}" approve ${token}`, home, /The agent may now run this command once\./);
}

export interface PtyApprovalsWatcher {
  stop(): void;
}

// The watcher-shaped seam: enroll the PIN once at start, then poll the case
// home's approvals store and drive every newly minted token through the
// real approve CLI. Same polling doctrine as the blind watcher; the
// per-token latency includes one node CLI boot (~1s), well inside the
// model's plan-to-run turnaround.
export async function startPtyApprovalsWatcher(home: string, bin: string): Promise<PtyApprovalsWatcher> {
  const enrollment = await enrollApprovalsPinPty(bin, home);
  if (!enrollment.ok) {
    throw new Error(
      `the PTY seam could not enroll the approvals PIN in the case home (script(1) missing? non-POSIX host?):\n${enrollment.output.slice(-400)}`,
    );
  }
  const confirmed = new Set<string>();
  const storePath = join(home, '.config', 'huaweicloud', 'approvals.json');
  const busy = new Set<string>();
  const tick = (): void => {
    let tokens: string[];
    try {
      const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, unknown>;
      tokens = Object.keys(parsed).filter((key) => parsed[key] !== null && typeof parsed[key] === 'object');
    } catch {
      return; // absent or mid-write: the next tick sees it
    }
    for (const token of tokens) {
      if (confirmed.has(token) || busy.has(token)) continue;
      confirmed.add(token);
      busy.add(token);
      void approveTokenPty(bin, home, token).finally(() => busy.delete(token));
    }
  };
  const timer = setInterval(tick, 500);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

// The seam's own dry-run contract, for the runner and reviewers: the exact
// store path the watcher polls, exposed so a lane can seed or inspect it.
export function ptyWatcherStorePath(home: string): string {
  return join(home, '.config', 'huaweicloud', 'approvals.json');
}
