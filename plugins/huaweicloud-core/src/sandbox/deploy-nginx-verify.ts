// The #935 A1 deploy_nginx write-verification family, extracted from the
// former deploy-nginx module during the cx rebalance: the config-name basename
// sanitation, the DB_NGINX_* marker parser, and the deploy verdict — pure
// functions so the verdict is unit-testable. deploy-nginx.ts folds them into
// its deploy script; session-manager.ts re-exports them as the public face.

import { stripTerminalEscapes } from './sandbox-output.ts';

// A1 (#935): normalize configName to a bare filename — a path-shaped value
// (e.g. a local path echoed back by a caller) must never splice into a broken
// target like `/etc/nginx/conf.d//root/hc-activity.conf` (nginx never serves
// it, the tunnel answers 502). Only the basename is kept and the `.conf`
// suffix stripped before the path is rebuilt; a pure filename (no separators)
// keeps the previous behavior unchanged.
export function resolveNginxConfigPath(configName: string | undefined, project: string): string {
  const raw = String(configName || project || '');
  const base = raw.split(/[\\/]/).filter(Boolean).pop() || '';
  const name = base.replace(/\.conf$/i, '') || 'default';
  return `/etc/nginx/conf.d/${name}.conf`;
}

export interface ParsedDeployNginxVerify {
  configMissing: boolean;
  nginxTest: string;
  nginxTestOutput: string;
}

// A1 (#935): parse the write-verification block appended to the deploy_nginx
// script. The old flow returned ok:true whenever the deploy script exited 0,
// even when the tee write silently failed — the config file never existed and
// the tunnel answered 502. The verification block emits explicit markers:
//   DB_NGINX_CONFIG_OK=1      — the target config file exists (the inverted,
//                               presence-required success marker)
//   DB_NGINX_CONFIG_MISSING=1 — it does not (the failure marker)
//   DB_NGINX_T=PASS|FAIL      — nginx -t verdict, with failure output echoed
//                               as `DB_NGINX_T_OUTPUT: ...` lines
// EVERY marker is presence-required (interrogate round 2): the OK/MISSING
// pair is emitted as if/else by the script, and configMissing reads MISSING
// present OR OK absent — so a selectively mangled escape sequence swallowing
// any marker line can only read as the FAILURE direction, never as the
// pre-inversion false success (a swallowed MISSING used to read "verified").
// The markers are ANCHORED (^…$ on the trimmed lines), so OSC-integration
// shells that wrap every line in \x1b]133;C\x07 cannot blind the parse
// either (port-v2defects; the #946 single-seam doctrine: stripTerminalEscapes
// folds in here like every sandbox-output parser). Each line is also TRIMMED
// before the anchored lookups (the deploy-check sibling doctrine, interrogate
// round 1): residual leading/trailing whitespace — a shell variant appending
// a space after the OSC terminator, an indented echo — escapes the
// escape-stripper and would read the same false failure. Known cosmetic
// delta vs the old whole-text regexes (interrogate round 2, recorded): the
// per-line trim drops empty `DB_NGINX_T_OUTPUT: ` lines and trailing
// whitespace inside output payloads — only the diagnostic message consumes
// those.
export function parseDeployNginxVerifyOutput(stdout: string | undefined): ParsedDeployNginxVerify {
  const text = stripTerminalEscapes(stdout);
  const lines = text.split('\n').map((line) => line.trim());
  const configMissing =
    lines.some((line) => /^DB_NGINX_CONFIG_MISSING=1$/.test(line)) ||
    !lines.some((line) => /^DB_NGINX_CONFIG_OK=1$/.test(line));
  const nginxTest = lines.find((line) => /^DB_NGINX_T=\w+$/.test(line))?.slice('DB_NGINX_T='.length) ?? '';
  const nginxTestOutput = lines
    .filter((line) => line.startsWith('DB_NGINX_T_OUTPUT: '))
    .map((line) => line.slice('DB_NGINX_T_OUTPUT: '.length))
    .join('\n');
  return { configMissing, nginxTest, nginxTestOutput };
}

export interface DeployNginxVerdict {
  ok: boolean;
  error?: string;
}

// A1 (#935): the deploy verdict. A deploy script exit of 0 alone is NOT proof
// of success — the tee write can fail silently (broken pipe) and nginx -t can
// reject the config. Returns ok:false with an explicit, actionable error for
// any verification failure; a pure function so the verdict is unit-testable.
export function evaluateDeployNginxVerify(
  result: { exitCode: number },
  verify: ParsedDeployNginxVerify,
  configPath: string,
): DeployNginxVerdict {
  const writeVerified = result.exitCode === 0 && !verify.configMissing && verify.nginxTest === 'PASS';
  if (writeVerified) return { ok: true };
  const problems: string[] = [];
  if (result.exitCode !== 0) problems.push(`deploy script exited with code ${result.exitCode}`);
  if (verify.configMissing)
    problems.push(
      `nginx config file ${configPath} was not created (tee write failed or the verification output was corrupted)`,
    );
  if (verify.nginxTest !== 'PASS')
    problems.push(`nginx -t did not pass${verify.nginxTestOutput ? ` — ${verify.nginxTestOutput}` : ''}`);
  return {
    ok: false,
    error: `sandbox deploy nginx: configuration write verification failed — ${problems.join('; ')}.`,
  };
}
