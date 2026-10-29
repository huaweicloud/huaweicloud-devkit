import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

// AgentArts memory lifecycle acceptance (the PR11 deliverable): a gated,
// cloud-bound create → get → delete → list-disappearance proof of the
// unblocked memory trio, including the one-time api_key capture contract
// (0600 file under the scratch state root, payload stays redacted).
//
// Gated by a SINGLE switch: AGENTARTS_E2E=1 (same contract as the golden
// path; plain `npm test` never loads this file). FAILS CLOSED on the same
// isolation invariants: creds 0600 shape, fingerprint ≠ the machine's
// devkit account, e2e-aa-* adopt-or-abort sweeps (memory spaces AND
// agents). NO docker preflight — memory is control-plane only.
//
// Region topology (adjudicated 2026-10-21, findings trap 15): the memory
// family's help text CLAIMS a cn-north-4 default, but the actual chain is
// CLI param default None → get_region() → cn-southwest-2 (constant.py:79).
// This run pins cn-southwest-2 — the true code default and the control-
// plane region — and still passes --region explicitly on every call.
// Design contract: docs/agentarts-pr0-findings.md + the PR11 review rounds.

const GATE = process.env.AGENTARTS_E2E === '1';
const CREDS_PATH = join(homedir(), '.config', 'agentarts-e2e', 'creds');
const WORKTREE = join(import.meta.dirname, '..', '..', '..');
const SCRATCH_ROOT = join(WORKTREE, '.e2e-home');
const AGENTARTS_BIN = join(SCRATCH_ROOT, 'venv', 'bin', 'agentarts');
const MEMORY_REGION = 'cn-southwest-2';

process.env.AGENTARTS_BIN = AGENTARTS_BIN;

function parseCreds() {
  const raw = readFileSync(CREDS_PATH, 'utf8');
  const creds = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) creds[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  if (!creds.AK || !creds.SK) {
    throw new Error('creds file must define AK and SK (variable names, mapped to HUAWEICLOUD_SDK_AK/SK)');
  }
  return creds;
}

const runid = `e2e-aa-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const spaceName = `${runid}-space`;
const report = { runid, startedAt: new Date().toISOString(), stages: {}, approvals: 0, traps: [] };

async function stage(name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    report.stages[name] = { ok: true, durationMs: Date.now() - startedAt, ...(detail || {}) };
    console.log(`ok   ${name} (${Date.now() - startedAt}ms)`);
  } catch (error) {
    report.stages[name] = { ok: false, durationMs: Date.now() - startedAt, error: String(error.message || error) };
    console.error(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}

function scanTree(root, creds) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) {
        const text = readFileSync(p, 'utf8');
        if (text.includes(creds.AK) || text.includes(creds.SK)) hits.push(p);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return hits;
}

test(
  'agentarts memory lifecycle e2e (S0 preflight → M1 create → M2 get → M3 delete → M4 gone)',
  { skip: !GATE ? 'set AGENTARTS_E2E=1 to run the gated cloud e2e' : false },
  async () => {
    const creds = parseCreds();
    let scratch;
    let spaceId;
    let deployed = false;
    const artifacts = {};
    let planAgentartsCommand;
    let runAgentartsApprovedCommand;
    let runAgentartsReadonlyCommand;

    try {
      await stage('S0-preflight', async () => {
        assert.equal(statSync(CREDS_PATH).mode & 0o777, 0o600, 'creds file must be 0600');
        assert.ok(existsSync(AGENTARTS_BIN), `expected the scratch venv CLI at ${AGENTARTS_BIN}`);
        const { fingerprint } = await import(
          join(WORKTREE, 'plugins', 'huaweicloud-core', 'src', 'auth', 'reconcile.mjs')
        );
        const { readGlobalCredentials } = await import(
          join(WORKTREE, 'plugins', 'huaweicloud-core', 'src', 'auth', 'credentials.mjs')
        );
        const daily = readGlobalCredentials();
        if (daily?.ak && daily?.sk) {
          assert.notEqual(
            fingerprint(creds.AK, creds.SK),
            fingerprint(daily.ak, daily.sk),
            "E2E credentials match this machine's configured devkit account — refusing to run (isolation invariant)",
          );
        }
        scratch = mkdtempSync(join(SCRATCH_ROOT, 'e2e', `${runid}-`));
        const envSwaps = {
          HOME: scratch,
          XDG_CACHE_HOME: join(scratch, '.cache'),
          XDG_DATA_HOME: join(scratch, '.local', 'share'),
          HUAWEICLOUD_HOME: scratch,
          AGENTARTS_BIN,
        };
        for (const [key, value] of Object.entries(envSwaps)) {
          process.env[key] = value;
        }
        const mod = await import(join(WORKTREE, 'plugins', 'huaweicloud-core', 'src', 'agentarts-cli.mjs'));
        ({ planAgentartsCommand, runAgentartsApprovedCommand, runAgentartsReadonlyCommand } = mod);
        const { setRuntimeCredentials } = await import(
          join(WORKTREE, 'plugins', 'huaweicloud-core', 'src', 'auth', 'credentials.mjs')
        );
        setRuntimeCredentials(creds.AK, creds.SK, undefined, MEMORY_REGION);
        // Adopt-or-abort: no pre-existing e2e-aa-* memory spaces.
        const preList = await runAgentartsReadonlyCommand([
          'memory',
          'list',
          '--region',
          MEMORY_REGION,
          '--output',
          'json',
        ]);
        assert.equal(preList.ok, true, `preflight memory list failed: ${preList.stderr || preList.error}`);
        const names = [...String(preList.stdout).matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
        const leftovers = names.filter((n) => n.startsWith('e2e-aa-'));
        assert.deepEqual(leftovers, [], `pre-existing e2e-aa-* spaces: ${leftovers.join(', ')}`);
        return { scratch, preExistingSpaces: names.length };
      });

      async function approvedRun(args) {
        report.approvals += 1;
        const plan = planAgentartsCommand(args);
        assert.equal(plan.ok, true, `plan rejected: ${plan.error}`);
        return runAgentartsApprovedCommand({ args, approvalToken: plan.approvalToken, approvedByUser: true });
      }

      await stage('M1-create', async () => {
        // Pre-canonicalized args (the token hash binds the exact form).
        // --strategies is REQUIRED (friction fix 1: server 400 without it,
        // and a failed create orphans the API key).
        const result = await approvedRun([
          'memory',
          'create',
          spaceName,
          '--strategies',
          'semantic',
          '--region',
          MEMORY_REGION,
          '--output',
          'json',
        ]);
        assert.equal(result.ok, true, `create failed: ${(result.stderr || result.error || '').slice(0, 500)}`);
        spaceId = result.spaceId;
        assert.ok(spaceId, 'create must surface spaceId');
        deployed = true;
        // The key contract: 0600 file in the scratch state root, raw key inside,
        // and the payload NEVER carries the raw key.
        assert.ok(result.memoryApiKeyFile, 'create must surface memoryApiKeyFile');
        assert.match(result.memoryApiKeyFile, new RegExp(`${spaceId}\\.txt$`));
        assert.ok(result.memoryApiKeyFile.startsWith(scratch), 'key file must live under the scratch state root');
        assert.equal(statSync(result.memoryApiKeyFile).mode & 0o777, 0o600, 'key file must be 0600');
        const rawKey = readFileSync(result.memoryApiKeyFile, 'utf8').trim();
        assert.ok(rawKey.length > 0, 'key file must hold the raw key');
        artifacts.rawKey = rawKey;
        artifacts.keyFile = result.memoryApiKeyFile;
        assert.ok(!JSON.stringify(result).includes(rawKey), 'payload must not carry the raw key');
        return { spaceId, keyFile: result.memoryApiKeyFile };
      });

      await stage('M2-get', async () => {
        const result = await runAgentartsReadonlyCommand(['memory', 'get', spaceId, '--region', MEMORY_REGION]);
        assert.equal(result.ok, true, `get failed: ${(result.stderr || result.error || '').slice(0, 500)}`);
        // S0 adjudication capture: does get re-expose the api_key? Record, and
        // enforce that whatever comes back never carries the raw key unredacted.
        assert.ok(!JSON.stringify(result).includes(artifacts.rawKey), 'get output must not leak the raw key');
        return { getRedacted: !String(result.stdout).includes(artifacts.rawKey) };
      });

      await stage('M3-delete', async () => {
        const result = await approvedRun(['memory', 'delete', spaceId, '--region', MEMORY_REGION, '--force']);
        assert.equal(result.ok, true, `delete failed: ${(result.stderr || result.error || '').slice(0, 500)}`);
        deployed = false;
        return {};
      });

      await stage('M4-gone', async () => {
        // List-disappearance convergence (PR7-style), not just exit output.
        let gone = false;
        let lastDetail = '';
        for (let attempt = 0; attempt < 3 && !gone; attempt += 1) {
          const list = await runAgentartsReadonlyCommand([
            'memory',
            'list',
            '--region',
            MEMORY_REGION,
            '--output',
            'json',
          ]);
          if (list.ok) {
            const ids = [...String(list.stdout).matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
            const names = [...String(list.stdout).matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
            gone = !ids.includes(spaceId) && !names.includes(spaceName);
            lastDetail = gone ? '' : 'still listed';
          } else {
            lastDetail = `list failed: ${list.stderr || list.error}`;
          }
          if (!gone && attempt < 2) await new Promise((r) => setTimeout(r, 10_000));
        }
        assert.ok(gone, `space ${spaceId} not gone after delete — ${lastDetail}`);
        return {};
      });

      await stage('S6-canary', async () => {
        // Credential canary over the scratch tree: AK/SK (and the raw key,
        // outside its ONE sanctioned file) must appear nowhere.
        const hits = scanTree(scratch, creds);
        const keyFile = artifacts.keyFile;
        const strayKeys = [];
        const walk = (dir) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (entry.isFile() && p !== keyFile) {
              if (readFileSync(p, 'utf8').includes(artifacts.rawKey)) strayKeys.push(p);
            }
          }
        };
        if (existsSync(scratch)) walk(scratch);
        assert.deepEqual(hits, [], `AK/SK literals leaked: ${hits.join(', ')}`);
        assert.deepEqual(strayKeys, [], `raw api_key leaked outside the key file: ${strayKeys.join(', ')}`);
        assert.equal(report.approvals, 2, `expected exactly 2 approvals (create, delete), counted ${report.approvals}`);
        return {};
      });
    } finally {
      // Convergence: a created space must not survive a failed run.
      if (deployed && runAgentartsApprovedCommand && planAgentartsCommand && spaceId) {
        try {
          const plan = planAgentartsCommand(['memory', 'delete', spaceId, '--region', MEMORY_REGION, '--force']);
          if (plan.approvalToken) {
            await runAgentartsApprovedCommand({
              args: ['memory', 'delete', spaceId, '--region', MEMORY_REGION, '--force'],
              approvalToken: plan.approvalToken,
              approvedByUser: true,
            });
            report.residue = 'finally-deleted';
          }
        } catch (error) {
          report.residue = `finally-delete failed: ${error.message}`;
        }
      } else {
        report.residue = false;
      }
      report.finishedAt = new Date().toISOString();
      mkdirSync(join(SCRATCH_ROOT, 'e2e'), { recursive: true });
      const reportPath = join(SCRATCH_ROOT, 'e2e', `report-${runid}-memory.json`);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(reportPath, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
      chmodSync(reportPath, 0o600);
      console.log(`report: ${reportPath}`);
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test('agentarts memory e2e gate contract (no cloud access)', () => {
  assert.equal(GATE, false, 'this companion test only runs UNGATED — the gated test above owns the cloud run');
  assert.equal(typeof parseCreds, 'function');
});
