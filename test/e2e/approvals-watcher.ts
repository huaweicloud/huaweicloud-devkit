// The approvals watcher: the E2E's simulation of the USER's out-of-band
// terminal confirmation, for token-mode approval cases.
//
// The doctrine (mirrors the suite's boundary philosophy): the agent layer
// and the devkit product run REAL; the Huawei Cloud boundary is fake but
// recording; and the HUMAN boundary is simulated — the in-chat half by the
// case prompt ("我批准…"), the out-of-band terminal half by this watcher.
// In the token posture a plan mints a token whose terminal confirmation
// (`npx huaweicloud-devkit approve <token>`) is the human's move: the
// interactive CLI is deliberately un-simulatable headless (TTY-gated,
// PIN-gated — an agent piping into Bash cannot pass, by design), so this
// watcher plays the post-approval state through the product's own
// `confirmApprovalToken` (the same function the CLI calls after its gates):
// the custody-HMAC grant it writes is real, the server-side verify in
// `consumeApprovalToken` is real, the single-use consume is real.
//
// Key agreement: the grant MAC is keyed by the vault custody master key,
// which the watcher process (here) and the MCP server child (spawned with
// the case env) must resolve IDENTICALLY or the grant never verifies. Both
// sides therefore run on the pinned env tier (`HW_VAULT_MASTER_KEY`, the
// product's documented CI tier — resolveMasterKey checks it first, so no
// machine's OS keychain is ever read or bootstrapped by the E2E, dev
// workstation included). The value is not a secret: it guards only the
// throwaway home's approvals store, which contains nothing but this case's
// own tokens and dies with the home.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { confirmApprovalToken } from '../../plugins/huaweicloud-core/src/lib/approval-tokens.ts';

// base64 of 32 bytes (the env tier's exact shape). Pinned, public, and
// case-scoped: any fixed value works; this one is committed so the
// watcher and the injected case env can never drift apart.
export const E2E_VAULT_MASTER_KEY = 'bgdPqPS9m9UpBKNHbVlffb8vZQet2PRHmea9ZwNFgFg=';

// The store file inside the throwaway home: devkitStateBase() resolves to
// the config tree for a writable home (every E2E home is one — the same
// layout assumption selfcheck's credentials.json seed makes), and the
// state constants live in approval-tokens.ts.
const APPROVALS_POLL_MS = 200;

export interface ApprovalsWatcher {
  stop(): void;
}

// Confirms every approval token minted under `home`, polling the store.
// Start before the agent run, stop in the same finally that removes the
// home. Confirming is idempotent (already-confirmed tokens return
// already_confirmed without a rewrite), and the seen-set keeps repeat work
// off the tick. The interval is unref'd: a crash path that forgets stop()
// must not hang the runner's exit, and the timer still fires while the
// event loop is alive (the child's stdio streams keep it alive through the
// awaited agent run).
export function startApprovalsWatcher(home: string): ApprovalsWatcher {
  const confirmed = new Set<string>();
  const storePath = join(home, '.config', 'huaweicloud', 'approvals.json');
  const tick = (): void => {
    // The product resolves state and custody from process.env at call time
    // (huaweiConfigBase/defaultSecretsRoot both default to process.env), so
    // the watcher pins the case home + the env tier around the synchronous
    // confirm — no other code interleaves (single-threaded, sync call), and
    // the save/restore below keeps the runner's own env untouched.
    const savedHome = process.env.HUAWEICLOUD_HOME;
    const savedKey = process.env.HW_VAULT_MASTER_KEY;
    process.env.HUAWEICLOUD_HOME = home;
    process.env.HW_VAULT_MASTER_KEY = E2E_VAULT_MASTER_KEY;
    try {
      let tokens: string[] = [];
      try {
        // The store may not exist yet, and a torn read of a mid-write file
        // just skips this tick (writes are temp+rename; the miss window is
        // one poll at most).
        const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, unknown>;
        tokens = Object.keys(parsed);
      } catch {
        return;
      }
      for (const token of tokens) {
        if (confirmed.has(token)) continue;
        confirmed.add(token);
        // Blind confirm: every key in this throwaway store is a token this
        // case's agent minted; stale/expired/consumed states return their
        // own statuses without side effects, and the PIN/TTY gates belong
        // to the interactive CLI this watcher deliberately bypasses (the
        // simulated user already decided).
        confirmApprovalToken(token);
      }
    } finally {
      if (savedHome === undefined) delete process.env.HUAWEICLOUD_HOME;
      else process.env.HUAWEICLOUD_HOME = savedHome;
      if (savedKey === undefined) delete process.env.HW_VAULT_MASTER_KEY;
      else process.env.HW_VAULT_MASTER_KEY = savedKey;
    }
  };
  const timer = setInterval(tick, APPROVALS_POLL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
