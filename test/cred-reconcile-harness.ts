// Full-scenario matrix for the credential reconciliation feature.
// Every test is hermetic: HUAWEICLOUD_HOME points at a temp dir, HW_* / HCLOUD_*
// env vars are wiped and restored, runtime credentials are cleared, and none of
// the developer's real ~/.config/huaweicloud or ~/.hcloud files are touched.
// Only masked fingerprints (sha256(ak+sk).slice(0,8)) appear in assertions.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { clearRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.ts';

import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';

// PR-3b registered the account-switch pair on the approval chain, so an
// auth_switch call through dispatch now gates. The reconcile matrix pins
// the HANDLER flows (persist, mirrors, import lifecycle, R3/R10 policies),
// not the approval ladder, so the drive answers the gate's confirmation
// form mechanically: ask mode plus an always-accepting elicitation seam
// executes the call in one step, end to end through the real dispatch
// (the vendor gate still runs on the args). The ladder itself is pinned
// in test/approval-auth.test.ts.
export async function gatedAuthSwitchCall(args: Record<string, unknown>): Promise<unknown> {
  const previous = process.env.DEVKIT_APPROVAL_MODE;
  process.env.DEVKIT_APPROVAL_MODE = 'ask';
  try {
    return await callTool('huaweicloud_auth_switch', args, {
      elicitation: {
        capable: true,
        prompt: async () => ({ decision: 'accept', content: { decision: 'approve-once' } }),
      },
    });
  } finally {
    if (previous === undefined) delete process.env.DEVKIT_APPROVAL_MODE;
    else process.env.DEVKIT_APPROVAL_MODE = previous;
  }
}

// Deterministic-tier seam: disable the once-per-session first-assertion
// vendor challenge (HUAWEICLOUD_VENDOR_CHALLENGE=off, the installer-override
// pattern) so cold-attested calls in this file dispatch without the
// challenge bounce. The challenge itself is pinned where it is the subject
// (tools.test.ts's gate test drives the dance; the selfcheck drives it on
// the wire); the real-model e2e tier never sets this seam.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

export const FAKE_HCLOUD = fileURLToPath(new URL('./fixtures/fake-hcloud.ts', import.meta.url));
export const FAKE_HCLOUD_FAIL = fileURLToPath(new URL('./fixtures/fake-hcloud-fail-config.ts', import.meta.url));
export const FAKE_HCLOUD_FAIL_PROJECT_ID = fileURLToPath(
  new URL('./fixtures/fake-hcloud-fail-project-id.ts', import.meta.url),
);
export const FAKE_HCLOUD_PRIVACY = fileURLToPath(new URL('./fixtures/fake-hcloud-privacy.ts', import.meta.url));

export const ENV_KEYS = [
  'HUAWEICLOUD_HOME',
  'HCLOUD_CONFIG_PATH',
  'HCLOUD_OBS_CONFIG_PATH',
  'HW_ACCESS_KEY',
  'HW_SECRET_KEY',
  'HW_SECURITY_TOKEN',
  'HW_REGION',
  'HUAWEICLOUD_REGION',
  'HCLOUD_BIN',
  'HCLOUD_BIN_ARGS_JSON',
  'HCLOUD_FAKE_LOG',
  'HCLOUD_FAKE_SCRIPT',
  'HCLOUD_FAKE_DELETE_ERROR',
  'HW_STS_EXPIRES_AT',
  'CODEARTS_PROJECT_DIR',
];

export type AuthSwitchResult =
  | { status: 'needs_confirmation'; confirmToken: string }
  | { status: 'error'; scope: string; error: string }
  | { status: 'ok' | 'cleared' | 'partial'; scope?: string; backedUp?: boolean; outcome?: string };

export function withTempHome(fn: (dir: string) => void | Promise<void>): void | Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-e2e-'));
  const prev: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) prev[key] = process.env[key];
  process.env.HUAWEICLOUD_HOME = dir;
  process.env.HCLOUD_CONFIG_PATH = join(dir, '.hcloud', 'config.json');
  process.env.HCLOUD_OBS_CONFIG_PATH = join(dir, '.obsutilconfig');
  for (const key of ENV_KEYS) {
    if (key !== 'HUAWEICLOUD_HOME' && key !== 'HCLOUD_CONFIG_PATH' && key !== 'HCLOUD_OBS_CONFIG_PATH')
      delete process.env[key];
  }
  clearRuntimeCredentials();
  const cleanup = () => {
    clearRuntimeCredentials();
    for (const key of ENV_KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn(dir);
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

// The fake KooCLI config is wired to HCLOUD_CONFIG_PATH (set in withTempHome),
// so readKooCliProfiles reads it instead of the real ~/.hcloud/config.json.
export interface FakeKooCliProfile {
  name: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  securityToken?: string;
}

export function writeFakeKooCli(current: string, profiles: FakeKooCliProfile[]) {
  const p = join(process.env.HUAWEICLOUD_HOME!, '.hcloud', 'config.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ current, profiles }, null, 2));
  return p;
}

export function setFakeHcloud(logPath: string, fixture: string = FAKE_HCLOUD) {
  process.env.HCLOUD_BIN = process.execPath;
  process.env.HCLOUD_BIN_ARGS_JSON = JSON.stringify([fixture]);
  process.env.HCLOUD_FAKE_LOG = logPath;
}

// #920 test helpers: persist via the tool, read the fake hcloud call log,
// and assert the delete-before-set ordering the stale-token purge requires.
export async function persistViaSwitch(
  ak: string,
  sk: string,
  region: string,
): Promise<AuthSwitchResult & { hcloud?: { ok?: boolean; profileReset?: boolean } }> {
  return (await gatedAuthSwitchCall({
    mode: 'memory',
    action: 'persist',
    ak,
    sk,
    region,
    vendorConfirmed: 'test: vendor established by the harness',
  })) as AuthSwitchResult & { hcloud?: { ok?: boolean; profileReset?: boolean } };
}

export function readHcloudCalls(log: string): string[][] {
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
}

export function assertDeleteBeforeSet(calls: string[][]): void {
  const deleteIdx = calls.findIndex((c) => c[0] === 'configure' && c[1] === 'delete');
  const setIdx = calls.findIndex((c) => c[0] === 'configure' && c[1] === 'set');
  assert.ok(deleteIdx !== -1, 'configure delete must run (stale-token cleanup, #920)');
  assert.ok(setIdx !== -1, 'configure set must run after the delete (re-create)');
  assert.ok(deleteIdx < setIdx, 'the profile delete must precede the re-create');
}

// Read one profile from the fake KooCLI config (the fake implements the
// configure delete/set effects against the real config path).
export function readFakeProfile(dir: string, name: string): Record<string, string> {
  const config = JSON.parse(readFileSync(join(dir, '.hcloud', 'config.json'), 'utf8')) as {
    profiles: Array<Record<string, string>>;
  };
  const profile = config.profiles.find((p) => p.name === name);
  assert.ok(profile, `profile ${name} must exist in the fake config`);
  return profile;
}

// D4-24 (#745): auth_confirm returns the precise JSON contract for consumed
// and unknown tokens instead of throwing a generic Error string.

// #919 follow-up UX: auth_status exposes the credential panel (temporary STS
// vs permanent S1, and which one is active).
