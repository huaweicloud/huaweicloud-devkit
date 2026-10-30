import type { CaseFixtures, E2eCase, Expectation } from '../types.ts';

// Fake credentials for the HTTP-boundary packs. These are fixture values,
// never real secrets; the http fake answers them regardless of content.
// Shared with core.ts's voucher-bearing cases: the S1 vault seed that lets
// voucher_status reach the local HTTP fake instead of failing at the
// credential gate, and the claimed=true status response that puts it on its
// silent path ("claimed, do not disturb") so the agent moves on to the
// actual request.
export const S1_SEED = JSON.stringify(
  { ak: 'E2E_M3_AK', sk: 'E2E_M3_SK', securityToken: '', region: 'cn-north-4' },
  null,
  2,
);

export const VOUCHER_CLAIMED_RESPONSE = {
  path: '/voucher/status',
  method: 'GET',
  status: 200,
  body: { claimed: true, voucherId: 'vou-e2e-001', amount: 50, status: 'ACTIVE' },
};

// KooCLI current-profile config so persistCredentials can resolve a managed
// profile and run `hcloud configure set` (unresolved → status 'partial',
// no configure argv — the reviewer-verified mechanism).
const KOOLCLI_SEED = JSON.stringify(
  {
    current: 'deploy',
    profiles: [{ name: 'deploy', accessKeyId: 'OLD_AK', secretAccessKey: 'OLD_SK', region: 'cn-north-4' }],
  },
  null,
  2,
);

export const authCases: E2eCase[] = [
  {
    id: 'auth-switch-persist-writes-stores',
    pack: 'auth',
    prompt:
      '把我的华为云凭证持久化到本地:AK 的字面值就是字符串 E2E_M3_AK,SK 的字面值就是字符串 E2E_M3_SK(直接把这两串字符作为凭证值传给工具参数,它们不是环境变量名,不要去查找 .env 或环境),区域 cn-north-4。用 huaweicloud_auth_switch 的 action=persist 完成,然后把持久化结果(S1 文件、OBS 配置、KooCLI profile 同步状态)告诉我。',
    fixtures: {
      home: {
        '.hcloud/config.json': KOOLCLI_SEED,
      },
      hcloud: {
        responses: [],
        // refreshUserHashAfterAuthChange fires hdkitGenerateUserHash against
        // the http fake (404, best-effort) — no hcloud call needed here, but
        // `configure set` must answer exit 0 (the fake's default).
      },
    },
    expect: [
      // ak/sk arrive in the trace redacted — match only the non-secret keys.
      {
        kind: 'toolCall',
        name: 'huaweicloud_auth_switch',
        args: { action: 'persist', region: 'cn-north-4' },
        ok: true,
      },
      {
        kind: 'hcloud',
        head: ['configure', 'set'],
        flags: { 'cli-profile': 'deploy', 'cli-access-key': 'E2E_M3_AK', 'cli-region': 'cn-north-4' },
        times: { min: 1, max: 1 },
      },
      { kind: 'file', path: '.obsutilconfig', contains: 'ak=E2E_M3_AK' },
      { kind: 'file', path: '.config/huaweicloud/credentials.json', contains: 'cn-north-4' },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['persist', '持久化', 'ok'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
];

export const voucherCases: E2eCase[] = [
  {
    id: 'voucher-status-claimed',
    pack: 'voucher',
    prompt: '查询我的华为云开发者代金券领取状态,告诉我是否已领取。',
    fixtures: {
      home: {
        '.config/huaweicloud/credentials.json': S1_SEED,
      },
      http: {
        responses: [VOUCHER_CLAIMED_RESPONSE],
      },
    },
    expect: [
      { kind: 'toolCall', name: 'huaweicloud_voucher_status', ok: true },
      { kind: 'http', method: 'GET', path: '/voucher/status', times: { min: 1, max: 2 } },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['已领取', 'claimed', '领取'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
  {
    id: 'voucher-claim-posts',
    pack: 'voucher',
    prompt: '帮我领取华为云开发者代金券(如果还没领取的话),把领取结果告诉我。',
    fixtures: {
      home: {
        '.config/huaweicloud/credentials.json': S1_SEED,
      },
      http: {
        responses: [
          {
            path: '/voucher/status',
            method: 'GET',
            status: 200,
            body: { claimed: false },
          },
          {
            path: '/voucher/claim',
            method: 'POST',
            status: 200,
            body: { claimed: true, voucherId: 'vou-e2e-002', amount: 50 },
          },
        ],
      },
    },
    expect: [
      // hdkitVoucherClaim swallows errors into {claimed:false,...} (still
      // ok:true in the trace), so the POST recording is the gate and the
      // toolCall is liveness.
      { kind: 'http', method: 'POST', path: '/voucher/claim', times: { min: 1, max: 2 } },
      { kind: 'toolCall', name: 'huaweicloud_voucher_claim', ok: true },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['领取成功', 'claimed', 'vou-e2e-002'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
];

export const sandboxCases: E2eCase[] = [
  {
    // Consent protocol: 403 HDKIT_NOT_REALNAME must stop the agent at the
    // real-name wall — it may not sign the agreement on the user's behalf.
    id: 'sandbox-checkuser-realname-consent',
    pack: 'sandbox',
    prompt: '帮我检查是否满足华为云沙箱的使用条件,如果满足就连接沙箱。',
    fixtures: {
      home: {
        '.config/huaweicloud/credentials.json': S1_SEED,
      },
      http: {
        responses: [
          {
            path: '/check-user',
            method: 'GET',
            status: 403,
            body: { code: 'HDKIT_NOT_REALNAME', message: 'real-name verification is required before sandbox use' },
          },
        ],
      },
    },
    expect: [
      { kind: 'http', method: 'GET', path: '/check-user', times: { min: 1, max: 2 } },
      { kind: 'noToolCall', name: 'huaweicloud_sandbox_sign_agreement' },
      { kind: 'noToolCall', name: 'huaweicloud_sandbox_connect' },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['实名', 'real-name', 'realname', '认证'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
  {
    // connect returns a session; the ws-exec boundary stays unfaked and
    // fails fast (hwlink 404 on the local fake, best-effort caught;
    // transferGitRepo is a no-op without git args — reviewer-verified).
    id: 'sandbox-connect-session',
    pack: 'sandbox',
    prompt: '连接华为云沙箱(不需要配置 git 仓库),把返回的会话信息告诉我。',
    fixtures: {
      home: {
        '.config/huaweicloud/credentials.json': S1_SEED,
      },
      http: {
        responses: [
          {
            path: '/check-user',
            method: 'GET',
            status: 200,
            body: { realnameVerified: true, agreementSigned: true, userHash: 'hash-e2e-001' },
          },
          {
            path: '/connect',
            method: 'POST',
            status: 200,
            body: {
              session_id: 'sess-e2e-001',
              dev_stage_id: 'ds-e2e-001',
              connection_id: 'conn-e2e-001',
              connection_address: 'e2e-connection.example.com',
              expiresAt: '2099-01-01T00:00:00Z',
            },
          },
        ],
      },
    },
    expect: [
      { kind: 'toolCall', name: 'huaweicloud_sandbox_connect', ok: true },
      { kind: 'http', method: 'POST', path: '/connect', times: { min: 1, max: 2 } },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['sess-e2e-001', 'ds-e2e-001', 'session', '会话'] } }],
    budget: { timeoutMs: 300_000, attempts: 2 },
  },
  {
    // The only HW_IAM_ENDPOINT consumer: sandbox_credentials validates
    // against the fake IAM before injecting via hdkitservice.
    id: 'sandbox-credentials-iam-validated',
    pack: 'sandbox',
    prompt: '给华为云沙箱工作区 dev_stage_id=ds-e2e-002 注入临时凭证(标准流程:先校验再注入),把注入结果告诉我。',
    fixtures: {
      home: {
        '.config/huaweicloud/credentials.json': S1_SEED,
      },
      http: {
        responses: [
          {
            path: '/v3/projects',
            method: 'GET',
            status: 200,
            body: { projects: [{ id: 'proj-e2e-001', name: 'cn-north-4' }] },
          },
          {
            path: '/credentials',
            method: 'POST',
            status: 200,
            body: {
              ak: 'STS_TEMP_AK',
              sk: 'STS_TEMP_SK',
              securitytoken: 'STS_TEMP_TOKEN',
              expiresAt: '2099-01-01T00:00:00Z',
            },
          },
        ],
      },
    },
    expect: [
      { kind: 'toolCall', name: 'huaweicloud_sandbox_credentials', args: { dev_stage_id: 'ds-e2e-002' }, ok: true },
      { kind: 'http', method: 'GET', path: '/v3/projects', times: { min: 1, max: 2 } },
      { kind: 'http', method: 'POST', path: '/credentials', times: { min: 1, max: 2 } },
      // Validation before injection: the IAM read must precede the
      // hdkitservice credential write on the HTTP channel.
      {
        kind: 'sequence',
        channel: 'http',
        steps: [
          { method: 'GET', path: '/v3/projects' },
          { method: 'POST', path: '/credentials' },
        ],
      },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['注入', 'inject', 'credential', '凭证'] } }],
    budget: { timeoutMs: 300_000, attempts: 2 },
  },
];

// ws-exec pair over the local hwlink fake. Connection-count arithmetic is
// the mechanism proof: connect runs one one-shot (devbridge cleanup, its own
// connection) plus the CACHED export-PATH session (a second connection) —
// so two exec_with_session calls that REUSE the session leave the count at
// 2, while a close_session in between forces a cache miss and a third.
const WS_DEV_STAGE = 'ds-e2e-ws-001';

// Shared expectation fragments for the ws trio (dedup, not abstraction):
// every case gates the connect POST and the zero-unknown drift guard.
const CONNECT_POST: Expectation = { kind: 'http', method: 'POST', path: '/connect', times: { min: 1, max: 2 } };
const ZERO_UNKNOWN: Expectation = { kind: 'ws', intent: 'unknown', times: { min: 0, max: 0 } };

function wsSandboxFixtures(): CaseFixtures {
  return {
    ws: true,
    home: {
      '.config/huaweicloud/credentials.json': S1_SEED,
    },
    http: {
      responses: [
        { path: '/check-user', method: 'GET', status: 200, body: { realnameVerified: true, agreementSigned: true } },
        {
          path: '/connect',
          method: 'POST',
          status: 200,
          body: { session_id: WS_DEV_STAGE, dev_stage_id: WS_DEV_STAGE },
        },
        {
          path: `/open-api-public/v1/devenvs/${WS_DEV_STAGE}/connections`,
          method: 'POST',
          status: 200,
          body: { error_code: '0000', result: { connection_id: 'conn-e2e-ws-1' } },
        },
        {
          path: `/open-api-public/v1/devenvs/${WS_DEV_STAGE}/connections/conn-e2e-ws-1`,
          method: 'GET',
          status: 200,
          body: { result: { connection_info: { url: '{wsUrl}', extensions: { source: 778899 } } } },
        },
        // session_id and dev_stage_id are the SAME value on purpose: the
        // agent may pass either as workspace_id, and identical ids keep
        // the session-cache key and the connection endpoint stable no
        // matter which one the LLM picks.
      ],
    },
  };
}

export const wsSandboxCases: E2eCase[] = [
  {
    // expose_tunnel: the verdict lands in the tool RESULT, so the honest
    // gates are script DELIVERY and recognition on the ws channel plus
    // toolCall ok — the output grammar is pinned cross-tier in
    // ws-exec-protocol.test.ts (fake synthesis ↔ parseDevbridge*Output).
    id: 'sandbox-expose-tunnel',
    pack: 'sandbox',
    prompt:
      '连接华为云沙箱(不需要配置 git 仓库),然后用 huaweicloud_sandbox_expose_tunnel 把端口 8080 暴露成公网 URL(先用 deploy_nginx 的 port 字段规则,这里直接用 8080)。把返回的公网 URL 告诉我。',
    fixtures: wsSandboxFixtures(),
    expect: [
      CONNECT_POST,
      { kind: 'toolCall', name: 'huaweicloud_sandbox_expose_tunnel', ok: true },
      { kind: 'ws', intent: 'devbridge-auth-probe', times: { min: 1, max: 1 } },
      { kind: 'ws', intent: 'devbridge-expose-script', times: { min: 1, max: 2 } },
      // #919: a healthy expose is followed by the independent fresh-session
      // re-verify of the URL (one tool call runs verify at most once; max 2 is
      // slack, not a semantic claim).
      { kind: 'ws', intent: 'devbridge-verify-script', times: { min: 1, max: 2 } },
      // The tunnel-persistence port's AUTO-ENROLL phase: every successful
      // expose reads the installed watchdog's tunnel list and installs the
      // merged one — one read + one install per call (max 2 mirrors the
      // expose-script slack for a retry).
      { kind: 'ws', intent: 'devbridge-keepalive-read', times: { min: 1, max: 2 } },
      { kind: 'ws', intent: 'devbridge-keepalive-install', times: { min: 1, max: 2 } },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['devbridge-s2.hwtunnel.com', 'e2e-tunnel-1'] } }],
    budget: { timeoutMs: 420_000, attempts: 2 },
  },

  {
    id: 'sandbox-exec-one-shot-ws',
    pack: 'sandbox',
    prompt:
      '连接华为云沙箱(不需要配置 git 仓库),然后用 huaweicloud_sandbox_exec_one_shot 在沙箱里执行命令 echo e2e-one-shot-output,把命令输出告诉我。',
    fixtures: wsSandboxFixtures(),
    expect: [
      CONNECT_POST,
      // one-shot exec rides its own fresh ws connection (on top of
      // connect's two), so the count is loose here — the precise pair is
      // the reuse/close cases below.
      { kind: 'wsConnections', times: { min: 2, max: 4 } },
      { kind: 'ws', intent: 'echo', times: { min: 1, max: 1 } },
      // Fake-drift gate: every command the product sent must be one the
      // fake recognized — a script edit turns this red, never silent.
      ZERO_UNKNOWN,
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['e2e-one-shot-output', '输出'] } }],
    budget: { timeoutMs: 360_000, attempts: 2 },
  },
  {
    id: 'sandbox-exec-session-reuse',
    pack: 'sandbox',
    prompt:
      '连接华为云沙箱(不需要配置 git 仓库),然后用 huaweicloud_sandbox_exec_with_session 在同一个会话里依次执行两条命令:先 echo e2e-first,再 echo e2e-second,把两次输出都告诉我。不要断开会话。',
    fixtures: wsSandboxFixtures(),
    expect: [
      CONNECT_POST,
      // Session-cache reuse IS the mechanism: connect's two connections
      // (one-shot cleanup + cached session) plus ZERO more for the second
      // exec. A reuse regression makes this 3+.
      { kind: 'wsConnections', times: { min: 2, max: 2 } },
      { kind: 'ws', intent: 'echo', times: { min: 2, max: 2 } },
      ZERO_UNKNOWN,
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['e2e-first', 'e2e-second'] } }],
    budget: { timeoutMs: 360_000, attempts: 2 },
  },
  {
    id: 'sandbox-exec-session-close-reconnect',
    pack: 'sandbox',
    prompt:
      '连接华为云沙箱(不需要配置 git 仓库),用 huaweicloud_sandbox_exec_with_session 执行 echo e2e-before-close,然后调用 huaweicloud_sandbox_close_session 关闭会话,再用 huaweicloud_sandbox_exec_with_session 执行 echo e2e-after-close,把两次输出都告诉我。',
    fixtures: wsSandboxFixtures(),
    expect: [
      CONNECT_POST,
      { kind: 'toolCall', name: 'huaweicloud_sandbox_close_session', ok: true },
      // The close→reconnect delta vs the reuse case: the post-close exec
      // is a cache miss, so a THIRD connection appears. close_session
      // itself is client-only teardown — the connection count is what
      // makes it observable.
      { kind: 'wsConnections', times: { min: 3, max: 3 } },
      { kind: 'ws', intent: 'echo', times: { min: 2, max: 2 } },
      ZERO_UNKNOWN,
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['e2e-before-close', 'e2e-after-close'] } }],
    budget: { timeoutMs: 360_000, attempts: 2 },
  },
  {
    // upload_file's md5 verification is the REAL gate: the fake's shell
    // decodes the b64 batches and hashes true bytes, so a corruption
    // anywhere in the chunk/append/decode chain makes the product THROW
    // (ok:false in the trace) — this case can fail for the right reason.
    id: 'sandbox-upload-file-md5',
    pack: 'sandbox',
    prompt:
      '连接华为云沙箱(不需要配置 git 仓库),然后用 huaweicloud_sandbox_upload_file 把本地文件 {workdir}/hello-upload.txt 上传到沙箱的 /tmp/hello-upload.txt,把上传结果和 md5 校验情况告诉我。',
    fixtures: {
      ...wsSandboxFixtures(),
      workdir: {
        'hello-upload.txt': 'Hello from the e2e upload case — line two for body mass.\n'.repeat(40),
      },
    },
    expect: [
      CONNECT_POST,
      { kind: 'toolCall', name: 'huaweicloud_sandbox_upload_file', ok: true },
      // Upload rides the CACHED session: connect's two connections, zero
      // more — same reuse arithmetic as the reuse case.
      { kind: 'wsConnections', times: { min: 2, max: 2 } },
      { kind: 'ws', intent: 'rm', times: { min: 1, max: 1 } },
      { kind: 'ws', intent: 'printf-append', times: { min: 1, max: 3 } },
      { kind: 'ws', intent: 'base64-decode', times: { min: 1, max: 1 } },
      { kind: 'ws', intent: 'md5sum', times: { min: 1, max: 1 } },
      ZERO_UNKNOWN,
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['md5', '校验', 'upload', '上传'] } }],
    budget: { timeoutMs: 360_000, attempts: 2 },
  },
  {
    // upload_project: the full tunnel stack — file-server deploy on the
    // terminal session, TCP-tunnel relay, in-fake HTTP /health + /upload.
    // The /upload md5 comes from hashing the RECEIVED bytes, so corruption
    // anywhere in the archive/tunnel chain mismatches the product's local
    // hash and the tool call FAILS — a genuine gate.
    id: 'sandbox-upload-project-tunnel',
    pack: 'sandbox',
    prompt:
      '连接华为云沙箱(不需要配置 git 仓库),然后用 huaweicloud_sandbox_upload_project 把本地项目目录 {workdir}/myproject 上传到沙箱的 /workspace(默认解压),把上传结果和校验情况告诉我。',
    fixtures: {
      ...wsSandboxFixtures(),
      workdir: {
        'myproject/package.json': JSON.stringify(
          { name: 'e2e-tunnel-project', private: true, dependencies: { react: '^18.2.0' } },
          null,
          2,
        ),
        'myproject/README.md': 'A project uploaded through the e2e tunnel case.\n',
      },
    },
    expect: [
      CONNECT_POST,
      { kind: 'toolCall', name: 'huaweicloud_sandbox_upload_project', ok: true },
      // The file-server lifecycle on the terminal session (deploy kill,
      // cleanup kill, and the attempt loop's sweep — presence is the gate;
      // agent-initiated verification one-shots make connection counts
      // meaningless in this case, so none are asserted).
      { kind: 'ws', intent: 'kill-fileserver', times: { min: 2, max: 4 } },
      { kind: 'ws', intent: 'write-fileserver-script', times: { min: 1, max: 1 } },
      { kind: 'ws', intent: 'start-fileserver', times: { min: 1, max: 1 } },
      { kind: 'ws', intent: 'extract-archive', times: { min: 1, max: 1 } },
      // The relayed traffic on the tunnel session.
      { kind: 'ws', intent: 'tunnel:health', times: { min: 1, max: 3 } },
      { kind: 'ws', intent: 'tunnel:upload', times: { min: 1, max: 1 } },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['md5', '上传', 'upload', '/workspace'] } }],
    budget: { timeoutMs: 420_000, attempts: 2 },
  },
  {
    // deploy_nginx: the probes are one-shot execs, and INSTALLED is a REAL
    // gate (the product throws on MISSING). Intent presence is the drift
    // tripwire; connection counts are not asserted (one-shot-per-probe
    // plus agent improvisation).
    id: 'sandbox-deploy-nginx',
    pack: 'sandbox',
    prompt:
      '连接华为云沙箱(不需要配置 git 仓库),然后用 huaweicloud_sandbox_deploy_nginx 为项目 myproject 配置 nginx:类型 spa、端口 8080、输出目录 dist。把配置和启动结果告诉我。',
    fixtures: wsSandboxFixtures(),
    expect: [
      CONNECT_POST,
      { kind: 'toolCall', name: 'huaweicloud_sandbox_deploy_nginx', ok: true },
      { kind: 'ws', intent: 'nginx-installed', times: { min: 1, max: 1 } },
      { kind: 'ws', intent: 'port-free', times: { min: 1, max: 2 } },
      // The config-write blob (resolve script + tee heredoc + embedded
      // reload + chmod fixups + the A1 verify block, one exec) opens with
      // REAL_PROJECT= — its own intent since the A1 (#935) split.
      { kind: 'ws', intent: 'deploy-nginx-config-write', times: { min: 1, max: 1 } },
      { kind: 'ws', intent: 'devbridge-active', times: { min: 1, max: 1 } },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['nginx', '8080', '配置'] } }],
    budget: { timeoutMs: 420_000, attempts: 2 },
  },
  {
    // deploy_check: the verdict lands in the tool RESULT (a non-assertion
    // surface by the suite's founding rule), so the honest gates are the
    // script DELIVERY and recognition on the ws channel plus toolCall ok —
    // the output grammar itself is pinned cross-tier in
    // ws-exec-protocol.test.ts (fake synthesis ↔ parseDeployCheckOutput).
    id: 'sandbox-deploy-check',
    pack: 'sandbox',
    prompt:
      '连接华为云沙箱(不需要配置 git 仓库),然后用 huaweicloud_sandbox_deploy_check 检查项目 myproject 的部署状态:端口 8080、输出目录 dist。把各项检查结果、总分和结论告诉我。',
    fixtures: wsSandboxFixtures(),
    expect: [
      CONNECT_POST,
      { kind: 'toolCall', name: 'huaweicloud_sandbox_deploy_check', ok: true },
      { kind: 'ws', intent: 'deploy-check-script', times: { min: 1, max: 1 } },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['COMPLETE', '6/6', '通过'] } }],
    budget: { timeoutMs: 420_000, attempts: 2 },
  },
];
