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
    pattern: /^echo "=== DEPLOY CHECK ==="$/,
    run: () => ({ stdout: DEPLOY_CHECK_ALL_PASS }),
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
    // upload_file reset: `rm -f "<tmp>"` (double-quoted path).
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
    // The resolve-script family (multi-line blobs): upload_project's
    // permission fixup opens with REAL_PATH=, deployNginx's config-write
    // blob opens with REAL_PROJECT= — both are readlink resolvers.
    intent: 'resolve-real-path',
    pattern: /^REAL_(PATH|PROJECT)=\$\(readlink .*$/,
    run: () => ({ stdout: '' }),
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
  {
    // deployNginx tunnel probe (version-aware shape, 2>/dev/null inside).
    intent: 'devbridge-active',
    pattern: /^\(devbridge list -j .*grep -q.*$/,
    run: () => ({ stdout: 'ACTIVE\n' }),
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
  'nginx_serving:PASS (port 8080)',
  'output_dir:PASS',
  'content_verified:PASS',
  'devbridge_tunnel:PASS',
  'tunnel_url_accessible:PASS',
  'qr_code:PASS',
  'SCORE:6/6',
  'TUNNEL_URL:https://e2e-tunnel-1-8080.devbridge-s2.hwtunnel.com',
  'VERDICT:COMPLETE',
].join('\n');

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
