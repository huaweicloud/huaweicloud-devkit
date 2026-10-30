// The E2E runner entry point (`node test/e2e/runner.ts`, package.json
// test:e2e): arg parsing, driver selection (E2E_AGENT), the suite loop with
// the incident-hardening streaks, and the always-ships report. The family
// modules: harness.ts (shared plumbing), seams.ts (session seam vars + PATH
// hardening), pack-install.ts (tarball → prefix install), case-fixtures.ts
// (home/workdir seeding), recordings.ts (log/trace/file collection),
// report.ts (attempt shapes + summaries + retention), case-run.ts (the
// per-case attempt loop), selfcheck.ts (the LLM-less chain proof, assertion
// ladder in selfcheck-verify.ts).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scrubSecrets } from './env-policy.ts';
import { ALL_CASES } from './cases/index.ts';
import { opencodeDriver } from './drivers/opencode.ts';
import { codexDriver } from './drivers/codex.ts';
import { hermesDriver } from './drivers/hermes.ts';
import { verifyLegWire } from './drivers/shared.ts';
import type { AgentDriver, DriverId } from './drivers/types.ts';
import { loadDotEnv, out, packageJson, root, sweepStaleTempDirs } from './harness.ts';
import { installPrefix, npmPackTarball } from './pack-install.ts';
import { runCase } from './case-run.ts';
import { selfcheck } from './selfcheck.ts';
import { emptyRecordings } from './recordings.ts';
import { pruneReports, runnerErrorVerdict, scrubbedStack } from './report.ts';

const DRIVERS: Record<DriverId, AgentDriver> = {
  opencode: opencodeDriver,
  codex: codexDriver,
  hermes: hermesDriver,
};

async function main(): Promise<void> {
  loadDotEnv();
  if (process.env.E2E_ENABLE !== '1') {
    out('[runner] E2E_ENABLE is not 1 — skipping (set E2E_ENABLE=1 to run the agent-level E2E suite)');
    return;
  }
  const args = process.argv.slice(2);
  const driverId = process.env.E2E_AGENT || 'opencode';
  const driver = DRIVERS[driverId as DriverId];
  const pkg = packageJson();

  if (args[0] === 'selfcheck') {
    const tarball = npmPackTarball();
    const prefix = installPrefix(tarball);
    try {
      const bin = join(prefix, 'node_modules', 'huaweicloud-devkit', 'bin', 'setup.cjs');
      const ok = await selfcheck(bin, pkg.kooCliVersion);
      out(`[selfcheck] ${ok ? 'PASS' : 'FAIL'}`);
      process.exitCode = ok ? 0 : 1;
    } finally {
      rmSync(prefix, { recursive: true, force: true });
      rmSync(tarball, { force: true });
    }
    return;
  }

  // The report scaffold exists before anything that can fail loudly, and
  // the finally below always serializes it: every terminal path — probe
  // refusal, fatal throw, aborted suite, normal completion — ships an
  // uploaded artifact. The 2026-10-22 CI runs (both legs) exited 1 with no
  // .e2e-results at all, taking the only per-attempt diagnostics with them;
  // that class of evidence loss ends here.
  const reportDir = join(root, '.e2e-results');
  mkdirSync(reportDir, { recursive: true });
  pruneReports(reportDir);
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    agent: null,
    cases: [] as unknown[],
  };
  let tarball: string | null = null;
  let prefix: string | null = null;
  try {
    if (!driver) {
      report.fatalError = `unknown E2E_AGENT "${driverId}" (available: ${Object.keys(DRIVERS).join(', ')})`;
      out(`[runner] ${report.fatalError as string}`);
      process.exitCode = 2;
      return;
    }
    const probe = await driver.probe();
    report.agent = {
      id: driver.id,
      command: probe.command,
      model: process.env.E2E_MODEL || null,
      provider: process.env.E2E_PROVIDER_ID || null,
      devkitVersion: pkg.version,
      agentVersion: probe.version,
    };
    if (!probe.ok) {
      // Probe detail carries gateway response bodies — scrubbed like every
      // other runner surface, and the spelling stays grep-compatible with
      // the workflow's driver-echo guard.
      report.fatalError = scrubSecrets(probe.detail);
      out(`[runner] driver ${driver.id} not ready: ${report.fatalError as string}`);
      process.exitCode = 2;
      return;
    }
    // Startup echo of the resolved driver (and version) — the matrix CI legs
    // grep this (load-bearing, not informational) so a wiring miss cannot
    // pass as a green duplicate of the other leg.
    out(`[runner] driver ${driver.id}${probe.version ? ` (${probe.version})` : ''}: ${scrubSecrets(probe.detail)}`);
    sweepStaleTempDirs();

    const selected = args.length > 0 ? ALL_CASES.filter((c) => args.includes(c.id)) : ALL_CASES;
    if (selected.length === 0) {
      report.fatalError = `no case matches ${args.join(', ')} (available: ${ALL_CASES.map((c) => c.id).join(', ')})`;
      out(`[runner] ${report.fatalError as string}`);
      process.exitCode = 2;
      return;
    }

    tarball = npmPackTarball();
    prefix = installPrefix(tarball);
    const bin = join(prefix, 'node_modules', 'huaweicloud-devkit', 'bin', 'setup.cjs');
    let failures = 0;
    let skips = 0;
    let runnerErrors = 0;
    let consecutiveRunnerErrors = 0;
    let consecutiveDeadAgents = 0;
    let aborted = false;
    for (const caseDef of selected) {
      out(`[runner] case ${caseDef.id} (pack ${caseDef.pack})`);
      let outcome: Awaited<ReturnType<typeof runCase>>;
      try {
        outcome = await runCase(caseDef, driver, bin, pkg.kooCliVersion);
      } catch (error) {
        // The belt over runCase's own per-attempt catch: a throw outside the
        // attempt loop (temp dirs, fake startup) still becomes a case entry
        // with the stack, never a suite-killing unhandled rejection.
        const stack = scrubbedStack(error);
        const verdict = runnerErrorVerdict(caseDef.id, stack);
        outcome = {
          verdict,
          recordings: emptyRecordings(),
          report: {
            attempts: [
              {
                attempt: 1,
                exitCode: null,
                hcloudCalls: [],
                installHcloudCalls: [],
                httpCalls: [],
                gatewayCalls: [],
                wsCalls: [],
                stdout: stack.slice(0, 8000),
                stderr: '',
                verdict,
              },
            ],
          },
        };
      }
      (report.cases as unknown[]).push({ id: caseDef.id, ...outcome.report, verdict: outcome.verdict });
      if (outcome.report.skipped) {
        skips++;
        out(`  SKIP  ${caseDef.id} — ${outcome.report.skipped.reason}`);
        continue;
      }
      if (outcome.verdict.pass) {
        consecutiveRunnerErrors = 0;
        consecutiveDeadAgents = 0;
        out(`  PASS  ${caseDef.id}`);
        continue;
      }
      failures++;
      if (outcome.verdict.runnerError) {
        runnerErrors++;
        consecutiveRunnerErrors++;
        out(`  FAIL  ${caseDef.id} — runner error: ${outcome.verdict.runnerError}`);
        if (consecutiveRunnerErrors >= 3) {
          // Three harness crashes in a row is systematic, not flaky: stop
          // burning budget (each red case still paid install + LLM turns)
          // and leave the stacks in the report as the diagnostic.
          report.fatalError = `aborted after ${consecutiveRunnerErrors} consecutive runner-error cases (last: ${caseDef.id})`;
          out(`[runner] ${report.fatalError as string}`);
          process.exitCode = 2;
          aborted = true;
          break;
        }
        continue;
      }
      consecutiveRunnerErrors = 0;
      // Mode-aware liveness text: boundary cases died with no boundary
      // activity; disclosure cases (whose expected outcome IS zero
      // boundary activity) died short of the handshake or the model turn
      // (non-zero exit) — the same suffix for both would send triage to
      // the wrong channel.
      const livenessSuffix = outcome.verdict.liveness
        ? ''
        : caseDef.liveness === 'disclosure'
          ? ' (liveness: no handshake disclosures or the agent exited non-zero)'
          : ' (liveness: no boundary activity recorded)';
      out(`  FAIL  ${caseDef.id}${livenessSuffix}`);
      for (const v of outcome.verdict.expectations) {
        // The console evidence rides the CI job log (the workflow tees
        // runner stdout), so it scrubs like the report artifact.
        if (!v.pass) out(`    expectation failed: ${JSON.stringify(v.expectation)} — ${scrubSecrets(v.evidence)}`);
      }
      if (!outcome.verdict.liveness) {
        consecutiveDeadAgents++;
        // A dead-agent streak with a live start probe means the gateway (or
        // the key's quota) died mid-suite: re-probe once at three, and abort
        // as infra when the wire is dead instead of burning the remaining
        // cases on guaranteed red.
        if (consecutiveDeadAgents === 3) {
          const wire = await verifyLegWire(driver.modelWire);
          if (!wire.ok) {
            report.fatalError = `model wire died mid-suite after case ${caseDef.id}: ${scrubSecrets(wire.detail)}`;
            out(`[runner] ${report.fatalError as string}`);
            process.exitCode = 2;
            aborted = true;
            break;
          }
        }
      } else {
        consecutiveDeadAgents = 0;
      }
    }
    if (!aborted) {
      // Pure infra red (every failure a runner error) exits 2, the runner's
      // infra class — distinguishable from product red without reading the
      // report body.
      process.exitCode = failures > 0 ? (runnerErrors === failures ? 2 : 1) : 0;
      out(
        `[runner] ${selected.length - failures - skips}/${selected.length} cases passed` +
          `${skips > 0 ? `, ${skips} skipped` : ''}${failures > 0 ? `, ${failures} failed` : ''}`,
      );
    }
  } catch (error) {
    report.fatalError = scrubSecrets(String((error as Error)?.stack ?? error)).slice(0, 4000);
    out(`[runner] fatal: ${String((error as Error)?.message ?? error)}`);
    process.exitCode = 1;
  } finally {
    if (prefix) {
      try {
        rmSync(prefix, { recursive: true, force: true });
      } catch {
        // best-effort cleanup on the crash path
      }
    }
    if (tarball) {
      try {
        rmSync(tarball, { force: true });
      } catch {
        // best-effort cleanup on the crash path
      }
    }
    const reportPath = join(reportDir, `report-${Date.now()}.json`);
    // The whole serialized report passes the scrub: per-attempt transcripts,
    // hcloud argv, and the evaluator's expectation evidence (which embeds
    // raw argv and tool args) all land in this uploaded CI artifact.
    try {
      writeFileSync(reportPath, scrubSecrets(JSON.stringify(report, null, 2)), 'utf8');
      out(`[runner] Report: ${reportPath}`);
    } catch (error) {
      out(`[runner] report write failed: ${String(error)}`);
      // A green run that shipped no artifact is misleading (the report is
      // the suite's evidence): only an already-set infra exit code (2)
      // survives a lost report.
      process.exitCode = process.exitCode === 2 ? 2 : 1;
    }
  }
}

void main();
