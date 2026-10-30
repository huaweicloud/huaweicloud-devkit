import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { pluginRoot, readSource, root } from './structure-helpers.ts';

test('proxy nginx template listens on targetPort, not the stale listenPort (#738)', () => {
  const deployNginx = readSource(join('src', 'sandbox', 'deploy-nginx.ts'));

  // The proxy template must reference ${targetPort} (the auto-incremented port),
  // not ${listenPort} (the original requested port which may be occupied).
  const proxyBlock = deployNginx.match(/proxy: `server \{[\s\S]*?\}`/);
  assert.ok(proxyBlock, 'proxy nginx template block not found');
  assert.match(proxyBlock[0], /listen \$\{targetPort\}/);
  assert.doesNotMatch(proxyBlock[0], /listen \$\{listenPort\}/);
});

test('effectiveNodePort for proxy resolves via the pure resolveProxyNodePort helper on targetPort (#738)', () => {
  const deployNginx = readSource(join('src', 'sandbox', 'deploy-nginx.ts'));

  // effectiveNodePort must track the resolved targetPort so the Node app and
  // nginx stay in sync after auto-increment, and the resolution must be
  // extractable into a pure, unit-testable function.
  const nodePortBlock = deployNginx.match(
    /const effectiveNodePort =[\s\S]*?resolveProxyNodePort\(nodePort, targetPort[^;]*;[\s\S]*?\n\s*: undefined;/,
  );
  assert.ok(nodePortBlock, 'effectiveNodePort block not found');
  const block = nodePortBlock[0];
  assert.match(block, /resolveProxyNodePort\(nodePort, targetPort/);
  assert.doesNotMatch(block, /nodePort !== listenPort/);

  const helper = deployNginx.match(/export async function resolveProxyNodePort\([\s\S]*?\n\}/);
  assert.ok(helper, 'resolveProxyNodePort helper not found');
  assert.match(helper[0], /nodePort && nodePort !== nginxListenPort \? nodePort : nginxListenPort \+ 1/);
  assert.match(helper[0], /candidate === nginxListenPort \|\| \(await isPortInUse\(candidate\)\)/);
});

test('port conflict and drift warnings use the unified logic for all nginx types (#738)', () => {
  const deployNginx = readSource(join('src', 'sandbox', 'deploy-nginx.ts'));

  // The #736 stopgap formatProxyPortWarning must stay retired; proxy gets the
  // same conflict/drift warnings as spa/static.
  assert.doesNotMatch(deployNginx, /formatProxyPortWarning/);
  assert.match(deployNginx, /formatPortConflictWarning\(basePort, targetPort\)/);
  assert.match(deployNginx, /formatPortDriftWarning\(basePort, targetPort\)/);
  assert.doesNotMatch(deployNginx, /nginxType !== 'proxy'\s*\?\s*formatPortDriftWarning/);
});

test('deploy_nginx warnings are joined with the pipe separator (#738)', () => {
  const deployNginx = readSource(join('src', 'sandbox', 'deploy-nginx.ts'));
  assert.match(deployNginx, /\.join\(' \| '\)/);
});

test('devbridge uses the valid `list` command, not the non-existent `ls`', () => {
  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  const deployNginx = readSource(join('src', 'sandbox', 'deploy-nginx.ts'));

  assert.doesNotMatch(sandbox, /devbridge ls\b/);
  assert.match(sandbox, /devbridge list\b/);

  assert.doesNotMatch(deployNginx, /devbridge ls\b/);
  assert.match(deployNginx, /devbridge list -j/);
});

test('huawei-sandbox skill documents devbridge description and host/connect traps', () => {
  const body = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  assert.match(body, /only Chinese characters, digits, letters/);
  assert.match(body, /Connection failed, retrying/);
  assert.match(body, /devbridge host/);
  assert.match(body, /expose_via_devbridge/);
});

test('devbridge tunnel handling is migrated to the s2 gateway domain', () => {
  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  const sessionManager = readSource(join('src', 'sandbox', 'session-manager.ts'));
  // The s2 gateway wire contract moved to devbridge-gateway.ts (the session-manager
  // modularization); the canonical literals are pinned at their new home.
  const gateway = readSource(join('src', 'sandbox', 'devbridge-gateway.ts'));

  // Code must construct tunnel URLs exclusively from the s2 gateway domain.
  // The guard must also catch regex-literal occurrences where dots are escaped
  // (`cn-north-4-bridge\.myhuaweicloud\.com`) — plain dot matching is blind to those.
  assert.match(gateway, /devbridge-s2\.hwtunnel\.com/);
  assert.doesNotMatch(gateway, /cn-north-4-bridge\\?\.myhuaweicloud\\?\.com/);

  // A migrated gateway serves a placeholder page with HTTP 200 — the check must inspect the body.
  assert.match(gateway, /服务已迁移/);

  // The constants stay on the session-manager.ts public face — the sandbox
  // consumers import them from that path (the re-export seam must not drift
  // away); the devbridge-tunnel family imports devbridge-gateway.ts directly.
  assert.match(sessionManager, /DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER,\n\} from '\.\/devbridge-gateway\.ts'/);

  // The skill must teach the new URL form and the dead legacy form.
  assert.match(sandbox, /devbridge-s2\.hwtunnel\.com/);
  assert.doesNotMatch(sandbox, /https:\/\/<id>-<port>\.cn-north-4-bridge\.myhuaweicloud\.com/);
});

test('devbridge host launch survives the exec session (#919/#922): setsid guard, disown, -e 72', () => {
  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  const devbridgeTunnel = readSource(join('src', 'sandbox', 'devbridge-tunnel.ts'));
  // The face pin: the expose contract re-exports from its canonical module
  // (devbridge-expose.ts) since the devbridge-tunnel modularization — the
  // pure re-export seam must not drift away from the family.
  assert.match(
    devbridgeTunnel,
    /export \{[\s\S]*?buildDevbridgeExposeScript,[\s\S]*?\} from '\.\/devbridge-expose\.ts';/,
  );
  // The tunnel parameter policy (validators, lifetime constants, the 0.1.x
  // version gate) lives in devbridge-validation.ts since the devbridge-tunnel
  // modularization; the canonical literals are pinned at their new home.
  const devbridgeValidation = readSource(join('src', 'sandbox', 'devbridge-validation.ts'));
  // The expose attempt contract (script, stdout grammar, reachability warning)
  // lives in devbridge-expose.ts since the same split.
  const devbridgeExpose = readSource(join('src', 'sandbox', 'devbridge-expose.ts'));
  // The deploy_check remediation lives in deploy-check.ts since the
  // session-manager modularization.
  const deployCheckSource = readSource(join('src', 'sandbox', 'deploy-check.ts'));

  // The tool's expose script: setsid-detached nohup with the no-setsid fallback
  // (some images lack setsid), stdin dropped from the controlling tty, guarded
  // disown (POSIX-sh without the builtin must not abort), and the 72h expiry
  // echoed so exposeTunnel can compute expiresAt.
  assert.match(devbridgeExpose, /if command -v setsid > \/dev\/null 2>&1; then setsid nohup devbridge host/);
  assert.match(devbridgeExpose, /< \/dev\/null & else nohup devbridge host/);
  assert.match(devbridgeExpose, /`disown 2>\/dev\/null \|\| true`/);
  assert.match(devbridgeValidation, /DEVBRIDGE_HOST_EXPIRY_HOURS = 72/);
  assert.match(devbridgeExpose, /DB_EXPIRY_HOURS=\$\{expiryHours\}/);
  // #1000, the agent-facing SKILL surface: the manual fallbacks' curls carry
  // --noproxy with the MANDATORY comment, and the Proxy-trap doctrine
  // paragraph (with the SSH-path cross-reference) teaches the why. Localhost
  // curls are exempt — loopback bypasses the injected proxy.
  assert.match(sandbox, /curl -s --noproxy '\*' -o \/dev\/null/);
  assert.match(sandbox, /Proxy trap on verify commands \(#1000\)/);
  assert.match(sandbox, /windows-ssh\.md §0\.1/);
  assert.match(sandbox, /localhost curls are unaffected/);
  // #999: the data-disk-first PATH doctrine — /workspace survives reboots,
  // ~/.huawei/bin is wiped to the image state; the persistence table teaches
  // it and every PATH export carries the data-disk prefix.
  assert.match(sandbox, /Sandbox filesystem persistence: what survives a reboot \(#999\)/);
  assert.match(sandbox, /export PATH="\/workspace\/.local\/bin:\$HOME\/\.huawei\/bin:\$PATH"/);
  assert.match(devbridgeExpose, /export PATH="\/workspace\/.local\/bin:\$HOME\/\.huawei\/bin:\$PATH"/);
  assert.match(sandbox, /stale ~\/\.huawei\/bin\/devbridge removed/);
  // The Layer-3 install target is the substantive core of #999 — WHERE the
  // binary lands. The old system-disk-only export form must not re-creep.
  assert.match(sandbox, /mkdir -p \/workspace\/.local\/bin/);
  assert.match(sandbox, /install -m 0755 \/tmp\/devbridge-pkg\/devbridge \/workspace\/.local\/bin\/devbridge/);
  assert.doesNotMatch(
    sandbox,
    /export PATH="\$HOME\/\.huawei\/bin:\$PATH"/,
    'the system-disk-only export must not return',
  );
  // The connect flow's unquoted PATH form (handlers-account.ts since the
  // sandbox pack's family split, extracted verbatim from tools.ts) — the
  // third code leg.
  const sandboxConnectSource = readSource(join('src', 'packs', 'sandbox', 'handlers-account.ts'));
  assert.match(sandboxConnectSource, /export PATH=\/workspace\/.local\/bin:\$HOME\/\.huawei\/bin\$\{PATH:\+:\$PATH\}/);

  // The old 8h default must not re-creep into ANY sandbox sibling's tunnel
  // script (family-wide sweep — stronger than the old single-file check, which
  // the devbridge-tunnel modularization would have left vacuous on the face).
  const tunnelScriptFamily = readdirSync(join(pluginRoot, 'src', 'sandbox'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => [`sandbox/${name}`, readSource(join('src', 'sandbox', name))] as const);
  for (const [name, source] of tunnelScriptFamily) {
    assert.doesNotMatch(source, /-e 8\b/, `${name}: no hardcoded 8h tunnel expiry`);
  }

  // The skill teaches the same guarded launch on every host start line.
  assert.match(sandbox, /setsid nohup devbridge host -p <port> -e 72/);
  assert.match(sandbox, /disown 2>\/dev\/null \|\| true/);
  assert.doesNotMatch(sandbox, /-e 8 /);
  // The deploy_check remediation string is the third agent-facing surface —
  // it must teach the same guarded launch (a bare `nohup … &` there reaps the
  // host when the remediation's own exec session ends).
  assert.match(deployCheckSource, /setsid nohup devbridge host <tunnelId> -p \$\{port\} -e 72/);
  assert.match(
    deployCheckSource,
    /devbridge host <tunnelId> -p \$\{port\} -e 72 > \/tmp\/host\.log 2>&1 < \/dev\/null & fi; disown/,
  );
  // Migration/quota verdicts are host-log facts read from dedicated fields —
  // never a whole-stdout scan that the echoed probe body (DB_TUNNEL_BODY)
  // could poison with app content. Count-robust (grep -c prints line counts).
  assert.match(devbridgeExpose, /DB_MIGRATION=\$\(grep -c '\$\{DEVBRIDGE_MIGRATION_MARKER\}' \$\{hostLog\}/);
  assert.match(devbridgeExpose, /Number\(readDbField\(text, 'DB_MIGRATION'\)\) > 0/);
  assert.doesNotMatch(devbridgeExpose, /includes\('10006'\)/);
});

test('expose_tunnel re-verifies from an independent exec session and classifies gateway tunnel errors (#919)', () => {
  const devbridgeTunnel = readSource(join('src', 'sandbox', 'devbridge-tunnel.ts'));
  // The face pin: the re-verify family re-exports from its canonical module
  // (devbridge-verify.ts) since the devbridge-tunnel modularization.
  assert.match(
    devbridgeTunnel,
    /export \{ buildDevbridgeVerifyScript, parseDevbridgeVerifyOutput \} from '\.\/devbridge-verify\.ts';/,
  );
  // The deploy_check probe script lives in deploy-check.ts since the
  // session-manager modularization.
  const deployCheckSource = readSource(join('src', 'sandbox', 'deploy-check.ts'));
  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  // The fresh-session re-verify family lives in devbridge-verify.ts since the
  // devbridge-tunnel modularization.
  const devbridgeVerify = readSource(join('src', 'sandbox', 'devbridge-verify.ts'));

  // Fresh-session GET re-verify with the dedicated parser and output fields.
  assert.match(devbridgeVerify, /export function buildDevbridgeVerifyScript/);
  assert.match(devbridgeVerify, /export function parseDevbridgeVerifyOutput/);
  assert.match(devbridgeVerify, /persistent/);
  assert.match(devbridgeVerify, /请勿分享/);
  assert.match(devbridgeVerify, /DB_VERIFY_HTTP_CODE/);

  // Gateway-level errors: status-gated exact-body markers, shared constants.
  // The probe compares the WHOLE body (tr strips \r/\n — CRLF-tolerant, and an
  // app page that merely mentions a marker never matches).
  const gateway = readSource(join('src', 'sandbox', 'devbridge-gateway.ts'));
  assert.match(gateway, /DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER = 'tunnel not found'/);
  assert.match(gateway, /DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER = 'port not configured'/);
  assert.match(gateway, /DEVBRIDGE_BAD_GATEWAY_MARKER = 'bad gateway'/);
  assert.match(deployCheckSource, /body=\$\(tr -d '[^']*' < \/tmp\/\.dc_tunnel_body/);
  // #1000 (v2 completion): the deploy_check tunnel probe also bypasses the
  // injected sandbox proxy — every curl against *.hwtunnel.com carries it.
  assert.match(deployCheckSource, /curl -s --noproxy '\*' -o \/tmp\/\.dc_tunnel_body/);
  // U16: the tunnel-persistence subsystem — renewal, the watchdog, and the
  // #998/#999/#1000 hardening ride the devbridge-tunnel family's canonical
  // modules (pinned below at their homes since the modularization).
  const devbridgeValidation = readSource(join('src', 'sandbox', 'devbridge-validation.ts'));
  // The renew family lives in devbridge-renew.ts since the devbridge-tunnel
  // modularization.
  const devbridgeRenew = readSource(join('src', 'sandbox', 'devbridge-renew.ts'));
  // The keepalive watchdog family lives in devbridge-keepalive.ts since the
  // devbridge-tunnel modularization.
  const devbridgeKeepalive = readSource(join('src', 'sandbox', 'devbridge-keepalive.ts'));
  // The exposeTunnel orchestration lives in devbridge-expose-flow.ts since the
  // devbridge-tunnel modularization.
  const devbridgeExposeFlow = readSource(join('src', 'sandbox', 'devbridge-expose-flow.ts'));
  assert.match(devbridgeValidation, /export function validateExpiryHours/);
  assert.match(devbridgeValidation, /export function validateTunnelId/);
  assert.match(devbridgeRenew, /export function buildDevbridgeRenewScript/);
  assert.match(devbridgeKeepalive, /export function buildDevbridgeKeepaliveScript/);
  assert.match(devbridgeKeepalive, /export function mergeKeepaliveTunnels/);
  // The keepalive health check carries --noproxy (U11 landmine — main missed it).
  assert.match(devbridgeKeepalive, /HC=\$\(curl -s --noproxy '\*' -o \/dev\/null/);
  // The persistence reference and the tool rows exist.
  assert.ok(
    existsSync(
      join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'references', 'tunnel-persistence.md'),
    ),
  );
  assert.match(sandbox, /huaweicloud_sandbox_renew_tunnel/);
  assert.match(sandbox, /huaweicloud_sandbox_keepalive_watchdog/);
  assert.match(sandbox, /AUTO-enrolls into the keepalive watchdog/);
  assert.match(sandbox, /tunnel-persistence\.md/);
  // The 1.1.12 full-stack knowledge (the terminal review's one completeness
  // find — it arrived under no issue number and fell through the per-unit
  // checkpoints): the PostgREST reference, the routing section, and the
  // backend-present integration note.
  assert.ok(
    existsSync(
      join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'references', 'fullstack-postgrest.md'),
    ),
  );
  assert.match(sandbox, /## Full-Stack: REST API over PostgreSQL \(PostgREST\)/);
  assert.match(sandbox, /Backend present\?/);
  assert.match(sandbox, /fullstack-postgrest\.md/);

  // The dev #1016/#1017/#1019/#1020 knowledge wave ported into the reference:
  // the PG data-disk move (the 系统盘 rollback trap), the Aliyun RPM mirror,
  // the third-party-proxy + official-sha256 doctrine, and the corrected
  // write-grant beat (401 → targeted GRANT → 201).
  const postgrest = readSource(
    join('src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'references', 'fullstack-postgrest.md'),
  );
  // PGDATA lives on the data disk — /var/lib/pgsql rolls back on reboot (#1019).
  assert.match(postgrest, /\/workspace\/pgsql\/16\/data/);
  assert.match(postgrest, /initdb -D \/workspace\/pgsql\/16\/data/);
  assert.doesNotMatch(postgrest, /\/var\/lib\/pgsql\/16\/data/);
  assert.match(postgrest, /系统盘 \(system disk\)/);
  // RPMs come from the Aliyun mirror, not the ~8KB/s official sources.
  assert.match(postgrest, /mirrors\.aliyun\.com\/postgresql\/repos\/yum\/16\/redhat\/rhel-8-aarch64/);
  assert.match(postgrest, /mirrors\.aliyun\.com\/almalinux\/8\/BaseOS/);
  // Third-party proxy bytes are verified against the official GitHub digest.
  assert.match(postgrest, /postgrest-v16\.5-linux-static-aarch64\.tar\.xz/);
  assert.match(postgrest, /\| sha256sum -c -/);
  assert.match(postgrest, /test -n "\$PGRST_SHA256"/);
  // POST 401 → targeted GRANT → 201 (the ported third beat — anchored on the
  // Step-4 sentence itself, not the same-shaped restart-trap sentence).
  assert.match(postgrest, /After that targeted grant the same `POST \/api\/todos` returns \*\*201\*\*/);
  // #1021 follow-up: the reboot-recovery guidance must not route the nginx
  // config through deploy_nginx (its spa/proxy/static templates carry no
  // /api/ reverse proxy — the restored site would be SPA-only); both
  // recovery mentions re-apply Step 3's single-origin block instead.
  assert.doesNotMatch(postgrest, /Re-create via `huaweicloud_sandbox_deploy_nginx`/);
  assert.doesNotMatch(postgrest, /re-create the nginx config via\s+`huaweicloud_sandbox_deploy_nginx`/);
  assert.match(postgrest, /Re-apply Step 3's single-origin block/);
  assert.match(
    postgrest,
    /re-apply the Step 3 single-origin nginx\s+config \(never `huaweicloud_sandbox_deploy_nginx`/,
  );

  assert.match(
    deployCheckSource,
    /\[ "\$code" = "404" \] && \[ "\$body" = "\$\{DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER\}" \]/,
  );

  // Retry exhaustion on a gateway-dead URL must fail, not soften to a warning.
  assert.match(devbridgeExposeFlow, /gateway reports the fresh tunnel URL as dead/);
});

test('huawei-sandbox carries the Stack-Selection Gate (workbench ⇒ PostgREST default) (#1021)', () => {
  const skill = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );

  // The gate must exist as a top-level section between the Target-Selection
  // Gate and the Overview — not buried as a conditional branch inside the
  // Web Application Deployment section. The lookups are line-anchored (^##)
  // so a demotion to ### (or a wholesale re-heading under an umbrella
  // section) cannot keep the pins green.
  const gateMatch = /^## Stack-Selection Gate \(MANDATORY — do not skip\)$/m.exec(skill);
  assert.ok(gateMatch, 'Stack-Selection Gate section missing as a top-level heading');
  const gateStart = gateMatch.index;
  const targetGate = /^## Target-Selection Gate/m.exec(skill)?.index ?? -1;
  const overview = /^## Overview/m.exec(skill)?.index ?? -1;
  assert.ok(targetGate !== -1 && targetGate < gateStart, 'Stack-Selection Gate must follow the Target-Selection Gate');
  assert.ok(overview !== -1 && gateStart < overview, 'Stack-Selection Gate must precede the Overview');

  const nextHeading = skill.indexOf('\n## ', gateStart + 1);
  const gate = nextHeading === -1 ? skill.slice(gateStart) : skill.slice(gateStart, nextHeading);
  assert.match(
    gate,
    /you MUST treat it as a \*\*full-stack workbench deployment\*\*/,
    'gate must force the full-stack classification',
  );
  assert.match(gate, /defaults to \*\*PostgreSQL \+ PostgREST\*\*/, 'gate must state the PostgREST default');
  assert.match(gate, /`question` tool/, 'gate must mandate the question tool for ambiguous backends');
  assert.match(gate, /NEVER infer or default the stack to SPA/, 'gate must carry the never-default-to-SPA hard rule');
  assert.match(gate, /Pre-code checkpoint \(MANDATORY\)/, 'gate must carry the pre-code checkpoint');
  // The STOP-and-redirect beat is what makes the checkpoint more than a
  // checkbox: an already-started SPA-only deployment must be stopped and
  // redirected, never papered over with a bolted-on static backend.
  assert.match(
    gate,
    /STOP, tell the developer, and redirect to the full-stack path/,
    'the checkpoint must STOP and redirect an already-started SPA-only deployment',
  );
  assert.match(gate, /bolted-on static backend/, 'the checkpoint must forbid the bolted-on static backend');
  // Routing: the PostgREST choice lands on the full-stack section FIRST via
  // its real heading anchor (the T3-landed section), the other two stacks on
  // the web deployment section — both target headings must exist at the
  // level the anchors claim, or the routing dead-links.
  assert.match(
    gate,
    /\[Full-Stack: REST API over PostgreSQL\]\(#full-stack-rest-api-over-postgresql-postgrest\)/,
    'gate must route to the full-stack procedure at its real heading anchor',
  );
  assert.match(
    gate,
    /\[Web Application Deployment\]\(#web-application-deployment\)/,
    'gate must route the non-PostgREST stacks to the web deployment section',
  );
  assert.match(skill, /^## Web Application Deployment$/m, 'the web deployment heading the anchor targets must exist');

  // The Web Application Deployment backend note keeps its pinned opener and
  // carries the gate back-reference (dev's reinforcement sentence), so an
  // agent entering at section level still meets the gate — plus the
  // reconciliation clause: the Full-Stack section's hand-written
  // single-origin nginx config must not be re-clobbered by the
  // deploy_nginx sub-step's SPA/proxy/static template.
  assert.match(
    skill,
    /The backend choice was already confirmed by the \[Stack-Selection Gate\]\(#stack-selection-gate-mandatory--do-not-skip\) before any code was uploaded/,
    'the Backend present? note must back-reference the gate',
  );
  assert.match(
    skill,
    /skip the Configure Nginx sub-step/,
    'the PostgREST path must not re-run deploy_nginx over the single-origin config',
  );

  // The late-flow catch-all surface: the Critical Warnings table carries a
  // stack-gate row beside the target-gate row (the target-gate doctrine is
  // reinforced on four surfaces in this skill — gate section, Activation
  // bullet, Step 0, the warnings row; the stack gate needs the same
  // catch-all).
  assert.match(
    skill,
    /Stack not confirmed \(workbench ⇒ SPA\)/,
    'the Critical Warnings table must carry the stack-gate row',
  );

  // Trigger words in the frontmatter description so the model hits the skill
  // on workbench-shaped requests without postgres/数据库 keywords. v2 keeps
  // its vendor-gate prefix text (pinned in structure-load-path.test.ts) —
  // the widened run only extends the Triggers list between `web application`
  // and `hwlink`, and the NOT-for exclusions stay untouched (full-stack
  // routing never conflicts with the ECS/CCE exclusions).
  const frontmatter = skill.match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? '';
  assert.match(
    frontmatter,
    /web application, backend service, 工作台, workbench, full-stack, 全栈, CRUD 应用, database-backed REST API, PostgREST, postgres, hwlink/,
    'the widened trigger run must land between web application and hwlink',
  );
  assert.match(
    frontmatter,
    /NOT for: ECS instances \(use huawei-ecs\), CCE clusters \(use huawei-cce\)/,
    'the NOT-for exclusions must stay intact beside the widened triggers',
  );

  // The workflow sequences the stack gate before any code can land, linking
  // the gate section at its real heading anchor — position, not just
  // presence: after Step 0 (the target gate) and before the whole numbered
  // preflight (whose Connect step can already transfer code via the `git`
  // parameter, ahead of the explicit upload step).
  assert.match(
    skill,
    /Step 0\.5 — Stack-Selection Gate \(MANDATORY\)\*\*: before uploading or writing any application code, confirm the backend stack via the \[Stack-Selection Gate\]\(#stack-selection-gate-mandatory--do-not-skip\)/,
    'workflow must sequence the stack gate before code upload, linking the gate at its real anchor',
  );
  const step0 = skill.indexOf('**Step 0 — Target-Selection Gate (MANDATORY)**');
  const step05 = skill.indexOf('**Step 0.5 — Stack-Selection Gate (MANDATORY)**');
  const preflight = skill.indexOf('Setup is a **plugin-side preflight**');
  assert.ok(step0 !== -1 && step05 !== -1 && step0 < step05, 'Step 0.5 must follow Step 0 in the workflow');
  assert.ok(
    preflight !== -1 && step05 < preflight,
    'Step 0.5 must precede the whole numbered preflight (the Connect step can already transfer code via the git parameter)',
  );
});

test('deploy_check judges reachability by non-000 and probes listed tunnels boundedly', () => {
  const deployCheckSource = readSource(join('src', 'sandbox', 'deploy-check.ts'));

  // nginx_serving: any non-000 HTTP code counts (404/502 = content issue,
  // not a connectivity issue).
  assert.match(deployCheckSource, /\[ -n "\$HTTP_CODE" \] && \[ "\$HTTP_CODE" != "000" \]/);
  assert.doesNotMatch(deployCheckSource, /grep -qE "\^\(2\|3\)"/);

  // Bounded per-tunnel probing (head -5) with a selected URL — `devbridge list`
  // order is arbitrary, so the first row must not shadow the live tunnel.
  assert.match(deployCheckSource, /TUNNEL_IDS=\$\(devbridge list -j[^\n]*head -5\)/);
  assert.match(deployCheckSource, /for CAND in \$TUNNEL_IDS; do/);
  assert.match(deployCheckSource, /SELECTED_URL="\$CAND_URL"/);
});

test('stripTerminalEscapes is the single escape-stripping seam for sandbox output parsers (#946)', () => {
  const sessionManager = readSource(join('src', 'sandbox', 'session-manager.ts'));
  const devbridgeTunnel = readSource(join('src', 'sandbox', 'devbridge-tunnel.ts'));
  // The face pin: the auth parser re-exports from its canonical module
  // (devbridge-auth.ts) since the devbridge-tunnel modularization.
  assert.match(
    devbridgeTunnel,
    /export \{ buildDevbridgeAuthProbe, parseDevbridgeAuthOutput \} from '\.\/devbridge-auth\.ts';/,
  );
  // sandbox-output.ts is the canonical home since the session-manager
  // modularization; the whole sandbox sibling family is swept so no sibling
  // (new or old) re-rolls the seam.
  const sandboxOutput = readSource(join('src', 'sandbox', 'sandbox-output.ts'));
  // The deploy-check parser lives in deploy-check.ts since the same split.
  const deployCheckSource = readSource(join('src', 'sandbox', 'deploy-check.ts'));
  // The nginx-verify parser lives in deploy-nginx-verify.ts since the
  // deploy-nginx family split (port-v2defects: it was the one anchored-marker
  // parser left outside the seam — every successful deploy_nginx read as
  // failed on OSC-integration shells).
  const deployNginxVerifySource = readSource(join('src', 'sandbox', 'deploy-nginx-verify.ts'));
  // The devbridge parsers live in their canonical modules since the
  // devbridge-tunnel modularization (auth probe parser in devbridge-auth.ts,
  // the expose/probe parsers in devbridge-expose.ts).
  const devbridgeAuth = readSource(join('src', 'sandbox', 'devbridge-auth.ts'));
  const devbridgeExpose = readSource(join('src', 'sandbox', 'devbridge-expose.ts'));
  const devbridgeVerify = readSource(join('src', 'sandbox', 'devbridge-verify.ts'));
  const devbridgeRenew = readSource(join('src', 'sandbox', 'devbridge-renew.ts'));
  const devbridgeKeepalive = readSource(join('src', 'sandbox', 'devbridge-keepalive.ts'));
  const sandboxFamily = readdirSync(join(pluginRoot, 'src', 'sandbox'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => [`sandbox/${name}`, readSource(join('src', 'sandbox', name))] as const);

  // One exported definition; every devbridge parser module imports the
  // canonical seam directly since the devbridge-tunnel modularization (auth
  // parser in devbridge-auth.ts, expose/probe parsers in devbridge-expose.ts,
  // verify in devbridge-verify.ts, renew in devbridge-renew.ts, keepalive in
  // devbridge-keepalive.ts — no second copy, no face round-trip; the
  // devbridge-tunnel.ts face is a pure re-export seam and imports nothing).
  assert.match(sandboxOutput, /export function stripTerminalEscapes/);
  assert.match(sessionManager, /export \{ stripTerminalEscapes \} from '\.\/sandbox-output\.ts';/);
  assert.match(devbridgeAuth, /import \{ stripTerminalEscapes \} from '\.\/sandbox-output\.ts';/);
  assert.match(devbridgeExpose, /import \{ stripTerminalEscapes \} from '\.\/sandbox-output\.ts';/);
  assert.match(devbridgeVerify, /import \{ stripTerminalEscapes \} from '\.\/sandbox-output\.ts';/);
  assert.match(devbridgeRenew, /import \{ stripTerminalEscapes \} from '\.\/sandbox-output\.ts';/);
  assert.match(devbridgeKeepalive, /import \{ stripTerminalEscapes \} from '\.\/sandbox-output\.ts';/);
  const csiConstruction = "ESC + '\\\\[[0-9:;<=>?]*[ -/]*[a-zA-Z]'";
  assert.equal(sandboxOutput.split(csiConstruction).length - 1, 1, 'CSI regex must be constructed once');
  for (const [name, source] of sandboxFamily) {
    if (name === 'sandbox/sandbox-output.ts') continue;
    assert.equal(source.includes(csiConstruction), false, `${name}: no CSI construction copy`);
  }
  // The CSI class covers the private-mode parameter bytes (\x1b[?2026h etc.) —
  // a digits-;-only class leaves them intact and blinds the anchored lookups.
  assert.match(sandboxOutput, /0-9:;<=>\?\]\*\[ -\/\]\*\[a-zA-Z\]/);
  for (const [name, source] of sandboxFamily) {
    // Deny BOTH CSI- and OSC-form literal-regex copies (/\x1b[…/, /\x1b]…).
    assert.doesNotMatch(
      source,
      /\/\\x1b[\\[\]]/,
      `${name}: no literal escape-regex copies — fold stripTerminalEscapes in`,
    );
  }

  // Every sandbox-output parser entry point folds the stripper in.
  assert.match(deployCheckSource, /parseDeployCheckOutput\(stdout[\s\S]{0,400}?stripTerminalEscapes\(stdout\)/);
  assert.match(
    deployNginxVerifySource,
    /parseDeployNginxVerifyOutput\(stdout[\s\S]{0,400}?stripTerminalEscapes\(stdout\)/,
  );
  assert.match(deployNginxVerifySource, /import \{ stripTerminalEscapes \} from '\.\/sandbox-output\.ts';/);
  assert.match(devbridgeExpose, /parseDevbridgeExposeOutput\(stdout[\s\S]{0,600}?stripTerminalEscapes\(stdout\)/);
  assert.match(devbridgeAuth, /parseDevbridgeAuthOutput\(stdout[\s\S]{0,400}?stripTerminalEscapes\(stdout\)/);
  assert.match(devbridgeVerify, /parseDevbridgeVerifyOutput\(stdout[\s\S]{0,400}?stripTerminalEscapes\(stdout\)/);
  assert.match(devbridgeExpose, /parseDevbridgeProbeSequence\(stdout[\s\S]{0,700}?stripTerminalEscapes\(stdout\)/);
});

test('devbridge 0.2.x flow: auth capability probe, version detection, in-place upgrade guidance', () => {
  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  // The credentials tool handler moved to the sandbox pack with the P2 pack
  // program, and into handlers-credentials.ts with the pack's family split
  // (extracted verbatim from tools.ts).
  const sandboxCredentials = readSource(join('src', 'packs', 'sandbox', 'handlers-credentials.ts'));

  // SKILL.md must never teach the removed 0.1.x login flow (--huaweicloud SSO flag is
  // gone from every 0.2.x build), and the obsolete warning row must stay gone.
  assert.doesNotMatch(sandbox, /auth login --huaweicloud/);
  assert.doesNotMatch(sandbox, /Login needs --huaweicloud/);
  assert.match(sandbox, /Never expose tunnel details/);

  // The #935 sandbox traps (ported from main 1.1.10): 0.2.x has no
  // --huaweicloud flag (docs ran ahead of the binary — teach the direct
  // --access-key form); platform-side STS credentials are obsutil-encrypted
  // (devbridge reads ciphertext → APIGW.0301); sandboxes have no systemd.
  assert.match(sandbox, /does NOT exist in sandbox devbridge 0\.2\.x binaries/);
  assert.match(sandbox, /obsutil 加密态存储/);
  assert.match(sandbox, /沙箱无 systemd/);
  assert.match(sandbox, /nginx -t` 验证 \+ `nginx -s reload` 热加载/);

  // The paired implementation pin: the SKILL's deploy_nginx claim (配置写入
  // 后自动回验存在性与 nginx -t) is only true because the sandbox family
  // implements the A1 verify block — deploy-nginx.ts splices the markers into
  // the deploy script and folds in the verdict from deploy-nginx-verify.ts —
  // docs-ahead-of-code (the failure this guard's sibling prose denounces)
  // fails here.
  const deployNginx = readSource(join('src', 'sandbox', 'deploy-nginx.ts'));
  const deployNginxVerify = readSource(join('src', 'sandbox', 'deploy-nginx-verify.ts'));
  assert.match(deployNginx, /DB_NGINX_CONFIG_MISSING=1/);
  // The presence-inverted pair (interrogate round 2): the script emits
  // OK-or-MISSING as if/else so every marker is presence-required and a
  // swallowed marker line reads as the failure direction, never as the
  // pre-inversion false success.
  assert.match(deployNginx, /DB_NGINX_CONFIG_OK=1/);
  assert.match(deployNginx, /else echo "DB_NGINX_CONFIG_MISSING=1"; fi/);
  assert.match(deployNginx, /DB_NGINX_T=PASS/);
  assert.match(deployNginxVerify, /DB_NGINX_CONFIG_OK=1/);
  assert.match(deployNginxVerify, /export function resolveNginxConfigPath/);
  assert.match(deployNginx, /fix_and_retry/);

  // Auth is a verified three-tier waterfall (keyring → AK/SK → api-key file);
  // the preferred path is the expose_tunnel tool, the manual script is the
  // fallback. The probe vocabulary is DB_AUTH_MODE modes, not AUTH_MODE.
  assert.match(sandbox, /auth login --help 2>&1 \| grep -q -- '--access-key'/);
  assert.match(sandbox, /hwcloud keyring get HW_DEVBRIDGE_API_KEY 2>&1/);
  assert.match(sandbox, /devbridge_"\*\)|devbridge_\*\)/);
  assert.match(sandbox, /API_KEY_KEYRING/);
  assert.match(sandbox, /AKSK_SUPPORTED/);
  assert.match(sandbox, /API_KEY_FILE/);
  assert.match(sandbox, /NO_CREDENTIAL/);
  assert.match(
    sandbox,
    /--security-token "\$HW_SECURITY_TOKEN"/,
    'STS credentials must carry the security token or the gateway rejects with 401 APIGW.0301',
  );
  assert.match(
    sandbox,
    /auth login --access-key "\$HW_ACCESS_KEY" --secret-key "\$HW_SECRET_KEY"/,
    'image-build branch must teach the direct AK/SK login',
  );
  assert.match(sandbox, /huaweicloud_sandbox_expose_tunnel/);
  assert.match(sandbox, /attempts/);

  // The API Key guidance (release-build branch) must survive, incl. version detection
  // and the in-place upgrade.
  assert.match(sandbox, /auth login --api-key "\$HW_API_KEY"/);
  assert.match(sandbox, /devbridge version/);
  assert.match(sandbox, /devbridge-install\.sh -s/);
  assert.match(sandbox, /devstation\.connect\.huaweicloud\.com\/space\/devbridge\/apikey/);
  assert.match(sandbox, /HW_API_KEY/);

  // The credentials tool must support injecting the DevBridge API Key:
  // - env-first precedence (keeps the long-lived key out of the conversation)
  // - separate storage from the temporary AK/SK (/tmp/hw_api_key vs /tmp/hw_creds.sh)
  assert.match(sandboxCredentials, /api_key/);
  assert.match(sandboxCredentials, /process\.env\.HW_API_KEY \|\| args\.api_key/);
  assert.match(sandboxCredentials, /\/tmp\/hw_api_key/);
  assert.match(sandbox, /\/tmp\/hw_api_key/);

  // The API Key must NOT be written into the shared AK/SK creds script.
  const credsWrite = sandboxCredentials.match(/const credsScript = \[[\s\S]*?\]/);
  assert.ok(credsWrite, 'credsScript block not found in packs/sandbox/handlers-credentials.ts');
  assert.doesNotMatch(credsWrite[0], /HW_API_KEY/);

  // The CodeArts Doer sidecopy must mirror the probe-branch flow and not regress
  // to the removed 0.1.x flow either. .codeartsdoer is a gitignored install
  // copy (never tracked), so a clean checkout has no sidecopy to check.
  const sidecopyPath = join(root, '.codeartsdoer', 'skills', 'huawei-sandbox', 'SKILL.md');
  if (existsSync(sidecopyPath)) {
    const sidecopy = readFileSync(sidecopyPath, 'utf8');
    assert.doesNotMatch(sidecopy, /auth login --huaweicloud/);
    assert.doesNotMatch(sidecopy, /res-hd\.hc-cdn\.cn/);
    assert.doesNotMatch(sidecopy, /devbridge ls\b/);
    assert.doesNotMatch(sidecopy, /https:\/\/<id>-<port>\.cn-north-4-bridge/);
    assert.match(sidecopy, /auth login --help 2>&1 \| grep -q -- '--access-key'/);
    assert.match(sidecopy, /API_KEY_KEYRING/);
    assert.match(sidecopy, /AKSK_SUPPORTED/);
    assert.match(sidecopy, /NO_CREDENTIAL/);
    assert.match(sidecopy, /auth login --api-key "\$HW_API_KEY"/);
    assert.match(sidecopy, /devbridge-s2\.hwtunnel\.com/);
    assert.match(sidecopy, /\/tmp\/hw_api_key/);
  }
});
