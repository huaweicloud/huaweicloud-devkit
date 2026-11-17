// The PR-3a e2e PTY-seam dry run (the plan's Verify-unit box; never inside
// npm test, E2E-enable-gated by convention because it drives the REAL
// installed CLI): enroll the approvals PIN through the TTY-gated `pin`
// verb inside a pseudo-terminal, mint a gate token for a write-classified
// sandbox exec, approve it through the TTY-gated `approve` verb — PIN
// prompt and all — then verify the consume (single use, grant-backed) end
// to end. No LLM, no network: the exec handler's synchronous refusal after
// the consume is the proof the token spent.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const bin = join(root, 'bin', 'setup.cjs');

const home = join('/tmp/opencode/pr-3a/tmp', 'pty-seam-dryrun-home');
rmSync(home, { recursive: true, force: true });
mkdirSync(join(home, '.config', 'huaweicloud'), { recursive: true });

process.env.HUAWEICLOUD_HOME = home;
process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = 'off';
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';
delete process.env.DEVKIT_APPROVAL_MODE; // token mode: the default

// The env-tier custody key, the same agreement case-run.ts injects for the
// MCP child: the PTY watcher's CLI children pin this key, so this process
// (which plays the MCP side here) must resolve the SAME master key or the
// grant the CLI writes never verifies at consume.
const { E2E_VAULT_MASTER_KEY } = await import(new URL('../test/e2e/approvals-watcher.ts', import.meta.url).href);
process.env.HW_VAULT_MASTER_KEY = E2E_VAULT_MASTER_KEY;

const { startPtyApprovalsWatcher, ptyWatcherStorePath } = await import(
  new URL('../test/e2e/approve-pty.ts', import.meta.url).href
);
const { callTool } = await import(new URL('../plugins/huaweicloud-core/src/tools.ts', import.meta.url).href);

// 1. The watcher enrolls the PIN through the real CLI inside the PTY.
const watcher = await startPtyApprovalsWatcher(home, bin);
console.log('PIN enrolled through the real TTY-gated pin verb');

// 2. A write-classified sandbox exec mints at the gate.
const mintEnvelope = await callTool('huaweicloud_sandbox_exec_one_shot', {
  command: 'hcloud ECS DeleteServers --server_id=i-1 --cli-region=cn-north-4',
  approvedByUser: true,
});
if (mintEnvelope.code !== 'USER_CONFIRMATION_REQUIRED' || !mintEnvelope.approvalToken) {
  console.error('FAIL: expected the mint envelope, got', JSON.stringify(mintEnvelope).slice(0, 200));
  process.exit(1);
}
console.log('mint envelope returned, token:', mintEnvelope.approvalToken);

// 3. The PTY watcher drives the real approve verb; poll for the CONFIRMED
// state — inspectApprovalToken's 'valid' covers the awaiting entry too, so
// the proof the poll needs is the entry's own state field.
const { readFileSync } = await import('node:fs');
const storePath = ptyWatcherStorePath(home);
const entryState = () => {
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'));
    const entry = parsed[mintEnvelope.approvalToken] ?? {};
    return entry.state ?? '';
  } catch {
    return '';
  }
};
const deadline = Date.now() + 30_000;
let state = '';
while (Date.now() < deadline) {
  state = entryState();
  if (state === 'user_confirmed') break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (state !== 'user_confirmed') {
  console.error('FAIL: the PTY approve did not land in time (entry state:', state + ')');
  process.exit(1);
}
console.log('approved through the real TTY-gated approve verb (PIN answered), state:', state);

// 4. The consume: the retry spends the token and reaches the handler.
const spent = await callTool('huaweicloud_sandbox_exec_one_shot', {
  command: 'hcloud ECS DeleteServers --server_id=i-1 --cli-region=cn-north-4',
  approvalToken: mintEnvelope.approvalToken,
  approvedByUser: true,
}).then(
  (value) => ({ ok: true, value }),
  (error) => ({ ok: false, error }),
);
// The token is GATE-consumed before the handler runs; the handler then
// refuses synchronously for the missing workspace_id — the exact proof the
// gate passed and the handler was reached.
const refusal = spent.ok ? '' : String(spent.error && spent.error.message);
if (spent.ok || !/workspace_id is required/.test(refusal)) {
  console.error('FAIL: expected the post-consume handler refusal, got', JSON.stringify(spent).slice(0, 300));
  process.exit(1);
}
console.log('token consumed; the handler was reached (its workspace refusal is the proof)');

// 5. Single use: the replayed token answers already_processed.
const replay = await callTool('huaweicloud_sandbox_exec_one_shot', {
  command: 'hcloud ECS DeleteServers --server_id=i-1 --cli-region=cn-north-4',
  approvalToken: mintEnvelope.approvalToken,
  approvedByUser: true,
});
if (replay.outcome !== 'already_processed') {
  console.error('FAIL: expected already_processed on the replay, got', JSON.stringify(replay).slice(0, 200));
  process.exit(1);
}
watcher.stop();
console.log('replay answered already_processed — single use holds');

// 6. The terminal-line probe (round 3, F1): mint a token whose command
// carries the SPACE-separated secret spelling and drive the real approve
// verb; the CLI's Confirming line renders the STORE entry, so the terminal
// must show the folded form, never the plaintext.
const { approveTokenPty } =
  await import('/home/yanchengyu/.herdr/worktrees/HuaweiCloud-Devkit/pr3a/test/e2e/approve-pty.ts');
const secretMint = await callTool('huaweicloud_sandbox_exec_one_shot', {
  command: 'hcloud ECS DeleteServers --password pty-hunter2-secret --server_id=i-1 --cli-region=cn-north-4',
  approvedByUser: true,
});
if (secretMint.code !== 'USER_CONFIRMATION_REQUIRED' || !secretMint.approvalToken) {
  console.error('FAIL: expected the space-form mint envelope, got', JSON.stringify(secretMint).slice(0, 200));
  process.exit(1);
}
const approve = await approveTokenPty(bin, home, secretMint.approvalToken);
if (!approve.ok || !approve.output.includes('Confirming:')) {
  console.error('FAIL: the approve verb did not run:', JSON.stringify(approve.output.slice(-400)));
  process.exit(1);
}
if (approve.output.includes('pty-hunter2-secret')) {
  console.error('FAIL: the terminal Confirming line leaked the space-form secret');
  console.error(approve.output);
  process.exit(1);
}
if (!approve.output.includes('<redacted>')) {
  console.error('FAIL: the terminal Confirming line does not show the folded form');
  console.error(approve.output);
  process.exit(1);
}
console.log('terminal Confirming line clean: the space-form secret folded to <redacted>');
console.log('PTY SEAM DRY RUN: PASS (mint → real approve → consume → single-use → terminal line clean)');
console.log('store:', ptyWatcherStorePath(home));
