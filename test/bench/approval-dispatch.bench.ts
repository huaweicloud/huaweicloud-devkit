import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { callTool, type ToolName } from '../../plugins/huaweicloud-core/src/tools.ts';
import { fixtureDir } from '../fixture-dir.ts';

// The PR-1 perf probe: p50 milliseconds per call for two in-process
// callTool probes, trunk and head interleaved, three rounds each.
//
//   Probe A — 200 huaweicloud_plan_cli_command calls: the approval pack's
//     own plan face, which shares the dispatch path with the gated run tool
//     and pays the same diff-added roster check (a table miss) plus its
//     existing mint cost.
//   Probe B — 200 huaweicloud_search_docs calls: the cleanest signal for
//     the diff-added dispatch-layer roster check on a non-gated tool.
//
// The trunk side comes from TRUNK_DEVKIT_SRC — the absolute path to a TRUNK
// checkout's plugins/huaweicloud-core/src directory (built: a raw checkout
// has no skills tree, and Probe B would silently measure a no-op). The
// bench runs from the head checkout against both trees, so it fails loudly
// when the trunk side is missing instead of reporting a vacuous pass.
// Rules: head fails if Probe A p50 exceeds trunk by more than 10 percent,
// or if Probe B p50 exceeds trunk by more than 0.5 milliseconds absolute.
//
// Excluded from `npm test` by the test/*.test.ts glob on purpose — this is
// a deliberate perf run, never part of the CI battery.

const TRUNK_DEVKIT_SRC = process.env.TRUNK_DEVKIT_SRC;
const ROUNDS = 3;
const ITERATIONS = 200;
const WARMUP = 20;
const PROBE_A_BUDGET_RATIO = 1.1;
const PROBE_B_BUDGET_MS = 0.5;

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

async function timedCall(side: Side, name: string, args: Record<string, unknown>): Promise<number> {
  const previous = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = homes[side];
  try {
    const start = performance.now();
    await dispatch(side, name, args);
    return performance.now() - start;
  } finally {
    if (previous === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = previous;
  }
}

function p50(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const PLAN_ARGS = { args: ['ECS', 'ListServersDetails'], vendorConfirmed: 'bench: vendor established by the harness' };
const SEARCH_ARGS = { query: 'create ecs instance', topic: 'all' };

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
});
