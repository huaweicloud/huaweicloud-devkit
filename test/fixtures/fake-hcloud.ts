#!/usr/bin/env node
// Fake hcloud for E2E. Records EVERY invocation's argv to HCLOUD_FAKE_LOG
// (one JSON array per line — the assertion surface). Answers from
// HCLOUD_FAKE_SCRIPT (JSON: { responses: [{ argv, stdout, stderr, exitCode }],
// default? }, first element-wise-prefix hit wins) and otherwise falls back to
// the three hardcoded responses the auth/reconcile tests pin. A present but
// unparsable script fails loud (exit 2): that is a test-infra bug, not a
// case outcome. ESM.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const log = process.env.HCLOUD_FAKE_LOG || '/tmp/hcloud-fake.log';
const argv: string[] = process.argv.slice(2);

function record(args: string[]): void {
  const dir = dirname(resolve(log));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(log, JSON.stringify(args) + '\n');
}

record(argv);

interface FakeResponse {
  argv?: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

interface FakeScript {
  responses?: FakeResponse[];
  default?: FakeResponse;
}

function loadScript(): FakeScript | null {
  const scriptPath = process.env.HCLOUD_FAKE_SCRIPT;
  if (!scriptPath) return null;
  if (!existsSync(scriptPath)) {
    process.stderr.write(`HCLOUD_FAKE_SCRIPT not found: ${scriptPath}\n`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(scriptPath, 'utf8')) as FakeScript;
  } catch (error) {
    process.stderr.write(`HCLOUD_FAKE_SCRIPT is not valid JSON: ${String(error)}\n`);
    process.exit(2);
  }
}

function prefixHit(prefix: string[] | undefined, candidate: string[]): boolean {
  return (
    Array.isArray(prefix) && prefix.length <= candidate.length && prefix.every((value, i) => value === candidate[i])
  );
}

const script = loadScript();
if (script && Array.isArray(script.responses)) {
  const hit = script.responses.find((r) => prefixHit(r.argv, argv));
  const chosen: FakeResponse | undefined = hit || script.default;
  if (chosen) {
    if (chosen.stderr) process.stderr.write(chosen.stderr);
    if (chosen.stdout) process.stdout.write(chosen.stdout);
    process.exit(typeof chosen.exitCode === 'number' ? chosen.exitCode : 0);
  }
}

if (argv[0] === 'version') {
  process.stdout.write(`KooCLI Fake ${process.env.HCLOUD_FAKE_VERSION || '7.2.12'}\n`);
  process.exit(0);
}
if (argv[0] === 'IAM' && argv[1] === 'KeystoneListProjects') {
  process.stdout.write(`${JSON.stringify({ projects: [{ id: 'proj-e2e-001', name: 'cn-north-4' }] })}\n`);
  process.exit(0);
}
process.exit(0);
