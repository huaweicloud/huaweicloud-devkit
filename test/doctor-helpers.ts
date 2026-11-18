// The shared doctor-run harness, extracted from doctor-skills-tree.test.ts:
// the hermetic fake-HOME env, the doctor/install runners, and the payload
// tree writer. Both doctor test files import it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { PACKS } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import { npmCacheEnv } from './npm-cache.ts';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const setupCli = join(root, 'bin', 'setup.cjs');
export const distSetup = join(root, 'plugins', 'huaweicloud-core', 'dist', 'setup-cli.js');
export const realTree = join(root, 'plugins', 'huaweicloud-core', 'skills');

export const allSkills = [...new Set(PACKS.flatMap((pack) => pack.skills))];

// Doctor needs the built CLI and the generated tree (its roster of record is
// the shipped manifest); one guided precondition instead of raw failures.
assert.ok(existsSync(distSetup) && existsSync(realTree), 'dist/ and skills/ missing — run: npm run build');

// A minimal fake-HOME env for doctor. Payload candidates resolve through
// os.homedir(), which reads USERPROFILE on Windows and HOME on POSIX — both
// must be redirected or the negative tests pass vacuously on Windows (the
// payload lands where doctor never looks). HERMES_HOME is the
// highest-priority override for the hermes payload dir and must be cleared
// or an ambient value leaks a real install into the candidates.
export function doctorEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    // keep OfficeAce detection hermetic in automated environments (#654)
    HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT: '1',
    ...npmCacheEnv(),
    ...extra,
  };
  delete env.ATOMCODE_HOME;
  delete env.HUAWEICLOUD_HOME;
  delete env.OFFICE_CLAW_CONFIG_ROOT;
  delete env.HERMES_HOME;
  // XDG_CONFIG_HOME redirects the opencode config root (xdgConfigHome);
  // CODEX_HOME keys the uninstaller's codex cache cleanup. Ambient values
  // would leak doctor's fresh-install probes into real state (a test that
  // needs XDG_CONFIG_HOME set uses the DSH_HOME guard pattern). XDG_DATA_HOME
  // and OPENCODE_DB are the same hazard for the opencode saved-permission
  // store: they would let doctor read the machine's live store (and its
  // "always allow" rows) under a fake HOME.
  if (!('XDG_CONFIG_HOME' in extra)) delete env.XDG_CONFIG_HOME;
  if (!('XDG_DATA_HOME' in extra)) delete env.XDG_DATA_HOME;
  delete env.CODEX_HOME;
  delete env.OPENCODE_DB;
  if (!('DSH_HOME' in extra)) delete env.DSH_HOME;
  return env;
}

// The doctor-run tail every spawner shares: the status contract (exit 1 is
// the healthy "some check failed" path — exit 0 means every check passed)
// and the plain-text strip. One home for both, so a staged-bin runner and
// the helpers below cannot drift.
export function doctorRunText(run: { status: number | null; stdout: string | null; stderr?: string | null }): string {
  assert.ok(run.status === 0 || run.status === 1, `doctor crashed: ${run.stderr}`);
  // Strip ANSI so [PASS]/[FAIL] assertions see the plain markers (check()
  // wraps them in color escapes). The escape is built from fromCharCode —
  // same idiom as dep-provision's stripAnsi — because eslint's
  // no-control-regex (rightly) flags control characters in regex literals.
  return (run.stdout ?? '').replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

// Doctor with the exit code exposed: a FAIL-shaped config exits 1 (the
// cmdDoctor contract), so the posture's FAIL directions can pin it.
export function runDoctorStatus(home: string, extra: Record<string, string> = {}): { stdout: string; status: number } {
  const run = spawnSync(process.execPath, [setupCli, 'doctor'], {
    encoding: 'utf8',
    env: doctorEnv(home, extra),
    timeout: 60_000,
  });
  return { stdout: doctorRunText(run), status: run.status ?? 1 };
}

export function runDoctor(home: string, extra: Record<string, string> = {}): string {
  return runDoctorStatus(home, extra).stdout;
}

// A real install into the fake home, so the native freshness checks see an
// installed payload with receipt-managed native copies. Returns the plain
// (ANSI-stripped) stdout for assertions on installer WARN lines.
export function runInstall(home: string, extra: Record<string, string> = {}): string {
  const run = spawnSync(process.execPath, [setupCli, 'install', '--target', 'opencode'], {
    encoding: 'utf8',
    env: doctorEnv(home, extra),
    // Install-bearing: cold fake-HOME undici fetch needs the 240s class.
    timeout: 240_000,
  });
  assert.ok(run.status === 0, `install failed: ${run.stderr}\n${run.stdout}`);
  return (run.stdout ?? '').replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

// A real uninstall from the fake home (the posture's removal half).
export function runUninstall(home: string, extra: Record<string, string> = {}): string {
  const run = spawnSync(process.execPath, [setupCli, 'uninstall', '--target', 'opencode'], {
    encoding: 'utf8',
    env: doctorEnv(home, extra),
    timeout: 120_000,
  });
  assert.ok(run.status === 0, `uninstall failed: ${run.stderr}\n${run.stdout}`);
  return (run.stdout ?? '').replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

// An installed payload's skills/ dir, as copyServerPayload would have laid
// it out: one directory per skill, each with a SKILL.md.
export function writePayloadTree(payloadSkills: string, names: string[]): void {
  for (const name of names) {
    mkdirSync(join(payloadSkills, name), { recursive: true });
    writeFileSync(join(payloadSkills, name, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8');
  }
}
