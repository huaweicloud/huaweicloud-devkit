import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { APPROVAL_SPECS } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import { runApprovalGate, NO_SESSION_SEAM_ERROR } from '../plugins/huaweicloud-core/src/approval-gate.ts';
import { confirmApprovalToken, hashArgs } from '../plugins/huaweicloud-core/src/lib/approval-tokens.ts';
import { readConsentEvents } from '../plugins/huaweicloud-core/src/approval-ledger.ts';
import { clearRuntimePacksOverride } from '../plugins/huaweicloud-core/src/packs/enable.ts';
import { withApprovalMode, withVaultAuthHome } from './approval-mode-harness.ts';
import { withTempAuthHome } from './hcloud-cli-harness.ts';
import { withMockedFetch } from './obs-fetch-harness.ts';
import type {
  ApprovalSpec,
  ElicitationSeam,
  ElicitFormRequest,
} from '../plugins/huaweicloud-core/src/approval-types.ts';
import type { ToolName } from '../plugins/huaweicloud-core/src/tool-definitions.ts';

// PR-3c's registration battery: the five tools (the obs pair, upgrade,
// secret_delete, packs_configure) gate in both modes with the right
// flavors, the packs_configure seam precheck refuses a no-seam call before
// any mint, the obs read stays ungated while set/delete confirm, and the
// unregistered neighbors (secret_set, secret_list, setup_obs_config) run
// with no gate envelope at all. Driven through the real callTool dispatch
// wherever the handler runs hermetically (mocked fetch for obs, the vault
// for secrets, the session override for packs_configure); upgrade's execute
// leg is pinned at the gate level only, because the handler spawns npm
// against the registry — its behavior is owned by update-check-upgrade and
// the recorder battery.

function approvalsPath(home: string): string {
  return join(home, '.config', 'huaweicloud', 'approvals.json');
}

interface MintEnvelope {
  status: string;
  code: string;
  approvalToken: string;
  userConfirmation: { needed: boolean; summary: string; argsHash: string; command: string };
}

// The mint leg of a gate-source tool. The attestation precedes every gate
// effect (the trunk contract the hcloud battery pins), so the call is
// ATTESTED but tokenless: the model asserts the user approved, the gate
// answers that the terminal confirmation is still missing.
async function mint(
  name: ToolName,
  args: Record<string, unknown>,
  opts: Record<string, unknown> = {},
): Promise<MintEnvelope> {
  const envelope = (await callTool(name, { ...args, approvedByUser: true }, opts)) as MintEnvelope;
  assert.equal(envelope.status, 'rejected');
  assert.equal(envelope.code, 'USER_CONFIRMATION_REQUIRED', `${name} mints on the first no-token call`);
  assert.match(envelope.approvalToken, /^[0-9a-f-]{36}$/);
  assert.equal(envelope.userConfirmation.needed, true);
  assert.match(
    envelope.userConfirmation.command,
    new RegExp(`npx huaweicloud-devkit approve ${envelope.approvalToken}`),
    `${name}'s envelope carries the approve line`,
  );
  return envelope;
}

function elicitingSeam(decision: 'accept' | 'decline', requests: ElicitFormRequest[] = []): ElicitationSeam {
  return {
    capable: true,
    prompt: async (request) => {
      requests.push(request);
      return decision === 'accept' ? { decision: 'accept', content: { confirm: true } } : { decision: 'decline' };
    },
  };
}

const WEBSITE_SET_ARGS = {
  action: 'set',
  bucket: 'pr3c-bucket',
  region: 'cn-north-4',
  indexDocument: 'index.html',
};

test('obs website set: token mode mints with the bucket in the view, the confirmed retry lands the signed PUT', async () => {
  await withTempAuthHome(async (home) => {
    const calls: Array<{ method: unknown; url: string; body: unknown }> = [];
    await withMockedFetch(
      async (url, opts) => {
        calls.push({
          method: (opts as { method?: string }).method,
          url: String(url),
          body: (opts as { body?: string }).body,
        });
        return { status: 200, text: async () => '' };
      },
      async () => {
        const envelope = await mint('huaweicloud_obs_set_website_config', WEBSITE_SET_ARGS);
        assert.match(
          envelope.userConfirmation.summary,
          /huaweicloud_obs_set_website_config: set website config on bucket pr3c-bucket \(region cn-north-4\), index index\.html/,
          'the confirmation view names the tool, action, bucket, region, and index document',
        );
        assert.equal(
          envelope.userConfirmation.argsHash,
          hashArgs({
            action: 'set',
            bucket: 'pr3c-bucket',
            region: 'cn-north-4',
            indexDocument: 'index.html',
            errorDocument: undefined,
          }),
          'the envelope binds the CONTENT projection, never the gate fields',
        );
        assert.equal(confirmApprovalToken(envelope.approvalToken).status, 'confirmed');
        assert.equal(calls.length, 0, 'nothing executed before the confirmation');

        const res = (await callTool('huaweicloud_obs_set_website_config', {
          ...WEBSITE_SET_ARGS,
          approvalToken: envelope.approvalToken,
          approvedByUser: true,
        })) as Record<string, unknown>;
        assert.equal(res.ok, true, 'the confirmed retry executes');
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.method, 'PUT');
        assert.equal(calls[0]!.url, 'https://pr3c-bucket.obs.cn-north-4.myhuaweicloud.com/?website');
        assert.match(String(calls[0]!.body), /<IndexDocument><Suffix>index\.html<\/Suffix><\/IndexDocument>/);
      },
    );
    assert.equal(existsSync(approvalsPath(home)), true, 'the spent token leaves its tombstone behind');
  });
});

test('obs website set: a retry with different content under the same token refuses on the pin view', async () => {
  await withTempAuthHome(async () => {
    await withMockedFetch(
      async () => ({ status: 200, text: async () => '' }),
      async () => {
        const envelope = await mint('huaweicloud_obs_set_website_config', WEBSITE_SET_ARGS);
        assert.equal(confirmApprovalToken(envelope.approvalToken).status, 'confirmed');
        await assert.rejects(
          callTool('huaweicloud_obs_set_website_config', {
            ...WEBSITE_SET_ARGS,
            bucket: 'other-bucket',
            approvalToken: envelope.approvalToken,
            approvedByUser: true,
          }),
          /Provided args do not match the approved plan/,
          'a different bucket under the same token never executes',
        );
      },
    );
  });
});

test('obs classified: action=get is a signed read that runs ungated; delete mints like set', async () => {
  await withTempAuthHome(async (home) => {
    const calls: Array<{ method: unknown; url: string }> = [];
    await withMockedFetch(
      async (url, opts) => {
        const method = (opts as { method?: string }).method;
        calls.push({ method, url: String(url) });
        // OBS answers DELETE with 204 No Content; GET with 200 + XML body.
        return { status: method === 'DELETE' ? 204 : 200, text: async () => '<WebsiteConfiguration/>' };
      },
      async () => {
        const got = (await callTool('huaweicloud_obs_set_website_config', {
          action: 'get',
          bucket: 'pr3c-bucket',
          region: 'cn-north-4',
          approvedByUser: true,
        })) as Record<string, unknown>;
        assert.equal(got.ok, true);
        assert.equal(calls[0]!.method, 'GET');
        assert.equal(existsSync(approvalsPath(home)), false, 'the read classifies none: no mint, no approvals store');

        const envelope = await mint('huaweicloud_obs_set_website_config', {
          action: 'delete',
          bucket: 'pr3c-bucket',
          region: 'cn-north-4',
        });
        assert.match(envelope.userConfirmation.summary, /delete website config on bucket pr3c-bucket/);
        assert.equal(confirmApprovalToken(envelope.approvalToken).status, 'confirmed');
        const removed = (await callTool('huaweicloud_obs_set_website_config', {
          action: 'delete',
          bucket: 'pr3c-bucket',
          region: 'cn-north-4',
          approvalToken: envelope.approvalToken,
          approvedByUser: true,
        })) as Record<string, unknown>;
        assert.equal(removed.ok, true);
        assert.equal(calls[1]!.method, 'DELETE');
      },
    );
  });
});

test('obs set preconditions refuse before the mint: no approval is doomed (both modes)', async () => {
  await withTempAuthHome(async (home) => {
    await withMockedFetch(
      async () => ({ status: 200, text: async () => '' }),
      async () => {
        await assert.rejects(
          callTool('huaweicloud_obs_set_website_config', {
            action: 'set',
            bucket: 'pr3c-bucket',
            region: 'cn-north-4',
            approvedByUser: true,
          }),
          /indexDocument is required for action=set/,
          'token mode: the set precondition precedes the mint',
        );
        await assert.rejects(
          callTool('huaweicloud_obs_set_cors', {
            action: 'set',
            bucket: 'pr3c-bucket',
            region: 'cn-north-4',
            approvedByUser: true,
          }),
          /rules array is required for action=set/,
          'token mode: the cors set precondition precedes the mint',
        );
        assert.equal(existsSync(approvalsPath(home)), false, 'no token was minted for refused content');
      },
    );
    await withApprovalMode('ask', async () => {
      await assert.rejects(
        callTool('huaweicloud_obs_set_website_config', {
          action: 'set',
          bucket: 'pr3c-bucket',
          region: 'cn-north-4',
          approvedByUser: true,
        }),
        /indexDocument is required for action=set/,
        'ask mode: the floor precedes the form and the consent record',
      );
      assert.deepEqual(readConsentEvents(), [], 'a refused call is not a consent arrival');
    });
  });
});

test('obs website set in ask mode: the elicitation form carries the summarize view, accept executes with the ledger row', async () => {
  await withTempAuthHome(async () => {
    const requests: ElicitFormRequest[] = [];
    const calls: Array<{ method: unknown }> = [];
    await withApprovalMode('ask', async () => {
      await withMockedFetch(
        async (_url, opts) => {
          calls.push({ method: (opts as { method?: string }).method });
          return { status: 200, text: async () => '' };
        },
        async () => {
          // The commandless ask arrival keeps the trunk attestation contract:
          // the ATTESTED call is the one the form answers (the elicitation
          // branch supersedes the attestation — a human answered, which is
          // strictly stronger).
          const res = (await callTool(
            'huaweicloud_obs_set_website_config',
            { ...WEBSITE_SET_ARGS, approvedByUser: true },
            {
              sessionId: 'pr3c-obs-ask',
              elicitation: elicitingSeam('accept', requests),
            },
          )) as Record<string, unknown>;
          assert.equal(res.ok, true, 'the form accept executes the signed PUT');
          assert.equal(calls.length, 1);
          assert.equal(calls[0]!.method, 'PUT');
        },
      );
    });
    assert.equal(requests.length, 1, 'the capable arrival raised exactly one form');
    assert.match(
      requests[0]!.message,
      /set website config on bucket pr3c-bucket/,
      'the form body carries the summarize view naming the bucket',
    );
    const rows = readConsentEvents().filter((row) => row.tool === 'huaweicloud_obs_set_website_config');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.evidence, 'elicitation');
    assert.equal(rows[0]!.outcome, 'granted');
    assert.equal(
      rows[0]!.argsHash,
      hashArgs({
        action: 'set',
        bucket: 'pr3c-bucket',
        region: 'cn-north-4',
        indexDocument: 'index.html',
        errorDocument: undefined,
      }),
      'the ledger row binds the content projection',
    );
  });
});

test('obs website set in ask mode: a declined form refuses fail-closed with nothing recorded', async () => {
  await withTempAuthHome(async () => {
    await withApprovalMode('ask', async () => {
      await withMockedFetch(
        async () => ({ status: 200, text: async () => '' }),
        async () => {
          const refusal = (await callTool(
            'huaweicloud_obs_set_website_config',
            { ...WEBSITE_SET_ARGS, approvedByUser: true },
            {
              sessionId: 'pr3c-obs-decline',
              elicitation: elicitingSeam('decline'),
            },
          )) as Record<string, unknown>;
          assert.equal(refusal.status, 'rejected');
          assert.equal(refusal.code, 'ELICITATION_DECLINED');
        },
      );
    });
    assert.deepEqual(
      readConsentEvents().filter((row) => row.tool === 'huaweicloud_obs_set_website_config'),
      [],
      'a declined form records no consent',
    );
  });
});

test('obs read in ask mode: the classified pass-through raises no form and records no consent', async () => {
  await withTempAuthHome(async () => {
    const requests: ElicitFormRequest[] = [];
    await withApprovalMode('ask', async () => {
      await withMockedFetch(
        async () => ({ status: 200, text: async () => '<WebsiteConfiguration/>' }),
        async () => {
          const got = (await callTool(
            'huaweicloud_obs_set_website_config',
            {
              action: 'get',
              bucket: 'pr3c-bucket',
              region: 'cn-north-4',
              approvedByUser: true,
            },
            { sessionId: 'pr3c-obs-get', elicitation: elicitingSeam('accept', requests) },
          )) as Record<string, unknown>;
          assert.equal(got.ok, true, 'the signed read runs unconfirmed');
        },
      );
    });
    assert.equal(requests.length, 0, 'a signed read never pops');
    assert.deepEqual(readConsentEvents(), [], 'the pass-through records no consent');
  });
});

test('secret_delete: token mode names the ref in the view, the confirmed retry deletes; secret_set stays ungated', async () => {
  await withVaultAuthHome(async (home) => {
    const set = (await callTool('huaweicloud_secret_set', {
      ref: 'secret://mcp/pr3c',
      channel: 'value',
      value: 'MCP-PR3C-SECRET',
    })) as Record<string, unknown>;
    assert.equal(set.status, 'set', 'secret_set runs with no gate envelope (the user is the plaintext source)');
    assert.equal(existsSync(approvalsPath(home)), false, 'the unregistered neighbor minted nothing');

    const envelope = await mint('huaweicloud_secret_delete', { ref: 'secret://mcp/pr3c' });
    assert.match(
      envelope.userConfirmation.summary,
      /huaweicloud_secret_delete: delete secret secret:\/\/mcp\/pr3c from the local vault/,
      'the confirmation view names the ref',
    );
    assert.equal(confirmApprovalToken(envelope.approvalToken).status, 'confirmed');
    const removed = (await callTool('huaweicloud_secret_delete', {
      ref: 'secret://mcp/pr3c',
      approvalToken: envelope.approvalToken,
      approvedByUser: true,
    })) as Record<string, unknown>;
    assert.equal(removed.removed, 1, 'the confirmed retry deletes the secret');

    const list = (await callTool('huaweicloud_secret_list', {})) as Record<string, unknown>;
    assert.equal(list.count, 0, 'secret_list stays ungated and reports the deletion');
  });
});

test('secret_delete in ask mode: an attested arrival executes on posture and records it; an unattested one throws fail-closed', async () => {
  await withVaultAuthHome(async () => {
    await callTool('huaweicloud_secret_set', { ref: 'secret://mcp/attested', channel: 'value', value: 'x' });
    await withApprovalMode('ask', async () => {
      // The commandless ask arrival keeps the trunk contract: unattested
      // throws the teaching error (no envelope to show — the recorded
      // commandless residual), and the attested retry executes on posture
      // trust, honestly labeled in the ledger.
      await assert.rejects(
        callTool('huaweicloud_secret_delete', { ref: 'secret://mcp/attested' }),
        /approvedByUser must be true/,
        'the unattested commandless arrival refuses before any gate effect',
      );
      const removed = (await callTool(
        'huaweicloud_secret_delete',
        {
          ref: 'secret://mcp/attested',
          approvedByUser: true,
        },
        { sessionId: 'pr3c-posture' },
      )) as Record<string, unknown>;
      assert.equal(removed.removed, 1);
    });
    const rows = readConsentEvents().filter((row) => row.tool === 'huaweicloud_secret_delete');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.evidence, 'posture', 'the commandless ask-mode execution records posture trust');
  });
});

test('packs_configure: the seam precheck refuses a no-seam call before any mint, in both modes', async () => {
  await withTempAuthHome(async (home) => {
    const tokenMode = (await callTool('huaweicloud_packs_configure', { enable: ['obs'] })) as {
      ok: boolean;
      error: string;
    };
    assert.deepEqual(tokenMode, { ok: false, error: NO_SESSION_SEAM_ERROR });
    assert.equal(existsSync(approvalsPath(home)), false, 'the no-seam refusal mints no token');
    assert.deepEqual(readConsentEvents(), [], 'the no-seam refusal writes no ledger entry');

    await withApprovalMode('ask', async () => {
      const askMode = (await callTool('huaweicloud_packs_configure', { enable: ['obs'] })) as {
        ok: boolean;
        error: string;
      };
      assert.deepEqual(askMode, { ok: false, error: NO_SESSION_SEAM_ERROR });
    });
    assert.equal(existsSync(approvalsPath(home)), false, 'ask mode refused the same way');
    assert.deepEqual(readConsentEvents(), [], 'still no ledger entry');
  });
});

test('packs_configure in a stdio session: the token envelope names the pack ids, the confirmed retry applies the override', async () => {
  // DEVKIT_PACKS=core: enabling obs must be a real change — with the full
  // default surface the enable would be a no-op and changed would read
  // false for a reason unrelated to the gate.
  const previousPacks = process.env.DEVKIT_PACKS;
  process.env.DEVKIT_PACKS = 'core';
  try {
    await withTempAuthHome(async () => {
      const envelope = await mint('huaweicloud_packs_configure', { enable: ['obs'] }, { onPacksChanged: () => {} });
      assert.match(
        envelope.userConfirmation.summary,
        /huaweicloud_packs_configure: enable pack\(s\) obs/,
        'the confirmation view names the enabled pack ids — the disclosure face is the consequence',
      );
      assert.equal(confirmApprovalToken(envelope.approvalToken).status, 'confirmed');
      const applied = (await callTool(
        'huaweicloud_packs_configure',
        { enable: ['obs'], approvalToken: envelope.approvalToken, approvedByUser: true },
        { onPacksChanged: () => {} },
      )) as Record<string, unknown>;
      assert.equal(applied.ok, true);
      assert.equal(applied.changed, true, 'the confirmed retry applies the session override');
    });
  } finally {
    clearRuntimePacksOverride();
    if (previousPacks === undefined) delete process.env.DEVKIT_PACKS;
    else process.env.DEVKIT_PACKS = previousPacks;
  }
});

test('packs_configure in ask mode: a stdio session with a capable client pops the form naming the pack ids', async () => {
  const previousPacks = process.env.DEVKIT_PACKS;
  process.env.DEVKIT_PACKS = 'core';
  try {
    await withTempAuthHome(async () => {
      const requests: ElicitFormRequest[] = [];
      await withApprovalMode('ask', async () => {
        const applied = (await callTool(
          'huaweicloud_packs_configure',
          { enable: ['obs', 'sandbox'], approvedByUser: true },
          {
            sessionId: 'pr3c-cfg-ask',
            onPacksChanged: () => {},
            elicitation: elicitingSeam('accept', requests),
          },
        )) as Record<string, unknown>;
        assert.equal(applied.ok, true, 'the form accept completes the call');
        assert.equal(applied.changed, true);
      });
      assert.equal(requests.length, 1, 'the stdio arrival raised exactly one form');
      assert.match(requests[0]!.message, /enable pack\(s\) obs, sandbox/, 'the form names the enabled pack ids');
      const rows = readConsentEvents().filter((row) => row.tool === 'huaweicloud_packs_configure');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.evidence, 'elicitation');
    });
  } finally {
    clearRuntimePacksOverride();
    if (previousPacks === undefined) delete process.env.DEVKIT_PACKS;
    else process.env.DEVKIT_PACKS = previousPacks;
  }
});

test('upgrade: token mode names the version in the view and the always-flavor grant gates the consume leg', async () => {
  await withTempAuthHome(async () => {
    // The execute leg is pinned at the gate level: the handler spawns npm
    // against the registry, which no hermetic battery may do. The mint
    // envelope goes through the real dispatch; the consume leg drives the
    // real spec with the confirmed token.
    const envelope = await mint('huaweicloud_upgrade', { version: 'latest', target: 'opencode' });
    assert.match(
      envelope.userConfirmation.summary,
      /huaweicloud_upgrade: upgrade huaweicloud-devkit to version latest \(target opencode\)/,
      'the confirmation view names the version',
    );
    assert.equal(confirmApprovalToken(envelope.approvalToken).status, 'confirmed');

    const spec = APPROVAL_SPECS.huaweicloud_upgrade as ApprovalSpec;
    assert.equal(spec.flavor, 'always');
    const consumed = await runApprovalGate(
      'huaweicloud_upgrade',
      spec,
      { version: 'latest', target: 'opencode', approvalToken: envelope.approvalToken, approvedByUser: true },
      {},
    );
    assert.ok('pass' in consumed, 'the confirmed token consumes on the always grant and the projection hash');
  });
});

test('setup_obs_config stays unregistered: the handler answers, no gate envelope ever mints', async () => {
  await withVaultAuthHome(async (home) => {
    const result = (await callTool('huaweicloud_setup_obs_config', {})) as Record<string, unknown>;
    assert.notEqual(
      result.code,
      'USER_CONFIRMATION_REQUIRED',
      'the flagged boundary item never returns the gate envelope',
    );
    assert.notEqual(result.status, 'rejected', 'no gate rejection shape on an unregistered tool');
    assert.equal(existsSync(approvalsPath(home)), false, 'the flagged boundary item mints nothing');
  });
});
