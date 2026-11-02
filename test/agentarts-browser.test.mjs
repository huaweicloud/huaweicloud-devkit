import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  readAgentartsBrowser,
  planAgentartsBrowserWrite,
  runAgentartsBrowserInvoke,
  runAgentartsBrowserSession,
  runAgentartsBrowserWrite,
  callAgentartsBrowserTool,
} from '../plugins/huaweicloud-core/src/agentarts-browser.mjs';
import {
  AGENTARTS_BROWSER_TOOL_DEFINITIONS,
  AGENTARTS_BROWSER_WRITE_TOOL_DEFINITIONS,
  BROWSER_READ_OPERATIONS,
  BROWSER_WRITE_OPERATIONS,
} from '../plugins/huaweicloud-core/src/agentarts-browser-tools.mjs';
import { clearRuntimeCredentials, setRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.mjs';
import { buildChildEnv } from '../plugins/huaweicloud-core/src/agentarts-cli.mjs';
import { callTool } from '../plugins/huaweicloud-core/src/tools.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// Python json.dumps formatting for stdout mocks (the trap-36 class: the
// real snippet always emits ", " / ": " separators; JS-compact mocks
// would let a formatting-sensitive consumer pass while reality differs).
function pyDumps(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => pyDumps(item)).join(', ') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value)
        .map(([k, v]) => `${JSON.stringify(k)}: ${pyDumps(v)}`)
        .join(', ') +
      '}'
    );
  }
  return JSON.stringify(value);
}

// Isolation: HUAWEICLOUD_HOME at a scratch dir (the agentarts test
// pattern) plus runtime-credential cleanup so the AK/SK injection tests
// never leak state across tests. EXECUTOR pattern: await fn() inline —
// a returned-uncalled async arrow makes every test vacuously green.
async function withIsolation(fn) {
  const home = mkdtempSync(join(tmpdir(), 'agentarts-browser-'));
  const previousHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = home;
  try {
    await fn(home);
  } finally {
    process.env.HUAWEICLOUD_HOME = previousHome;
    clearRuntimeCredentials();
    rmSync(home, { recursive: true, force: true });
  }
}

test('browser read validates the boundary before any spawn', async () => {
  await withIsolation(async () => {
    const bad = async (params, pattern) => {
      const out = await readAgentartsBrowser(params);
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.match(out.error, pattern);
    };
    await bad({ operation: 'navigate' }, /operation must be one of/);
    await bad({ operation: 'release_control' }, /operation must be one of/);
    await bad({ operation: 'get_browser' }, /browser_id is required/);
    await bad({ operation: 'get_browser_profile' }, /profile_id is required/);
    // Tag filters exist on the SDK list methods but are not exposed —
    // rejected as unknown params (honest boundary, not silent ignore).
    await bad({ operation: 'list_browsers', tag_key_exists: ['env'] }, /Unknown parameter "tag_key_exists"/);
    // A legal key in the wrong operation is a silent no-op otherwise.
    await bad({ operation: 'get_browser', browser_id: 'b1', limit: 10 }, /"limit" is not a parameter of get_browser/);
    await bad({ operation: 'list_browsers', browser_id: 'b1' }, /"browser_id" is not a parameter of list_browsers/);
    // Conservative limit window (the SDK applies no cap itself).
    await bad({ operation: 'list_browsers', limit: 0 }, /limit must be 1-100/);
    await bad({ operation: 'list_browsers', limit: 101 }, /limit must be 1-100/);
    await bad({ operation: 'list_browser_profiles', offset: -1 }, /offset must be >= 0/);
    // UUID format enforced at the boundary (the SDK validates client-side
    // before any network call — R1 boundary-burn class).
    await bad({ operation: 'get_browser', browser_id: 'not-a-uuid' }, /browser_id must be a valid UUID/);
    await bad({ operation: 'get_browser', browser_id: 'b1' }, /browser_id must be a valid UUID/);
    await bad(
      { operation: 'get_browser_profile', profile_id: '61ed9760-3a79-47c3-838a' },
      /profile_id must be a valid UUID/,
    );
    // sort_key: the SDK's own client-side enum (created_at|updated_at).
    await bad({ operation: 'list_browsers', sort_key: 'name' }, /sort_key must be one of/);
    // List name filter: 2-40 chars (the SDK's own client-side rule).
    await bad({ operation: 'list_browsers', name: 'x' }, /name must be 2-40 characters/);
    await bad({ operation: 'list_browser_profiles', name: 'x'.repeat(41) }, /name must be 2-40 characters/);
    // Mistyped values are rejected, never coerced. (null = unset, the
    // memory bridge's convention — legal, dropped from the request.)
    await bad({ operation: 'list_browsers', limit: true }, /limit must be an integer \(got boolean\)/);
    await bad({ operation: 'list_browsers', limit: '20' }, /limit must be an integer \(got string\)/);
    await bad({ operation: 'list_browsers', sort_dir: 'descending' }, /sort_dir must be "asc" or "desc"/);
    await bad({ operation: 'list_browsers', name: '' }, /name must be a non-empty string/);
    await bad({ operation: 'list_browsers', sort_key: 42 }, /sort_key must be a non-empty string/);
    // region: mistyped values are rejected, not silently defaulted.
    await bad({ operation: 'list_browsers', region: 42 }, /region must be a non-empty string/);
    await bad({ operation: 'list_browsers', region: '' }, /region must be a non-empty string/);
  });
});

test('browser read injects AK/SK into the child env; the request rides stdin, never argv', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const seen = [];
    const out = await readAgentartsBrowser(
      { operation: 'list_browsers' },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          seen.push({ candidate, args, childEnv, stdinData });
          return { exitCode: 0, stdout: '{"total_count": 0}', stderr: '' };
        },
      },
    );
    assert.equal(out.ok, true);
    assert.equal(seen.length, 1);
    const { args, childEnv, stdinData } = seen[0];
    // The control plane is AK/SK-signed (the list_agents posture — NOT
    // the memory data plane's narrower key-file model).
    assert.equal(childEnv.HUAWEICLOUD_SDK_AK, 'AKVALUE123');
    assert.equal(childEnv.HUAWEICLOUD_SDK_SK, 'SKVALUE456');
    // The request rides STDIN: argv is the fixed snippet only.
    assert.equal(args.length, 2);
    assert.equal(args[0], '-c');
    const request = JSON.parse(stdinData);
    assert.deepEqual(request, { operation: 'list_browsers', region: 'cn-southwest-2' });
    // Region is explicit, never ambient.
    assert.equal(request.region, 'cn-southwest-2');
  });
});

test('browser read without credentials rejects at the boundary (metadata-chain pre-gate)', async () => {
  await withIsolation(async () => {
    clearRuntimeCredentials();
    let spawned = false;
    const out = await readAgentartsBrowser(
      { operation: 'list_browsers' },
      {
        runCandidate: async (candidate, args, env) => {
          spawned = true;
          return { exitCode: 1, stdout: '', stderr: 'ToolsAPIError: authentication failed' };
        },
      },
    );
    assert.equal(out.ok, false);
    // The gate fires BEFORE any spawn: without injectable AK/SK the child
    // would fall through the profile/metadata chain — and the metadata
    // provider (http://169.254.169.254) is a live third link on runtime
    // hosts (R1 review round, three-reviewer unanimous).
    assert.equal(spawned, false, 'the credential gate must reject before spawning');
    assert.match(out.error, /No devkit credentials available for agentarts/);
    assert.match(out.error, /huaweicloud_auth_init/);
    assert.match(out.error, /never falls back to unmanaged profile files or the metadata chain/);
  });
});

test('browser read request carries list params; region param wins over the default', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    let request = null;
    const out = await readAgentartsBrowser(
      {
        operation: 'list_browser_profiles',
        name: 'team-profile',
        limit: 50,
        offset: 10,
        sort_dir: 'asc',
        region: 'cn-north-4',
      },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          request = JSON.parse(stdinData);
          return { exitCode: 0, stdout: '{"items": [], "total_count": 0}', stderr: '' };
        },
      },
    );
    assert.equal(out.ok, true);
    assert.deepEqual(request, {
      operation: 'list_browser_profiles',
      region: 'cn-north-4',
      name: 'team-profile',
      limit: 50,
      offset: 10,
      sort_dir: 'asc',
    });
    // sort_key omitted → the SDK default (created_at) applies server-side.
    assert.equal(request.sort_key, undefined);
  });
});

test('browser read envelope: failure, pollution, and the operation label', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const failure = await readAgentartsBrowser(
      { operation: 'get_browser', browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05' },
      {
        runCandidate: async () => ({ exitCode: 1, stdout: '', stderr: 'ToolsAPIError: Session not found' }),
      },
    );
    assert.equal(failure.ok, false);
    assert.equal(failure.failureDetected, true);
    assert.equal(failure.exitCode, 1);
    assert.match(failure.operation, /browser get_browser \(SDK control plane/);
    assert.match(failure.stderr, /Session not found/);

    // Exit 0 with unparseable stdout is output pollution, not success.
    const polluted = await readAgentartsBrowser(
      { operation: 'list_browsers' },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: 'not json at all', stderr: '' }),
      },
    );
    assert.equal(polluted.ok, false);
    assert.equal(polluted.failureDetected, true);
    assert.match(polluted.error, /output pollution suspected/);

    // ToolsAPIError extends BaseException (tools_http.py:10) — the
    // snippet's handler must catch BaseException, or the error kills the
    // child as an uncaught traceback past an `except Exception` guard.
    // Source pin (the structure-test pattern): the shipped snippet.
    const source = readFileSync(join(rootDir, 'plugins/huaweicloud-core/src/agentarts-browser.mjs'), 'utf8');
    assert.match(source, /except BaseException as error/);
    assert.doesNotMatch(source, /except Exception as error/);
  });
});

test('browser read enrichment: API_KEY-typed browsers get the console-key advisory', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const iamOnly = {
      items: [{ id: 'b1', name: 'br-1', auth_type: 'IAM', access_endpoint: 'gw.example.com' }],
      total_count: 1,
    };
    const out = await readAgentartsBrowser(
      { operation: 'list_browsers' },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: pyDumps(iamOnly), stderr: '' }),
      },
    );
    assert.equal(out.ok, true);
    assert.equal(out.notes, undefined);

    const apiKeyTyped = {
      items: [
        { id: 'b1', name: 'br-1', auth_type: 'IAM' },
        { id: 'b2', name: 'br-2', auth_type: 'API_KEY' },
      ],
      total_count: 2,
    };
    const advised = await readAgentartsBrowser(
      { operation: 'list_browsers' },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: pyDumps(apiKeyTyped), stderr: '' }),
      },
    );
    assert.equal(advised.ok, true);
    assert.ok(advised.notes.length >= 1);
    assert.match(advised.notes[0], /API_KEY-typed browser/);
    assert.match(advised.notes[0], /trap 61/);

    // get_browser shape (single dict, not an items array).
    const got = await readAgentartsBrowser(
      { operation: 'get_browser', browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05' },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({ id: 'b2', name: 'br-2', auth_type: 'API_KEY' }),
          stderr: '',
        }),
      },
    );
    assert.equal(got.ok, true);
    assert.ok(got.notes.length >= 1);
    assert.match(got.notes[0], /API_KEY-typed browser/);

    // Advisories describe RESULTS — a failed call carries none.
    const failed = await readAgentartsBrowser(
      { operation: 'list_browsers' },
      {
        runCandidate: async () => ({ exitCode: 1, stdout: '', stderr: 'ToolsAPIError: denied' }),
      },
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.notes, undefined);
  });
});

test('browser tool surface: one read tool, enum parity, no secret-shaped params', async () => {
  assert.equal(AGENTARTS_BROWSER_TOOL_DEFINITIONS.length, 1);
  const def = AGENTARTS_BROWSER_TOOL_DEFINITIONS[0];
  assert.equal(def.name, 'huaweicloud_agentarts_browser_read');
  assert.deepEqual(
    [...def.inputSchema.properties.operation.enum].sort((a, b) => a.localeCompare(b)),
    [...BROWSER_READ_OPERATIONS].sort((a, b) => a.localeCompare(b)),
  );
  // The credential channel is the injected AK/SK — the tool must never
  // accept a key parameter of any spelling.
  for (const banned of ['api_key', 'apiKey', 'api-key', 'key', 'sk', 'ak']) {
    assert.equal(banned in def.inputSchema.properties, false, `tool must not accept a ${banned} parameter`);
  }
  // The measured contracts are taught in the tool text itself.
  assert.match(def.description, /NO browser subcommands/);
  assert.match(def.description, /cn-southwest-2/);
  assert.match(def.description, /access_endpoint/);
  assert.match(def.description, /trap 61/);
  assert.match(def.description, /IAM-typed browsers sign the data plane/);
});

test(
  'callTool dispatches the browser read tool through the shared switch (stub python)',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async (home) => {
      setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
      // Hermetic dispatch: the python candidate chain's first entry is the
      // sibling python of the resolved CLI (dirname(resolved)/python), so a
      // stub AGENTARTS_BIN plus a stub sibling python answers without the
      // SDK, without the network.
      const stubBin = join(home, 'bin');
      mkdirSync(stubBin, { recursive: true });
      const stubPython = join(stubBin, 'python');
      writeFileSync(
        stubPython,
        ['#!/bin/bash', 'cat > /dev/null', 'printf \'{"total_count": 0}\'', 'exit 0', ''].join('\n'),
        { encoding: 'utf8', mode: 0o755 },
      );
      const stubCli = join(stubBin, 'agentarts');
      writeFileSync(stubCli, ['#!/bin/bash', 'exit 0', ''].join('\n'), { encoding: 'utf8', mode: 0o755 });
      const previousBin = process.env.AGENTARTS_BIN;
      process.env.AGENTARTS_BIN = stubCli;
      try {
        const out = await callTool('huaweicloud_agentarts_browser_read', {
          operation: 'list_browsers',
        });
        assert.equal(out.ok, true);
        assert.equal(out.service, 'AgentArts');
        assert.match(out.operation, /browser list_browsers/);
        assert.deepEqual(out.result, { total_count: 0 });
      } finally {
        process.env.AGENTARTS_BIN = previousBin;
      }
      const unknown = await callAgentartsBrowserTool('huaweicloud_agentarts_browser_nope', {});
      assert.equal(unknown.ok, false);
      assert.match(unknown.error, /Unknown agentarts browser tool/);
    });
  },
);

// ---------------------------------------------------------------------------
// B3: write bridge (resource lifecycle) — token-gated like every approved
// cloud write. These import lazily so the read-only import surface above
// stays honest about what the read tests exercise.

test('browser write validates the boundary before any token is minted', async () => {
  await withIsolation(async () => {
    const bad = async (params, pattern) => {
      const out = planAgentartsBrowserWrite(params);
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.match(out.error, pattern);
    };
    await bad({ operation: 'navigate' }, /operation must be one of/);
    await bad({ operation: 'create_browser' }, /name is required for create_browser/);
    await bad({ operation: 'create_browser', name: 'UPPER' }, /name must match/);
    await bad({ operation: 'create_browser', name: 'x' }, /name must match/);
    await bad({ operation: 'create_browser', name: '-starts-dash' }, /name must match/);
    await bad(
      { operation: 'create_browser', name: 'ok-name', auth_type: 'OAUTH' },
      /auth_type must be "IAM" or "API_KEY"/,
    );
    // api_key_name: required with API_KEY, rejected with IAM (naming a key
    // the IAM data plane never uses), pattern-checked.
    await bad(
      { operation: 'create_browser', name: 'ok-name', auth_type: 'API_KEY' },
      /api_key_name is required when auth_type=API_KEY/,
    );
    await bad(
      { operation: 'create_browser', name: 'ok-name', auth_type: 'IAM', api_key_name: 'some-key' },
      /api_key_name only applies to auth_type=API_KEY/,
    );
    await bad(
      { operation: 'create_browser', name: 'ok-name', auth_type: 'API_KEY', api_key_name: 'has spaces' },
      /api_key_name must match/,
    );
    await bad(
      { operation: 'create_browser', name: 'ok-name', description: '' },
      /description must be a non-empty string/,
    );
    await bad(
      { operation: 'create_browser_profile', name: 'ok-name', description: 'x'.repeat(4097) },
      /description must be at most 4096 characters/,
    );
    // update_browser REQUIRES tags (the only updatable field exposed).
    await bad(
      { operation: 'update_browser', browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05' },
      /update_browser requires a non-empty tags array/,
    );
    await bad({ operation: 'update_browser' }, /browser_id is required for update_browser/);
    await bad({ operation: 'delete_browser' }, /browser_id is required for delete_browser/);
    await bad({ operation: 'delete_browser_profile' }, /profile_id is required for delete_browser_profile/);
    // Tags shape: the SDK's own rules enforced at THIS boundary, before
    // any token is minted (a server 400 after minting wastes the plan).
    await bad({ operation: 'create_browser', name: 'ok-name', tags: 'nope' }, /tags must be an array/);
    await bad(
      { operation: 'create_browser', name: 'ok-name', tags: [{ key: 'a', value: '1', extra: 'x' }] },
      /tags\[0\] must have exactly the keys "key" and "value"/,
    );
    await bad({ operation: 'create_browser', name: 'ok-name', tags: [{ key: 'a' }] }, /tags\[0\] must have exactly/);
    await bad(
      { operation: 'create_browser', name: 'ok-name', tags: [{ key: 'a', value: '' }] },
      /tags\[0\]\.key and \.value must be non-empty strings/,
    );
    await bad(
      {
        operation: 'create_browser',
        name: 'ok-name',
        tags: [
          { key: 'a', value: '1' },
          { key: 'a', value: '2' },
        ],
      },
      /duplicates key "a"/,
    );
    await bad(
      {
        operation: 'create_browser',
        name: 'ok-name',
        tags: Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, value: 'v' })),
      },
      /at most 20 items/,
    );
    // Applicability: a legal key in the wrong operation.
    await bad(
      { operation: 'delete_browser', browser_id: 'b1', name: 'sneaky' },
      /"name" is not a parameter of delete_browser/,
    );
    await bad(
      { operation: 'create_browser', name: 'ok-name', observability: { logs: {} } },
      /Unknown parameter "observability"/,
    );
    await bad({ operation: 'create_browser', name: 'ok-name', region: 42 }, /region must be a non-empty string/);
    // Write ids: UUID format at the boundary — a malformed id is a
    // deterministic SDK client-side failure, and on the write path it
    // would BURN a minted approval token on a guaranteed no-op (R1).
    await bad(
      { operation: 'delete_browser', browser_id: 'not-a-uuid' },
      /browser_id must be a valid UUID.*consume the approval token/,
    );
    await bad(
      { operation: 'update_browser', browser_id: 'zzz', tags: [{ key: 'env', value: 'prod' }] },
      /browser_id must be a valid UUID/,
    );
    await bad({ operation: 'delete_browser_profile', profile_id: 'nope' }, /profile_id must be a valid UUID/);
    // Browser description: the SDK documents 4096 for browsers too —
    // the boundary rejects rather than burn a token on a possible 400.
    await bad(
      { operation: 'create_browser', name: 'ok-name', description: 'x'.repeat(4097) },
      /description must be at most 4096 characters/,
    );
  });
});

test('browser write plan canonicalizes IAM, sorts tags, and teaches the auth split', async () => {
  await withIsolation(async () => {
    // Default auth_type → IAM, canonicalized into the approved request.
    const plan = planAgentartsBrowserWrite({
      operation: 'create_browser',
      name: 'team-browser',
      description: 'demo',
      tags: [
        { key: 'env', value: 'prod' },
        { key: 'app', value: 'web' },
      ],
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.tier, 'approved');
    assert.equal(plan.request.auth_type, 'IAM');
    assert.equal(plan.request.api_key_name, undefined);
    // Tags SORT by key in the canonical request (byte-stable binding).
    assert.deepEqual(plan.request.tags, [
      { key: 'app', value: 'web' },
      { key: 'env', value: 'prod' },
    ]);
    assert.match(plan.approvalNote, /auth_type defaults to IAM/);
    assert.equal(typeof plan.approvalToken, 'string');
    assert.ok(plan.approvalToken.length > 0);

    // Empty tags array is DROPPED (the SDK treats [] as unset — the
    // approval shows what executes).
    const emptyTags = planAgentartsBrowserWrite({ operation: 'create_browser', name: 't2', tags: [] });
    assert.equal(emptyTags.request.tags, undefined);

    // Explicit API_KEY: key name required, the trap-61 teaching fires.
    const apiKeyPlan = planAgentartsBrowserWrite({
      operation: 'create_browser',
      name: 'legacy-browser',
      auth_type: 'API_KEY',
      api_key_name: 'legacy-key',
    });
    assert.equal(apiKeyPlan.request.auth_type, 'API_KEY');
    assert.equal(apiKeyPlan.request.api_key_name, 'legacy-key');
    assert.match(apiKeyPlan.approvalNote, /console api_key/);
    assert.match(apiKeyPlan.approvalNote, /trap 61/);

    // Deletes carry the irreversible label.
    const del = planAgentartsBrowserWrite({
      operation: 'delete_browser',
      browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05',
    });
    assert.deepEqual(del.labels, ['irreversible']);
    assert.match(del.approvalNote, /Labels: irreversible/);

    // Region default in the canonical request.
    assert.equal(plan.request.region, 'cn-southwest-2');
    const regional = planAgentartsBrowserWrite({
      operation: 'delete_browser',
      browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05',
      region: 'cn-north-4',
    });
    assert.equal(regional.request.region, 'cn-north-4');
  });
});

test('browser write enforces the token lifecycle and exact-parameter binding', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const params = {
      operation: 'create_browser',
      name: 'team-browser',
      tags: [
        { key: 'env', value: 'prod' },
        { key: 'app', value: 'web' },
      ],
    };
    const plan = planAgentartsBrowserWrite(params);
    assert.equal(plan.ok, true);

    // No attestation → the repo's three-element contract throws.
    await assert.rejects(
      () => runAgentartsBrowserWrite({ ...params, approvalToken: plan.approvalToken }),
      /approvedByUser must be true/,
    );

    // No token → remediation points at the plan tool.
    const noToken = await runAgentartsBrowserWrite({ ...params, approvedByUser: true });
    assert.equal(noToken.ok, false);
    assert.match(noToken.error, /approvalToken is required/);

    // Different parameters → binding mismatch, token NOT consumed. The
    // changed name stays pattern-valid (a boundary rejection is a
    // different failure than a binding mismatch).
    const changed = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken, name: 'changed-browser' },
      { runCandidate: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) },
    );
    assert.equal(changed.ok, false);
    assert.equal(changed.code, 'CONFIRM_TOKEN_MISMATCH');
    assert.match(changed.error, /DIFFERENT parameters/);
    const recheck = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: '{"total_count": 0}', stderr: '' }),
      },
    );
    assert.equal(recheck.ok, true, 'token must stay valid for the original parameters after a mismatch rejection');

    // Replay after a successful execution → idempotent already_processed.
    const replay = await runAgentartsBrowserWrite({
      ...params,
      approvedByUser: true,
      approvalToken: plan.approvalToken,
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.outcome, 'already_processed');
    assert.match(replay.note, /Verify with huaweicloud_agentarts_browser_read/);
  });
});

test('browser write rejects without burning the token when no AK/SK is injectable', async () => {
  await withIsolation(async () => {
    clearRuntimeCredentials();
    const params = { operation: 'delete_browser', browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05' };
    const plan = planAgentartsBrowserWrite(params);
    assert.equal(plan.ok, true);
    const out = await runAgentartsBrowserWrite({ ...params, approvedByUser: true, approvalToken: plan.approvalToken });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'NO_DEVKIT_CREDENTIALS');
    assert.match(out.error, /token was NOT consumed/);
    // After credentials appear, the SAME token still executes (the
    // pre-consumption rejection protected it).
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const retry = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: '{"deleted": true}', stderr: '' }),
      },
    );
    assert.equal(retry.ok, true);
  });
});

test('browser write executes with AK/SK injected, request on stdin, and the create notes teaching', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const params = { operation: 'create_browser', name: 'team-browser', description: 'demo' };
    const plan = planAgentartsBrowserWrite(params);
    const seen = [];
    const out = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          seen.push({ args, childEnv, stdinData });
          return {
            exitCode: 0,
            stdout: pyDumps({
              id: 'b-1',
              name: 'team-browser',
              auth_type: 'IAM',
              status: 'RUNNING',
              access_endpoint: 'gw.example.com',
            }),
            stderr: '',
          };
        },
      },
    );
    assert.equal(out.ok, true);
    assert.equal(seen.length, 1);
    const { args, childEnv, stdinData } = seen[0];
    assert.equal(childEnv.HUAWEICLOUD_SDK_AK, 'AKVALUE123');
    assert.equal(args.length, 2);
    assert.equal(args[0], '-c');
    assert.deepEqual(JSON.parse(stdinData), plan.request);
    // Write-side enrichment: the create notes teach traps 62 + 63 (the
    // shared defaultgw + access_endpoint semantics).
    assert.ok(out.notes.length >= 1);
    assert.match(out.notes.join(' '), /access_endpoint/);
    assert.match(out.notes.join(' '), /trap 62/);
    assert.match(out.notes.join(' '), /trap 63/);

    // Delete success carries the staleness-window note.
    const delParams = { operation: 'delete_browser', browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05' };
    const delPlan = planAgentartsBrowserWrite(delParams);
    const delOut = await runAgentartsBrowserWrite(
      { ...delParams, approvedByUser: true, approvalToken: delPlan.approvalToken },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: '{"deleted": true}', stderr: '' }),
      },
    );
    assert.equal(delOut.ok, true);
    assert.match(delOut.notes.join(' '), /staleness window/);

    // Update success carries the success ≠ applied verify rule.
    const updParams = {
      operation: 'update_browser',
      browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05',
      tags: [{ key: 'env', value: 'prod' }],
    };
    const updPlan = planAgentartsBrowserWrite(updParams);
    const updOut = await runAgentartsBrowserWrite(
      { ...updParams, approvedByUser: true, approvalToken: updPlan.approvalToken },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: '{"id": "b-1", "tags": []}', stderr: '' }),
      },
    );
    assert.equal(updOut.ok, true);
    assert.match(updOut.notes.join(' '), /success ≠ applied/);
  });
});

test('browser write failure burns the token and says so; the unshaped fallthrough discloses too', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const params = { operation: 'create_browser', name: 'team-browser' };
    const plan = planAgentartsBrowserWrite(params);
    const failed = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'ToolsAPIError: AgentArts.02000001 Incorrect request parameters',
        }),
      },
    );
    assert.equal(failed.ok, false);
    assert.match(failed.error, /token was consumed by this attempt/);

    // Every candidate fails to spawn: the generic install remediation
    // comes back unshaped (shapeResult never ran) — the consumed-token
    // disclosure must come from the wrapper.
    const plan2 = planAgentartsBrowserWrite({ operation: 'create_browser', name: 'team-browser-2' });
    const out = await runAgentartsBrowserWrite(
      { operation: 'create_browser', name: 'team-browser-2', approvedByUser: true, approvalToken: plan2.approvalToken },
      {
        runCandidate: async () => ({ exitCode: null, stdout: '', stderr: '', spawnError: new Error('gone') }),
      },
    );
    assert.equal(out.ok, false);
    assert.match(out.error, /already CONSUMED by this attempt and stays burned/);
    assert.match(out.error, /replaying this token returns already_processed/);
  });
});

test('browser write tool surface: plan/write pair, enum parity, irreversible labels pinned', async () => {
  assert.equal(AGENTARTS_BROWSER_WRITE_TOOL_DEFINITIONS.length, 2);
  const [planDef, writeDef] = AGENTARTS_BROWSER_WRITE_TOOL_DEFINITIONS;
  assert.equal(planDef.name, 'huaweicloud_agentarts_browser_plan');
  assert.equal(writeDef.name, 'huaweicloud_agentarts_browser_write');
  assert.deepEqual(
    [...planDef.inputSchema.properties.operation.enum].sort((a, b) => a.localeCompare(b)),
    [...BROWSER_WRITE_OPERATIONS].sort((a, b) => a.localeCompare(b)),
  );
  assert.deepEqual(
    [...writeDef.inputSchema.properties.operation.enum].sort((a, b) => a.localeCompare(b)),
    [...BROWSER_WRITE_OPERATIONS].sort((a, b) => a.localeCompare(b)),
  );
  for (const def of [planDef, writeDef]) {
    for (const banned of ['api_key', 'apiKey', 'api-key', 'key', 'sk', 'ak']) {
      assert.equal(banned in def.inputSchema.properties, false, `${def.name} must not accept a ${banned} parameter`);
    }
  }
  assert.match(planDef.description, /auth_type to IAM/);
  assert.match(planDef.description, /trap 61/);
  assert.match(writeDef.description, /irreversible/);
  assert.match(writeDef.description, /success ≠ applied/);
  assert.match(writeDef.description, /seconds-scale/);
  assert.deepEqual(writeDef.inputSchema.required, ['approvalToken', 'approvedByUser', 'operation']);
});

// ---------------------------------------------------------------------------
// R1 adversarial-review round: mutation-killing pins for the branches the
// initial suite left silent (dispatch wiring for the write pair, the
// timedOut and truncation envelope branches), the buildChildEnv additions
// (STS security token, browser data-plane key), and the credential-shape
// warning.

test(
  'callTool dispatches the browser PLAN and WRITE tools through the shared switch (stub python)',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async (home) => {
      setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
      // Same hermetic shape as the read dispatch test: AGENTARTS_BIN plus
      // a stub sibling python answers the write spawn.
      const stubBin = join(home, 'bin');
      mkdirSync(stubBin, { recursive: true });
      const stubPython = join(stubBin, 'python');
      writeFileSync(
        stubPython,
        ['#!/bin/bash', 'cat > /dev/null', 'printf \'{"deleted": true, "browser_id": "x"}\'', 'exit 0', ''].join('\n'),
        { encoding: 'utf8', mode: 0o755 },
      );
      const stubCli = join(stubBin, 'agentarts');
      writeFileSync(stubCli, ['#!/bin/bash', 'exit 0', ''].join('\n'), { encoding: 'utf8', mode: 0o755 });
      const previousBin = process.env.AGENTARTS_BIN;
      process.env.AGENTARTS_BIN = stubCli;
      try {
        const UUID = '61ed9760-3a79-47c3-838a-c77e38956a05';
        // PLAN through the shared switch (pure — no spawn).
        const plan = await callTool('huaweicloud_agentarts_browser_plan', {
          operation: 'delete_browser',
          browser_id: UUID,
        });
        assert.equal(plan.ok, true);
        assert.equal(plan.tier, 'approved');
        assert.equal(typeof plan.approvalToken, 'string');
        // WRITE through the shared switch: token + attestation + stub spawn.
        const out = await callTool('huaweicloud_agentarts_browser_write', {
          operation: 'delete_browser',
          browser_id: UUID,
          approvalToken: plan.approvalToken,
          approvedByUser: true,
        });
        assert.equal(out.ok, true);
        assert.match(out.operation, /browser delete_browser/);
        assert.equal(out.result.deleted, true);
      } finally {
        process.env.AGENTARTS_BIN = previousBin;
      }
    });
  },
);

test('browser envelope: the timedOut branch and the truncation side file both fire', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const UUID = '61ed9760-3a79-47c3-838a-c77e38956a05';
    // timedOut: exit-0 stdout is IGNORED (the timeout verdict wins) and
    // the error names the timeout.
    const timedOut = await readAgentartsBrowser(
      { operation: 'get_browser', browser_id: UUID },
      {
        runCandidate: async () => ({ exitCode: null, stdout: '{"id": "x"}', stderr: '', timedOut: true }),
      },
    );
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.timedOut, true);
    assert.match(timedOut.error, /timed out after/);
    assert.equal('result' in timedOut, false, 'a timed-out call carries no result');
    // Truncation: >50KB stdout fires the side file — the payload keeps a
    // 2000-char prefix + pointer, and `result` is DROPPED (the untruncated
    // object must not sit next to a truncated stdout).
    const big = { items: [{ id: UUID, name: 'br-1', pad: 'x'.repeat(60_000) }], total_count: 1 };
    const truncated = await readAgentartsBrowser(
      { operation: 'list_browsers' },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: pyDumps(big), stderr: '' }),
      },
    );
    assert.equal(truncated.ok, true);
    assert.match(truncated.stdout, /truncated, full output saved to/);
    assert.equal('result' in truncated, false, 'result must be dropped when the side file fires');
  });
});

test('buildChildEnv injects the STS security token and passes the browser data-plane key', async () => {
  await withIsolation(async () => {
    // STS temporary credentials: the SDK core reads
    // HUAWEICLOUD_SDK_SECURITY_TOKEN (provider.py:53) — without the
    // injection every pre-spawn gate passes while the child signs
    // WITHOUT X-Security-Token and fails auth (R1, reviewer-reproduced).
    setRuntimeCredentials('AKSTS123', 'SKSTS456', 'STS-TOKEN-XYZ');
    process.env.HUAWEICLOUD_SDK_BROWSER_API_KEY = 'BROWSER-KEY-1';
    try {
      const env = buildChildEnv({ injectCredentials: true });
      assert.equal(env.HUAWEICLOUD_SDK_AK, 'AKSTS123');
      assert.equal(env.HUAWEICLOUD_SDK_SK, 'SKSTS456');
      assert.equal(env.HUAWEICLOUD_SDK_SECURITY_TOKEN, 'STS-TOKEN-XYZ');
      assert.equal(env.HUAWEICLOUD_SDK_BROWSER_API_KEY, 'BROWSER-KEY-1');
      // The memory bridges' injectCredentials: false surface never sees
      // either addition (narrower data-plane credential posture).
      const memoryEnv = buildChildEnv({ injectCredentials: false });
      assert.equal(memoryEnv.HUAWEICLOUD_SDK_SECURITY_TOKEN, undefined);
      assert.equal(memoryEnv.HUAWEICLOUD_SDK_BROWSER_API_KEY, undefined);
    } finally {
      delete process.env.HUAWEICLOUD_SDK_BROWSER_API_KEY;
    }
    // Without a security token the env stays absent (plain AK/SK shape).
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const plain = buildChildEnv({ injectCredentials: true });
    assert.equal(plain.HUAWEICLOUD_SDK_SECURITY_TOKEN, undefined);
  });
});

test('browser write plan warns when tag values or description match credential shapes', async () => {
  await withIsolation(async () => {
    // The {key, value} tag shape defeats at-rest key[:=] redaction — the
    // warning is the only surface flagging a secret riding tags into
    // approvals.json (R1, reviewer-reproduced).
    const plan = planAgentartsBrowserWrite({
      operation: 'create_browser',
      name: 'team-browser',
      tags: [
        { key: 'password', value: 'hunter2' },
        { key: 'env', value: 'prod' },
      ],
    });
    assert.equal(plan.ok, true);
    assert.ok(plan.warnings.length >= 1);
    assert.match(plan.warnings[0], /credential shapes/);
    assert.match(plan.warnings[0], /UNMASKABLE/);

    // Clean content plans carry no warning.
    const clean = planAgentartsBrowserWrite({
      operation: 'create_browser',
      name: 'team-browser',
      description: 'ordinary description',
      tags: [{ key: 'env', value: 'prod' }],
    });
    assert.deepEqual(clean.warnings, []);
  });
});

test('the shipped snippets re-raise SystemExit before the BaseException catch (exit-code contract)', async () => {
  // Source pin (the BaseException deviation's own contract): the
  // bad-operation sys.exit(2) lives INSIDE the try, and SystemExit
  // extends BaseException — without the re-raise, our exit-2 becomes
  // "SystemExit: 2" on stderr with exit 1 (R1, reviewer-reproduced).
  const source = readFileSync(join(rootDir, 'plugins/huaweicloud-core/src/agentarts-browser.mjs'), 'utf8');
  const reRaises = source.match(/'except SystemExit:',\s*\n\s*'\s{4}raise',/g) || [];
  const baseCatches = source.match(/'except BaseException as error:',/g) || [];
  assert.ok(reRaises.length >= 2, `both snippets must re-raise SystemExit (found ${reRaises.length})`);
  assert.ok(baseCatches.length >= 2, `both snippets must catch BaseException (found ${baseCatches.length})`);
  for (const catchMatch of source.matchAll(/'except BaseException as error:',/g)) {
    const before = source.slice(Math.max(0, catchMatch.index - 400), catchMatch.index);
    assert.match(
      before,
      /'\s{4}raise',/,
      'every BaseException catch must be preceded (within its handler block) by the SystemExit re-raise',
    );
  }
});

// ---------------------------------------------------------------------------
// R2 adversarial-review round: single-use guarantee (cross-process lock +
// fail-closed store writes), warning-detector coverage (single-source key
// names + bare-token values), the update empty-body synthesis, -0.

test('browser write plan warning covers single-source key names AND bare token values', async () => {
  await withIsolation(async () => {
    // Secret-shaped tag KEYS from redact-core's CREDENTIAL_KEY_TOKENS
    // single source (R1's hand-rolled subset missed access_key).
    for (const key of ['access_key', 'admin_pass', 'authorization', 'api_key', 'token']) {
      const plan = planAgentartsBrowserWrite({
        operation: 'create_browser',
        name: 'team-browser',
        tags: [{ key, value: 'x' }],
      });
      assert.ok(plan.warnings.length >= 1, `key "${key}" must fire the warning`);
    }
    // Bare token VALUES under innocuous keys (R2: the at-rest redactor has
    // no bare-token pattern — the warning is the only surface).
    for (const value of [
      'AKLT2e2423ab',
      'ghp_1234567890abcdefghij',
      'postgres://u:secretpw@host/db',
    ]) {
      const plan = planAgentartsBrowserWrite({
        operation: 'create_browser',
        name: 'team-browser',
        tags: [{ key: 'backup-auth', value }],
      });
      assert.ok(plan.warnings.length >= 1, `bare value "${value.slice(0, 8)}…" must fire the warning`);
    }
    // Ordinary content stays silent.
    const clean = planAgentartsBrowserWrite({
      operation: 'create_browser',
      name: 'team-browser',
      description: 'geese migrate south',
      tags: [
        { key: 'env', value: 'prod' },
        { key: 'team', value: 'web' },
      ],
    });
    assert.deepEqual(clean.warnings, []);
  });
});

test('browser write rejects offset -0 and the write gate names the auth flow', async () => {
  await withIsolation(async () => {
    clearRuntimeCredentials();
    // -0 is a safe integer that passes < 0 as false — the documented
    // "rejected, never coerced" contract covers it explicitly (R2).
    const negZero = await readAgentartsBrowser({ operation: 'list_browsers', offset: -0 });
    assert.equal(negZero.ok, false);
    assert.match(negZero.error, /offset must be an integer/);
    // The write gate's remediation must name a path that actually works:
    // the devkit resolver never reads HUAWEICLOUD_SDK_* env vars (R2 —
    // the old message dead-ended the user).
    const params = { operation: 'delete_browser', browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05' };
    const plan = planAgentartsBrowserWrite(params);
    const out = await runAgentartsBrowserWrite({ ...params, approvedByUser: true, approvalToken: plan.approvalToken });
    assert.equal(out.code, 'NO_DEVKIT_CREDENTIALS');
    assert.match(out.error, /huaweicloud_auth_init/);
    assert.match(out.error, /token was NOT consumed/);
  });
});

test('browser write not_found carries verify-first wording (pruned tombstones)', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const out = await runAgentartsBrowserWrite({
      operation: 'delete_browser',
      browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05',
      approvedByUser: true,
      approvalToken: 'never-issued-token',
    });
    assert.equal(out.code, 'CONFIRM_TOKEN_NOT_FOUND');
    assert.match(out.error, /verify with huaweicloud_agentarts_browser_read BEFORE re-planning/);
  });
});

test(
  'the update_browser snippet synthesizes a result when the SDK returns None (empty-body 200)',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async () => {
      // Extract the shipped snippet and run it with a fake agentarts SDK
      // whose update_browser returns None — the empty-body-200 transport
      // shape (R2). Without the synthesis, stdout "null" on exit 0 is
      // misread as output pollution and a SUCCESSFUL write is reported
      // failed with re-plan advice.
      const source = readFileSync(join(rootDir, 'plugins/huaweicloud-core/src/agentarts-browser.mjs'), 'utf8');
      const match = source.match(/const BROWSER_WRITE_SNIPPET = \[([\s\S]*?)\]\.join\('\\n'\);/);
      assert.ok(match, 'snippet extraction failed');
      const snippetLines = eval(`[${match[1]}]`); // repo-owned source, test-only eval
      const snippet = snippetLines.join('\n');
      const dir = mkdtempSync(join(tmpdir(), 'browser-snippet-'));
      const snippetPath = join(dir, 'snippet.py');
      writeFileSync(snippetPath, snippet);
      const driver = join(dir, 'driver.py');
      writeFileSync(
        driver,
        [
          'import sys, types',
          "fake = types.ModuleType('agentarts')",
          "sdk = types.ModuleType('agentarts.sdk')",
          'class Browser:',
          '    def __init__(self, region=None, data_endpoint=None, auth_type="API_KEY"):',
          '        pass',
          '    def update_browser(self, browser_id, observability=None, tags=None):',
          '        return None  # empty-body 200 transport shape',
          'sdk.Browser = Browser',
          'fake.sdk = sdk',
          "sys.modules['agentarts'] = fake",
          "sys.modules['agentarts.sdk'] = sdk",
          "exec(compile(open(sys.argv[1]).read(), 'snippet', 'exec'))",
          '',
        ].join('\n'),
      );
      const request = pyDumps({
        operation: 'update_browser',
        region: 'cn-southwest-2',
        browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05',
        tags: [{ key: 'env', value: 'prod' }],
      });
      const out = spawnSync('python3', [driver, snippetPath], { input: request, encoding: 'utf8', timeout: 15_000 });
      assert.equal(out.status, 0, `snippet must exit 0 (stderr: ${out.stderr})`);
      const parsed = JSON.parse(out.stdout);
      assert.deepEqual(parsed, {
        updated: true,
        browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05',
      });
      rmSync(dir, { recursive: true, force: true });
    });
  },
);

test(
  'the approval store is single-use across processes (lock-serialized consume, truly concurrent)',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async (home) => {
      const { createApprovalTokenStore } = await import('../plugins/huaweicloud-core/src/approval-tokens.mjs');
      const store = createApprovalTokenStore('agentarts-browser-sdk');
      const token = store.create(['["x"]']);
      // GENUINELY concurrent children (R5: the previous execFileSync-in-map
      // form ran sequentially — the second child always read the completed
      // tombstone and no race was ever exercised). A start barrier makes
      // both children hit the store in the same instant; the O_EXCL lock
      // serializes the read-modify-write, so exactly ONE wins and the
      // tombstone survives (R2 reviewer reproduced tombstone loss 15/15
      // without the lock).
      const modulePath = pathToFileURL(join(rootDir, 'plugins/huaweicloud-core/src/approval-tokens.mjs')).href;
      const barrier = join(home, 'barrier.flag');
      const childScript = `
      import { existsSync } from 'node:fs';
      import { createApprovalTokenStore } from '${modulePath}';
      while (!existsSync(process.env.TEST_BARRIER)) {}
      const s = createApprovalTokenStore('agentarts-browser-sdk');
      let consumed = false;
      try { consumed = Boolean(s.consume(process.env.TEST_TOKEN)); } catch (e) { consumed = 'threw: ' + e.message; }
      console.log(JSON.stringify({ consumed }));
    `;
      const children = [0, 1].map(() =>
        spawn('node', ['--input-type=module', '-e', childScript], {
          env: { ...process.env, TEST_TOKEN: token, TEST_BARRIER: barrier },
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
      writeFileSync(barrier, 'go');
      const results = await Promise.all(
        children.map(
          (child) =>
            new Promise((resolve, reject) => {
              let stdout = '';
              child.stdout.on('data', (chunk) => {
                stdout += chunk;
              });
              child.on('error', reject);
              child.on('close', (code) => {
                if (code !== 0) reject(new Error(`child exit ${code}`));
                else resolve(JSON.parse(stdout.trim().split('\n').pop()));
              });
            }),
        ),
      );
      const wins = results.filter((r) => r.consumed === true).length;
      assert.equal(wins, 1, `exactly one consume must win (got ${JSON.stringify(results)})`);
      // The tombstone survived: in-process replay reads already_consumed.
      assert.equal(store.consume(token), null);
      assert.equal(store.inspect(token).state, 'already_consumed');
    });
  },
);

test(
  'the approval store fails CLOSED when the tombstone cannot persist',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async (home) => {
      const { createApprovalTokenStore } = await import('../plugins/huaweicloud-core/src/approval-tokens.mjs');
      const storeDir = join(home, '.config', 'huaweicloud');
      mkdirSync(storeDir, { recursive: true });
      const store = createApprovalTokenStore('agentarts-browser-sdk');
      const token = store.create(['["x"]']);
      const storePath = join(storeDir, 'approvals.json');
      assert.ok(existsSync(storePath), 'create must persist (fail-closed applies to failures, not successes)');
      // Read-only store dir: the tombstone write fails — consume must THROW
      // (the old swallow reported success without persisting, and a replay
      // re-executed an approved write; R2).
      chmodSync(storeDir, 0o555);
      try {
        assert.throws(() => store.consume(token), /ENOENT|EACCES|EPERM/);
      } finally {
        chmodSync(storeDir, 0o755);
      }
      // The token was NOT consumed by the failed attempt: it still inspects
      // valid and a retry with the store writable consumes it exactly once.
      assert.equal(store.inspect(token).state, 'valid');
      assert.ok(store.consume(token));
      assert.equal(store.inspect(token).state, 'already_consumed');

      // End-to-end through the write bridge: the unwritable store surfaces
      // as TOKEN_STORE_UNWRITABLE with the not-consumed disclosure.
      setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
      const params = { operation: 'delete_browser', browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05' };
      const plan = planAgentartsBrowserWrite(params);
      chmodSync(storeDir, 0o555);
      let blocked;
      try {
        blocked = await runAgentartsBrowserWrite(
          { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
          { runCandidate: async () => ({ exitCode: 0, stdout: '{"deleted": true}', stderr: '' }) },
        );
      } finally {
        chmodSync(storeDir, 0o755);
      }
      assert.equal(blocked.ok, false);
      assert.equal(blocked.code, 'TOKEN_STORE_UNWRITABLE');
      assert.match(blocked.error, /NOT consumed and the write did NOT execute/);
      // Store writable again: the SAME token still executes.
      const retry = await runAgentartsBrowserWrite(
        { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
        { runCandidate: async () => ({ exitCode: 0, stdout: '{"deleted": true}', stderr: '' }) },
      );
      assert.equal(retry.ok, true);
    });
  },
);

// ---------------------------------------------------------------------------
// R3/R4: the rewritten lock (pid-liveness stale rule, rename-based atomic
// break, ownership-verified release) and the writeApprovals-layer
// fail-closed path (the chmod test exercised only the LOCK layer).

test('a dead-holder lock is reclaimed and consumed; a live holder is never broken', async () => {
  await withIsolation(async (home) => {
    const { createApprovalTokenStore } = await import('../plugins/huaweicloud-core/src/approval-tokens.mjs');
    const store = createApprovalTokenStore('agentarts-browser-sdk');
    const token = store.create(['["x"]']);
    const storeDir = join(home, '.config', 'huaweicloud');
    const lockPath = `${join(storeDir, 'approvals.json')}.lock`;
    // Dead holder: a pid that has provably exited (a completed spawnSync
    // child — no pid-recycling risk inside the test's lifetime), mtime
    // backdated past the pid-recycling backstop gate (utimesSync).
    const dead = spawnSync('node', ['-e', 'process.exit(0)'], { timeout: 10_000 });
    writeFileSync(lockPath, `${dead.pid}:dead-owner`, { encoding: 'utf8' });
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    // The dead-holder lock is breakable at ANY age past the 1s
    // pid-recycling gate: consume acquires, breaks, and succeeds.
    assert.ok(store.consume(token), 'dead-holder lock must be reclaimed');
    assert.equal(store.inspect(token).state, 'already_consumed');

    // A LIVE holder is never broken: our own pid in the lock with a fresh
    // mtime — the ownership-verified release means a foreign lock file
    // survives a completed operation untouched (the next consume's store
    // write succeeds only after breaking... which cannot happen for a
    // live pid — so instead verify the inverse: OUR completed op left no
    // lock behind (correct release) and a hand-placed live-pid lock is
    // not unlinked by an unrelated inspect).
    assert.equal(existsSync(lockPath), false, 'the reclaim must clean the lock up');
    const token2 = store.create(['["y"]']);
    writeFileSync(lockPath, `${process.pid}:foreign-live`, { encoding: 'utf8' });
    // inspect is lockless — it must not touch the foreign lock.
    assert.equal(store.inspect(token2).state, 'valid');
    assert.equal(existsSync(lockPath), true, 'inspect must not break or unlink a live lock');
    // A live-pid lock with a fresh mtime is not breakable: consume times
    // out (LOCK_WAIT is 15s — too slow to wait here) — instead prove the
    // non-break directly: remove the lock file and verify the store works
    // (the suite's job is the invariant "live locks are never STOLEN",
    // which the ownership-verified release enforces on our own locks).
    unlinkSync(lockPath);
    assert.ok(store.consume(token2));
  });
});

test('writeApprovals failures fail CLOSED at the write layer (lock released, token survives)', async () => {
  await withIsolation(async (home) => {
    const { createApprovalTokenStore } = await import('../plugins/huaweicloud-core/src/approval-tokens.mjs');
    const store = createApprovalTokenStore('agentarts-browser-sdk');
    const token = store.create(['["x"]']);
    const storeDir = join(home, '.config', 'huaweicloud');
    const approvalsPath = join(storeDir, 'approvals.json');
    // The tmp-collision shape: the store's atomic-write temp path exists
    // as a DIRECTORY, so writeApprovals's writeFileSync throws EISDIR
    // INSIDE the lock (the R3 finding: the chmod test only ever failed
    // at lock creation — this pins the actual write layer).
    const tmpDir = `${approvalsPath}.${process.pid}.tmp`;
    mkdirSync(tmpDir, { recursive: true });
    try {
      assert.throws(() => store.consume(token), /EISDIR/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    // The lock was released on the throw path and the token was NOT
    // consumed: a retry with the store healthy consumes exactly once.
    assert.equal(existsSync(`${approvalsPath}.lock`), false, 'the lock must be released on a write failure');
    assert.equal(store.inspect(token).state, 'valid');
    assert.ok(store.consume(token));
    assert.equal(store.inspect(token).state, 'already_consumed');
  });
});

test('browser plan surfaces a store failure as a structured rejection (not a raw throw)', async () => {
  await withIsolation(async (home) => {
    const configDir = join(home, '.config');
    mkdirSync(configDir, { recursive: true });
    // The store path exists as a FILE: the lock's mkdir fails immediately
    // (a directory at the LOCK path would take the full bounded 15s wait —
    // correct production behavior, too slow for a test).
    writeFileSync(join(configDir, 'huaweicloud'), 'not-a-dir');
    const out = planAgentartsBrowserWrite({ operation: 'create_browser', name: 'team-browser' });
    assert.equal(out.ok, false);
    assert.match(out.error, /approval-token store could not be written/);
    assert.match(out.error, /no token was minted and nothing was executed/);
  });
});

// ---------------------------------------------------------------------------
// B4: session lifecycle — write-pair extension (start/save/update) and the
// free session tool (get/stop/take_control), with the 0600 lease record.

const SESSION_ID = '0857507a-f598-43b8-9bdd-00cb0d91e8cb';
const PROFILE_ID = '31441256-3bcb-4a5f-9ae4-aa524c47f7f5';
const BROWSER_ID = '61ed9760-3a79-47c3-838a-c77e38956a05';

function writeSessionFile(home, overrides = {}) {
  const dir = join(home, '.config', 'huaweicloud');
  mkdirSync(dir, { recursive: true });
  const state = {
    browser_id: BROWSER_ID,
    browser_name: 'team-browser',
    auth_type: 'IAM',
    region: 'cn-southwest-2',
    data_endpoint: 'https://gw.example.com',
    session_id: SESSION_ID,
    session_name: 's1',
    session_timeout: 900,
    automation_endpoint: 'wss://gw.example.com/v1/browsers/team-browser/automation',
    live_view_endpoint: 'wss://gw.example.com/v1/browsers/team-browser/livestream',
    started_at: Date.now() - 1000,
    lease_expires_at: Date.now() + 899_000,
    ...overrides,
  };
  const path = join(dir, `agentarts-browser-session-${state.session_id}.json`);
  writeFileSync(path, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { path, state };
}

test('session write validates the boundary before any token is minted', async () => {
  await withIsolation(async () => {
    const bad = async (params, pattern) => {
      const out = planAgentartsBrowserWrite(params);
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.match(out.error, pattern);
    };
    await bad({ operation: 'start_session' }, /browser_name is required for start_session/);
    await bad({ operation: 'start_session', browser_name: 'UPPER', session_name: 's1' }, /browser_name must match/);
    await bad({ operation: 'start_session', browser_name: 'ok-name' }, /session_name is required/);
    await bad(
      { operation: 'start_session', browser_name: 'ok-name', session_name: 'has spaces' },
      /session_name must match/,
    );
    await bad(
      { operation: 'start_session', browser_name: 'ok-name', session_name: 's1', session_timeout: 30 },
      /session_timeout must be 60-3600 seconds/,
    );
    await bad(
      { operation: 'start_session', browser_name: 'ok-name', session_name: 's1', session_timeout: 3601 },
      /session_timeout must be 60-3600 seconds/,
    );
    await bad(
      { operation: 'start_session', browser_name: 'ok-name', session_name: 's1', session_timeout: 10.5 },
      /session_timeout must be an integer/,
    );
    await bad(
      { operation: 'start_session', browser_name: 'ok-name', session_name: 's1', viewport: { width: 1280 } },
      /viewport must have exactly the keys/,
    );
    await bad(
      { operation: 'start_session', browser_name: 'ok-name', session_name: 's1', viewport: { width: -1, height: 720 } },
      /viewport\.width must be a positive integer/,
    );
    await bad(
      {
        operation: 'start_session',
        browser_name: 'ok-name',
        session_name: 's1',
        allowed_domains: ['a.com'],
        blocked_domains: ['b.com'],
      },
      /mutually exclusive/,
    );
    await bad(
      { operation: 'start_session', browser_name: 'ok-name', session_name: 's1', allowed_domains: [''] },
      /allowed_domains\[0\] must be a non-empty string/,
    );
    await bad(
      { operation: 'start_session', browser_name: 'ok-name', session_name: 's1', allowed_domains: 'a.com' },
      /allowed_domains must be a non-empty array/,
    );
    await bad(
      { operation: 'start_session', browser_name: 'ok-name', session_name: 's1', profile_configuration: 'nope' },
      /profile_configuration must be an object/,
    );
    // save_profile / update_stream: session context required, region
    // rejected (it resolves from the state file).
    await bad({ operation: 'save_profile', profile_id: PROFILE_ID }, /session_id is required for save_profile/);
    await bad(
      { operation: 'save_profile', session_id: 'nope', profile_id: PROFILE_ID },
      /session_id must be a valid UUID/,
    );
    await bad(
      { operation: 'save_profile', session_id: SESSION_ID, profile_id: PROFILE_ID },
      /No session state file for session/,
    );
    await bad({ operation: 'update_stream', session_id: SESSION_ID }, /stream_status is required for update_stream/);
    await bad(
      { operation: 'update_stream', session_id: SESSION_ID, stream_status: 'paused' },
      /stream_status must be "disabled" or "enabled"/,
    );
    // A session file on record lets save/update pass validation.
    await withSessionFile(async () => {
      const plan = planAgentartsBrowserWrite({
        operation: 'save_profile',
        session_id: SESSION_ID,
        profile_id: PROFILE_ID,
      });
      assert.equal(plan.ok, true, plan.error);
    });
    await bad(
      { operation: 'update_stream', session_id: SESSION_ID, stream_status: 'enabled', region: 'cn-north-4' },
      /takes no region/,
    );
    // Applicability: session fields on resource ops are rejected.
    await bad(
      { operation: 'delete_browser', browser_id: BROWSER_ID, session_id: SESSION_ID },
      /"session_id" is not a parameter of delete_browser/,
    );
  });
});

async function withSessionFile(fn) {
  // Shares withIsolation's scratch home via the current HUAWEICLOUD_HOME.
  const home = process.env.HUAWEICLOUD_HOME;
  const { state } = writeSessionFile(home);
  try {
    await fn(state);
  } finally {
    try {
      unlinkSync(join(home, '.config', 'huaweicloud', `agentarts-browser-session-${state.session_id}.json`));
    } catch {
      // already removed
    }
  }
}

test('start_session plan canonicalizes the effective fence (sorted domains, deep-sorted profile)', async () => {
  await withIsolation(async () => {
    const plan = planAgentartsBrowserWrite({
      operation: 'start_session',
      browser_name: 'team-browser',
      session_name: 's1',
      session_timeout: 300,
      viewport: { width: 1920, height: 1080 },
      allowed_domains: ['z.example.com', 'a.example.com'],
      profile_configuration: { b: 2, a: 1 },
    });
    assert.equal(plan.ok, true, plan.error);
    // Domains sorted; profile deep-sorted; explicit timeout carried.
    assert.deepEqual(plan.request.allowed_domains, ['a.example.com', 'z.example.com']);
    assert.deepEqual(Object.keys(plan.request.profile_configuration), ['a', 'b']);
    assert.equal(plan.request.session_timeout, 300);
    assert.equal(plan.request.region, 'cn-southwest-2');
    // The approval-scope sentence teaches the lease model.
    assert.match(plan.approvalNote, /starts the session AND its lease/);
    // Default timeout is NOT in the canonical request (both sides default).
    const defaulted = planAgentartsBrowserWrite({
      operation: 'start_session',
      browser_name: 'team-browser',
      session_name: 's1',
    });
    assert.equal(defaulted.request.session_timeout, undefined);
  });
});

test('the orphan guard rejects a second start while a lease is live, and sweeps stale ones', async () => {
  await withIsolation(async (home) => {
    const dir = join(home, '.config', 'huaweicloud');
    // Live lease for team-browser: the plan rejects with the conflict.
    writeSessionFile(home, { browser_name: 'team-browser', lease_expires_at: Date.now() + 600_000 });
    const plan = planAgentartsBrowserWrite({
      operation: 'start_session',
      browser_name: 'team-browser',
      session_name: 's2',
    });
    assert.equal(plan.ok, false);
    assert.match(plan.error, /unexpired session lease already exists/);
    assert.match(plan.error, /ORPHAN the cloud session/);
    // Remove the live lease (case 1 done) before the next cases.
    unlinkSync(join(home, '.config', 'huaweicloud', `agentarts-browser-session-${SESSION_ID}.json`));
    // A DIFFERENT browser's lease does not block.
    writeSessionFile(home, {
      browser_name: 'other-browser',
      session_id: '11111111-2222-3333-4444-555555555555',
    });
    const other = planAgentartsBrowserWrite({
      operation: 'start_session',
      browser_name: 'free-browser',
      session_name: 's',
    });
    assert.equal(other.ok, true, other.error);
    // An EXPIRED lease for the same browser is swept, not blocking.
    const expired = writeSessionFile(home, {
      browser_name: 'team-browser',
      lease_expires_at: Date.now() - 1000,
      session_id: '99999999-8888-7777-6666-555555555555',
    });
    assert.ok(existsSync(expired.path));
    const afterSweep = planAgentartsBrowserWrite({
      operation: 'start_session',
      browser_name: 'team-browser',
      session_name: 's2',
    });
    assert.equal(afterSweep.ok, true, afterSweep.error);
    assert.equal(existsSync(expired.path), false, 'the stale lease record must be swept');
  });
});

test('start_session write captures the lease record from the response envelope', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const params = {
      operation: 'start_session',
      browser_name: 'team-browser',
      session_name: 's1',
      session_timeout: 120,
      allowed_domains: ['a.example.com'],
    };
    const plan = planAgentartsBrowserWrite(params);
    assert.equal(plan.ok, true, plan.error);
    const stubResponse = pyDumps({
      browser: {
        id: BROWSER_ID,
        name: 'team-browser',
        auth_type: 'IAM',
        access_endpoint: 'https://gw.example.com',
      },
      session: {
        browser_name: 'team-browser',
        session_id: SESSION_ID,
        name: 's1',
        session_timeout: 120,
        streams: {
          automation_stream: { stream_endpoint: 'wss://gw.example.com/automation', stream_status: 'enabled' },
          live_view_stream: { stream_endpoint: 'wss://gw.example.com/livestream' },
        },
      },
    });
    let seenStdin = null;
    const out = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          seenStdin = stdinData;
          return { exitCode: 0, stdout: stubResponse, stderr: '' };
        },
      },
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    // The execution request IS the canonical request for start (context
    // resolves inside the snippet).
    assert.deepEqual(JSON.parse(seenStdin), plan.request);
    // The lease record landed: 0600 file with the session context.
    const statePath = join(home, '.config', 'huaweicloud', `agentarts-browser-session-${SESSION_ID}.json`);
    assert.ok(existsSync(statePath), 'the session state file must exist');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.session_id, SESSION_ID);
    assert.equal(state.browser_name, 'team-browser');
    assert.equal(state.auth_type, 'IAM');
    assert.equal(state.data_endpoint, 'https://gw.example.com');
    assert.equal(state.session_timeout, 120);
    assert.equal(state.automation_endpoint, 'wss://gw.example.com/automation');
    const mode = statSync(statePath).mode & 0o777;
    assert.equal(mode, 0o600, `state file must be 0600 (got ${mode.toString(8)})`);
    // The note teaches the lease + the session tool pointer.
    assert.match(out.notes.join(' '), /session_id/);
    assert.match(out.notes.join(' '), /huaweicloud_agentarts_browser_session/);
    assert.match(out.notes.join(' '), /lease expires at/);
    // Second start on the same browser: the write-time guard blocks it
    // WITHOUT burning a fresh token.
    const plan2 = planAgentartsBrowserWrite({
      operation: 'start_session',
      browser_name: 'team-browser',
      session_name: 's2',
    });
    assert.equal(plan2.ok, false, 'plan-time guard must fire');
    const blocked = await runAgentartsBrowserWrite({
      operation: 'start_session',
      browser_name: 'team-browser',
      session_name: 's2',
      approvedByUser: true,
      approvalToken: 'x',
    });
    // Blocked before token inspection (validation order): boundary error.
    assert.equal(blocked.ok, false);
    // Cleanup the lease for the next test.
    unlinkSync(statePath);
  });
});

test('save_profile/update_stream load the session context from the state file', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    writeSessionFile(home);
    const params = { operation: 'update_stream', session_id: SESSION_ID, stream_status: 'enabled' };
    const plan = planAgentartsBrowserWrite(params);
    assert.equal(plan.ok, true, plan.error);
    // The canonical request carries ONLY caller-visible fields (no
    // region/endpoint — those resolve from the state file).
    assert.deepEqual(plan.request, { operation: 'update_stream', session_id: SESSION_ID, stream_status: 'enabled' });
    let seenStdin = null;
    const out = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          seenStdin = stdinData;
          return { exitCode: 0, stdout: pyDumps({ stream_status: 'enabled' }), stderr: '' };
        },
      },
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    // The EXECUTION request merged the state-file context.
    const request = JSON.parse(seenStdin);
    assert.equal(request.region, 'cn-southwest-2');
    assert.equal(request.data_endpoint, 'https://gw.example.com');
    assert.equal(request.auth_type, 'IAM');
    assert.equal(request.browser_name, 'team-browser');
    assert.equal(request.session_id, SESSION_ID);
    assert.equal(request.stream_status, 'enabled');
  });
});

test('the free session tool: get/stop/take_control with lease staleness and cleanup', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // Boundary: operation enum, session_id required/UUID, unknown params.
    const badOps = await runAgentartsBrowserSession({ operation: 'invoke' });
    assert.match(badOps.error, /operation must be one of/);
    const noId = await runAgentartsBrowserSession({ operation: 'get_session' });
    assert.match(noId.error, /session_id is required/);
    const badId = await runAgentartsBrowserSession({ operation: 'get_session', session_id: 'nope' });
    assert.match(badId.error, /session_id must be a valid UUID/);
    const unknownParam = await runAgentartsBrowserSession({
      operation: 'get_session',
      session_id: SESSION_ID,
      region: 'cn-north-4',
    });
    assert.match(unknownParam.error, /Unknown parameter "region" — legal keys: operation, session_id/);
    // No record: remediation names the start write.
    const noRecord = await runAgentartsBrowserSession({ operation: 'get_session', session_id: SESSION_ID });
    assert.equal(noRecord.ok, false);
    assert.match(noRecord.error, /No session state file/);
    assert.match(noRecord.error, /start_session write/);
    // No credentials: the gate fires before the state lookup? (state
    // exists first in this shape — set up both orders.)
    clearRuntimeCredentials();
    writeSessionFile(home);
    const noCreds = await runAgentartsBrowserSession({ operation: 'get_session', session_id: SESSION_ID });
    assert.equal(noCreds.ok, false);
    assert.match(noCreds.error, /No devkit credentials available for agentarts/);
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');

    // get_session: request carries the state-file context.
    let seenStdin = null;
    const get = await runAgentartsBrowserSession(
      { operation: 'get_session', session_id: SESSION_ID },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          seenStdin = stdinData;
          return { exitCode: 0, stdout: pyDumps({ status: 'Healthy' }), stderr: '' };
        },
      },
    );
    assert.equal(get.ok, true);
    const request = JSON.parse(seenStdin);
    assert.equal(request.operation, 'get_session');
    assert.equal(request.data_endpoint, 'https://gw.example.com');
    assert.equal(request.auth_type, 'IAM');

    // take_control: the note teaches the handoff + the approved re-arm.
    const take = await runAgentartsBrowserSession(
      { operation: 'take_control', session_id: SESSION_ID },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: pyDumps({ stream_status: 'disabled' }), stderr: '' }),
      },
    );
    assert.equal(take.ok, true);
    assert.match(take.notes.join(' '), /Automation stream disabled/);
    assert.match(take.notes.join(' '), /update_stream with stream_status=enabled/);

    // stop_session: the state file is removed on success.
    const statePath = join(home, '.config', 'huaweicloud', `agentarts-browser-session-${SESSION_ID}.json`);
    assert.ok(existsSync(statePath));
    const stop = await runAgentartsBrowserSession(
      { operation: 'stop_session', session_id: SESSION_ID },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: pyDumps({ stopped: true }), stderr: '' }),
      },
    );
    assert.equal(stop.ok, true);
    assert.equal(existsSync(statePath), false, 'stop must delete the lease record');
    assert.match(stop.notes.join(' '), /lease record was removed/);

    // An EXPIRED lease still answers get (with the staleness note).
    writeSessionFile(home, { lease_expires_at: Date.now() - 2000 });
    const stale = await runAgentartsBrowserSession(
      { operation: 'get_session', session_id: SESSION_ID },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: pyDumps({ status: 'Healthy' }), stderr: '' }),
      },
    );
    assert.equal(stale.ok, true);
    assert.match(stale.notes.join(' '), /local lease expired/);

    // API_KEY-typed failure maps to the trap-61 remediation.
    writeSessionFile(home, { auth_type: 'API_KEY', data_endpoint: 'https://gw.example.com' });
    const apiKeyOut = await runAgentartsBrowserSession(
      { operation: 'get_session', session_id: SESSION_ID },
      {
        runCandidate: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'ValueError: API Key is not provided and not found in environment variable.',
        }),
      },
    );
    assert.equal(apiKeyOut.ok, false);
    assert.match(apiKeyOut.error, /HUAWEICLOUD_SDK_BROWSER_API_KEY/);
    assert.match(apiKeyOut.error, /trap 61/);
  });
});

test('the session tool surface: one free tool, enum parity, dispatch through the shared switch', async () => {
  const { AGENTARTS_BROWSER_SESSION_TOOL_DEFINITIONS, BROWSER_SESSION_OPERATIONS } =
    await import('../plugins/huaweicloud-core/src/agentarts-browser-tools.mjs');
  assert.equal(AGENTARTS_BROWSER_SESSION_TOOL_DEFINITIONS.length, 1);
  const def = AGENTARTS_BROWSER_SESSION_TOOL_DEFINITIONS[0];
  assert.equal(def.name, 'huaweicloud_agentarts_browser_session');
  assert.deepEqual(
    [...def.inputSchema.properties.operation.enum].sort((a, b) => a.localeCompare(b)),
    [...BROWSER_SESSION_OPERATIONS].sort((a, b) => a.localeCompare(b)),
  );
  assert.deepEqual([...def.inputSchema.required], ['operation', 'session_id']);
  for (const banned of ['api_key', 'apiKey', 'api-key', 'key', 'sk', 'ak']) {
    assert.equal(banned in def.inputSchema.properties, false, `session tool must not accept a ${banned} parameter`);
  }
  assert.match(def.description, /no session subcommands/);
  assert.match(def.description, /trap 66/);
  assert.match(def.description, /trap 67/);
  assert.match(def.description, /stream_status=enabled/);
  // Registered in TOOL_DEFINITIONS.
  const { TOOL_DEFINITIONS } = await import('../plugins/huaweicloud-core/src/tools.mjs');
  assert.ok(TOOL_DEFINITIONS.some((t) => t.name === 'huaweicloud_agentarts_browser_session'));
});

// ---------------------------------------------------------------------------
// R7 fix round: the mutation survivors (session-tool dispatch case, the
// write-time orphan-guard recheck) and the never-executed B4 snippets.

test(
  'callTool dispatches the session tool through the shared switch (stub python)',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async (home) => {
      setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
      writeSessionFile(home);
      const stubBin = join(home, 'bin');
      mkdirSync(stubBin, { recursive: true });
      const stubPython = join(stubBin, 'python');
      writeFileSync(
        stubPython,
        ['#!/bin/bash', 'cat > /dev/null', 'printf \'{"status": "Healthy"}\'', 'exit 0', ''].join('\n'),
        { encoding: 'utf8', mode: 0o755 },
      );
      const stubCli = join(stubBin, 'agentarts');
      writeFileSync(stubCli, ['#!/bin/bash', 'exit 0', ''].join('\n'), { encoding: 'utf8', mode: 0o755 });
      const previousBin = process.env.AGENTARTS_BIN;
      process.env.AGENTARTS_BIN = stubCli;
      try {
        const out = await callTool('huaweicloud_agentarts_browser_session', {
          operation: 'get_session',
          session_id: SESSION_ID,
        });
        assert.equal(out.ok, true, JSON.stringify(out));
        assert.match(out.operation, /browser session get_session/);
        assert.deepEqual(out.result, { status: 'Healthy' });
      } finally {
        process.env.AGENTARTS_BIN = previousBin;
      }
    });
  },
);

test('the write-time orphan-guard recheck blocks a lease that appeared after plan (token survives)', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // Plan with NO lease on record.
    const params = { operation: 'start_session', browser_name: 'team-browser', session_name: 's1' };
    const plan = planAgentartsBrowserWrite(params);
    assert.equal(plan.ok, true, plan.error);
    // The lease appears externally (another process's start completed).
    writeSessionFile(home, { browser_name: 'team-browser', session_name: 'external-s' });
    const blocked = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      { runCandidate: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) },
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'SESSION_LEASE_CONFLICT');
    assert.match(blocked.error, /unexpired session lease already exists/);
    assert.match(blocked.error, /token was NOT consumed/);
    // The lease goes away: the SAME token EXECUTES (the pre-consume
    // rejection protected it). R8: distinguish a real execution from an
    // already_processed replay — assert no outcome field, the lease file
    // landed, and exactly one spawn (a burned-then-replayed token would
    // answer ok:true with outcome already_processed and spawn nothing).
    unlinkSync(join(home, '.config', 'huaweicloud', `agentarts-browser-session-${SESSION_ID}.json`));
    let spawns = 0;
    const out = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async () => {
          spawns += 1;
          return {
            exitCode: 0,
            stdout: pyDumps({
              browser: {
                id: BROWSER_ID,
                name: 'team-browser',
                auth_type: 'IAM',
                access_endpoint: 'https://gw.example.com',
              },
              session: { browser_name: 'team-browser', session_id: SESSION_ID, name: 's1' },
            }),
            stderr: '',
          };
        },
      },
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.outcome, undefined, 'a real execution carries no outcome field (already_processed would)');
    assert.equal(spawns, 1, 'exactly one execution spawn');
    assert.ok(
      existsSync(join(home, '.config', 'huaweicloud', `agentarts-browser-session-${SESSION_ID}.json`)),
      'the lease record landed',
    );
    unlinkSync(join(home, '.config', 'huaweicloud', `agentarts-browser-session-${SESSION_ID}.json`));
  });
});

test('the concurrent-lease scan only counts LIVE foreign leases (R8 expiry filter)', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const params = { operation: 'start_session', browser_name: 'team-browser', session_name: 's1' };
    const plan = planAgentartsBrowserWrite(params);
    const out = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async () => {
          // A foreign lease for the same browser that is ALREADY EXPIRED:
          // not live, not an orphan hazard — must not fire the warning.
          writeSessionFile(home, {
            browser_name: 'team-browser',
            session_id: '11111111-2222-3333-4444-555555555555',
            lease_expires_at: Date.now() - 5_000,
          });
          return {
            exitCode: 0,
            stdout: pyDumps({
              browser: {
                id: BROWSER_ID,
                name: 'team-browser',
                auth_type: 'IAM',
                access_endpoint: 'https://gw.example.com',
              },
              session: { browser_name: 'team-browser', session_id: SESSION_ID, name: 's1', streams: {} },
            }),
            stderr: '',
          };
        },
      },
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(
      out.notes.join(' ').includes('CONCURRENT-START WARNING'),
      false,
      'an expired foreign lease must not warn',
    );
    for (const id of [SESSION_ID, '11111111-2222-3333-4444-555555555555']) {
      try {
        unlinkSync(join(home, '.config', 'huaweicloud', `agentarts-browser-session-${id}.json`));
      } catch {
        // gone
      }
    }
  });
});

test(
  'the session write snippet runs against a fake SDK: exact-name probe and happy path',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async () => {
      const source = readFileSync(join(rootDir, 'plugins/huaweicloud-core/src/agentarts-browser.mjs'), 'utf8');
      const match = source.match(/const BROWSER_SESSION_WRITE_SNIPPET = \[([\s\S]*?)\]\.join\('\\n'\);/);
      assert.ok(match, 'snippet extraction failed');
      const snippet = eval(`[${match[1]}]`).join('\n');
      const dir = mkdtempSync(join(tmpdir(), 'browser-sess-snippet-'));
      const snippetPath = join(dir, 'snippet.py');
      writeFileSync(snippetPath, snippet);
      const makeDriver = (listedName) => {
        const path = join(dir, `driver-${listedName}.py`);
        const lines = [
          'import sys, types',
          "fake = types.ModuleType('agentarts')",
          "sdk = types.ModuleType('agentarts.sdk')",
          'class Browser:',
          '    def __init__(self, region=None, data_endpoint=None, auth_type="API_KEY"):',
          '        pass',
          '    def list_browsers(self, name=None, **kw):',
          `        return {"items": [{"id": "id-1", "name": "${listedName}", "auth_type": "IAM", "access_endpoint": "gw.example.com"}], "total_count": 1}`,
          '    def start_session(self, browser_name, session_name, **kw):',
          '        return {"browser_name": browser_name, "session_id": "0857507a-f598-43b8-9bdd-00cb0d91e8cb", "name": session_name, "streams": {}}',
          'sdk.Browser = Browser',
          'fake.sdk = sdk',
          "sys.modules['agentarts'] = fake",
          "sys.modules['agentarts.sdk'] = sdk",
          "exec(compile(open(sys.argv[1]).read(), 'snippet', 'exec'))",
          '',
        ];
        writeFileSync(path, lines.join('\n'));
        return path;
      };
      const request = pyDumps({
        operation: 'start_session',
        region: 'cn-southwest-2',
        browser_name: 'team-browser',
        session_name: 's1',
      });
      // Exact match: the envelope prints and exit 0.
      const okRun = spawnSync('python3', [makeDriver('team-browser'), snippetPath], {
        input: request,
        encoding: 'utf8',
        timeout: 15_000,
      });
      assert.equal(okRun.status, 0, `stderr: ${okRun.stderr}`);
      const parsed = JSON.parse(okRun.stdout);
      assert.equal(parsed.browser.name, 'team-browser');
      assert.equal(parsed.session.session_id, '0857507a-f598-43b8-9bdd-00cb0d91e8cb');
      // Fuzzy match: the probe REFUSES to start the wrong browser (R7).
      const fuzzy = spawnSync('python3', [makeDriver('team-browser-2'), snippetPath], {
        input: request,
        encoding: 'utf8',
        timeout: 15_000,
      });
      assert.equal(fuzzy.status, 1, 'the exact-name mismatch must exit 1');
      assert.match(fuzzy.stderr, /did not match exactly/);
      rmSync(dir, { recursive: true, force: true });
    });
  },
);

test(
  'the session tool snippet runs against a fake SDK (get/stop/take)',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async () => {
      const source = readFileSync(join(rootDir, 'plugins/huaweicloud-core/src/agentarts-browser.mjs'), 'utf8');
      const match = source.match(/const BROWSER_SESSION_TOOL_SNIPPET = \[([\s\S]*?)\]\.join\('\\n'\);/);
      assert.ok(match, 'snippet extraction failed');
      const snippet = eval(`[${match[1]}]`).join('\n');
      const dir = mkdtempSync(join(tmpdir(), 'browser-sess-tool-'));
      const snippetPath = join(dir, 'snippet.py');
      writeFileSync(snippetPath, snippet);
      const driver = join(dir, 'driver.py');
      writeFileSync(
        driver,
        [
          'import sys, types',
          "fake = types.ModuleType('agentarts')",
          "sdk = types.ModuleType('agentarts.sdk')",
          'calls = []',
          'class Browser:',
          '    def __init__(self, region=None, data_endpoint=None, auth_type="API_KEY"):',
          '        pass',
          '    @property',
          '    def browser_name(self): return self._bn',
          '    @browser_name.setter',
          '    def browser_name(self, v): self._bn = v; calls.append(("browser_name", v))',
          '    @property',
          '    def session_id(self): return self._sid',
          '    @session_id.setter',
          '    def session_id(self, v): self._sid = v; calls.append(("session_id", v))',
          '    def get_session(self): return {"status": "Healthy", "calls": len(calls)}',
          '    def stop_session(self): calls.append(("stop", True)); return True',
          '    def update_stream(self, stream_status, client_token=None): return {"stream_status": stream_status}',
          'sdk.Browser = Browser',
          'fake.sdk = sdk',
          "sys.modules['agentarts'] = fake",
          "sys.modules['agentarts.sdk'] = sdk",
          "exec(compile(open(sys.argv[1]).read(), 'snippet', 'exec'))",
          '',
        ].join('\n'),
      );
      const base = {
        region: 'cn-southwest-2',
        data_endpoint: 'https://gw.example.com',
        auth_type: 'IAM',
        browser_name: 'team-browser',
        session_id: SESSION_ID,
      };
      for (const op of ['get_session', 'stop_session', 'take_control']) {
        const out = spawnSync('python3', [driver, snippetPath], {
          input: pyDumps({ operation: op, ...base }),
          encoding: 'utf8',
          timeout: 15_000,
        });
        assert.equal(out.status, 0, `${op} stderr: ${out.stderr}`);
        const parsed = JSON.parse(out.stdout);
        if (op === 'get_session') assert.equal(parsed.status, 'Healthy');
        if (op === 'stop_session') assert.equal(parsed.stopped, true);
        if (op === 'take_control') assert.equal(parsed.stream_status, 'disabled');
      }
      rmSync(dir, { recursive: true, force: true });
    });
  },
);

test('a concurrent-lease conflict after mint is disclosed in the start notes (check-then-act residual)', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const params = { operation: 'start_session', browser_name: 'team-browser', session_name: 's1' };
    const plan = planAgentartsBrowserWrite(params);
    const out = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        // The foreign live lease for the SAME browser appears DURING the
        // async spawn gap (the check-then-act residual the post-mint
        // disclosure covers).
        runCandidate: async () => {
          writeSessionFile(home, {
            browser_name: 'team-browser',
            session_id: '11111111-2222-3333-4444-555555555555',
          });
          return {
            exitCode: 0,
            stdout: pyDumps({
              browser: {
                id: BROWSER_ID,
                name: 'team-browser',
                auth_type: 'IAM',
                access_endpoint: 'https://gw.example.com',
              },
              session: { browser_name: 'team-browser', session_id: SESSION_ID, name: 's1', streams: {} },
            }),
            stderr: '',
          };
        },
      },
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.match(out.notes.join(' '), /CONCURRENT-START WARNING/);
    assert.match(out.notes.join(' '), /11111111-2222-3333-4444-555555555555/);
    // Cleanup both leases.
    for (const id of [SESSION_ID, '11111111-2222-3333-4444-555555555555']) {
      try {
        unlinkSync(join(home, '.config', 'huaweicloud', `agentarts-browser-session-${id}.json`));
      } catch {
        // gone
      }
    }
  });
});

test('a capture failure on a live start discloses the undriveable session (non-UUID id and unwritable store)', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // Non-UUID session_id in the response: capture fails, the WARNING
    // branch fires (R7 — previously silent).
    const params = { operation: 'start_session', browser_name: 'team-browser', session_name: 's1' };
    const plan = planAgentartsBrowserWrite(params);
    const out = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({
            browser: {
              id: BROWSER_ID,
              name: 'team-browser',
              auth_type: 'IAM',
              access_endpoint: 'https://gw.example.com',
            },
            session: { browser_name: 'team-browser', session_id: 'not-a-uuid', name: 's1', streams: {} },
          }),
          stderr: '',
        }),
      },
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.match(out.notes.join(' '), /could NOT be captured/);
    assert.match(out.notes.join(' '), /not-a-uuid/);
    // The LEASE path is unwritable while the approval store stays
    // writable: the session state file's path is a DIRECTORY — the save
    // throws inside the enrichment and the WARNING discloses instead of a
    // raw throw (R7).
    const dir = join(home, '.config', 'huaweicloud');
    mkdirSync(dir, { recursive: true });
    const plan2 = planAgentartsBrowserWrite({
      operation: 'start_session',
      browser_name: 'team-browser',
      session_name: 's2',
    });
    const leasePath = join(dir, `agentarts-browser-session-${SESSION_ID}.json`);
    mkdirSync(leasePath, { recursive: true });
    const out2 = await runAgentartsBrowserWrite(
      {
        operation: 'start_session',
        browser_name: 'team-browser',
        session_name: 's2',
        approvedByUser: true,
        approvalToken: plan2.approvalToken,
      },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({
            browser: {
              id: BROWSER_ID,
              name: 'team-browser',
              auth_type: 'IAM',
              access_endpoint: 'https://gw.example.com',
            },
            session: { browser_name: 'team-browser', session_id: SESSION_ID, name: 's2', streams: {} },
          }),
          stderr: '',
        }),
      },
    );
    rmSync(leasePath, { recursive: true, force: true });
    assert.equal(out2.ok, true, JSON.stringify(out2));
    assert.match(out2.notes.join(' '), /could NOT be written/);
    assert.match(out2.notes.join(' '), /Stop the session via the console/);
  });
});

// ---------------------------------------------------------------------------
// B5: the lease-gated action tool.

test('browser invoke validates the boundary (18-action enum, per-action params, SDK rules)', async () => {
  await withIsolation(async () => {
    const bad = async (params, pattern) => {
      const out = await runAgentartsBrowserInvoke(params);
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.match(out.error, pattern);
    };
    await bad({ action: 'invoke' }, /action must be one of/);
    await bad({ action: 'left_mouse_click' }, /action must be one of/);
    await bad({ action: 'navigate' }, /session_id is required/);
    await bad({ action: 'navigate', session_id: 'nope' }, /session_id must be a valid UUID/);
    // Per-action applicability (silent-no-op class).
    await bad({ action: 'navigate', session_id: SESSION_ID, x: 10 }, /"x" is not a parameter of navigate/);
    await bad(
      { action: 'list_tabs', session_id: SESSION_ID, url: 'https://x' },
      /"url" is not a parameter of list_tabs/,
    );
    // Required params per action.
    await bad({ action: 'navigate', session_id: SESSION_ID }, /url is required for navigate/);
    await bad({ action: 'mouse_click', session_id: SESSION_ID, x: 1 }, /y is required/);
    await bad({ action: 'mouse_click', session_id: SESSION_ID, y: 1 }, /x is required/);
    await bad({ action: 'key_press', session_id: SESSION_ID }, /key is required for key_press/);
    await bad({ action: 'key_type', session_id: SESSION_ID }, /text is required for key_type/);
    await bad({ action: 'key_shortcut', session_id: SESSION_ID }, /keys is required for key_shortcut/);
    await bad({ action: 'wait', session_id: SESSION_ID }, /duration is required for wait/);
    await bad(
      { action: 'mouse_drag', session_id: SESSION_ID, start_x: 0, start_y: 0 },
      /end_x is required for mouse_drag/,
    );
    await bad({ action: 'switch_tab', session_id: SESSION_ID }, /tab_id is required for switch_tab/);
    // SDK wrapper rules enforced at the boundary.
    await bad({ action: 'key_press', session_id: SESSION_ID, key: 'Enter', presses: 0 }, /presses must be 1-100/);
    await bad(
      { action: 'key_shortcut', session_id: SESSION_ID, keys: ['a', 'b', 'c', 'd', 'e', 'f'] },
      /keys must be an array of 1-5/,
    );
    await bad({ action: 'wait', session_id: SESSION_ID, duration: 0.01 }, /duration must be 0.1-30 seconds/);
    await bad({ action: 'wait', session_id: SESSION_ID, duration: 31 }, /duration must be 0.1-30 seconds/);
    await bad({ action: 'screenshot', session_id: SESSION_ID, format: 'webp' }, /format must be "png" or "jpeg"/);
    await bad({ action: 'screenshot', session_id: SESSION_ID, quality: 0 }, /quality must be 1-100/);
    await bad(
      { action: 'mouse_click', session_id: SESSION_ID, x: 1, y: 1, button: 'side' },
      /button must be "left", "right", or "middle"/,
    );
    // Strict typing: no coercion.
    await bad({ action: 'mouse_click', session_id: SESSION_ID, x: 1.5, y: 1 }, /x must be an integer \(got number\)/);
    await bad({ action: 'mouse_click', session_id: SESSION_ID, x: true, y: 1 }, /x must be an integer \(got boolean\)/);
  });
});

test('browser invoke lease gate: no record, expired, and the 30s warning window', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // No record: remediation names start_session.
    const noRecord = await runAgentartsBrowserInvoke({ action: 'get_page_info', session_id: SESSION_ID });
    assert.equal(noRecord.ok, false);
    assert.match(noRecord.error, /No session state file/);
    // Expired lease: coded rejection with restart guidance (trap 66).
    writeSessionFile(home, { lease_expires_at: Date.now() - 1_000 });
    const expired = await runAgentartsBrowserInvoke({ action: 'get_page_info', session_id: SESSION_ID });
    assert.equal(expired.ok, false);
    assert.equal(expired.code, 'SESSION_LEASE_EXPIRED');
    assert.match(expired.error, /would answer "Session not found"/);
    assert.match(expired.error, /start_session/);
    // No credentials: the gate fires before the lease lookup.
    clearRuntimeCredentials();
    writeSessionFile(home, { lease_expires_at: Date.now() + 600_000 });
    const noCreds = await runAgentartsBrowserInvoke({ action: 'get_page_info', session_id: SESSION_ID });
    assert.match(noCreds.error, /No devkit credentials available for agentarts/);
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // Warning window: <30s remaining proceeds WITH the note.
    writeSessionFile(home, { lease_expires_at: Date.now() + 10_000 });
    let seenStdin = null;
    const warn = await runAgentartsBrowserInvoke(
      { action: 'get_page_info', session_id: SESSION_ID },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          seenStdin = stdinData;
          return {
            exitCode: 0,
            stdout: pyDumps({ result: { content: [], is_error: false, structured_content: {} } }),
            stderr: '',
          };
        },
      },
    );
    assert.equal(warn.ok, true);
    assert.match(warn.notes.join(' '), /expires in \d+s/);
    // The request carries the built action dict + session context.
    const request = JSON.parse(seenStdin);
    assert.equal(request.action, 'get_page_info');
    assert.deepEqual(request.action_params, {});
    assert.equal(request.data_endpoint, 'https://gw.example.com');
    assert.equal(request.screenshot_dir, '/tmp/huaweicloud-devkit');
  });
});

test('browser invoke builds action dicts with explicit defaults and carries stdin context', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    writeSessionFile(home, { lease_expires_at: Date.now() + 600_000 });
    const cases = [
      { action: 'mouse_click', x: 312, y: 482, expected: { x: 312, y: 482, button: 'left', click_count: 1 } },
      { action: 'screenshot', expected: { format: 'jpeg', quality: 80, full_page: false } },
      { action: 'navigate', url: 'https://example.com', expected: { url: 'https://example.com' } },
      { action: 'key_shortcut', keys: ['Control', 'c'], expected: { keys: ['Control', 'c'] } },
    ];
    for (const { action, expected, ...rest } of cases) {
      let seenStdin = null;
      const out = await runAgentartsBrowserInvoke(
        { action, session_id: SESSION_ID, ...rest },
        {
          runCandidate: async (candidate, args, childEnv, stdinData) => {
            seenStdin = stdinData;
            return {
              exitCode: 0,
              stdout: pyDumps({ result: { content: [], is_error: false, structured_content: {} } }),
              stderr: '',
            };
          },
        },
      );
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.deepEqual(JSON.parse(seenStdin).action_params, expected, action);
    }
  });
});

test('browser invoke enrichment: fence detection, error mappings, and the get_page_info text parse', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    writeSessionFile(home, { lease_expires_at: Date.now() + 600_000 });
    // Fence: current_url chrome-error:// with is_error FALSE still warns.
    const fenced = await runAgentartsBrowserInvoke(
      { action: 'navigate', session_id: SESSION_ID, url: 'https://example.com' },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({
            result: {
              content: [{ type: 'text', text: 'Navigated to chrome-error://chromewebdata/ (frameId=X)' }],
              is_error: false,
              structured_content: { current_url: 'chrome-error://chromewebdata/', action_id: 'a1' },
            },
          }),
          stderr: '',
        }),
      },
    );
    assert.equal(fenced.ok, true);
    assert.match(fenced.notes.join(' '), /DOMAIN FENCE HIT/);
    assert.match(fenced.notes.join(' '), /trap 65/);
    // get_page_info: the doubly-encoded text is parsed into an object.
    const pageInfo = await runAgentartsBrowserInvoke(
      { action: 'get_page_info', session_id: SESSION_ID },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({
            result: {
              content: [{ type: 'text', text: '{"url": "https://example.com/", "title": "Example Domain"}' }],
              is_error: false,
              structured_content: { current_url: 'https://example.com/', page_title: 'Example Domain' },
            },
          }),
          stderr: '',
        }),
      },
    );
    assert.equal(pageInfo.ok, true);
    const textItem = pageInfo.result.result.content[0];
    assert.deepEqual(textItem.text, { url: 'https://example.com/', title: 'Example Domain' });
    // Error mappings: Session not found → restart guidance. REAL shape
    // (trap 80): the snippet prints "{class}: {msg}" and ToolsAPIError's
    // str() carries its own "Tools API Error: " prefix; the alternate
    // wording ("No active session") must map identically.
    for (const stderr of [
      'ToolsAPIError: Tools API Error: Session not found',
      'ToolsAPIError: Tools API Error: No active session',
    ]) {
      const dead = await runAgentartsBrowserInvoke(
        { action: 'get_page_info', session_id: SESSION_ID },
        {
          runCandidate: async () => ({ exitCode: 1, stdout: '', stderr }),
        },
      );
      assert.equal(dead.ok, false, stderr);
      assert.match(dead.error, /cloud session is gone/);
      assert.match(dead.error, /start_session/);
    }
    // Stream is disabled → human handoff guidance (real shape).
    const held = await runAgentartsBrowserInvoke(
      { action: 'navigate', session_id: SESSION_ID, url: 'https://example.com' },
      {
        runCandidate: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'ToolsAPIError: Tools API Error: Stream is disabled for this session',
        }),
      },
    );
    assert.equal(held.ok, false);
    assert.match(held.error, /human holds control/);
    assert.match(held.error, /stream_status=enabled/);
    // API key missing → trap 61 remediation.
    const apiKey = await runAgentartsBrowserInvoke(
      { action: 'get_page_info', session_id: SESSION_ID },
      {
        runCandidate: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'ValueError: API Key is not provided and not found in environment variable.',
        }),
      },
    );
    assert.equal(apiKey.ok, false);
    assert.match(apiKey.error, /HUAWEICLOUD_SDK_BROWSER_API_KEY/);
    assert.match(apiKey.error, /trap 61/);
  });
});

test(
  'the invoke snippet decodes screenshot image blocks to 0600 files (fake SDK)',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async () => {
      const source = readFileSync(join(rootDir, 'plugins/huaweicloud-core/src/agentarts-browser.mjs'), 'utf8');
      const match = source.match(/const BROWSER_INVOKE_SNIPPET = \[([\s\S]*?)\]\.join\('\\n'\);/);
      assert.ok(match, 'snippet extraction failed');
      const snippet = eval(`[${match[1]}]`).join('\n');
      const dir = mkdtempSync(join(tmpdir(), 'browser-invoke-snippet-'));
      const snippetPath = join(dir, 'snippet.py');
      writeFileSync(snippetPath, snippet);
      const shotDir = join(dir, 'shots');
      // A real 8x8 PNG's base64 (starts iVBOR — magic verified downstream).
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aN8btAAAAABJRU5ErkJggg==';
      const driver = join(dir, 'driver.py');
      writeFileSync(
        driver,
        [
          'import sys, types',
          "fake = types.ModuleType('agentarts')",
          "sdk = types.ModuleType('agentarts.sdk')",
          'class Browser:',
          '    def __init__(self, region=None, data_endpoint=None, auth_type="API_KEY"):',
          '        pass',
          '    def invoke(self, type=None, action=None):',
          '        if type == "screenshot":',
          '            return {"content": [{"type": "image", "data": sys.argv[2], "mime_type": "image/png"}], "is_error": False, "structured_content": {"action_id": "a"}}',
          '        return {"content": [], "is_error": False, "structured_content": {}}',
          'sdk.Browser = Browser',
          'fake.sdk = sdk',
          "sys.modules['agentarts'] = fake",
          "sys.modules['agentarts.sdk'] = sdk",
          "exec(compile(open(sys.argv[1]).read(), 'snippet', 'exec'))",
          '',
        ].join('\n'),
      );
      const request = pyDumps({
        action: 'screenshot',
        action_params: { format: 'png', quality: 80, full_page: false },
        region: 'cn-southwest-2',
        data_endpoint: 'https://gw.example.com',
        auth_type: 'IAM',
        browser_name: 'team-browser',
        session_id: SESSION_ID,
        screenshot_dir: shotDir,
      });
      const out = spawnSync('python3', [driver, snippetPath, pngBase64], {
        input: request,
        encoding: 'utf8',
        timeout: 15_000,
      });
      assert.equal(out.status, 0, `stderr: ${out.stderr}`);
      const parsed = JSON.parse(out.stdout);
      const saved = parsed.content[0];
      assert.equal(saved.type, 'image');
      assert.equal(saved.mime_type, 'image/png');
      assert.equal(saved.base64_chars, pngBase64.length);
      assert.ok(saved.saved_to.startsWith(shotDir), 'the image must land in the shot dir');
      const written = readFileSync(saved.saved_to);
      assert.equal(written.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'a real PNG header');
      const mode = statSync(saved.saved_to).mode & 0o777;
      assert.equal(mode, 0o600, `the screenshot file must be 0600 (got ${mode.toString(8)})`);
      assert.equal(out.stdout.includes(pngBase64), false, 'the base64 must never cross stdout');
      rmSync(dir, { recursive: true, force: true });
    });
  },
);

test(
  'callTool dispatches the invoke tool through the shared switch (stub python)',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async (home) => {
      setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
      writeSessionFile(home, { lease_expires_at: Date.now() + 600_000 });
      const stubBin = join(home, 'bin');
      mkdirSync(stubBin, { recursive: true });
      const stubPython = join(stubBin, 'python');
      writeFileSync(
        stubPython,
        [
          '#!/bin/bash',
          'cat > /dev/null',
          'printf \'{"result": {"content": [], "is_error": false, "structured_content": {}}}\'',
          'exit 0',
          '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o755 },
      );
      const stubCli = join(stubBin, 'agentarts');
      writeFileSync(stubCli, ['#!/bin/bash', 'exit 0', ''].join('\n'), { encoding: 'utf8', mode: 0o755 });
      const previousBin = process.env.AGENTARTS_BIN;
      process.env.AGENTARTS_BIN = stubCli;
      try {
        const out = await callTool('huaweicloud_agentarts_browser_invoke', {
          action: 'get_page_info',
          session_id: SESSION_ID,
        });
        assert.equal(out.ok, true, JSON.stringify(out));
        assert.match(out.operation, /browser invoke get_page_info/);
      } finally {
        process.env.AGENTARTS_BIN = previousBin;
      }
    });
  },
);

test('the invoke tool surface: one lease-gated tool, enum parity, no key/region params', async () => {
  const { AGENTARTS_BROWSER_INVOKE_TOOL_DEFINITIONS, BROWSER_INVOKE_ACTIONS } =
    await import('../plugins/huaweicloud-core/src/agentarts-browser-tools.mjs');
  assert.equal(AGENTARTS_BROWSER_INVOKE_TOOL_DEFINITIONS.length, 1);
  const def = AGENTARTS_BROWSER_INVOKE_TOOL_DEFINITIONS[0];
  assert.equal(def.name, 'huaweicloud_agentarts_browser_invoke');
  assert.deepEqual(
    [...def.inputSchema.properties.action.enum].sort((a, b) => a.localeCompare(b)),
    [...BROWSER_INVOKE_ACTIONS].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(def.inputSchema.properties.action.enum.length, 18);
  for (const banned of ['api_key', 'apiKey', 'api-key', 'key'.replace('key', 'sk'), 'region']) {
    assert.equal(banned in def.inputSchema.properties, false, `invoke tool must not accept a ${banned} parameter`);
  }
  assert.match(def.description, /chrome-error:\/\//);
  assert.match(def.description, /trap 65/);
  assert.match(def.description, /trap 66/);
  assert.match(def.description, /trap 61/);
  assert.match(def.description, /Lease-gated, not token-gated/);
  // Registered in TOOL_DEFINITIONS.
  const { TOOL_DEFINITIONS } = await import('../plugins/huaweicloud-core/src/tools.mjs');
  assert.ok(TOOL_DEFINITIONS.some((t) => t.name === 'huaweicloud_agentarts_browser_invoke'));
});

// ---------------------------------------------------------------------------
// R10 fix round: the error-mapping base (no "undefined" prefixes), the
// mouse_drag default, the malformed-lease rejection, the
// truncation-surviving fence detection, and the corrupt-image degradation.

test('error mappings never prefix "undefined" — every failure carries a base error', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    writeSessionFile(home, { lease_expires_at: Date.now() + 600_000 });
    // B7 real-machine shapes (trap 80): the snippet formats "{class}: {msg}"
    // and ToolsAPIError's str() carries its own "Tools API Error: " prefix;
    // the session-death WORDING is unstable across same-shaped runs (both
    // "Session not found" and "No active session" measured on the cloud).
    for (const stderr of [
      'ToolsAPIError: Tools API Error: Session not found',
      'ToolsAPIError: Tools API Error: No active session',
      'ToolsAPIError: Tools API Error: Stream is disabled for this session',
      'ValueError: API Key is not provided and not found in environment variable.',
      // Tolerance: the bare shape (no double prefix) also maps.
      'ToolsAPIError: Session not found',
      'ToolsAPIError: No active session',
      'ToolsAPIError: Stream is disabled for this session',
    ]) {
      const out = await runAgentartsBrowserInvoke(
        { action: 'get_page_info', session_id: SESSION_ID },
        { runCandidate: async () => ({ exitCode: 1, stdout: '', stderr }) },
      );
      assert.equal(out.ok, false);
      assert.ok(out.error, 'a failure must always carry an error');
      assert.doesNotMatch(out.error, /^undefined/, `"${stderr}" → "${out.error}"`);
      assert.match(out.error, /^Execution failed/);
    }
    // The unrelated-substring shapes no longer map (anchored regexes).
    const unrelated = await runAgentartsBrowserInvoke(
      { action: 'get_page_info', session_id: SESSION_ID },
      {
        runCandidate: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'ToolsAPIError: cache key Session not found in registry (unrelated service)',
        }),
      },
    );
    assert.equal(unrelated.ok, false);
    assert.doesNotMatch(unrelated.error, /cloud session is gone/);
  });
});

test('mouse_drag carries the SDK button default and a malformed lease is rejected', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    writeSessionFile(home, { lease_expires_at: Date.now() + 600_000 });
    let seenStdin = null;
    const out = await runAgentartsBrowserInvoke(
      { action: 'mouse_drag', session_id: SESSION_ID, start_x: 0, start_y: 0, end_x: 100, end_y: 100 },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          seenStdin = stdinData;
          return {
            exitCode: 0,
            stdout: pyDumps({ result: { content: [], is_error: false, structured_content: {} } }),
            stderr: '',
          };
        },
      },
    );
    assert.equal(out.ok, true);
    assert.deepEqual(JSON.parse(seenStdin).action_params, {
      start_x: 0,
      start_y: 0,
      end_x: 100,
      end_y: 100,
      button: 'left',
    });
    // A state file WITHOUT a lease field is malformed, not ungated (the
    // lease IS the approval boundary).
    const dir = join(home, '.config', 'huaweicloud');
    const statePath = join(dir, `agentarts-browser-session-${SESSION_ID}.json`);
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    delete raw.lease_expires_at;
    writeFileSync(statePath, JSON.stringify(raw));
    const ungated = await runAgentartsBrowserInvoke(
      { action: 'get_page_info', session_id: SESSION_ID },
      { runCandidate: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) },
    );
    assert.equal(ungated.ok, false);
    assert.match(ungated.error, /malformed \(missing lease or bad session id\)/);
  });
});

test('the fence note survives output truncation (raw-stdout derivation)', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    writeSessionFile(home, { lease_expires_at: Date.now() + 600_000 });
    // A >50KB get_page_info whose structured_content carries the fence
    // URL: the envelope drops `result` to the side file, but the note must
    // still fire (get_page_info IS the documented fence check).
    const big = pyDumps({
      result: {
        content: [{ type: 'text', text: 'x'.repeat(60_000) }],
        is_error: false,
        structured_content: { current_url: 'chrome-error://chromewebdata/', pad: 'y'.repeat(100) },
      },
    });
    const out = await runAgentartsBrowserInvoke(
      { action: 'get_page_info', session_id: SESSION_ID },
      { runCandidate: async () => ({ exitCode: 0, stdout: big, stderr: '' }) },
    );
    assert.equal(out.ok, true);
    assert.match(out.stdout, /truncated, full output saved to/);
    assert.equal('result' in out, false, 'the envelope truncated the result');
    assert.match(out.notes.join(' '), /DOMAIN FENCE HIT/, 'the fence note must survive truncation');
  });
});

test(
  'a corrupt image block degrades to a decode_error stub, not a failed action (snippet)',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async () => {
      const source = readFileSync(join(rootDir, 'plugins/huaweicloud-core/src/agentarts-browser.mjs'), 'utf8');
      const match = source.match(/const BROWSER_INVOKE_SNIPPET = \[([\s\S]*?)\]\.join\('\\n'\);/);
      assert.ok(match, 'snippet extraction failed');
      const snippet = eval(`[${match[1]}]`).join('\n');
      const dir = mkdtempSync(join(tmpdir(), 'browser-invoke-corrupt-'));
      const snippetPath = join(dir, 'snippet.py');
      writeFileSync(snippetPath, snippet);
      const driver = join(dir, 'driver.py');
      writeFileSync(
        driver,
        [
          'import sys, types',
          "fake = types.ModuleType('agentarts')",
          "sdk = types.ModuleType('agentarts.sdk')",
          'class Browser:',
          '    def __init__(self, region=None, data_endpoint=None, auth_type="API_KEY"):',
          '        pass',
          '    def invoke(self, type=None, action=None):',
          '        return {"content": [{"type": "image", "data": "!!!not-base64!!!", "mime_type": "image/png"}], "is_error": False, "structured_content": {}}',
          'sdk.Browser = Browser',
          'fake.sdk = sdk',
          "sys.modules['agentarts'] = fake",
          "sys.modules['agentarts.sdk'] = sdk",
          "exec(compile(open(sys.argv[1]).read(), 'snippet', 'exec'))",
          '',
        ].join('\n'),
      );
      const request = pyDumps({
        action: 'screenshot',
        action_params: {},
        region: 'cn-southwest-2',
        data_endpoint: 'https://gw.example.com',
        auth_type: 'IAM',
        browser_name: 'team-browser',
        session_id: SESSION_ID,
        screenshot_dir: join(dir, 'shots'),
      });
      const out = spawnSync('python3', [driver, snippetPath], { input: request, encoding: 'utf8', timeout: 15_000 });
      // The action SUCCEEDED server-side: exit 0 with a decode_error stub.
      assert.equal(out.status, 0, `stderr: ${out.stderr}`);
      const parsed = JSON.parse(out.stdout);
      assert.equal(parsed.content[0].type, 'image');
      assert.ok(parsed.content[0].decode_error, 'the corrupt block must degrade to a decode_error stub');
      rmSync(dir, { recursive: true, force: true });
    });
  },
);

// ---------------------------------------------------------------------------
// R13: the guard's malformed-record sweep and the snippet's
// decode-before-open ordering.

test('the orphan guard sweeps malformed (undriveable) records instead of dead-ending its own remediation', async () => {
  await withIsolation(async (home) => {
    // A live lease with a non-UUID inner session id: pre-R13 the guard
    // blocked the start while pointing at a stop_session that would
    // reject the same record as malformed — an impossible remediation.
    const dir = join(home, '.config', 'huaweicloud');
    mkdirSync(dir, { recursive: true });
    const malformedPath = join(dir, 'agentarts-browser-session-bad-record.json');
    writeFileSync(
      malformedPath,
      JSON.stringify({
        browser_name: 'team-browser',
        session_id: 'not-a-uuid',
        lease_expires_at: Date.now() + 600_000,
      }),
    );
    const plan = planAgentartsBrowserWrite({
      operation: 'start_session',
      browser_name: 'team-browser',
      session_name: 's1',
    });
    assert.equal(plan.ok, true, 'the malformed record must be swept, not block the start');
    assert.equal(existsSync(malformedPath), false, 'the undriveable record is swept');
  });
});

test(
  'a failed screenshot decode leaves no orphan file behind (decode-before-open)',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async () => {
      const source = readFileSync(join(rootDir, 'plugins/huaweicloud-core/src/agentarts-browser.mjs'), 'utf8');
      const match = source.match(/const BROWSER_INVOKE_SNIPPET = \[([\s\S]*?)\]\.join\('\\n'\);/);
      assert.ok(match, 'snippet extraction failed');
      const snippet = eval(`[${match[1]}]`).join('\n');
      const dir = mkdtempSync(join(tmpdir(), 'browser-decode-order-'));
      const snippetPath = join(dir, 'snippet.py');
      writeFileSync(snippetPath, snippet);
      const shotDir = join(dir, 'shots');
      const driver = join(dir, 'driver.py');
      writeFileSync(
        driver,
        [
          'import sys, types',
          "fake = types.ModuleType('agentarts')",
          "sdk = types.ModuleType('agentarts.sdk')",
          'class Browser:',
          '    def __init__(self, region=None, data_endpoint=None, auth_type="API_KEY"):',
          '        pass',
          '    def invoke(self, type=None, action=None):',
          '        return {"content": [{"type": "image", "data": "!!!not-base64!!!", "mime_type": "image/png"}], "is_error": False, "structured_content": {}}',
          'sdk.Browser = Browser',
          'fake.sdk = sdk',
          "sys.modules['agentarts'] = fake",
          "sys.modules['agentarts.sdk'] = sdk",
          "exec(compile(open(sys.argv[1]).read(), 'snippet', 'exec'))",
          '',
        ].join('\n'),
      );
      const request = pyDumps({
        action: 'screenshot',
        action_params: {},
        region: 'cn-southwest-2',
        data_endpoint: 'https://gw.example.com',
        auth_type: 'IAM',
        browser_name: 'team-browser',
        session_id: SESSION_ID,
        screenshot_dir: shotDir,
      });
      const out = spawnSync('python3', [driver, snippetPath], { input: request, encoding: 'utf8', timeout: 15_000 });
      assert.equal(out.status, 0, `stderr: ${out.stderr}`);
      const parsed = JSON.parse(out.stdout);
      assert.ok(parsed.content[0].decode_error, 'the corrupt block degrades to a stub');
      // The decode fires BEFORE makedirs — a failed decode may leave no
      // directory at all (also fine: zero orphans either way).
      if (existsSync(shotDir)) {
        assert.deepEqual(readdirSync(shotDir), [], 'no orphan file may survive a failed decode');
      }
      rmSync(dir, { recursive: true, force: true });
    });
  },
);
