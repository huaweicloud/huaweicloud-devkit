import { clearCustodyCache } from '../plugins/huaweicloud-core/src/lib/secret-vault/custody.ts';
import { withTempAuthHome } from './hcloud-cli-harness.ts';

// The approval batteries' shared env-flipping helpers: the vault-keyed home
// (withVaultAuthHome) and the approval-mode pin (withApprovalMode). One
// home for both files that drive the gate — the approval-gate battery and
// the PR-3a sandbox battery — so the isolation contract cannot drift
// between them.
//
// The master key guards only the throwaway home's approvals store; the
// value is committed by design (the e2e watcher's documented doctrine: not
// a secret, never a machine keychain read).
export const TEST_MASTER_KEY = Buffer.alloc(32, 0x33).toString('base64');

export async function withVaultAuthHome(
  fn: (home: string) => Promise<void> | void,
  options: { pinHcloudCredentials?: boolean } = {},
): Promise<void> {
  const previousKey = process.env.HW_VAULT_MASTER_KEY;
  process.env.HW_VAULT_MASTER_KEY = TEST_MASTER_KEY;
  clearCustodyCache();
  try {
    // withTempAuthHome clears the credential env for isolation; callers
    // whose handlers resolve through the env tier (the sandbox fetch
    // faces) pin a test pair back on inside the home, after the clear.
    await withTempAuthHome(async (home) => {
      if (!options.pinHcloudCredentials) {
        await fn(home);
        return;
      }
      const previousAccess = process.env.HW_ACCESS_KEY;
      const previousSecret = process.env.HW_SECRET_KEY;
      process.env.HW_ACCESS_KEY = 'TESTAK';
      process.env.HW_SECRET_KEY = 'TESTSK';
      try {
        await fn(home);
      } finally {
        if (previousAccess === undefined) delete process.env.HW_ACCESS_KEY;
        else process.env.HW_ACCESS_KEY = previousAccess;
        if (previousSecret === undefined) delete process.env.HW_SECRET_KEY;
        else process.env.HW_SECRET_KEY = previousSecret;
      }
    });
  } finally {
    clearCustodyCache();
    if (previousKey === undefined) delete process.env.HW_VAULT_MASTER_KEY;
    else process.env.HW_VAULT_MASTER_KEY = previousKey;
  }
}

export async function withApprovalMode<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
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
