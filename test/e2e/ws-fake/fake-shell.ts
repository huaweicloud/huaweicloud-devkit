// The fake shell: recognizes the product client's own command vocabulary
// and answers it. The marker formats (nonce framing) come from the
// PRODUCT's buildMarkers — single source of truth, cross-tier pinned by
// test/ws-exec-protocol.test.ts (feed buildShellCommands output through
// these recognizers; drift on either side reds the test).
import { createHash } from 'node:crypto';

import { buildMarkers } from '../../../plugins/huaweicloud-core/src/ws-exec/ws-exec-client.ts';

const MARKERS = buildMarkers('0000000000000000');

// The product's own marker prefixes (single source of truth — the golden
// test pins both sides together).
export const READY_PREFIX = MARKERS.readyPrefix;
export const DONE_PREFIX = MARKERS.donePrefix;

export interface ShellResult {
  intent: string;
  stdout: string;
  exitCode: number;
}

// Per-connection in-memory filesystem (one ws connection = one terminal =
// one shell; upload_file rides the persistent session, so its state must
// outlive a single exec). b64 temp files live as their appended text; the
// decode step materializes a Buffer; md5sum hashes real bytes — the same
// math the product's verification does.
export class FakeFs {
  private readonly files = new Map<string, Buffer>();
  // The fake machine's process table, reduced to what the tunnel relay
  // needs: ports a `python3 sandbox-file-server.py <port>` start has
  // "listened" on. The relay refuses any other dstPort (bounded surface —
  // dstPort is agent-influenced input).
  readonly servicePorts = new Set<number>();

  appendText(path: string, text: string): void {
    const prev = this.files.get(path);
    const chunk = Buffer.from(text, 'utf8');
    this.files.set(path, prev ? Buffer.concat([prev, chunk]) : chunk);
  }

  write(path: string, content: Buffer): void {
    this.files.set(path, content);
  }

  delete(path: string): void {
    this.files.delete(path);
  }

  read(path: string): Buffer | undefined {
    return this.files.get(path);
  }

  md5(path: string): string | null {
    const content = this.files.get(path);
    return content ? createHash('md5').update(content).digest('hex') : null;
  }
}

// Recognized-intent table — data, not branches. An unrecognized first line
// records intent 'unknown' (generic exit 0): the ws expectation channel
// gates zero-unknown, so a product script edit the fake no longer
// recognizes turns cases red instead of silently degrading.
interface IntentRow {
  intent: string;
  pattern: RegExp;
  run: (match: RegExpExecArray, fs: FakeFs) => { stdout: string; exitCode?: number };
}

const INTENT_TABLE: IntentRow[] = [
  {
    // deployFileServer's script write (b64 payload, single line). MUST
    // sit above `echo`: `echo '<b64>' | base64 -d > …` is this row, not a
    // plain echo (first match wins).
    intent: 'write-fileserver-script',
    pattern: /^echo '([^']*)' \| base64 -d > (.+)$/,
    run: (m, fs) => {
      fs.write(m[2]!, Buffer.from(m[1]!, 'base64'));
      return { stdout: '' };
    },
  },
  {
    // deployCheck's big script, anchored on its stable first line — NOT
    // full text (benign script edits keep matching; semantic drift breaks
    // the parse pin instead). Answers the all-pass marker vocabulary.
    intent: 'deploy-check-script',
    // #999: the data-disk PATH export rides the first line (a fresh one-shot
    // shell cannot see /workspace/.local/bin otherwise); the echo follows.
    pattern: /^export PATH="\/workspace\/.local\/bin:\$HOME\/\.huawei\/bin:\$PATH"; echo "=== DEPLOY CHECK ==="$/,
    run: () => ({ stdout: DEPLOY_CHECK_ALL_PASS }),
  },
  {
    // exposeTunnel's auth waterfall. Anchored on its EXACT first line —
    // the double-quoted PATH export is unique to the probe script (the
    // connect flow's PATH export is unquoted) — and MUST sit above the
    // generic `export-path` row or the probe would match it and answer
    // empty stdout (authMode '' → ok:false UNKNOWN, silently wrong).
    intent: 'devbridge-auth-probe',
    pattern: /^export PATH="\/workspace\/.local\/bin:\$HOME\/\.huawei\/bin:\$PATH"$/,
    run: () => ({ stdout: DEVBRIDGE_AUTH_KEYRING_STDOUT }),
  },
  {
    // exposeTunnel's #998 version read-back one-shot: the data-disk PATH export
    // riding the same line as the DB_VERSION echo (the field grammar — the
    // auth probe's $-anchored row cannot match it, and the generic export-path
    // row would silently answer '').
    intent: 'devbridge-version-probe',
    pattern: /^export PATH="\/workspace\/.local\/bin:\$HOME\/\.huawei\/bin:\$PATH"; echo "DB_VERSION=/,
    run: () => ({ stdout: 'DB_VERSION=0.2.2-release\n' }),
  },
  {
    // exposeTunnel's expose script AND its retry-cleanup blob — the latter
    // is a single ;-joined line whose prefix is the same pkill, so the
    // anchor must NOT be $-terminated. Synthesizes a healthy tunnel
    // answer for both callers. #999: the export rides the same first line as
    // the pkill (a leading standalone export would collide with the auth
    // probe's $-anchored row — first-line recognition cannot tell them apart).
    intent: 'devbridge-expose-script',
    pattern: /^export PATH="\/workspace\/\.local\/bin:\$HOME\/\.huawei\/bin:\$PATH"; pkill -f "devbridge host"/,
    run: () => ({ stdout: DEVBRIDGE_EXPOSE_OK_STDOUT }),
  },
  {
    // exposeTunnel's independent re-verify (#919): a fresh-session GET of the
    // exposed URL, emitted by buildDevbridgeVerifyScript. Synthesizes the
    // healthy persistent answer (HTTP 200, body is NOT "tunnel not found").
    intent: 'devbridge-verify-script',
    pattern: /^VERIFY_CODE=\$\(curl -s --noproxy '\*' -o \/tmp\/devbridge_verify_body /,
    run: () => ({ stdout: DEVBRIDGE_VERIFY_OK_STDOUT }),
  },
  {
    // The AUTO-ENROLL read one-shot of exposeTunnel (the tunnel-persistence
    // port): reads the INSTALLED watchdog's TUNNELS line so the new tunnel
    // MERGES into existing coverage. Empty list — no prior watchdog.
    intent: 'devbridge-keepalive-read',
    pattern: /^LINE=\$\(grep -m1 '\^TUNNELS=' \/tmp\/tunnel-keepalive\.sh/,
    run: () => ({ stdout: 'DB_KEEPALIVE_TUNNELS=\n' }),
  },
  {
    // The AUTO-ENROLL install one-shot (buildDevbridgeKeepaliveScript, also
    // huaweicloud_sandbox_keepalive_watchdog's body). #999 anchor doctrine:
    // the export rides the pkill line, so this row can sit above the generic
    // export-path row — a standalone export first line was byte-identical to
    // the auth probe's and the install was misread as one (measured on the
    // e2e legs: enrollment judged failed off the probe's answer, and the
    // retry-teaching warning inflated the auth-probe count). Success grammar
    // verbatim: syntax 0, a live PID, the log path.
    intent: 'devbridge-keepalive-install',
    pattern: /^export PATH="\/workspace\/\.local\/bin:\$HOME\/\.huawei\/bin:\$PATH"; pkill -f "tunnel-keepalive\.sh"/,
    run: () => ({
      stdout: 'DB_KEEPALIVE_SYNTAX=0\nDB_KEEPALIVE_PID=4242\nDB_KEEPALIVE_LOG=/tmp/tunnel-keepalive.log\n',
    }),
  },
  {
    // deployNginx's tunnel-activity probe (the version-aware #999 shape: the
    // data-disk PATH export riding the same first line as the subshell
    // probe). Sits ABOVE the generic export-path row or the probe would be
    // swallowed there, answer '', and the tool would report a phantom
    // "No active DevBridge tunnel" warning (measured on both e2e legs).
    intent: 'devbridge-active',
    pattern: /^export PATH="\/workspace\/\.local\/bin:\$HOME\/\.huawei\/bin:\$PATH"; \(devbridge list -j /,
    run: () => ({ stdout: 'ACTIVE\n' }),
  },
  {
    intent: 'echo',
    pattern: /^echo\s+(.*)$/,
    run: (m) => ({ stdout: `${m[1]}\n` }),
  },
  {
    // handleConnect's best-effort cleanup (session-manager.ts).
    intent: 'devbridge-delete-all',
    pattern: /^devbridge\s+delete-all\b.*$/,
    run: () => ({ stdout: '' }),
  },
  {
    // handleConnect's PATH export for later devbridge calls.
    intent: 'export-path',
    pattern: /^export\s+PATH=.*$/,
    run: () => ({ stdout: '' }),
  },
  {
    // upload_file reset (#953): `mkdir -p "$(dirname "<remote>")" && rm -f "<tmp>"`
    // — the compound form since the remote-parent-mkdir fix; the `rm` intent
    // is preserved so the case expectation and the fs.delete semantics carry
    // over unchanged.
    intent: 'rm',
    pattern: /^mkdir -p "\$\(dirname "[^"]*"\)" && rm -f "([^"]+)"$/,
    run: (m, fs) => {
      fs.delete(m[1]!);
      return { stdout: '' };
    },
  },
  {
    // upload_file reset, pre-#953 shape: bare `rm -f "<tmp>"`. Kept so
    // hand-written older scripts still recognize (the protocol pin feeds
    // both shapes).
    intent: 'rm',
    pattern: /^rm -f "([^"]+)"$/,
    run: (m, fs) => {
      fs.delete(m[1]!);
      return { stdout: '' };
    },
  },
  {
    // upload_file batches: `printf '%s' '<b64>' >> "<tmp>"` — the b64
    // alphabet carries no quotes, and the payload rides the FIRST line.
    intent: 'printf-append',
    pattern: /^printf '%s' '([^']*)' >> "([^"]+)"$/,
    run: (m, fs) => {
      fs.appendText(m[2]!, m[1]!);
      return { stdout: '' };
    },
  },
  {
    // upload_file decode: `base64 -d "<tmp>" > "<remote>" && rm -f "<tmp>"`.
    intent: 'base64-decode',
    pattern: /^base64 -d "([^"]+)" > "([^"]+)" && rm -f "([^"]+)"$/,
    run: (m, fs) => {
      const appended = fs.read(m[1]!);
      if (appended === undefined) return { stdout: '', exitCode: 1 };
      fs.write(m[2]!, Buffer.from(appended.toString('utf8'), 'base64'));
      fs.delete(m[3]!);
      return { stdout: '' };
    },
  },
  {
    // upload_file verify: `md5sum "<remote>"` — real md5 over the decoded
    // bytes; a mismatch makes the product THROW, which is the case's gate.
    intent: 'md5sum',
    pattern: /^md5sum "([^"]+)"$/,
    run: (m, fs) => {
      const md5 = fs.md5(m[1]!);
      if (md5 === null) return { stdout: '', exitCode: 1 };
      return { stdout: `${md5}  ${m[1]}\n` };
    },
  },
  {
    // deployFileServer's kill sweep (deploy + cleanup share the shape).
    intent: 'kill-fileserver',
    pattern: /^kill \$\(cat .*sandbox-file-server\.pid.*$/,
    run: () => ({ stdout: '' }),
  },
  {
    // deployFileServer's start: registers the "listening" port — the
    // tunnel relay whitelists exactly these (refuses everything else).
    intent: 'start-fileserver',
    pattern: /^python3 .*sandbox-file-server\.py (\d+)(?: \S+)? & echo \$! > .*$/,
    run: (m, fs) => {
      fs.servicePorts.add(Number(m[1]));
      return { stdout: '' };
    },
  },
  {
    // upload_project's extract step.
    intent: 'extract-archive',
    pattern: /^mkdir -p "([^"]+)" && tar -xzf "([^"]+)" -C "([^"]+)" && rm -f "([^"]+)"$/,
    run: (m, fs) => {
      fs.delete(m[2]!);
      return { stdout: '' };
    },
  },
  {
    // upload_project's permission fixup opens with REAL_PATH= — a readlink
    // resolver, no output expected.
    intent: 'resolve-real-path',
    pattern: /^REAL_PATH=\$\(readlink .*$/,
    run: () => ({ stdout: '' }),
  },
  {
    // deployNginx's config-write blob (resolve script + tee heredoc + embedded
    // reload + chmod fixups + the A1 (#935) verify block, one exec) opens with
    // REAL_PROJECT=. The verify block's success markers must be synthesized —
    // deployNginx's verdict reads them (DB_NGINX_CONFIG_OK, DB_NGINX_T=PASS;
    // the OK marker is presence-required since the interrogate-r2 inversion).
    intent: 'deploy-nginx-config-write',
    pattern: /^REAL_PROJECT=\$\(readlink .*$/,
    run: () => ({ stdout: 'DB_NGINX_CONFIG_OK=1\nDB_NGINX_T=PASS\n' }),
  },
  {
    // Agent-initiated verification (`ls /workspace/myproject` after an
    // upload, etc.): improvisation, not fake drift — answer generically.
    intent: 'ls',
    pattern: /^ls\b.*$/,
    run: () => ({ stdout: '' }),
  },
  {
    // deployNginx presence probe — the gate that MATTERS: without
    // INSTALLED the product throws (nginx MISSING is a real failure path).
    intent: 'nginx-installed',
    pattern: /^command -v nginx >\/dev\/null.*$/,
    run: () => ({ stdout: 'INSTALLED\n' }),
  },
  {
    // deployNginx port scan (up to base+9): always FREE on the fake.
    intent: 'port-free',
    pattern: /^ss -tlnp .*echo "IN_USE" \|\| echo "FREE"$/,
    run: () => ({ stdout: 'FREE\n' }),
  },
  {
    // Standalone reload tolerance (deployNginx's reload is EMBEDDED in the
    // config blob, keyed by its resolve-script first line instead).
    intent: 'nginx-reload',
    pattern: /^sudo killall -9 nginx/,
    run: () => ({ stdout: '' }),
  },
];

export function runShellCommand(blob: string, fs: FakeFs): ShellResult {
  const firstLine = blob.split('\n', 1)[0] ?? '';
  for (const row of INTENT_TABLE) {
    const match = row.pattern.exec(firstLine);
    if (match) {
      const { stdout, exitCode } = row.run(match, fs);
      return { intent: row.intent, stdout, exitCode: exitCode ?? 0 };
    }
  }
  return { intent: 'unknown', stdout: '', exitCode: 0 };
}

// --- nonce recognition (product vocabulary, exported for the golden pins) ---

// The deploy-check marker vocabulary the fake synthesizes — pinned
// BOTH ways by test/ws-exec-protocol.test.ts: this exact output must parse
// through the product's parseDeployCheckOutput (complete, 6/6, publicUrl),
// and the product's script must keep emitting this grammar.
export const DEPLOY_CHECK_ALL_PASS = [
  'nginx_serving:PASS (port 8080, HTTP 200)',
  'output_dir:PASS',
  'content_verified:PASS',
  'devbridge_tunnel:PASS',
  'tunnel_url_accessible:PASS (https://e2e-tunnel-1-8080.devbridge-s2.hwtunnel.com)',
  'qr_code:PASS',
  'SCORE:6/6',
  'TUNNEL_URL:https://e2e-tunnel-1-8080.devbridge-s2.hwtunnel.com',
  'VERDICT:COMPLETE',
].join('\n');

// The devbridge auth/expose vocabularies the fake synthesizes — pinned the
// same both-ways contract through parseDevbridgeAuthOutput /
// parseDevbridgeExposeOutput in test/ws-exec-protocol.test.ts.
export const DEVBRIDGE_AUTH_KEYRING_STDOUT = ['DB_AUTH_MODE=API_KEY_KEYRING'].join('\n');

export const DEVBRIDGE_EXPOSE_OK_STDOUT = [
  'DB_HOST_LOG=',
  'Tunnel URL: https://e2e-tunnel-1-8080.devbridge-s2.hwtunnel.com',
  'DB_TUNNEL_URL=https://e2e-tunnel-1-8080.devbridge-s2.hwtunnel.com',
  'DB_HTTP_CODE=200',
  'DB_EXPIRY_HOURS=72',
  'DB_TUNNEL_BODY=',
  'DB_QUOTA_ERROR=0',
  'DB_MIGRATION=0',
].join('\n');

// The #919 re-verify vocabulary (buildDevbridgeVerifyScript's output grammar) —
// pinned both-ways through parseDevbridgeVerifyOutput the same way.
export const DEVBRIDGE_VERIFY_OK_STDOUT = ['DB_VERIFY_HTTP_CODE=200', 'DB_VERIFY_NOT_FOUND=0'].join('\n');

// The client's ready command embeds the nonce as the printf argument
// `'__WS_EXEC_READY_' '<nonce>__'`.
export function extractReadyNonce(readyCommand: string): string | null {
  const re = new RegExp(`${MARKERS.readyPrefix}'\\s+'([0-9a-f]+)__'`);
  const hit = re.exec(readyCommand);
  return hit ? hit[1]! : null;
}

// The client's done command embeds it as `'__WS_EXEC_DONE_' '<nonce>__:'`.
export function extractDoneNonce(doneLine: string): string | null {
  const re = new RegExp(`${MARKERS.donePrefix}'\\s+'([0-9a-f]+)__:`);
  const hit = re.exec(doneLine);
  return hit ? hit[1]! : null;
}

// A line is the done-terminator when it starts with the client's rc probe.
export function isDoneCommandLine(line: string): boolean {
  return line.startsWith('__ws_exec_rc=$?');
}

export function readyMarkerFor(nonce: string): string {
  return `\n${MARKERS.readyPrefix}${nonce}__\n`;
}

export function doneMarkerFor(nonce: string, exitCode: number): string {
  return `\n${MARKERS.donePrefix}${nonce}__:${exitCode}\n`;
}
