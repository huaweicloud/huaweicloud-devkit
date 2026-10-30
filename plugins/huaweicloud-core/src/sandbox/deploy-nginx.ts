// The nginx deploy orchestration, extracted from session-manager: the
// #738 port-resolution helpers (conflict/drift warnings, resolveProxyNodePort)
// and deployNginx itself (installed check, port auto-increment, the three
// nginx templates, the chmod fixups, the tunnel-activity probe, and the #935
// write-verification fold-in from deploy-nginx-verify.ts). All exec goes
// through the one-shot surface in hwlink-connection.ts; session-manager.ts
// re-exports the public names as the stable public face.

import { execOneShot } from './hwlink-connection.ts';
import {
  evaluateDeployNginxVerify,
  parseDeployNginxVerifyOutput,
  resolveNginxConfigPath,
} from './deploy-nginx-verify.ts';

interface DeployNginxOptions {
  nginxType?: string;
  port?: number;
  project?: string;
  outputDir?: string;
  nodePort?: number;
  publicPort?: number;
  configName?: string;
}

interface DeployNginxResult {
  ok: boolean;
  error?: string;
  nginxType: string;
  port: number;
  nodePort: number | undefined;
  outputPath: string;
  projectPath: string;
  configPath: string;
  verification?: { configPath: string; nginxTest: string };
  exitCode: number;
  stdout: string;
  nextStep: string;
  warning: string | undefined;
}

export function formatPortConflictWarning(basePort: number, targetPort: number): string | undefined {
  return targetPort !== basePort ? `Port ${basePort} is in use — auto-assigned port ${targetPort}` : undefined;
}

export function formatPortDriftWarning(basePort: number, targetPort: number): string | undefined {
  if (targetPort === basePort) return undefined;
  return `Port ${basePort} was occupied — nginx now listens on port ${targetPort}. Any DevBridge tunnel bound to port ${basePort} is detached: run "devbridge port create <tunnelId> -p ${targetPort} --protocol http -a" and restart "devbridge host" for the new port.`;
}

export async function resolveProxyNodePort(
  nodePort: number | undefined,
  nginxListenPort: number,
  isPortInUse: (candidate: number) => Promise<boolean>,
): Promise<number> {
  const baseCandidate = nodePort && nodePort !== nginxListenPort ? nodePort : nginxListenPort + 1;
  let candidate = baseCandidate;
  for (
    let attempt = 0;
    attempt < 10 && (candidate === nginxListenPort || (await isPortInUse(candidate)));
    attempt += 1
  ) {
    candidate += 1;
  }
  return candidate;
}

export async function deployNginx(
  workspaceId: string,
  { nginxType, port, project, outputDir, nodePort, publicPort, configName }: DeployNginxOptions,
  username = 'root',
  timeoutMs = 60000,
): Promise<DeployNginxResult> {
  if (!workspaceId) {
    throw new Error('sandbox deploy nginx: workspace_id is required.');
  }
  if (!nginxType || !port || !project || !outputDir) {
    throw new Error('sandbox deploy nginx: nginxType, port, project, and outputDir are required.');
  }

  const nginxCheck = await execOneShot(
    workspaceId,
    'command -v nginx >/dev/null 2>&1 && echo "INSTALLED" || echo "MISSING"',
    username,
    10000,
  );
  if (!String(nginxCheck.stdout || '').includes('INSTALLED')) {
    throw new Error(
      'sandbox deploy nginx: nginx is not installed. Install it first:\n' +
        '  Detect OS: source /etc/os-release && echo $ID\n' +
        '  apt: sudo apt-get update -qq && sudo apt-get install -y -qq nginx\n' +
        '  yum: sudo yum install -y nginx\n' +
        '  dnf: sudo dnf install -y nginx\n' +
        'Alternatively, skip nginx and use Python HTTP server (see nginx-templates.md).',
    );
  }

  const listenPort = publicPort || port;
  const basePort = nginxType === 'proxy' ? listenPort : port;

  let targetPort = basePort;
  const maxPortAttempts = 10;
  for (let offset = 0; offset < maxPortAttempts; offset += 1) {
    targetPort = basePort + offset;
    try {
      const portCheck = await execOneShot(
        workspaceId,
        `ss -tlnp 2>/dev/null | grep -q ":${targetPort} " && echo "IN_USE" || echo "FREE"`,
        username,
        10000,
      );
      if (!String(portCheck.stdout || '').includes('IN_USE')) break;
    } catch {
      // a failed probe reads as in-use; conservatively try the next port
    }
    if (offset === maxPortAttempts - 1) {
      throw new Error(
        `sandbox deploy nginx: all ports ${basePort}-${basePort + maxPortAttempts - 1} are in use. Free a port and try again.`,
      );
    }
  }

  const effectiveNodePort =
    nginxType === 'proxy'
      ? await resolveProxyNodePort(nodePort, targetPort, async (candidate) => {
          const portCheck = await execOneShot(
            workspaceId,
            `ss -tlnp 2>/dev/null | grep -q ":${candidate} " && echo "IN_USE" || echo "FREE"`,
            username,
            10000,
          );
          return String(portCheck.stdout || '').includes('IN_USE');
        })
      : undefined;

  const projectPath = `/workspace/${project}`;
  const outputPath = outputDir.startsWith('/') ? outputDir : `${projectPath}/${outputDir}`;

  const resolveScript = `REAL_PROJECT=$(readlink -f "${projectPath}" 2>/dev/null || echo "${projectPath}")
REAL_OUTPUT="${outputPath}"
if [ "\${REAL_PROJECT}" != "${projectPath}" ]; then
  REL_OUTPUT=$(echo "${outputDir}" | sed "s|${projectPath}/||")
  REAL_OUTPUT="\${REAL_PROJECT}/\${REL_OUTPUT}"
fi`;

  const templates: Record<string, string> = {
    spa: `server {
    listen ${targetPort};
    root ${outputPath};
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1h;
        add_header Cache-Control "public, immutable";
    }
}`,
    proxy: `server {
    listen ${targetPort};
    server_name _;
    large_client_header_buffers 4 32k;

    location / {
        proxy_pass http://127.0.0.1:${effectiveNodePort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 60s;
        proxy_buffer_size 128k;
        proxy_buffers 4 256k;
        proxy_busy_buffers_size 256k;
    }
}`,
    static: `server {
    listen ${targetPort};
    root ${outputPath};
    index index.html;

    location / {
        try_files $uri $uri.html $uri/ =404;
        autoindex off;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1h;
        add_header Cache-Control "public, immutable";
    }
}`,
  };

  const config = templates[nginxType];
  if (!config) {
    throw new Error(`sandbox deploy nginx: unknown nginxType "${nginxType}". Must be one of: spa, proxy, static`);
  }

  // A1 (#935): configName is normalized to a bare filename so a path-shaped
  // value can never produce `/etc/nginx/conf.d//root/xxx.conf` again.
  const configPath = resolveNginxConfigPath(configName, project);

  const cmd = [
    resolveScript,
    `sudo mkdir -p /etc/nginx/conf.d`,
    `sudo tee ${configPath} > /dev/null << 'NGINX_EOF'`,
    config,
    `NGINX_EOF`,
    `# Resolve symlinks for chmod (chmod does not follow symlinks on Linux)`,
    `chmod -R o+rX "$REAL_PROJECT" 2>/dev/null || true`,
    `find "$REAL_PROJECT" -type d -exec chmod o+x {} \\; 2>/dev/null || true`,
    `find "$REAL_PROJECT" -type f -path "*/node_modules/.bin/*" -exec chmod +x {} \\; 2>/dev/null || true`,
    `if pgrep -x nginx > /dev/null 2>&1; then sudo killall -9 nginx 2>/dev/null; sleep 1; fi
    sudo nginx`,
    `# A1 (#935): verify the config write took effect before reporting success`,
    `NGINX_CONFIG_PATH=${configPath}`,
    `# Presence-inverted markers (interrogate round 2): the OK marker is emitted on
    # success and the MISSING marker on failure, so EVERY marker is presence-
    # required downstream — a selectively mangled escape sequence that swallows
    # one marker line can only ever read as the FAILURE direction, never as a
    # false success (the #935 defect this block exists to prevent).`,
    `if [ -f "$NGINX_CONFIG_PATH" ]; then echo "DB_NGINX_CONFIG_OK=1"; else echo "DB_NGINX_CONFIG_MISSING=1"; fi`,
    `NGINX_T_OUTPUT=$(sudo nginx -t 2>&1 || true)`,
    `if echo "$NGINX_T_OUTPUT" | grep -Eq "syntax is ok|test is successful"; then echo "DB_NGINX_T=PASS"; else echo "DB_NGINX_T=FAIL"; echo "$NGINX_T_OUTPUT" | sed "s/^/DB_NGINX_T_OUTPUT: /"; fi`,
  ].join('\n');

  const result = await execOneShot(workspaceId, cmd, username, timeoutMs);

  let tunnelActive = false;
  try {
    // Version-aware: devbridge 0.1.x exposes JSON via `list -j`; 0.2.x removed -j and
    // prints a table whose data rows start with the 8-char base32 tunnel ID.
    // #999: the data-disk-first PATH — a fresh one-shot shell does not inherit
    // any prior export, and after the Layer-3 install + dedup (or a reboot) the
    // only surviving binary lives at /workspace/.local/bin.
    const tunnelCheck = await execOneShot(
      workspaceId,
      'export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; (devbridge list -j 2>/dev/null | grep -q \'"tunnelId"\' || devbridge list 2>/dev/null | grep -Eq \'^[a-z2-7]{8}[[:space:]]\') && echo "ACTIVE" || echo "INACTIVE"',
      username,
      10000,
    );
    tunnelActive = String(tunnelCheck.stdout || '').includes('ACTIVE');
  } catch {
    // a failed probe leaves tunnelActive false; the result then carries the incomplete-deployment warning
  }

  const warning =
    [
      !tunnelActive
        ? 'No active DevBridge tunnel — deployment is incomplete. Proceed to Step 7 to expose the app.'
        : undefined,
      formatPortConflictWarning(basePort, targetPort),
      tunnelActive ? formatPortDriftWarning(basePort, targetPort) : undefined,
    ]
      .filter(Boolean)
      .join(' | ') || undefined;

  // A1 (#935): verify the config write before reporting success. A deploy
  // script exit of 0 alone is NOT proof — the tee write can fail silently and
  // nginx -t can reject the config. Any verification failure returns ok:false
  // with an explicit, actionable error.
  const verify = parseDeployNginxVerifyOutput(result.stdout);
  const verdict = evaluateDeployNginxVerify(result, verify, configPath);
  if (!verdict.ok) {
    return {
      ok: false,
      error: verdict.error,
      nginxType,
      port: targetPort,
      nodePort: effectiveNodePort || undefined,
      outputPath,
      projectPath,
      configPath,
      exitCode: result.exitCode,
      stdout: result.stdout,
      nextStep: 'fix_and_retry',
      warning,
    };
  }

  return {
    ok: true,
    nginxType,
    port: targetPort,
    nodePort: effectiveNodePort || undefined,
    outputPath,
    projectPath,
    configPath,
    verification: { configPath, nginxTest: verify.nginxTest },
    exitCode: result.exitCode,
    stdout: result.stdout,
    nextStep: 'expose_via_devbridge',
    warning,
  };
}
