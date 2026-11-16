import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { callTool, type ToolName } from '../../plugins/huaweicloud-core/src/tools.ts';
import { SANDBOX_APPROVAL_SPECS, bindingArgs } from '../../plugins/huaweicloud-core/src/packs/sandbox/approval.ts';
import { fixtureDir } from '../fixture-dir.ts';

// The PR-1 perf probe: p50 milliseconds per call for three in-process
// callTool probes, trunk and head interleaved, three rounds each.
//
//   Probe A — 200 huaweicloud_plan_cli_command calls: the approval pack's
//     own plan face, which shares the dispatch path with the gated run tool
//     and pays the same diff-added roster check (a table miss) plus its
//     existing mint cost.
//   Probe B — 200 huaweicloud_search_docs calls: the cleanest signal for
//     the diff-added dispatch-layer roster check on a non-gated tool.
//   Probe C — 200 huaweicloud_auth_status calls (PR-3b): the roster-miss
//     cost on the auth pack's own OFF-roster face — the two auth
//     registrations must cost an ungated sibling nothing.
//
// The PR-3a probes (the plan's perf block):
//
//   Probe C — 200 huaweicloud_sandbox_exec_one_shot calls carrying a
//     write-classified command, no token: head rejects through the gate's
//     mint envelope (classify → strict floors → mint → envelope), trunk
//     runs the same call ungated into the handler (its synchronous
//     workspace_id refusal — no network, no spawn). The diff-added work is
//     the gate plus classify, gated by an absolute budget.
//   Probe D — 200 runs of the sandbox exec spec's pure classify step alone
//     (head-only: the classify did not exist on trunk), an absolute budget.
//
// The trunk side comes from TRUNK_DEVKIT_SRC — the absolute path to a TRUNK
// checkout's plugins/huaweicloud-core/src directory (built: a raw checkout
// has no skills tree, and Probe B would silently measure a no-op). The
// bench runs from the head checkout against both trees, so it fails loudly
// when the trunk side is missing instead of reporting a vacuous pass.
// Rules: head fails if Probe A p50 exceeds trunk by more than 10 percent,
// Rules: head fails if Probe A p50 exceeds trunk by more than 10 percent,
// if Probe B p50 exceeds trunk by more than 0.5 milliseconds absolute, or
// if Probe C (auth_status, PR-3b) p50 exceeds trunk by more than 0.5
// milliseconds absolute; PR-3a adds: head fails if the classify step
// exceeds 2 milliseconds p50 absolute, or if the gated rejection path
// exceeds trunk ungated p50 plus 5 milliseconds absolute.
//
// Excluded from `npm test` by the test/*.test.ts glob on purpose — this is
// a deliberate perf run, never part of the CI battery.

const TRUNK_DEVKIT_SRC = process.env.TRUNK_DEVKIT_SRC;
const ROUNDS = 3;
const ITERATIONS = 200;
const WARMUP = 20;
const PROBE_A_BUDGET_RATIO = 1.1;
const PROBE_B_BUDGET_MS = 0.5;
const CLASSIFY_BUDGET_MS = 2;
const SANDBOX_REJECTION_BUDGET_MS = 5;

process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';
process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = 'off';

type Side = 'trunk' | 'head';
type Dispatch = (name: string, args: Record<string, unknown>) => Promise<unknown>;

async function loadTrunkDispatch(): Promise<Dispatch> {
  const mod = (await import(pathToFileURL(join(TRUNK_DEVKIT_SRC!, 'tools.ts')).href)) as {
    callTool: (name: string, args: unknown, opts: unknown) => Promise<unknown>;
  };
  return (name, args) => mod.callTool(name, args, {});
}

const headDispatch: Dispatch = (name, args) => callTool(name as ToolName, args, {});
let trunkDispatch: Dispatch | undefined;

async function dispatch(side: Side, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (side === 'head') return headDispatch(name, args);
  if (!trunkDispatch) trunkDispatch = await loadTrunkDispatch();
  return trunkDispatch(name, args);
}

const homes: Record<Side, string> = {
  trunk: fixtureDir('approval-bench-trunk-'),
  head: fixtureDir('approval-bench-head-'),
};

// One home-pin seam for every timed probe: HUAWEICLOUD_HOME points at the
// side's throwaway home for the call's duration, restored either way.
async function withSideHome<T>(side: Side, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = homes[side];
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = previous;
  }
}

async function timedCall(side: Side, name: string, args: Record<string, unknown>): Promise<number> {
  return withSideHome(side, async () => {
    const start = performance.now();
    await dispatch(side, name, args);
    return performance.now() - start;
  });
}

function p50(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const PLAN_ARGS = { args: ['ECS', 'ListServersDetails'], vendorConfirmed: 'bench: vendor established by the harness' };
const SEARCH_ARGS = { query: 'create ecs instance', topic: 'all' };
// auth_status is vendor-gated but not approval-rostered (PR-3b's probe):
// the probe carries the gate's quote and pays only the dispatch-layer
// roster miss.
const AUTH_STATUS_ARGS = { target: 'all', vendorConfirmed: 'bench: vendor established by the harness' };
// A write-classified command with no workspace_id: on head the gate mints
// and answers with the rejection envelope (nothing executes); on trunk the
// same call runs ungated into the handler's synchronous workspace refusal.
// The attestation rides like every token-mode roster call, so the measured
// head path is floors + classify + mint — not the precheck throw.
const SANDBOX_EXEC_ARGS = {
  command: 'hcloud ECS DeleteServers --server_id=i-1 --cli-region=cn-north-4',
  approvedByUser: true,
};

// The swallowing twin of timedCall, for probes whose outcome is a refusal
// on one or both sides (the envelope is a result, the handler's refusal is
// a throw): the measured cost is the dispatch work, not the outcome shape.
async function timedSwallowing(side: Side, name: string, args: Record<string, unknown>): Promise<number> {
  return withSideHome(side, async () => {
    const start = performance.now();
    await dispatch(side, name, args).then(
      () => undefined,
      () => undefined,
    );
    return performance.now() - start;
  });
}

async function runProbe(probe: string, tool: string, args: Record<string, unknown>): Promise<Record<Side, number>> {
  const samples: Record<Side, number[]> = { trunk: [], head: [] };
  for (let i = 0; i < WARMUP; i += 1) {
    // Interleave the warmup too: JIT tiering stays symmetric across sides.
    await timedCall('trunk', tool, args);
    await timedCall('head', tool, args);
  }
  for (let round = 0; round < ROUNDS; round += 1) {
    for (let i = 0; i < ITERATIONS; i += 1) {
      samples.trunk.push(await timedCall('trunk', tool, args));
      samples.head.push(await timedCall('head', tool, args));
    }
  }
  const result = { trunk: p50(samples.trunk), head: p50(samples.head) };
  console.log(
    `${probe}: trunk p50 ${result.trunk.toFixed(3)} ms, head p50 ${result.head.toFixed(3)} ms ` +
      `(${samples.trunk.length + samples.head.length} calls)`,
  );
  return result;
}

test('approval-dispatch bench: head stays within the trunk p50 budgets', async () => {
  assert.ok(
    TRUNK_DEVKIT_SRC,
    "TRUNK_DEVKIT_SRC must point at a built trunk checkout's plugins/huaweicloud-core/src " +
      '(git worktree add <dir> <trunk-sha>; npm ci --ignore-scripts --no-audit --no-fund; npm run build; ' +
      'TRUNK_DEVKIT_SRC=<dir>/plugins/huaweicloud-core/src node --test test/bench/approval-dispatch.bench.ts)',
  );

  const planP50 = await runProbe('Probe A (plan_cli_command)', 'huaweicloud_plan_cli_command', PLAN_ARGS);
  const searchP50 = await runProbe('Probe B (search_docs)', 'huaweicloud_search_docs', SEARCH_ARGS);

  assert.ok(
    planP50.head <= planP50.trunk * PROBE_A_BUDGET_RATIO,
    `Probe A head p50 ${planP50.head.toFixed(3)} ms exceeds trunk ${planP50.trunk.toFixed(3)} ms by more than 10 percent`,
  );
  assert.ok(
    searchP50.head <= searchP50.trunk + PROBE_B_BUDGET_MS,
    `Probe B head p50 ${searchP50.head.toFixed(3)} ms exceeds trunk ${searchP50.trunk.toFixed(3)} ms by more than 0.5 ms absolute`,
  );

  // Probe C (PR-3b): the roster-miss cost on the auth pack's own off-roster
  // face — the two auth registrations must cost an ungated sibling nothing.
  const authStatusP50 = await runProbe('Probe C (auth_status)', 'huaweicloud_auth_status', AUTH_STATUS_ARGS);
  assert.ok(
    authStatusP50.head <= authStatusP50.trunk + PROBE_B_BUDGET_MS,
    `Probe C head p50 ${authStatusP50.head.toFixed(3)} ms exceeds trunk ${authStatusP50.trunk.toFixed(3)} ms by more than 0.5 ms absolute`,
  );

  // Probe D (PR-3a): the gated sandbox rejection path against the same call
  // ungated on trunk. The trunk call lands in the handler's synchronous
  // workspace refusal (a throw); the head call stops at the gate's mint
  // envelope. Both sides are swallowed by the runner: the measured cost is
  // the dispatch work, not the outcome's shape. The head store is reset
  // before every timed call: a mint-only probe would otherwise measure the
  // PRE-EXISTING approvals store's O(size) read-modify-write growth (the
  // plan face's mint pays the same on trunk), not this PR's diff-added
  // gate + classify + mint work.
  const { rmSync } = await import('node:fs');
  const sandboxSamples: Record<Side, number[]> = { trunk: [], head: [] };
  const resetHeadStore = (): void => {
    rmSync(join(homes.head, '.config', 'huaweicloud', 'approvals.json'), { force: true });
  };
  for (let i = 0; i < WARMUP; i += 1) {
    await timedSwallowing('trunk', 'huaweicloud_sandbox_exec_one_shot', SANDBOX_EXEC_ARGS);
    resetHeadStore();
    await timedSwallowing('head', 'huaweicloud_sandbox_exec_one_shot', SANDBOX_EXEC_ARGS);
  }
  for (let round = 0; round < ROUNDS; round += 1) {
    for (let i = 0; i < ITERATIONS; i += 1) {
      sandboxSamples.trunk.push(await timedSwallowing('trunk', 'huaweicloud_sandbox_exec_one_shot', SANDBOX_EXEC_ARGS));
      resetHeadStore();
      sandboxSamples.head.push(await timedSwallowing('head', 'huaweicloud_sandbox_exec_one_shot', SANDBOX_EXEC_ARGS));
    }
  }
  const sandboxP50 = { trunk: p50(sandboxSamples.trunk), head: p50(sandboxSamples.head) };
  console.log(
    `Probe D (sandbox exec rejection): trunk p50 ${sandboxP50.trunk.toFixed(3)} ms (ungated), ` +
      `head p50 ${sandboxP50.head.toFixed(3)} ms (gate + classify + mint)`,
  );
  assert.ok(
    sandboxP50.head <= sandboxP50.trunk + SANDBOX_REJECTION_BUDGET_MS,
    `Probe E head p50 ${sandboxP50.head.toFixed(3)} ms exceeds trunk ungated ${sandboxP50.trunk.toFixed(3)} ms ` +
      `by more than ${SANDBOX_REJECTION_BUDGET_MS} ms absolute`,
  );

  // Probe E (PR-3a): the classified spec's pure classify step alone,
  // head-only — the step did not exist on trunk. A fresh binding object per
  // iteration, so the WeakMap ruling cache never serves a hit.
  const execSpec = SANDBOX_APPROVAL_SPECS.huaweicloud_sandbox_exec_one_shot;
  const classifySamples: number[] = [];
  for (let i = 0; i < WARMUP; i += 1) {
    execSpec.classify?.(bindingArgs(SANDBOX_EXEC_ARGS), {});
  }
  for (let round = 0; round < ROUNDS; round += 1) {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const binding = bindingArgs(SANDBOX_EXEC_ARGS);
      const start = performance.now();
      execSpec.classify?.(binding, {});
      classifySamples.push(performance.now() - start);
    }
  }
  const classifyP50 = p50(classifySamples);
  console.log(`Probe E (sandbox classify step): head p50 ${classifyP50.toFixed(3)} ms`);
  assert.ok(
    classifyP50 <= CLASSIFY_BUDGET_MS,
    `Probe E head p50 ${classifyP50.toFixed(3)} ms exceeds the ${CLASSIFY_BUDGET_MS} ms absolute classify budget`,
  );
});
