// The deploy-check family, extracted from session-manager: the TUNNEL_URL
// grammar, the stdout contract parser (name:PASS / SCORE:n/n / VERDICT), the
// expose remediation text, and deployCheck itself — the bounded check script
// (nginx serving, output dir, fingerprint, devbridge tunnel probes with the
// --noproxy trap handled, the cross-platform QR branch). Exec goes through the
// one-shot surface in hwlink-connection.ts; the s2 gateway markers come from
// devbridge-gateway.ts; session-manager.ts re-exports the public names as the
// stable public face.

import { execOneShot } from './hwlink-connection.ts';
import {
  DEVBRIDGE_BAD_GATEWAY_MARKER,
  DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER,
  DEVBRIDGE_TUNNEL_DOMAIN,
  DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER,
} from './devbridge-gateway.ts';
import { stripTerminalEscapes } from './sandbox-output.ts';

interface DeployCheckOptions {
  port: number;
  project: string;
  outputDir: string;
  frameworkType?: string;
}

interface DeployCheckEntry {
  status: string;
  detail: string;
}

interface DeployCheckResult {
  ok: boolean;
  complete: boolean;
  checkType: string;
  checks: Record<string, DeployCheckEntry>;
  score: { pass: number; total: number } | null;
  publicUrl: string | undefined;
  missingSteps: string | undefined;
  parseWarning: string | undefined;
  rawOutput: string | undefined;
  nextStep: string;
  remediation: string | undefined;
}

export const TUNNEL_URL_PATTERN = /TUNNEL_URL:(https:\/\/[A-Za-z0-9_-]+-\d+\.devbridge-s2\.hwtunnel\.com)/;

export function buildExposeRemediation(port: number): string {
  return `In the sandbox: source /tmp/hw_api_key 2>/dev/null; devbridge delete-all; devbridge create <name>; devbridge port create <tunnelId> -p ${port} --protocol http -a; if command -v setsid >/dev/null 2>&1; then setsid nohup devbridge host <tunnelId> -p ${port} -e 72 > /tmp/host.log 2>&1 < /dev/null & else nohup devbridge host <tunnelId> -p ${port} -e 72 > /tmp/host.log 2>&1 < /dev/null & fi; disown 2>/dev/null || true; If deploy_nginx reported a different (auto-incremented) port in its "port" field, use THAT port instead of the one shown here. Full procedure in huawei-sandbox skill, Step 7 (Expose via DevBridge).`;
}

// The deploy-check stdout contract as one exported pure function — the
// grammar (`name:PASS`, `SCORE:n/n`, `TUNNEL_URL:`, `VERDICT:COMPLETE`)
// is the product-fake interface for the e2e ws fake, so it is pinned by
// test/ws-exec-protocol.test.ts from BOTH sides (the fake's synthesized
// output must parse through this function).
export interface ParsedDeployCheck {
  checks: Record<string, DeployCheckEntry>;
  complete: boolean;
  score: { pass: number; total: number } | null;
  publicUrl: string | undefined;
  missing: string[];
  parseWarning: string | undefined;
}

export function parseDeployCheckOutput(stdout: string): ParsedDeployCheck {
  // Strip ANSI escape sequences (CSI color/cursor codes and OSC shell-integration markers)
  // and normalize line endings to \n to handle all terminal outputs.
  const cleanStdout = stripTerminalEscapes(stdout);
  const checks: Record<string, DeployCheckEntry> = {};
  const lines = cleanStdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(/^(\w+):(PASS|FAIL|SKIP)\b(.*)/);
    if (m) checks[m[1]!] = { status: m[2]!, detail: (m[3] || '').trim() };
  }
  const scoreMatch = cleanStdout.match(/SCORE:(\d+)\/(\d+)/);
  const tunnelMatch = cleanStdout.match(TUNNEL_URL_PATTERN);
  const complete = /VERDICT:COMPLETE/.test(cleanStdout);

  const missing: string[] = [];
  if (!complete) {
    for (const [key, val] of Object.entries(checks)) {
      if (val.status === 'FAIL') missing.push(key);
    }
  }

  // If checks is empty but score was found, parsing failed — raw output is kept for debugging
  const parseWarning =
    Object.keys(checks).length === 0 && scoreMatch
      ? 'Check output parsing failed — individual check results could not be extracted. See rawOutput for details.'
      : undefined;

  return {
    checks,
    complete,
    score: scoreMatch ? { pass: parseInt(scoreMatch[1]!, 10), total: parseInt(scoreMatch[2]!, 10) } : null,
    publicUrl: tunnelMatch ? tunnelMatch[1] : undefined,
    missing,
    parseWarning,
  };
}

export async function deployCheck(
  workspaceId: string,
  { port, project, outputDir, frameworkType }: DeployCheckOptions,
  username = 'root',
  // Mirrors SANDBOX_TIMEOUT_MS.deploy_check (packs/sandbox/schemas.ts,
  // re-exported through the pack's tools.ts face): the
  // bounded per-tunnel probing alone can spend 5 × 5s of curl plus devbridge
  // list round-trips. The remaining curls (localhost nginx/fingerprint, the
  // external QR service) are still unbounded — pre-existing; a hang there can
  // still consume the budget, but the probe loop itself now fits.
  timeoutMs = 60000,
): Promise<DeployCheckResult> {
  if (!workspaceId) {
    throw new Error('sandbox deploy check: workspace_id is required.');
  }

  const projectPath = `/workspace/${project}`;
  const outputPath = outputDir.startsWith('/') ? outputDir : `${projectPath}/${outputDir}`;
  const isCrossPlatform = frameworkType === 'cross-platform';

  const checkScript = [
    // #999: the export rides the same first line as the marker (one-shot
    // shells need it; first-line intent recognition needs a stable anchor).
    `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; echo "=== DEPLOY CHECK ==="`,
    `PASS=0`,
    `TOTAL=0`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:${port} 2>/dev/null)`,
    `if [ -n "$HTTP_CODE" ] && [ "$HTTP_CODE" != "000" ]; then`,
    `  echo "nginx_serving:PASS (port ${port}, HTTP \${HTTP_CODE})"`,
    `  PASS=$((PASS+1))`,
    `else`,
    `  echo "nginx_serving:FAIL (port ${port}, no HTTP response)"`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `if [ -d "${outputPath}" ] && ls -A "${outputPath}" 2>/dev/null | grep -q .; then`,
    `  echo "output_dir:PASS (${outputPath})"`,
    `  PASS=$((PASS+1))`,
    `else`,
    `  echo "output_dir:FAIL (${outputPath} empty or missing)"`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `FINGERPRINT_FILE="${outputPath}/.deploy_fingerprint"`,
    `FINGERPRINT_EXPECTED=$(cat "$FINGERPRINT_FILE" 2>/dev/null)`,
    `if [ -n "$FINGERPRINT_EXPECTED" ]; then`,
    `  FINGERPRINT_ACTUAL=$(curl -s http://localhost:${port}/.deploy_fingerprint 2>/dev/null)`,
    `  if [ "$FINGERPRINT_EXPECTED" = "$FINGERPRINT_ACTUAL" ]; then`,
    `    echo "content_verified:PASS"`,
    `    PASS=$((PASS+1))`,
    `  else`,
    `    echo "content_verified:FAIL (fingerprint mismatch — nginx may be serving stale content from a previous deployment)"`,
    `  fi`,
    `else`,
    `  echo "content_verified:SKIP (no fingerprint file)"`,
    `  TOTAL=$((TOTAL-1))`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `DB_TUNNEL_ACTIVE=0`,
    `if devbridge list -j 2>/dev/null | grep -q '"tunnelId"'; then`,
    `  DB_TUNNEL_ACTIVE=1`,
    `elif devbridge list 2>/dev/null | grep -Eq '^[a-z2-7]{8}[[:space:]]'; then`,
    `  DB_TUNNEL_ACTIVE=1`,
    `fi`,
    `if [ "$DB_TUNNEL_ACTIVE" = "1" ]; then`,
    `  echo "devbridge_tunnel:PASS"`,
    `  PASS=$((PASS+1))`,
    `else`,
    `  echo "devbridge_tunnel:FAIL"`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `TUNNEL_IDS=$(devbridge list -j 2>/dev/null | grep -oP '"tunnelId":\\s*"\\K[^"]+' | head -5)`,
    `if [ -z "$TUNNEL_IDS" ]; then`,
    `  TUNNEL_IDS=$(devbridge list 2>/dev/null | grep -E '^[a-z2-7]{8}[[:space:]]' | awk '{print $1}' | head -5)`,
    `fi`,
    `# Gateway-level tunnel errors have exact text/plain bodies ("tunnel not found"`,
    `# verified live on the s2 gateway): 404 "tunnel not found" = no live host session`,
    `# (the tunnel RECORD may still be in \`list\`); 404 "port not configured" = URL port`,
    `# not registered; 502 "bad gateway" = tunnel alive, local service down. The`,
    `# whole-content comparison (tr strips \\r/\\n, so CRLF forms compare equal) plus`,
    `# status gating avoids flagging app-generated 404/502 pages — a page that`,
    `# merely MENTIONS a marker never matches. No migration-marker grep here: the`,
    `# probe URL is always constructed on the CURRENT gateway domain, which never`,
    `# serves the retired gateway's placeholder — a body grep could only fire on`,
    `# app content (a Chinese page saying 服务已迁移 is a legitimate app). Migration`,
    `# is judged host-log-side by expose_tunnel (DB_MIGRATION). --max-time 5 (vs`,
    `# the expose/verify probes' 10) keeps 5 bounded probes inside the timeout budget.`,
    `probe_tunnel() {`,
    `  local url="$1" code body`,
    // #1000 (v2 completion — main missed this probe): --noproxy — the injected
    // sandbox proxy does not route the tunnel domain; a proxied probe returns
    // 502/404 fakes for a working tunnel, same trap as the expose/verify curls.
    `  code=$(curl -s --noproxy '*' -o /tmp/.dc_tunnel_body -w "%{http_code}" --max-time 5 "$url" 2>/dev/null)`,
    `  PROBE_FAIL_REASON=""`,
    `  if [ -z "$code" ] || [ "$code" = "000" ]; then PROBE_FAIL_REASON="unreachable"; rm -f /tmp/.dc_tunnel_body; return 1; fi`,
    `  body=$(tr -d '\\r\\n' < /tmp/.dc_tunnel_body 2>/dev/null)`,
    `  rm -f /tmp/.dc_tunnel_body`,
    `  if [ "$code" = "404" ] && [ "$body" = "${DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER}" ]; then PROBE_FAIL_REASON="tunnel not found (no live host session on the gateway)"; return 1; fi`,
    `  if [ "$code" = "404" ] && [ "$body" = "${DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER}" ]; then PROBE_FAIL_REASON="port not configured (URL port not registered on the tunnel)"; return 1; fi`,
    `  if [ "$code" = "502" ] && [ "$body" = "${DEVBRIDGE_BAD_GATEWAY_MARKER}" ]; then PROBE_FAIL_REASON="bad gateway (tunnel alive, local service not serving)"; return 1; fi`,
    `  return 0`,
    `}`,
    `# Probe each listed tunnel (bounded to 5) and select the first one that actually`,
    `# serves this port — \`devbridge list\` order is arbitrary, so a stale tunnel listed`,
    `# first must not shadow the live one.`,
    `SELECTED_URL=""`,
    `FIRST_ID=""`,
    `FIRST_REASON=""`,
    `for CAND in $TUNNEL_IDS; do`,
    `  if [ -z "$FIRST_ID" ]; then FIRST_ID="$CAND"; fi`,
    `  CAND_URL="https://\${CAND}-${port}.${DEVBRIDGE_TUNNEL_DOMAIN}"`,
    `  if probe_tunnel "$CAND_URL"; then`,
    `    SELECTED_URL="$CAND_URL"`,
    `    break`,
    `  fi`,
    `  # The FAIL detail pairs the first listed URL with the FIRST probe's reason —`,
    `  # PROBE_FAIL_REASON is overwritten per candidate and would misattribute.`,
    `  if [ -z "$FIRST_REASON" ]; then FIRST_REASON="$PROBE_FAIL_REASON"; fi`,
    `done`,
    `TUNNEL_URL="$SELECTED_URL"`,
    `if [ -n "$SELECTED_URL" ]; then`,
    `  echo "tunnel_url_accessible:PASS ($SELECTED_URL)"`,
    `  PASS=$((PASS+1))`,
    `elif [ -n "$FIRST_ID" ]; then`,
    `  echo "tunnel_url_accessible:FAIL (https://\${FIRST_ID}-${port}.${DEVBRIDGE_TUNNEL_DOMAIN} -> $FIRST_REASON)"`,
    `else`,
    `  echo "tunnel_url_accessible:FAIL (no tunnel)"`,
    `fi`,
    ``,
    `${`
TOTAL=$((TOTAL+1))
if [ -f "${outputPath}/qr.png" ]; then
  echo "qr_code:PASS"
  PASS=$((PASS+1))
else
  # Auto-detect cross-platform from project files (more reliable than frameworkType param)
  PROJ_DIR="/workspace/${project}"
  IS_CROSS=0
  if [ -f "$PROJ_DIR/manifest.json" ] || grep -qE '"@tarojs/taro"|"@dcloudio/uni-app"' "$PROJ_DIR/package.json" 2>/dev/null; then
    IS_CROSS=1
  fi
  if [ $IS_CROSS -eq 0 ] && ( [ -f "$PROJ_DIR/app.config.ts" ] || [ -f "$PROJ_DIR/app.config.js" ] ) && grep -qE "pages|tabBar" "$PROJ_DIR/app.config."* 2>/dev/null; then
    IS_CROSS=1
  fi

  if [ $IS_CROSS -eq 1 ]; then
    if [ -n "$TUNNEL_URL" ]; then
      curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$TUNNEL_URL" 2>/dev/null)" -o "${outputPath}/qr.png" 2>/dev/null
      chmod o+r "${outputPath}/qr.png" 2>/dev/null || true
      if [ -f "${outputPath}/qr.png" ] && [ -s "${outputPath}/qr.png" ]; then
        echo "qr_code:PASS (auto-generated)"
        PASS=$((PASS+1))
      else
        echo "qr_code:FAIL (QR generation failed)"
      fi
    else
      echo "qr_code:FAIL (no tunnel URL for QR generation)"
    fi
  else
    echo "qr_code:SKIP (not a cross-platform project)"
    TOTAL=$((TOTAL-1))
  fi
fi
`}`,
    `echo "SCORE:\${PASS}/\${TOTAL}"`,
    `echo "TUNNEL_URL:\${TUNNEL_URL:-}"`,
    `[ "\${PASS}" = "\${TOTAL}" ] && echo "VERDICT:COMPLETE" || echo "VERDICT:INCOMPLETE"`,
  ]
    .filter(Boolean)
    .join('\n');

  const result = await execOneShot(workspaceId, checkScript, username, timeoutMs);
  const stdout = String(result.stdout || '');
  const { checks, complete, score, publicUrl, missing, parseWarning } = parseDeployCheckOutput(stdout);

  const nextStepValue = !complete
    ? missing.includes('devbridge_tunnel') || missing.includes('tunnel_url_accessible')
      ? 'expose_via_devbridge'
      : missing.includes('nginx_serving')
        ? 'configure_nginx'
        : missing.includes('qr_code')
          ? 'generate_qr_code'
          : parseWarning
            ? 'review_raw_output'
            : 'review_checks'
    : 'complete';

  return {
    ok: true,
    complete,
    checkType: isCrossPlatform ? 'cross-platform' : 'standard',
    checks,
    score,
    publicUrl,
    missingSteps: missing.length > 0 ? missing.join(', ') : undefined,
    parseWarning,
    rawOutput: parseWarning ? stdout.trim() : undefined,
    nextStep: nextStepValue,
    remediation: nextStepValue === 'expose_via_devbridge' ? buildExposeRemediation(port) : undefined,
  };
}
