import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildCaseEnv } from './env-policy.ts';
import {
  evaluateCase,
  type CaseVerdict,
  type GatewayRecording,
  type Recordings,
  type TraceDisclosure,
  type TraceToolCall,
} from './evaluate.ts';
import { HttpFake } from './http-fake.ts';
import { WsFake } from './ws-fake/hwlink-server.ts';
import type { E2eCase, Expectation } from './types.ts';
import { opencodeDriver } from './drivers/opencode.ts';
import type { AgentDriver } from './drivers/types.ts';
import { cliCases } from './cases/cli.ts';
import { coreCases } from './cases/core.ts';
import { authCases, sandboxCases, voucherCases, wsSandboxCases } from './cases/http-packs.ts';
import { openMcpCases } from './cases/open-mcp.ts';
import { discoveryCases, obsCases } from './cases/local-packs.ts';
import { updateCases } from './cases/update.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fakeHcloud = fileURLToPath(new URL('../fixtures/fake-hcloud.ts', import.meta.url));
const fakeOpenMcp = fileURLToPath(new URL('../fixtures/fake-open-mcp-sidecar.mjs', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const TEMP_PREFIX = 'hwc-e2e-';
const DRIVERS: Record<string, AgentDriver> = { opencode: opencodeDriver };
const ALL_CASES: E2eCase[] = [
  ...cliCases,
  ...coreCases,
  ...authCases,
  ...voucherCases,
  ...sandboxCases,
  ...wsSandboxCases,
  ...openMcpCases,
  ...obsCases,
  ...discoveryCases,
  ...updateCases,
];

function packageJson(): { version: string; kooCliVersion: string } {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; kooCliVersion: string };
}

function out(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

// Local, gitignored model config (test/e2e/.env): KEY=VALUE lines, no
// interpolation. Loaded only for vars not already in the environment, so an
// explicit env or CI secret always wins over the file. Values never appear
// in runner output or the report — only var names in probe errors.
function loadDotEnv(): void {
  const dotenv = join(root, 'test', 'e2e', '.env');
  if (!existsSync(dotenv)) return;
  for (const line of readFileSync(dotenv, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// Signal death (SIGKILL and friends) skips every exit handler, so a crashed
// nightly can leak throwaway homes. The next run sweeps them: same prefix,
// older than a day — self-healing instead of accumulating.
interface AttemptReport {
  attempt: number;
  exitCode: number | null;
  hcloudCalls: string[];
  httpCalls: string[];
  gatewayCalls: string[];
  wsCalls: string[];
  stdout: string;
  stderr: string;
  verdict: CaseVerdict;
}

interface CaseRunReport {
  attempts: AttemptReport[];
  skipped?: { reason: string };
}

function sweepStaleTempDirs(): void {
  const dir = tmpdir();
  const dayMs = 24 * 60 * 60 * 1000;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(TEMP_PREFIX)) continue;
    const full = join(dir, entry);
    try {
      if (Date.now() - statSync(full).mtimeMs > dayMs) rmSync(full, { recursive: true, force: true });
    } catch {
      // best-effort sweep
    }
  }
}

function npmPackTarball(): string {
  out('[runner] npm pack (staging swap — do not run pack:verify concurrently)');
  const packed = JSON.parse(execFileSync(npm, ['pack', '--json'], { encoding: 'utf8', cwd: root })) as {
    filename: string;
  }[];
  return join(root, packed[0]!.filename);
}

function installPrefix(tarball: string): string {
  const prefix = mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}prefix-`));
  execFileSync(npm, ['install', '--no-audit', '--no-fund', tarball], { cwd: prefix, stdio: 'ignore' });
  return prefix;
}

function seamVars(
  home: string,
  scriptPath: string | null,
  kooCliVersion: string,
  httpFake: HttpFake,
  fixtures: E2eCase['fixtures'],
  pathShimDir: string,
): NodeJS.ProcessEnv {
  const vars: NodeJS.ProcessEnv = {
    HCLOUD_BIN: process.execPath,
    HCLOUD_BIN_ARGS_JSON: JSON.stringify([fakeHcloud]),
    HCLOUD_FAKE_LOG: join(home, 'hcloud-fake.log'),
    HCLOUD_FAKE_VERSION: kooCliVersion,
    HUAWEICLOUD_DEVKIT_TRACE: join(home, 'devkit-trace.jsonl'),
    // The whole Huawei Cloud HTTP boundary points at the local fake — every
    // case, scripted or not, so no request can ever leave the machine.
    // Unknown paths answer 404 (fast, deterministic) instead of hanging.
    HDKITSERVICE_ENDPOINT: httpFake.hdkitserviceBaseUrl,
    HW_IAM_ENDPOINT: httpFake.baseUrl,
    HWLINK_ENDPOINT: httpFake.baseUrl,
    // The gateway sidecar: the repo's fake fixture, spawned lazily by the
    // first gateway tool call, recording every JSON-RPC request.
    OPENMCP_BIN: fakeOpenMcp,
    OPENMCP_FAKE_LOG: join(home, 'openmcp-fake.log'),
    // PATH hardening: shim dir first, so a Bash-layer `hcloud` resolves to
    // the fake, never the host's real binary (see installPathShim).
    PATH: [pathShimDir, process.env.PATH ?? ''].join(process.platform === 'win32' ? ';' : ':'),
  };
  if (fixtures.openMcp?.policyTools) vars.FAKE_POLICY = '1';
  if (scriptPath) vars.HCLOUD_FAKE_SCRIPT = scriptPath;
  return vars;
}

// PATH-level hardening: the host may have a real hcloud on PATH
// (~/.local/bin/hcloud). The MCP layer reaches the fake via HCLOUD_BIN,
// but a Bash-layer `hcloud ...` would PATH-resolve to the REAL binary and
// touch the real cloud. The wrapper makes every PATH lookup land on the
// fake instead — same recording log, same scripted answers — so the suite
// stays hermetic even if the agent's shell permission posture changes.
function installPathShim(home: string): string {
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  // exec node <fake> "$@": keeps the fake's argv.slice(2) recording shape
  // identical to the MCP-driven invocations.
  writeFileSync(join(binDir, 'hcloud'), `#!/bin/sh\nexec "${process.execPath}" "${fakeHcloud}" "$@"\n`, {
    mode: 0o755,
    encoding: 'utf8',
  });
  // The win32 sibling, always written: cmd.exe resolves bare `hcloud` via
  // PATHEXT to hcloud.cmd — without it the PATH entry is a dead file on
  // win32 and lookups fall through to the host's real binary. On POSIX the
  // .cmd file is inert (nothing resolves it).
  writeFileSync(join(binDir, 'hcloud.cmd'), `@"${process.execPath}" "${fakeHcloud}" %*\r\n`, { encoding: 'utf8' });
  return binDir;
}

function readGatewayLog(home: string): GatewayRecording[] {
  const logPath = join(home, 'openmcp-fake.log');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        const record = JSON.parse(line) as { method?: string; tool?: string | null; args?: unknown };
        return { method: String(record.method ?? ''), tool: record.tool ?? null, args: record.args ?? {} };
      } catch {
        return { method: '(unparseable)', tool: null, args: {} };
      }
    });
}

function seedHome(home: string, fixtures: E2eCase['fixtures']): void {
  for (const [relPath, content] of Object.entries(fixtures.home ?? {})) {
    const target = join(home, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

function seedWorkdir(workdir: string, fixtures: E2eCase['fixtures']): void {
  for (const [relPath, content] of Object.entries(fixtures.workdir ?? {})) {
    const target = join(workdir, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

// {workdir} → absolute path: the one interpolation token, because the agent
// must receive the path only the runner can know. No other templating —
// prompts stay literal data.
function renderPrompt(prompt: string, workdir: string): string {
  return prompt.replaceAll('{workdir}', workdir);
}

function collectFiles(caseDef: E2eCase, home: string): Record<string, string | null> {
  const paths = new Set<string>();
  const scan = (exps: Expectation[] | undefined) => {
    for (const exp of exps ?? []) {
      if (exp.kind === 'file') paths.add(exp.path);
    }
  };
  scan(caseDef.expect);
  scan(caseDef.softExpect);
  const files: Record<string, string | null> = {};
  for (const relPath of paths) {
    const full = join(home, relPath);
    try {
      files[relPath] = readFileSync(full, 'utf8');
    } catch {
      files[relPath] = null;
    }
  }
  return files;
}

function readTrace(home: string): { toolCalls: TraceToolCall[]; disclosures: TraceDisclosure[] } {
  const tracePath = join(home, 'devkit-trace.jsonl');
  if (!existsSync(tracePath)) return { toolCalls: [], disclosures: [] };
  const toolCalls: TraceToolCall[] = [];
  const disclosures: TraceDisclosure[] = [];
  for (const line of readFileSync(tracePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { type?: string };
      if (record.type === 'toolCall') {
        const call = record as unknown as TraceToolCall;
        toolCalls.push({ name: call.name, args: call.args, ok: call.ok });
      } else if (record.type === 'disclosure') {
        const event = record as unknown as TraceDisclosure;
        disclosures.push({ event: event.event, toolCount: event.toolCount });
      }
    } catch {
      // malformed trace lines are a product bug the count assertions surface
    }
  }
  return { toolCalls, disclosures };
}

function runInstall(bin: string, home: string, workdir: string, env: NodeJS.ProcessEnv, installPacks?: string): void {
  const args = ['install', '--target', 'opencode'];
  if (installPacks) args.push('--packs', installPacks);
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd: workdir,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (res.status !== 0) {
    throw new Error(`install failed (exit ${res.status}): ${String(res.stderr || res.stdout).slice(0, 400)}`);
  }
}

function readHcloudLog(home: string): { argv: string[] }[] {
  const logPath = join(home, 'hcloud-fake.log');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return { argv: JSON.parse(line) as string[] };
      } catch {
        return { argv: [line] };
      }
    });
}

async function runCase(
  caseDef: E2eCase,
  driver: AgentDriver,
  bin: string,
  kooCliVersion: string,
): Promise<{ verdict: CaseVerdict; recordings: Recordings; report: CaseRunReport }> {
  const attempts: AttemptReport[] = [];
  let lastVerdict: CaseVerdict | null = null;
  let lastRecordings: Recordings = {
    hcloud: [],
    toolCalls: [],
    disclosures: [],
    http: [],
    gateway: [],
    ws: [],
    files: {},
    finalText: null,
  };
  const maxAttempts = Math.max(1, caseDef.budget.attempts);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (caseDef.unsupportedPlatforms?.some((p) => p.platform === process.platform)) {
      const skip = caseDef.unsupportedPlatforms.find((p) => p.platform === process.platform)!;
      return {
        verdict: {
          caseId: caseDef.id,
          pass: true,
          liveness: true,
          expectations: [],
          soft: [],
        },
        recordings: lastRecordings,
        report: { attempts: [], skipped: { reason: skip.reason } } satisfies CaseRunReport,
      };
    }
    const home = mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}home-`));
    const workdir = mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}work-`));
    const wsFake = caseDef.fixtures.ws ? new WsFake() : null;
    let httpFake: HttpFake | null = null;
    try {
      // Ws fake first: its ephemeral port resolves the literal {wsUrl}
      // token inside the http script (the hwlink GET-poll returns it as
      // connection_info.url) before the http fake is constructed —
      // JSON round-trip so the token resolves wherever it appears
      // (renderPrompt precedent: one token, no templating language).
      await wsFake?.start();
      const httpScript =
        wsFake && caseDef.fixtures.http
          ? (JSON.parse(JSON.stringify(caseDef.fixtures.http).replaceAll('{wsUrl}', wsFake.wsUrl)) as NonNullable<
              E2eCase['fixtures']['http']
            >)
          : (caseDef.fixtures.http ?? { responses: [] });
      httpFake = new HttpFake(httpScript);
      await httpFake.start();
      seedHome(home, caseDef.fixtures);
      seedWorkdir(workdir, caseDef.fixtures);
      const pathShimDir = installPathShim(home);
      const scriptPath = caseDef.fixtures.hcloud ? join(home, 'hcloud-script.json') : null;
      if (scriptPath) writeFileSync(scriptPath, JSON.stringify(caseDef.fixtures.hcloud), 'utf8');
      // Install first — driver.prepare() merges the model/provider config
      // into the config file the installer just wrote, so it must run after.
      const installEnv = buildCaseEnv({
        processEnv: process.env,
        home,
        seamVars: seamVars(home, scriptPath, kooCliVersion, httpFake, caseDef.fixtures, pathShimDir),
      });
      runInstall(bin, home, workdir, installEnv, caseDef.installPacks);
      const env = buildCaseEnv({
        processEnv: process.env,
        home,
        driverVars: driver.prepare({ home, workdir, platform: process.platform }),
        seamVars: seamVars(home, scriptPath, kooCliVersion, httpFake, caseDef.fixtures, pathShimDir),
        caseEnv: caseDef.env,
        relaxFixed: caseDef.fixtures.updateCheck ? ['HUAWEICLOUD_DEVKIT_SKIP_UPDATE'] : undefined,
      });
      if (caseDef.fixtures.updateCheck) {
        // Run-env only (never the install env): the product's registry seam.
        // npm itself never reads this var — only the devkit does — so the
        // agent's own npm usage (if any) is unaffected.
        env.HUAWEICLOUD_NPM_REGISTRY = httpFake.baseUrl;
      }

      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), caseDef.budget.timeoutMs);
      let run;
      try {
        run = await driver.runPrompt({
          prompt: renderPrompt(caseDef.prompt, workdir),
          cwd: workdir,
          env,
          timeoutMs: caseDef.budget.timeoutMs,
          signal: abort.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const recordings: Recordings = {
        hcloud: readHcloudLog(home),
        ...readTrace(home),
        http: [...httpFake.recordings],
        gateway: readGatewayLog(home),
        ws: wsFake
          ? wsFake.connections.map((conn) => ({
              ...conn,
              commands: conn.commands.map((cmd) => ({ ...cmd })),
            }))
          : [],
        files: collectFiles(caseDef, home),
        finalText: run.finalText,
      };
      const verdict = evaluateCase(caseDef, recordings);
      lastVerdict = verdict;
      lastRecordings = recordings;
      attempts.push({
        attempt,
        exitCode: run.exitCode,
        hcloudCalls: recordings.hcloud.map((c) => c.argv.join(' ')),
        httpCalls: recordings.http.map((h) => `${h.method} ${h.path}`),
        gatewayCalls: recordings.gateway.map((g) => `${g.method}${g.tool ? `:${g.tool}` : ''}`),
        wsCalls: recordings.ws.map(
          (conn) =>
            `conn(source=${conn.source ?? 'n/a'}): ${conn.commands.map((c) => c.intent).join(',') || '(no commands)'}`,
        ),
        stdout: run.stdout.slice(0, 8000),
        stderr: run.stderr.slice(0, 4000),
        verdict,
      });
      if (verdict.pass) break;
    } finally {
      await httpFake?.stop();
      await wsFake?.stop();
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  }

  return {
    verdict: lastVerdict!,
    recordings: lastRecordings,
    report: { attempts } satisfies CaseRunReport,
  };
}

// Full-chain plumbing proof without the LLM: tarball → install → MCP server
// → callTool → hcloud shim → recording. Drives the installed server over the
// dual-framing stdio transport with initialize + tools/list + check_cli +
// plan_cli_command, then asserts the fake recorded the version probe.
async function selfcheck(bin: string, kooCliVersion: string): Promise<boolean> {
  const home = mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}selfcheck-`));
  const wsFake = new WsFake();
  try {
    // Ws fake first: its ephemeral port resolves {wsUrl} in the hwlink
    // GET-poll script (connection_info.url), same token flow as a case.
    await wsFake.start();
    const hwlinkScript = JSON.stringify({
      responses: [
        {
          path: '/voucher/status',
          method: 'GET',
          status: 200,
          body: { claimed: true, voucherId: 'vou-selfcheck-001' },
        },
        { path: '/check-user', method: 'GET', status: 200, body: { realnameVerified: true, agreementSigned: true } },
        {
          path: '/connect',
          method: 'POST',
          status: 200,
          body: { session_id: 'sess-sc-001', dev_stage_id: 'ds-selfcheck-001' },
        },
        {
          path: '/open-api-public/v1/devenvs/ds-selfcheck-001/connections',
          method: 'POST',
          status: 200,
          body: { error_code: '0000', result: { connection_id: 'conn-sc-1' } },
        },
        {
          path: '/open-api-public/v1/devenvs/ds-selfcheck-001/connections/conn-sc-1',
          method: 'GET',
          status: 200,
          body: { result: { connection_info: { url: '{wsUrl}', extensions: { source: 424242 } } } },
        },
      ],
    }).replaceAll('{wsUrl}', wsFake.wsUrl);
    const httpFake = new HttpFake(JSON.parse(hwlinkScript));
    try {
      await httpFake.start();
      // S1 vault seed: voucher_status reads credentials via hdkitRequest,
      // which throws without them — the same precondition the live case has.
      mkdirSync(join(home, '.config', 'huaweicloud'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'huaweicloud', 'credentials.json'),
        JSON.stringify({ ak: 'SELFCHECK_AK', sk: 'SELFCHECK_SK', securityToken: '', region: 'cn-north-4' }, null, 2),
        'utf8',
      );
      const env = buildCaseEnv({
        processEnv: process.env,
        home,
        seamVars: seamVars(home, null, kooCliVersion, httpFake, {}, installPathShim(home)),
      });
      runInstall(bin, home, home, env);
      const server = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js');
      if (!existsSync(server)) {
        out(`[selfcheck] FAIL installed server missing: ${server}`);
        return false;
      }
      const requests = [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'e2e-selfcheck', version: '0' },
          },
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'huaweicloud_check_cli', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'huaweicloud_plan_cli_command',
            arguments: { args: ['VPC', 'ListSecurityGroups', '--cli-region=cn-north-4'] },
          },
        },
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'huaweicloud_voucher_status', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'huaweicloud_sandbox_connect', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'huaweicloud_list_skills', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: 8,
          method: 'tools/call',
          params: {
            name: 'huaweicloud_sandbox_exec_one_shot',
            // >8172-byte command: the client chunks terminal input at 8172
            // bytes, so this leg proves the fake's per-connection byte-stream
            // reassembly (a line-oriented fake fails here).
            arguments: { workspace_id: 'ds-selfcheck-001', command: `echo ${'A'.repeat(100_000)}` },
          },
        },
      ];
      // Drive the server like a real client: keep stdin OPEN until the last
      // (slow, HTTP-bound) response arrives, then close. spawnSync would end
      // stdin with the input, and the transport's stdin-close semantics
      // process.exit(0) before the voucher HTTP roundtrip completes.
      const res = await new Promise<{ stdout: string; stderr: string }>((resolveRun) => {
        const child = spawn(process.execPath, [server], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let closed = false;
        const timer = setTimeout(() => {
          if (!closed) child.stdin.end();
        }, 55_000);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          // The last request's response is on the wire — close like a client.
          // The slow exec rides LAST on purpose: when its response arrives,
          // every faster request before it has already answered, so closing
          // here cannot kill an in-flight response.
          if (!closed && stdout.includes('"id":8')) {
            closed = true;
            clearTimeout(timer);
            child.stdin.end();
          }
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('close', () => {
          clearTimeout(timer);
          resolveRun({ stdout, stderr });
        });
        child.on('error', (error) => {
          stderr += String(error);
          resolveRun({ stdout, stderr });
        });
        for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
      });
      const responses = new Map<number, unknown>();
      for (const line of String(res.stdout).split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const parsed = JSON.parse(line) as { id?: number };
          if (typeof parsed.id === 'number') responses.set(parsed.id, parsed);
        } catch {
          // framing noise
        }
      }
      const toolPayload = (id: number): Record<string, unknown> | null => {
        const resp = responses.get(id) as { result?: { content?: { type: string; text?: string }[] } } | undefined;
        const text = resp?.result?.content?.find((c) => c.type === 'text')?.text;
        if (!text) return null;
        try {
          return JSON.parse(text) as Record<string, unknown>;
        } catch {
          return null;
        }
      };
      let ok = true;
      const listResponse = responses.get(2) as { result?: { tools?: { name?: unknown }[] } } | undefined;
      const toolCount = listResponse?.result?.tools?.length ?? 0;
      if (toolCount < 40) {
        out(`[selfcheck] FAIL tools/list returned only ${toolCount} tools`);
        ok = false;
      } else {
        out(`[selfcheck] tools/list: ${toolCount} tools`);
      }
      const check = toolPayload(3);
      if (!check || check.installed !== true) {
        out(
          `[selfcheck] FAIL check_cli did not report the fake hcloud as installed: ${JSON.stringify(check).slice(0, 200)}`,
        );
        ok = false;
      } else {
        out(`[selfcheck] check_cli sees the fake hcloud (version ${String(check.installedVersion)})`);
      }
      const plan = toolPayload(4);
      if (!plan || !('approvalToken' in plan)) {
        out(`[selfcheck] FAIL plan_cli_command returned no approvalToken: ${JSON.stringify(plan).slice(0, 200)}`);
        ok = false;
      } else {
        out('[selfcheck] plan_cli_command minted an approval token');
      }
      const calls = readHcloudLog(home).map((c) => c.argv.join(' '));
      if (!calls.some((c) => c === 'version')) {
        out(`[selfcheck] FAIL fake hcloud log has no version probe: ${calls.join(' | ') || '(empty)'}`);
        ok = false;
      } else {
        out(`[selfcheck] fake hcloud recorded: ${calls.join(' | ')}`);
      }
      const trace = readTrace(home);
      const tracedNames = trace.toolCalls.map((c) => `${c.name}(ok=${c.ok})`);
      if (!trace.toolCalls.some((c) => c.name === 'huaweicloud_check_cli' && c.ok)) {
        out(`[selfcheck] FAIL trace has no successful check_cli toolCall: ${tracedNames.join(' | ') || '(none)'}`);
        ok = false;
      } else {
        out(`[selfcheck] trace toolCalls: ${tracedNames.join(' | ')}`);
      }
      const toolsListEvents = trace.disclosures.filter((d) => d.event === 'toolsList');
      if (toolsListEvents.length === 0 || toolsListEvents[0]?.toolCount !== toolCount) {
        out(
          `[selfcheck] FAIL trace toolsList disclosure disagrees with the wire count: ${JSON.stringify(toolsListEvents)}`,
        );
        ok = false;
      } else {
        out(`[selfcheck] trace disclosure toolsList=${toolsListEvents[0]?.toolCount} (x${toolsListEvents.length})`);
      }
      // The HTTP fake leg: voucher_status over the seeded vault must answer
      // through the scripted local endpoint (the user-hash prewarm's 404 on
      // the same fake is expected boot noise, not a failure).
      const voucher = toolPayload(5);
      if (!voucher || voucher.claimed !== true) {
        out(`[selfcheck] FAIL voucher_status did not report claimed=true: ${JSON.stringify(voucher).slice(0, 200)}`);
        ok = false;
      } else {
        out('[selfcheck] voucher_status answered through the local HTTP fake');
      }
      const voucherHits = httpFake.recordings.filter((r) => r.method === 'GET' && r.path === '/voucher/status');
      if (voucherHits.length === 0) {
        out(
          `[selfcheck] FAIL HTTP fake has no GET /voucher/status recording: ${
            httpFake.recordings.map((r) => `${r.method} ${r.path}`).join(' | ') || '(empty)'
          }`,
        );
        ok = false;
      } else {
        out(`[selfcheck] HTTP fake recorded GET /voucher/status (x${voucherHits.length})`);
      }
      // The v2 tool × trace seam leg: list_skills through the live wire and
      // the callTool wrapper. No 28-case live run calls this tool, and the
      // unit suite only exercises it with tracing off — this is the one
      // gate that proves the newest core tool lands in the trace like every
      // other dispatch.
      const skills = toolPayload(7);
      if (!skills || skills.ok !== true || typeof skills.count !== 'number' || skills.count < 1) {
        out(`[selfcheck] FAIL list_skills returned no catalog: ${JSON.stringify(skills).slice(0, 200)}`);
        ok = false;
      } else if (typeof skills.skillRoot !== 'string') {
        out(
          `[selfcheck] FAIL list_skills withheld skillRoot on a stdio session: ${JSON.stringify(skills).slice(0, 200)}`,
        );
        ok = false;
      } else {
        out(`[selfcheck] list_skills returned ${skills.count} entries with skillRoot`);
      }
      if (!trace.toolCalls.some((c) => c.name === 'huaweicloud_list_skills' && c.ok)) {
        out(`[selfcheck] FAIL trace has no list_skills toolCall: ${tracedNames.join(' | ') || '(none)'}`);
        ok = false;
      } else {
        out('[selfcheck] list_skills traced through the callTool wrapper');
      }
      // The ws-exec leg: sandbox connect + a >8172-byte one-shot exec through
      // the PRODUCT's own client stack (session-manager → hwlink API → ws
      // multiplexer → fake) — subprotocol echo, nonce handshake, chunk
      // reassembly, and marker completion all in one LLM-less proof.
      const exec = toolPayload(8);
      const execStdout = typeof exec?.stdout === 'string' ? exec.stdout : '';
      if (!execStdout.includes('A'.repeat(1000))) {
        out(
          `[selfcheck] FAIL exec_one_shot did not return the reassembled echo output (got ${execStdout.length} chars): ${JSON.stringify(exec).slice(0, 200)}`,
        );
        ok = false;
      } else {
        out(`[selfcheck] exec_one_shot returned ${execStdout.length} chars of reassembled output`);
      }
      const wsCommands = wsFake.connections.flatMap((conn) => conn.commands.map((cmd) => cmd.intent));
      if (!wsCommands.includes('echo')) {
        out(`[selfcheck] FAIL ws fake recorded no echo intent: ${wsCommands.join(' | ') || '(none)'}`);
        ok = false;
      } else {
        out(`[selfcheck] ws fake recorded: ${wsCommands.join(' | ')}`);
      }
      if (wsCommands.includes('unknown')) {
        out(`[selfcheck] FAIL ws fake recorded unknown intents — script drift: ${wsCommands.join(' | ')}`);
        ok = false;
      }
      return ok;
    } finally {
      await httpFake.stop();
    }
  } finally {
    await wsFake.stop();
    rmSync(home, { recursive: true, force: true });
  }
}

// Report retention: every run writes one JSON; without a prune the local
// .e2e-results/ dir grows without bound (D1). Keep the newest 20.
const REPORT_RETENTION = 20;

function pruneReports(reportDir: string): void {
  const reports = readdirSync(reportDir)
    .filter((name) => name.startsWith('report-') && name.endsWith('.json'))
    .map((name) => ({ name, mtime: statSync(join(reportDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of reports.slice(REPORT_RETENTION)) {
    try {
      rmSync(join(reportDir, stale.name), { force: true });
    } catch {
      // best-effort: pruning must never fail a run
    }
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  if (process.env.E2E_ENABLE !== '1') {
    out('[runner] E2E_ENABLE is not 1 — skipping (set E2E_ENABLE=1 to run the agent-level E2E suite)');
    return;
  }
  const args = process.argv.slice(2);
  const driverId = process.env.E2E_AGENT || 'opencode';
  const driver = DRIVERS[driverId];
  if (!driver) {
    out(`[runner] unknown E2E_AGENT "${driverId}" (available: ${Object.keys(DRIVERS).join(', ')})`);
    process.exitCode = 2;
    return;
  }
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

  const probe = driver.probe();
  if (!probe.ok) {
    out(`[runner] driver "${driverId}" not ready: ${probe.detail}`);
    process.exitCode = 2;
    return;
  }
  sweepStaleTempDirs();

  const selected = args.length > 0 ? ALL_CASES.filter((c) => args.includes(c.id)) : ALL_CASES;
  if (selected.length === 0) {
    out(`[runner] no case matches ${args.join(', ')} (available: ${ALL_CASES.map((c) => c.id).join(', ')})`);
    process.exitCode = 2;
    return;
  }

  const tarball = npmPackTarball();
  const prefix = installPrefix(tarball);
  const bin = join(prefix, 'node_modules', 'huaweicloud-devkit', 'bin', 'setup.cjs');
  const reportDir = join(root, '.e2e-results');
  mkdirSync(reportDir, { recursive: true });
  pruneReports(reportDir);
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    agent: {
      id: driver.id,
      command: probe.command,
      model: process.env.E2E_MODEL || null,
      provider: process.env.E2E_PROVIDER_ID || null,
      devkitVersion: pkg.version,
    },
    cases: [] as unknown[],
  };
  let failures = 0;
  try {
    for (const caseDef of selected) {
      out(`[runner] case ${caseDef.id} (pack ${caseDef.pack})`);
      const { verdict, report: caseReport } = await runCase(caseDef, driver, bin, pkg.kooCliVersion);
      (report.cases as unknown[]).push({ id: caseDef.id, ...caseReport, verdict });
      if (verdict.pass) {
        out(`  PASS  ${caseDef.id}`);
      } else {
        failures++;
        out(`  FAIL  ${caseDef.id}${verdict.liveness ? '' : ' (liveness: no boundary activity recorded)'}`);
        for (const v of verdict.expectations) {
          if (!v.pass) out(`    expectation failed: ${JSON.stringify(v.expectation)} — ${v.evidence}`);
        }
      }
    }
  } finally {
    rmSync(prefix, { recursive: true, force: true });
    rmSync(tarball, { force: true });
  }
  const reportPath = join(reportDir, `report-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  out(`[runner] ${selected.length - failures}/${selected.length} cases passed. Report: ${reportPath}`);
  process.exitCode = failures > 0 ? 1 : 0;
}

void main();
