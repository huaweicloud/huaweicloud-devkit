import assert from 'node:assert/strict';
import test, { after, mock } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { isolateDirectFetchEnv } from './fetch-stub-harness.ts';
import { fixtureDir } from './fixture-dir.ts';
import { confirmApprovalToken } from '../plugins/huaweicloud-core/src/lib/approval-tokens.ts';
import { readConsentEvents } from '../plugins/huaweicloud-core/src/approval-ledger.ts';
import { withApprovalMode, withVaultAuthHome } from './approval-mode-harness.ts';
import { elicitingSeam } from './eliciting-seam.ts';
import type {
  ConsentEvent,
  ElicitFormRequest,
  ElicitationSeam,
} from '../plugins/huaweicloud-core/src/approval-types.ts';
import type { ToolName } from '../plugins/huaweicloud-core/src/tool-definitions.ts';

// The PR-3a sandbox approval battery: the eight sandbox registrations in
// both gate modes, the classified deny after confirm, the retry memo's
// reuse and its delivered-outcome refusal, and the session standing
// consent. The gate contract is the subject; the sandbox handlers run
// behind module mocks (the session-manager and devbridge-tunnel faces, the
// fetch boundary) so the battery stays hermetic and the knobs can stage
// uncertain delivery deterministically. Consent rows are asserted through
// each call's own sessionId — the ledger is a shared store and rows from
// earlier cases in this file must never decide a later case.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';
process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = 'off';
process.env.HW_ACCESS_KEY = 'TESTAK';
process.env.HW_SECRET_KEY = 'TESTSK';
process.env.HDKITSERVICE_ENDPOINT = 'https://hdkit.test/api/';
process.env.HW_IAM_ENDPOINT = 'https://iam.test/';
process.env.HW_SANDBOX_POOL_CACHE_PATH = join(fixtureDir('approval-sandbox'), 'sandbox-pools.json');

const VENDOR = 'test: vendor established by the harness';
const PINNED_CREDENTIALS = { pinHcloudCredentials: true } as const;

const restoreFetchEnv = isolateDirectFetchEnv();
after(() => {
  restoreFetchEnv();
});

// The exec seam's knobs: every handler-family exec runs through these, so a
// test stages delivery (ok / scripted exit codes / a mid-command throw)
// without touching a real workspace.
const execLog: string[] = [];
let execThrows = false;
let execScript: Array<{ stdout: string; exitCode: number }> = [];

async function fakeExec(ws: string, cmd: string): Promise<{ stdout: string; exitCode: number }> {
  execLog.push(`${ws}:${cmd}`);
  if (execThrows) throw new Error('ws-exec timed out mid-command');
  const next = execScript.shift();
  if (next) return next;
  return { stdout: `ran on ${ws}: ${cmd}`, exitCode: 0 };
}

const tunnelLog: string[] = [];

// The module mocks must register before tools.ts imports the handlers
// (node:test's mock.module intercepts by resolved URL).
mock.module('../plugins/huaweicloud-core/src/sandbox/session-manager.ts', {
  namedExports: {
    execOneShot: fakeExec,
    execWithSession: fakeExec,
    closeSession: async () => true,
    setWorkspaceId: () => {},
    getCurrentWorkspaceId: () => 'ws-gate',
    uploadFileWithSession: async () => ({ ok: true, remote_path: '/tmp/uploaded' }),
    uploadProjectWithSession: async () => ({ ok: true }),
    deployNginx: async () => ({ ok: true, port: 8080 }),
    deployCheck: async () => ({ ok: true, complete: true }),
  },
});
mock.module('../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts', {
  namedExports: {
    exposeTunnel: async () => {
      tunnelLog.push('expose');
      return {
        ok: true,
        publicUrl: 'https://tun-0001-8080.devbridge-s2.hwtunnel.com',
        port: 8080,
        tunnelId: 'tun-0001',
      };
    },
    renewTunnel: async () => {
      tunnelLog.push('renew');
      return { ok: true, tunnelId: 'tun-0001', expiresAt: '2099-01-01T00:00:00Z', renewedForHours: 24 };
    },
    installKeepaliveWatchdog: async () => {
      tunnelLog.push('watchdog');
      return { ok: true, scriptPath: '/tmp/tunnel-keepalive.sh', watchdogPid: '123', tunnels: [] };
    },
    validateTunnelId: () => {},
  },
});

const { callTool } = await import('../plugins/huaweicloud-core/src/tools.ts');

// The fetch boundary: one dispatch stub covering the hdkitservice family
// and the IAM project read, recording every URL so per-tool execution is
// observable without pinning handler internals.
const fetchLog: string[] = [];

function withStubbedFetch(): () => void {
  const original = global.fetch;
  global.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(typeof input === 'string' ? input : ((input as { url?: string }).url ?? ''));
    fetchLog.push(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/v3/projects')) {
      return json({ projects: [{ id: 'proj-gate', name: 'cn-north-4' }] });
    }
    if (url.includes('/connect')) {
      return json({
        session_id: 'sess-gate',
        dev_stage_id: 'ds-gate',
        connection_id: 'conn-gate',
        connection_address: 'gate.example.com',
        expiresAt: '2099-01-01T00:00:00Z',
      });
    }
    if (url.includes('sign-agreement')) {
      return json({ signed: true, signedCount: 2 });
    }
    if (url.includes('/credentials')) {
      return json({ ak: 'STS_AK', sk: 'STS_SK', securitytoken: 'STS_TOKEN', expiresAt: '2099-01-01T00:00:00Z' });
    }
    return json({});
  }) as typeof fetch;
  return () => {
    global.fetch = original;
  };
}

// The eight registrations, each with its minimal valid args and the side
// effect its executed handler produces. The exec faces carry a
// write-classified command (measured: classifyTextCommand denies it as a
// write), so the gate engages for them in both modes.
const WRITE_COMMAND = 'hcloud ECS DeleteServers --server_id=i-1 --cli-region=cn-north-4';
const DESTRUCTIVE_COMMAND = 'rm -rf /tmp/x';

interface GatedTool {
  name: ToolName;
  args: Record<string, unknown>;
  effect: () => number;
}

const EXEC_ONE_SHOT = {
  name: 'huaweicloud_sandbox_exec_one_shot' as ToolName,
  args: { command: WRITE_COMMAND, workspace_id: 'ws-gate', username: 'root' },
};
const EXEC_WITH_SESSION = {
  name: 'huaweicloud_sandbox_exec_with_session' as ToolName,
  args: { command: WRITE_COMMAND, workspace_id: 'ws-gate', username: 'root' },
};

const GATED_TOOLS: GatedTool[] = [
  {
    name: 'huaweicloud_sandbox_connect',
    args: { vendorConfirmed: VENDOR, source: 'WEB' },
    effect: () => fetchLog.length,
  },
  { ...EXEC_WITH_SESSION, effect: () => execLog.length },
  { ...EXEC_ONE_SHOT, effect: () => execLog.length },
  {
    name: 'huaweicloud_sandbox_expose_tunnel',
    args: { port: 8080, workspace_id: 'ws-gate', username: 'root' },
    effect: () => tunnelLog.length,
  },
  {
    name: 'huaweicloud_sandbox_renew_tunnel',
    args: { tunnel_id: 'tun-0001', expiry_hours: 24, workspace_id: 'ws-gate', username: 'root' },
    effect: () => tunnelLog.length,
  },
  {
    name: 'huaweicloud_sandbox_keepalive_watchdog',
    args: {
      tunnels: [{ tunnel_id: 'tun-0001', url: 'https://tun-0001-8080.devbridge-s2.hwtunnel.com' }],
      workspace_id: 'ws-gate',
      username: 'root',
    },
    effect: () => tunnelLog.length,
  },
  { name: 'huaweicloud_sandbox_sign_agreement', args: {}, effect: () => fetchLog.length },
  { name: 'huaweicloud_sandbox_credentials', args: { dev_stage_id: 'ds-gate' }, effect: () => fetchLog.length },
];

let sessionSeq = 0;
function freshSessionId(prefix: string): string {
  sessionSeq += 1;
  return `${prefix}-${sessionSeq}`;
}

// The battery's home: the vault-keyed isolated home plus the pinned env
// credential pair the fetch-backed handlers resolve through.
const withSandboxHome = (fn: (home: string) => Promise<void> | void): Promise<void> =>
  withVaultAuthHome(fn, PINNED_CREDENTIALS);

function rowsFor(sessionId: string): ConsentEvent[] {
  return readConsentEvents().filter((event) => event.sessionId === sessionId);
}

// The accepting-seam + fresh-session prelude the ask-mode tests share: an
// accepting form and a session key nothing else in the file can collide
// with.
function acceptingSeam(label: string): {
  seam: ElicitationSeam;
  requests: ElicitFormRequest[];
  sessionId: string;
} {
  return {
    ...elicitingSeam({ decision: 'accept', content: { confirm: true } }),
    sessionId: freshSessionId(label),
  };
}

function resetKnobs(): void {
  execThrows = false;
  execScript = [];
  fetchLog.length = 0;
  execLog.length = 0;
  tunnelLog.length = 0;
}

// The eight-tool ask-mode loops' shared scaffolding: home, ask posture, and
// the fetch stub, torn down either way.
async function withGatedAskCase(fn: () => Promise<void>): Promise<void> {
  await withSandboxHome(async () => {
    await withApprovalMode('ask', async () => {
      const restore = withStubbedFetch();
      try {
        await fn();
      } finally {
        restore();
      }
    });
  });
}

// The eight-tool loops' shared per-tool case opener: reset the knobs, take
// the side-effect baseline, and mint a session key no other case touches.
function freshToolCase(tool: GatedTool): { before: number; sessionId: string } {
  resetKnobs();
  return { before: tool.effect(), sessionId: freshSessionId(String(tool.name)) };
}

// The eight-tool loops' shared retry assertion: the confirmed/attested retry
// reaches the handler and its side effects grow.
async function assertRetryExecutes(
  tool: GatedTool,
  before: number,
  retryArgs: Record<string, unknown>,
  opts: { sessionId: string; elicitation?: ElicitationSeam },
): Promise<Record<string, unknown>> {
  const retry = (await callTool(tool.name, retryArgs, opts)) as Record<string, unknown>;
  assert.ok(
    retry.status !== 'rejected',
    `${tool.name}: the retry executes (got ${JSON.stringify(retry).slice(0, 120)})`,
  );
  assert.ok(
    tool.effect() > before,
    `${tool.name}: the handler ran (side effects grew from ${before} to ${tool.effect()})`,
  );
  return retry;
}

test('token mode: each of the eight tools mints on the first no-token call and executes after the terminal confirm', async () => {
  await withSandboxHome(async () => {
    await withApprovalMode(undefined, async () => {
      const restore = withStubbedFetch();
      try {
        for (const tool of GATED_TOOLS) {
          resetKnobs();
          const before = tool.effect();
          const first = (await callTool(
            tool.name,
            { ...tool.args, approvedByUser: true },
            { sessionId: freshSessionId(tool.name) },
          )) as {
            status: string;
            code: string;
            approvalToken?: string;
            userConfirmation?: { command?: string };
          };
          assert.equal(first.status, 'rejected', `${tool.name}: the first call rejects`);
          assert.equal(first.code, 'USER_CONFIRMATION_REQUIRED', `${tool.name}: the mint envelope code`);
          assert.ok(typeof first.approvalToken === 'string', `${tool.name}: a token is minted`);
          assert.match(
            first.userConfirmation?.command ?? '',
            /^npx huaweicloud-devkit approve /,
            `${tool.name}: the confirmation carries the approve command line`,
          );
          assert.equal(tool.effect(), before, `${tool.name}: nothing executed on the mint`);

          const confirmed = confirmApprovalToken(first.approvalToken!);
          assert.equal(confirmed.status, 'confirmed', `${tool.name}: the terminal confirm records the grant`);

          await assertRetryExecutes(
            tool,
            before,
            { ...tool.args, approvalToken: first.approvalToken, approvedByUser: true },
            { sessionId: freshSessionId(`${String(tool.name)}-retry`) },
          );
        }
      } finally {
        restore();
      }
    });
  });
});

test('ask mode: each of the eight tools answers an unattested arrival with the T3 chat envelope, records nothing, and executes on the attested retry', async () => {
  await withGatedAskCase(async () => {
    for (const tool of GATED_TOOLS) {
      const { before, sessionId } = freshToolCase(tool);
      const first = (await callTool(tool.name, { ...tool.args }, { sessionId })) as {
        status: string;
        code: string;
        userConfirmation?: { command?: string; summary?: string; instruction?: string };
      };
      assert.equal(first.status, 'rejected', `${tool.name}: the unattested arrival rejects`);
      assert.equal(first.code, 'ASK_CONFIRMATION_REQUIRED', `${tool.name}: the chat round-trip code`);
      assert.match(
        first.userConfirmation?.instruction ?? '',
        /Show this exact (command|request) to the user/,
        `${tool.name}: the envelope teaches the chat round-trip`,
      );
      assert.ok(
        (first.userConfirmation?.summary ?? '').length > 0,
        `${tool.name}: the envelope carries the redacted summary`,
      );
      assert.equal(tool.effect(), before, `${tool.name}: nothing executed on the envelope`);
      assert.equal(rowsFor(sessionId).length, 0, `${tool.name}: the refusal recorded no consent`);

      await assertRetryExecutes(tool, before, { ...tool.args, approvedByUser: true }, { sessionId });
      const events = rowsFor(sessionId);
      assert.equal(events.length, 1, `${tool.name}: one consent row for the arrival`);
      assert.equal(events[0]!.outcome, 'granted');
      assert.equal(events[0]!.evidence, 'posture', `${tool.name}: the chat retry is posture trust`);
    }
  });
});

test('ask mode: a capable client answers the form, the ledger stamps elicitation, and the tick checkbox grants standing consent', async () => {
  await withGatedAskCase(async () => {
    for (const tool of GATED_TOOLS) {
      const { before, sessionId } = freshToolCase(tool);
      const { seam, requests } = elicitingSeam({
        decision: 'accept',
        content: { confirm: true, rememberForSession: true },
      });
      const first = (await callTool(tool.name, { ...tool.args }, { sessionId, elicitation: seam })) as Record<
        string,
        unknown
      >;
      assert.equal(requests.length, 1, `${tool.name}: the form fired once`);
      assert.ok(
        tool.effect() > before,
        `${tool.name}: the accept executed the handler (side effects grew from ${before} to ${tool.effect()})`,
      );
      assert.ok(first.status !== 'rejected', `${tool.name}: the accepted call runs`);

      const grantRows = rowsFor(sessionId).filter((event) => event.scope === 'session');
      assert.equal(grantRows.length, 1, `${tool.name}: the tick wrote one standing-grant row`);
      assert.equal(grantRows[0]!.evidence, 'elicitation', `${tool.name}: the grant row carries the form answer`);

      // The ride: an identical call runs with NO form and names the
      // standing grant on the response; the grant is never consumed.
      resetKnobs();
      const ride = (await callTool(tool.name, { ...tool.args }, { sessionId, elicitation: seam })) as Record<
        string,
        unknown
      >;
      assert.equal(requests.length, 1, `${tool.name}: the ride raised no second form`);
      assert.equal(ride.approvedVia, 'standing-session', `${tool.name}: the ride names the standing grant`);
      assert.ok(tool.effect() > 0, `${tool.name}: the ride executed the handler`);
      // The grant persisted through the ride (the spec's
      // first-use-disappearance bug): a second identical call rides too.
      resetKnobs();
      await callTool(tool.name, { ...tool.args }, { sessionId, elicitation: seam });
      assert.equal(requests.length, 1, `${tool.name}: the standing grant survives its first ride`);
    }
  });
});

test('standing consent is key-scoped: different arguments confirm again', async () => {
  await withSandboxHome(async () => {
    await withApprovalMode('ask', async () => {
      resetKnobs();
      const { seam, requests, sessionId } = acceptingSeam('standing-scope');
      const first = (await callTool(EXEC_ONE_SHOT.name, EXEC_ONE_SHOT.args, {
        sessionId,
        elicitation: seam,
      })) as Record<string, unknown>;
      assert.ok(first.status !== 'rejected');

      // A different command is a different consent key: the form fires.
      const otherArgs = {
        ...EXEC_ONE_SHOT.args,
        command: 'hcloud ECS DeleteServers --server_id=i-2 --cli-region=cn-north-4',
      };
      const second = (await callTool(EXEC_ONE_SHOT.name, otherArgs, {
        sessionId,
        elicitation: seam,
      })) as Record<string, unknown>;
      assert.equal(requests.length, 2, 'the different key raised the form again');
      assert.ok(second.status !== 'rejected');
    });
  });
});

test('the retry memo: an uncertain delivery reuses the prior consent with no second form, and the reuse inherits the tier', async () => {
  await withSandboxHome(async () => {
    await withApprovalMode('ask', async () => {
      resetKnobs();
      const { seam, requests, sessionId } = acceptingSeam('memo-uncertain');

      // The approved call throws mid-handler: delivery unknown.
      execThrows = true;
      await assert.rejects(
        () => callTool(EXEC_ONE_SHOT.name, EXEC_ONE_SHOT.args, { sessionId, elicitation: seam }),
        /ws-exec timed out/,
      );
      assert.equal(requests.length, 1, 'the first arrival raised the form once');

      // The byte-identical retry rides the memo: no form, the response
      // names the reuse, and the handler runs.
      execThrows = false;
      const retry = (await callTool(EXEC_ONE_SHOT.name, EXEC_ONE_SHOT.args, {
        sessionId,
        elicitation: seam,
      })) as Record<string, unknown>;
      assert.equal(requests.length, 1, 'the memo reuse raised no second form');
      assert.equal(retry.approvedVia, 'retry-uncertain', 'the reuse names the memo');
      assert.ok(retry.status !== 'rejected', 'the reused consent executed');

      const events = rowsFor(sessionId);
      assert.equal(events.length, 2, 'the reuse wrote its own consent row');
      assert.equal(events[0]!.evidence, 'elicitation', 'the original rode a form answer');
      assert.equal(events[1]!.evidence, 'elicitation', 'the memo reuse inherits the original tier');
      assert.equal(events[0]!.outcomeDetail, 'uncertain', 'the throw recorded an uncertain delivery');
      assert.equal(events[1]!.outcomeDetail, 'delivered', 'the reuse delivered');
    });
  });
});

test('the retry memo does not survive a delivered outcome: the same command confirms again', async () => {
  await withSandboxHome(async () => {
    await withApprovalMode('ask', async () => {
      resetKnobs();
      const { seam, requests, sessionId } = acceptingSeam('memo-delivered');

      const first = (await callTool(EXEC_ONE_SHOT.name, EXEC_ONE_SHOT.args, {
        sessionId,
        elicitation: seam,
      })) as Record<string, unknown>;
      assert.ok(first.status !== 'rejected', 'the delivered call ran');
      assert.equal(first.approvedVia, undefined, 'a fresh confirmation carries no reuse marker');
      assert.equal(rowsFor(sessionId)[0]!.outcomeDetail, 'delivered');

      // The memo is cleared: the identical call raises the form again and
      // never claims a reuse.
      const second = (await callTool(EXEC_ONE_SHOT.name, EXEC_ONE_SHOT.args, {
        sessionId,
        elicitation: seam,
      })) as Record<string, unknown>;
      assert.equal(requests.length, 2, 'the delivered key confirms again');
      assert.equal(second.approvedVia, undefined, 'no reuse is reported after a delivered outcome');
    });
  });
});

test('the memo carve: a memo-covered attested arrival rides the memo even when no T3 envelope was ever shown for the key', async () => {
  await withSandboxHome(async () => {
    await withApprovalMode('ask', async () => {
      resetKnobs();
      // The consent arrives through the FORM (T1) — the one path that never
      // shows a T3 envelope — and its delivery is uncertain, arming the
      // memo. The client then loses form capability (a reconnect to a
      // non-capable client): the attested arrival on the T3 leg has NO live
      // shown-envelope record, so without the memo check sitting BEFORE the
      // binding it would silently degrade to a fresh chat round-trip.
      let capable = true;
      const { seam, requests } = elicitingSeam({ decision: 'accept', content: { confirm: true } }, () => capable);
      const sessionId = freshSessionId('memo-carve');

      execThrows = true;
      await assert.rejects(
        () => callTool(EXEC_WITH_SESSION.name, EXEC_WITH_SESSION.args, { sessionId, elicitation: seam }),
        /ws-exec timed out/,
      );
      assert.equal(requests.length, 1, 'the form answered the first arrival');

      capable = false;
      execThrows = false;
      const retry = (await callTool(
        EXEC_WITH_SESSION.name,
        { ...EXEC_WITH_SESSION.args, approvedByUser: true },
        { sessionId, elicitation: seam },
      )) as Record<string, unknown>;
      assert.equal(
        retry.approvedVia,
        'retry-uncertain',
        'the memo-covered attested arrival rides the memo instead of degrading to a fresh envelope',
      );
      assert.notEqual(retry.code, 'ASK_CONFIRMATION_REQUIRED', 'no fresh chat round-trip was demanded');
      assert.ok(retry.status !== 'rejected', 'the carve executed the call');
      assert.equal(requests.length, 1, 'no second confirmation surface of any kind');
    });
  });
});

test('a failed (non-delivered) outcome also arms the memo; a delivered reuse clears it for the next call', async () => {
  await withSandboxHome(async () => {
    await withApprovalMode('ask', async () => {
      resetKnobs();
      const { seam, requests, sessionId } = acceptingSeam('memo-failed');

      // The handler ANSWERS with a failure: the child ran and failed — the
      // non-delivered class the memo covers.
      execScript = [{ stdout: 'boom', exitCode: 1 }];
      const first = (await callTool(EXEC_ONE_SHOT.name, EXEC_ONE_SHOT.args, {
        sessionId,
        elicitation: seam,
      })) as Record<string, unknown>;
      assert.equal((first as { exitCode?: number }).exitCode, 1);
      assert.equal(rowsFor(sessionId)[0]!.outcomeDetail, 'failed');

      const retry = (await callTool(EXEC_ONE_SHOT.name, EXEC_ONE_SHOT.args, {
        sessionId,
        elicitation: seam,
      })) as Record<string, unknown>;
      assert.equal(requests.length, 1, 'a failed outcome keeps the memo covering');
      assert.equal(retry.approvedVia, 'retry-uncertain');
      assert.equal(rowsFor(sessionId)[1]!.outcomeDetail, 'delivered', 'the reuse delivered');

      // The delivered reuse clears the memo: the next identical call
      // confirms again (ApprovalCoreConsent's result-conditioned scope).
      const third = (await callTool(EXEC_ONE_SHOT.name, EXEC_ONE_SHOT.args, {
        sessionId,
        elicitation: seam,
      })) as Record<string, unknown>;
      assert.equal(requests.length, 2, 'the delivered reuse cleared the memo');
      assert.equal(third.approvedVia, undefined);
    });
  });
});

test('classified benign content never mints and executes with no confirmation surface, in both modes', async () => {
  await withSandboxHome(async (home) => {
    const benign = { ...EXEC_ONE_SHOT.args, command: 'ls -la /workspace' };
    const approvalsPath = join(home, '.config', 'huaweicloud', 'approvals.json');

    await withApprovalMode('ask', async () => {
      resetKnobs();
      const { seam, requests } = elicitingSeam({ decision: 'accept', content: { confirm: true } });
      const sessionId = freshSessionId('benign-ask');
      const result = (await callTool(EXEC_ONE_SHOT.name, benign, {
        sessionId,
        elicitation: seam,
      })) as Record<string, unknown>;
      assert.equal(requests.length, 0, 'a benign command raises no form');
      assert.ok(result.status !== 'rejected', 'the benign command runs ungated');
      assert.equal(rowsFor(sessionId).length, 0, 'no consent row for a pass-through');
    });

    await withApprovalMode(undefined, async () => {
      resetKnobs();
      // Semantic pin, deliberately branch-shape-free (the sibling
      // registrations' gate changes may legitimately answer a no-token
      // arrival with either the attestation throw or an envelope): a
      // classified-benign no-token call never EXECUTES and never MINTS.
      // Those two invariants survive every branch; the exact refusal
      // surface does not.
      const swallowed = await callTool(EXEC_ONE_SHOT.name, benign, {
        sessionId: freshSessionId('benign-notoken'),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      void swallowed;
      assert.equal(execLog.length, 0, 'a benign no-token arrival executes nothing');
      assert.equal(
        existsSync(approvalsPath),
        false,
        'a benign no-token arrival mints nothing (NoDoomedToken: never a token for content the gate passes through)',
      );

      // The attested benign call executes: the classified pass sits between
      // the attestation and the mint, so nothing is minted on the way.
      const result = (await callTool(
        EXEC_ONE_SHOT.name,
        { ...benign, approvedByUser: true },
        {
          sessionId: freshSessionId('benign-token'),
        },
      )) as Record<string, unknown>;
      assert.ok(result.status !== 'rejected', 'a benign attested call mints nothing and executes');
      assert.equal(execLog.length, 1, 'the handler ran');
      assert.equal(existsSync(approvalsPath), false, 'no token was ever minted for benign content');
    });
  });
});

test('strict classification denies destructive content before any mint, and the deny survives every confirmation', async () => {
  await withSandboxHome(async () => {
    const destructive = { ...EXEC_ONE_SHOT.args, command: DESTRUCTIVE_COMMAND };

    // Token mode, no token: the deny fires at the gate face, nothing mints.
    await withApprovalMode(undefined, async () => {
      resetKnobs();
      const sessionId = freshSessionId('deny-mint');
      await assert.rejects(
        () => callTool(EXEC_ONE_SHOT.name, { ...destructive, approvedByUser: true }, { sessionId }),
        (error: unknown) => {
          assert.match((error as Error).message, /hwc-sandbox-destructive-command/, 'the deny names the rule');
          assert.match((error as Error).message, /no confirmation unlocks it/);
          return true;
        },
      );
      assert.equal(execLog.length, 0, 'nothing executed');
    });

    // Token mode WITH a confirmed token minted for a different command:
    // the deny precedes the consume, nothing burns, nothing executes.
    await withApprovalMode(undefined, async () => {
      resetKnobs();
      const mintSession = freshSessionId('deny-confirm');
      const mint = (await callTool(
        EXEC_ONE_SHOT.name,
        { ...EXEC_ONE_SHOT.args, approvedByUser: true },
        {
          sessionId: mintSession,
        },
      )) as { approvalToken?: string };
      assert.ok(typeof mint.approvalToken === 'string', 'the write-classified command minted');
      confirmApprovalToken(mint.approvalToken!);
      await assert.rejects(
        () =>
          callTool(
            EXEC_ONE_SHOT.name,
            { ...destructive, approvalToken: mint.approvalToken, approvedByUser: true },
            { sessionId: freshSessionId('deny-confirm-2') },
          ),
        /hwc-sandbox-destructive-command/,
        'the deny fires before the token consumes — the strict classification still arbitrates after confirm',
      );
      assert.equal(execLog.length, 0, 'nothing executed');
    });

    // Ask mode: no form ever fires for destructive content, and the
    // attested retry still denies — the user's chat approval cannot unlock
    // what the classification refuses.
    await withApprovalMode('ask', async () => {
      resetKnobs();
      const { seam, requests } = elicitingSeam({ decision: 'accept', content: { confirm: true } });
      const sessionId = freshSessionId('deny-ask');
      await assert.rejects(
        () => callTool(EXEC_ONE_SHOT.name, destructive, { sessionId, elicitation: seam }),
        /hwc-sandbox-destructive-command/,
      );
      assert.equal(requests.length, 0, 'no confirmation surface for destructive content');
      await assert.rejects(
        () => callTool(EXEC_ONE_SHOT.name, { ...destructive, approvedByUser: true }, { sessionId, elicitation: seam }),
        /hwc-sandbox-destructive-command/,
        'the deny survives an explicit user confirmation',
      );
      assert.equal(rowsFor(sessionId).length, 0, 'no consent row was ever recorded');
    });
  });
});

test('credential-shaped exec content denies too: no surface, no unlock', async () => {
  await withSandboxHome(async () => {
    await withApprovalMode('ask', async () => {
      resetKnobs();
      const sessionId = freshSessionId('deny-cred');
      await assert.rejects(
        () =>
          callTool(
            EXEC_ONE_SHOT.name,
            { ...EXEC_ONE_SHOT.args, command: 'cat ~/.huaweicloud/credentials.json' },
            {
              sessionId,
            },
          ),
        /credential|blocked/i,
        'reading credential files through the exec face refuses',
      );
      assert.equal(rowsFor(sessionId).length, 0);
    });
  });
});

// The doctor's standing-consent listing lives in the doctor family
// (doctor-ask-rule.test.ts carries it): this battery stays purely in-process
// — its own doctor spawns once competed with the marginal fold-timing test
// in the ledger battery under full-suite load, and the listing is a doctor
// behavior with the doctor family's spawn budget either way.
