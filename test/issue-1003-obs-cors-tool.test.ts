import assert from 'node:assert/strict';
import test from 'node:test';

import { callTool, TOOL_DEFINITIONS } from '../plugins/huaweicloud-core/src/tools.ts';
import { getToolSchema } from '../plugins/huaweicloud-core/src/tool-schemas.ts';
import { setRuntimeCredentials, clearRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { confirmApprovalToken } from '../plugins/huaweicloud-core/src/lib/approval-tokens.ts';
import { withTempAuthHome } from './hcloud-cli-harness.ts';
import { pinObsMockEnv, withMockedFetch } from './obs-fetch-harness.ts';

// The battery drives the obs cors gate through the token mint/confirm flow;
// the approval-mode flip (unset now means ask) requires the token posture
// pinned explicitly at module scope.
process.env.DEVKIT_APPROVAL_MODE = 'token';

// ---- #1003: huaweicloud_obs_set_cors tool (same-structure obsSignedRequest
// reuse; the subresource parameterization is the port's own seam) ----

test('TOOL_DEFINITIONS exposes huaweicloud_obs_set_cors with set/get/delete + rules schema (#1003)', () => {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === 'huaweicloud_obs_set_cors');
  assert.ok(tool, 'tool must be registered');
  // v2's ToolDefinition carries name+description; the zod schema is the
  // single source of truth — pin the RENDERED JSON Schema (toJSONSchema is the
  // stable surface; the zod def internals are not) plus main's required-set
  // pins, and the HEAD doctrine on the tool description.
  const schema = getToolSchema('huaweicloud_obs_set_cors').toJSONSchema() as {
    properties?: Record<string, { enum?: string[]; items?: { required?: string[] } }>;
    required?: string[];
  };
  assert.deepEqual(schema.properties?.action?.enum, ['set', 'get', 'delete']);
  assert.deepEqual(schema.properties?.rules?.items?.required, ['allowedOrigin', 'allowedMethod']);
  assert.deepEqual(schema.required, ['action', 'bucket', 'region']);
  assert.match(tool.description, /allowedMethod 必须含 HEAD/);
  assert.match(tool.description, /BrowserJS SDK/);
});

const fullRules = [
  {
    allowedOrigin: 'https://app.example.com',
    allowedMethod: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
    allowedHeader: ['*'],
    maxAgeSeconds: 3000,
  },
];

// The cors tool is approval-gated (PR-3c: set/delete are signed writes).
// Every write-side drive funnels through the attested mint → terminal
// confirm → retry cycle, inside an isolated auth home so the token never
// touches the machine's real approvals store. Reads classify none and
// need only the attestation.
async function gatedCorsCall(args: Record<string, unknown>): Promise<unknown> {
  let result: unknown;
  await withTempAuthHome(async () => {
    // withTempAuthHome's isolation strips the credential env the outer
    // withMockedFetch pinned, so the env tier is re-pinned INSIDE — the
    // retry's handler resolves credentials against the mock tier, never
    // the machine's real stores.
    pinObsMockEnv();
    const envelope = (await callTool('huaweicloud_obs_set_cors', { ...args, approvedByUser: true })) as {
      code: string;
      approvalToken: string;
    };
    assert.equal(envelope.code, 'USER_CONFIRMATION_REQUIRED', 'the tokenless write mints');
    assert.equal(confirmApprovalToken(envelope.approvalToken).status, 'confirmed');
    result = await callTool('huaweicloud_obs_set_cors', {
      ...args,
      approvalToken: envelope.approvalToken,
      approvedByUser: true,
    });
  });
  return result;
}

test('set builds CORSConfiguration XML and PUTs /?cors with the verify preflight hint (#1003)', async () => {
  const calls: Array<{ url: string; method: unknown; body: unknown }> = [];
  await withMockedFetch(
    async (url, opts) => {
      calls.push({
        url: String(url),
        method: (opts as { method?: string } | undefined)?.method,
        body: (opts as { body?: string } | undefined)?.body,
      });
      return { status: 200, text: async () => '' };
    },
    async () => {
      const res = (await gatedCorsCall({
        action: 'set',
        bucket: 'my-bucket',
        region: 'cn-north-4',
        rules: fullRules,
      })) as Record<string, unknown>;
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, 'https://my-bucket.obs.cn-north-4.myhuaweicloud.com/?cors');
      assert.equal(calls[0]!.method, 'PUT');
      assert.match(String(calls[0]!.body), /<CORSConfiguration>/);
      assert.match(String(calls[0]!.body), /<AllowedOrigin>https:\/\/app\.example\.com<\/AllowedOrigin>/);
      // p01: HEAD must be present — the BrowserJS SDK probe depends on it.
      assert.match(String(calls[0]!.body), /<AllowedMethod>HEAD<\/AllowedMethod>/);
      assert.match(String(calls[0]!.body), /<MaxAgeSeconds>3000<\/MaxAgeSeconds>/);
      assert.equal(res.ok, true);
      assert.match(String(res.message), /CORS configured for my-bucket/);
      assert.match(String(res.verify), /OPTIONS/);
      assert.match(String(res.verify), /Access-Control-Request-Method: HEAD/);
      assert.match(String(res.verify), /--noproxy/);
    },
  );
});

test('get and delete address the /?cors subresource (#1003)', async () => {
  const calls: Array<{ method: unknown; url: string }> = [];
  await withMockedFetch(
    async (url, opts) => {
      const method = (opts as { method?: string } | undefined)?.method;
      calls.push({ method, url: String(url) });
      return { status: method === 'DELETE' ? 204 : 200, text: async () => '<CORSConfiguration/>' };
    },
    async () => {
      const got = (await callTool('huaweicloud_obs_set_cors', {
        action: 'get',
        bucket: 'my-bucket',
        region: 'cn-north-4',
        approvedByUser: true,
      })) as Record<string, unknown>;
      assert.equal(calls[0]!.method, 'GET');
      assert.match(calls[0]!.url, /\?cors$/);
      assert.equal(got.ok, true);
      assert.match(String(got.verify), /OPTIONS/, 'get must carry the preflight hint too');

      const deleted = (await gatedCorsCall({
        action: 'delete',
        bucket: 'my-bucket',
        region: 'cn-north-4',
      })) as Record<string, unknown>;
      assert.equal(calls[1]!.method, 'DELETE');
      assert.match(calls[1]!.url, /\?cors$/);
      assert.equal(deleted.ok, true);
      assert.equal(deleted.status, 204);
    },
  );
});

test('set rejects a rule without HEAD at the input boundary, before any request (#1003/p01)', async () => {
  let fetchCalled = 0;
  await withMockedFetch(
    async () => {
      fetchCalled += 1;
      return { status: 200, text: async () => '' };
    },
    async () => {
      await assert.rejects(
        gatedCorsCall({
          action: 'set',
          bucket: 'my-bucket',
          region: 'cn-north-4',
          rules: [{ allowedOrigin: 'https://app.example.com', allowedMethod: ['GET', 'PUT'] }],
        }),
        (err: Error) => {
          assert.match(err.message, /must include 'HEAD'/);
          assert.match(err.message, /p01/);
          return true;
        },
      );
      assert.equal(fetchCalled, 0, 'input-boundary rejection must not reach the network');
    },
  );
});

test('set without credentials points at huaweicloud_auth_init (website-config parity, #1003)', async () => {
  await withMockedFetch(
    async () => ({ status: 200, text: async () => '' }),
    async () => {
      // runtimeCredentials wins over env/file stores — empty runtime creds
      // make the no-credential path hermetic.
      setRuntimeCredentials('', '', '', '');
      try {
        await assert.rejects(
          gatedCorsCall({
            action: 'set',
            bucket: 'my-bucket',
            region: 'cn-north-4',
            rules: fullRules,
          }),
          /huaweicloud_auth_init/,
        );
      } finally {
        clearRuntimeCredentials();
      }
    },
  );
});

test('set applies the documented defaults (allowedHeader *, maxAgeSeconds 3000) and escapes XML (#1003)', async () => {
  const calls: Array<{ body: unknown }> = [];
  await withMockedFetch(
    async (_url, opts) => {
      calls.push({ body: (opts as { body?: string } | undefined)?.body });
      return { status: 200, text: async () => '' };
    },
    async () => {
      await gatedCorsCall({
        action: 'set',
        bucket: 'my-bucket',
        region: 'cn-north-4',
        rules: [{ allowedOrigin: 'https://a.com?x=1&y=<2>', allowedMethod: ['GET', 'HEAD'] }],
      });
      const body = String(calls[0]!.body);
      assert.match(
        body,
        /<AllowedOrigin>https:\/\/a\.com\?x=1&amp;y=&lt;2&gt;<\/AllowedOrigin>/,
        'XML metacharacters must be escaped',
      );
      assert.match(body, /<AllowedHeader>\*<\/AllowedHeader>/, 'the * header default applies');
      assert.match(body, /<MaxAgeSeconds>3000<\/MaxAgeSeconds>/, 'the documented 3000 default applies when omitted');
    },
  );
});

test('set surfaces the OBS error body on non-200 for self-diagnosis (#1003)', async () => {
  await withMockedFetch(
    async () => ({ status: 400, text: async () => '<Error><Code>InvalidRequest</Code></Error>' }),
    async () => {
      const res = (await gatedCorsCall({
        action: 'set',
        bucket: 'my-bucket',
        region: 'cn-north-4',
        rules: fullRules,
      })) as Record<string, unknown>;
      assert.equal(res.ok, false);
      assert.equal(res.status, 400);
      assert.match(String(res.errorDetail), /InvalidRequest/);
    },
  );
});

test('STS credentials sign the x-amz-security-token header (#1003 hardening)', async () => {
  let auth = '';
  await withMockedFetch(
    async (_url, opts) => {
      auth = String((opts as { headers?: Record<string, string> } | undefined)?.headers?.Authorization ?? '');
      return { status: 200, text: async () => '' };
    },
    async () => {
      // Runtime credentials win over env AND the machine's real vault/S1 —
      // the only hermetic way to test the STS path on a credentialed host.
      setRuntimeCredentials('test-ak', 'test-sk', 'sts-token');
      try {
        const res = (await callTool('huaweicloud_obs_set_cors', {
          action: 'get',
          bucket: 'my-bucket',
          region: 'cn-north-4',
          approvedByUser: true,
        })) as Record<string, unknown>;
        assert.equal(res.ok, true);
        assert.match(
          auth,
          /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token/,
          'the token header must be signed',
        );
      } finally {
        clearRuntimeCredentials();
      }
    },
  );
});
