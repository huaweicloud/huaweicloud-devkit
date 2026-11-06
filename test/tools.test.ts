import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { callTool, listSkillDirs, type ToolArgs } from '../plugins/huaweicloud-core/src/tools.ts';
import type { RiskFinding } from '../plugins/huaweicloud-core/src/risk-rule-engine.ts';
import { fixtureDir } from './fixture-dir.ts';

interface HookCheckResult {
  ok: boolean;
  decision: 'allow' | 'warn' | 'deny';
  findings: RiskFinding[];
}

interface ServiceCatalogResult {
  recommendedSkills: string[];
}

interface RetrieveSkillResult {
  ok: boolean;
  error?: string;
  name?: string;
  version?: string | number;
  description?: string;
  content?: string;
  references: Array<{ filename: string; content: string }>;
}

test('the vendorConfirmed gate rejects unasserted calls, and the first asserted call clears the challenge once', async () => {
  // The enforcement rung plus the challenge rung above it (A/B-measured,
  // 2026-10-23: teaching-only never asked 0/5; the gate asked 4/5 with the
  // residual failure a COLD fabricated assertion — so the session's first
  // asserted call bounces once with the BY-THE-USER-or-assumed challenge,
  // the plan→run dance shape models complete honestly). service_catalog is
  // the side-effect-free face for the positive arms; auth_status the
  // measured first move for the negative arm. The seam is toggled ON here
  // (file-top sets it off for the file's incidental cold asserts) and the
  // sessionIds are unique so the consumed flag never leaks across tests.
  process.env.HUAWEICLOUD_VENDOR_CHALLENGE = undefined;
  try {
    await assert.rejects(callTool('huaweicloud_auth_status', {}, { sessionId: 'vendor-dance' }), (error: Error) => {
      assert.match(error.message, /Vendor gate: this tool operates on Huawei Cloud/);
      assert.match(error.message, /Pass vendorConfirmed with the user's establishing words/);
      assert.match(error.message, /ask which cloud they mean, then retry once established/);
      return true;
    });
    // Quote-form regressions: the boolean shape no longer passes (the
    // A/B residual showed a checkbox models will check on assumption —
    // a quote is the statement they will not fabricate lightly), and an
    // empty quote is no quote.
    await assert.rejects(
      // The old boolean shape is deliberately typed-out of ToolArgs; the
      // cast sends it anyway to pin that the gate (not just the type)
      // rejects it.
      callTool('huaweicloud_auth_status', { vendorConfirmed: true } as unknown as ToolArgs, {
        sessionId: 'vendor-dance',
      }),
      (error: Error) => {
        assert.match(error.message, /Vendor gate: this tool operates on Huawei Cloud/);
        return true;
      },
    );
    await assert.rejects(
      callTool('huaweicloud_auth_status', { vendorConfirmed: '   ' }, { sessionId: 'vendor-dance' }),
      (error: Error) => {
        assert.match(error.message, /Vendor gate: this tool operates on Huawei Cloud/);
        return true;
      },
    );
    // Unasserted rejections never consume the challenge: the next COLD
    // quoted call still bounces.
    await assert.rejects(
      callTool(
        'huaweicloud_auth_status',
        { vendorConfirmed: 'test: vendor established by the harness' },
        { sessionId: 'vendor-dance' },
      ),
      (error: Error) => {
        assert.match(error.message, /Vendor challenge: first Huawei Cloud tool call this session/);
        assert.match(error.message, /is the vendorConfirmed quote the user's actual words, or invented/);
        assert.match(error.message, /Retry the same call to proceed/);
        return true;
      },
    );
    // The dance completes: the retried asserted call dispatches.
    const cataloged = (await callTool(
      'huaweicloud_service_catalog',
      { vendorConfirmed: 'test: vendor established by the harness', intent: 'deploy an ecs instance' },
      { sessionId: 'vendor-dance' },
    )) as unknown;
    assert.ok(cataloged, 'the retried attested call must dispatch');
    // Once per session: the challenge is consumed — the next asserted call
    // in the same session passes without a bounce.
    const again = (await callTool(
      'huaweicloud_service_catalog',
      { vendorConfirmed: 'test: vendor established by the harness', intent: 'list obs buckets' },
      { sessionId: 'vendor-dance' },
    )) as unknown;
    assert.ok(again, 'a second asserted call in the same session must not bounce');
  } finally {
    process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';
  }
});

test('huaweicloud_hook_check_command returns deny finding', async () => {
  const result = (await callTool('huaweicloud_hook_check_command', {
    command:
      'hcloud VPC CreateSecurityGroupRule --security_group_rule.port_range_min=22 --security_group_rule.remote_ip_prefix=0.0.0.0/0',
  })) as HookCheckResult;
  assert.equal(result.decision, 'deny');
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].ruleId, 'hwc-network-public-admin-port');
});

test('callTool rejects invalid numeric timeoutMs instead of silently ignoring it', async () => {
  await assert.rejects(
    () =>
      callTool('huaweicloud_run_readonly_command', {
        vendorConfirmed: 'test: vendor established by the harness',
        args: ['ECS', 'ListServersDetails'],
        timeoutMs: 'not-a-number',
      } as unknown as ToolArgs),
    /positive number/,
  );
});

test('callTool accepts maxRetries 0 and integer timeoutMs (no false rejection)', async () => {
  // maxRetries: 0 is legitimate ("no retries") and must pass normalization (#530)
  await assert.doesNotReject(() =>
    callTool('huaweicloud_plan_cli_command', {
      vendorConfirmed: 'test: vendor established by the harness',
      args: ['ECS', 'ListServersDetails'],
      maxRetries: 0,
      timeoutMs: 30000,
    }),
  );
});

test('callTool normalizes model-emitted string numbers for the sandbox port family', async () => {
  // The 2026-11-03 e2e-nightly codex leg (fork PR-1, run 41730851595): the
  // model emitted "port": "8080" — the SDK zod (numericArg unions) passes
  // the string to callTool, and normalizeNumericArgs converts it before
  // dispatch (deploy-nginx's nodePort arithmetic reads port + 1; a string
  // would concatenate). With no sandbox connected the workspace guard is
  // the deterministic observable that the numeric layer passed the call
  // through; a non-numeric or non-positive port still rejects with the
  // #530 error shape.
  await assert.rejects(
    () =>
      callTool('huaweicloud_sandbox_deploy_nginx', {
        nginx_type: 'spa',
        port: '8080',
        project: 'myproject',
        output_dir: 'dist',
      } as unknown as ToolArgs),
    /workspace_id is required/,
  );
  await assert.rejects(
    () =>
      callTool('huaweicloud_sandbox_deploy_nginx', {
        nginx_type: 'spa',
        port: 'eighty',
        project: 'myproject',
        output_dir: 'dist',
      } as unknown as ToolArgs),
    /positive number/,
  );
  await assert.rejects(
    () =>
      callTool('huaweicloud_sandbox_deploy_nginx', {
        nginx_type: 'spa',
        port: 0,
        project: 'myproject',
        output_dir: 'dist',
      } as unknown as ToolArgs),
    /positive number/,
  );
  await assert.rejects(
    () =>
      callTool('huaweicloud_sandbox_expose_tunnel', {
        port: '8080',
        expiry_hours: '72',
      } as unknown as ToolArgs),
    /workspace_id is required/,
  );
});

test('huaweicloud_hook_check_artifacts detects broad IAM policy', async () => {
  const result = (await callTool('huaweicloud_hook_check_artifacts', {
    artifacts: [
      {
        path: 'policy.json',
        content: '{"Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}',
      },
    ],
  })) as HookCheckResult;
  assert.equal(result.decision, 'deny');
  assert.equal(result.findings[0].ruleId, 'hwc-iam-admin-policy');
});

test('huaweicloud_hook_check_deploy_plan warns on sandbox without ttl', async () => {
  const result = (await callTool('huaweicloud_hook_check_deploy_plan', {
    plan: {
      environment: 'preview',
      resources: [{ service: 'FunctionGraph', action: 'CreateFunction' }],
    },
  })) as HookCheckResult;
  assert.equal(result.decision, 'warn');
  assert.equal(result.ok, true);
  assert.equal(result.findings[0].ruleId, 'hwc-sandbox-missing-ttl');
});

test('service_catalog recommends sandbox first for static website deployment intent', async () => {
  const en = (await callTool('huaweicloud_service_catalog', {
    vendorConfirmed: 'test: vendor established by the harness',
    intent: 'deploy a static website',
  })) as ServiceCatalogResult;
  assert.equal(en.recommendedSkills[0], 'huawei-sandbox');
  assert.ok(en.recommendedSkills.includes('huawei-obs'));

  const zh = (await callTool('huaweicloud_service_catalog', {
    vendorConfirmed: 'test: vendor established by the harness',
    intent: '部署静态网站到华为云',
  })) as ServiceCatalogResult;
  assert.equal(zh.recommendedSkills[0], 'huawei-sandbox');

  const webApp = (await callTool('huaweicloud_service_catalog', {
    vendorConfirmed: 'test: vendor established by the harness',
    intent: 'host a web app for preview',
  })) as ServiceCatalogResult;
  assert.equal(webApp.recommendedSkills[0], 'huawei-sandbox');
});

test('service_catalog keeps storage routing for pure storage intent', async () => {
  const result = (await callTool('huaweicloud_service_catalog', {
    vendorConfirmed: 'test: vendor established by the harness',
    intent: 'store files in an obs bucket',
  })) as ServiceCatalogResult;
  assert.ok(result.recommendedSkills.includes('huawei-obs'));
  assert.notEqual(result.recommendedSkills[0], 'huawei-sandbox');
});

// Symlink creation needs privileges on Windows (the repo's other symlink
// tests skip there for the same reason); GitHub-hosted runners happen to be
// elevated, but the suite must not depend on that.

test(
  'listSkillDirs ignores files, subdirs without SKILL.md, and counts symlinked skill dirs',
  { skip: process.platform === 'win32' },
  () => {
    const base = fixtureDir('huaweicloud-list-skills-');
    try {
      const root = join(base, 'root');
      const external = join(base, 'external');
      mkdirSync(root, { recursive: true });
      mkdirSync(join(external, 'huawei-vpc'), { recursive: true });
      writeFileSync(join(external, 'huawei-vpc', 'SKILL.md'), '---\nname: huawei-vpc\n---\n', 'utf8');
      symlinkSync(join(external, 'huawei-vpc'), join(root, 'huawei-vpc'));
      mkdirSync(join(root, 'no-skill'));
      writeFileSync(join(root, 'stray.md'), 'x');

      assert.deepEqual(
        listSkillDirs(root).sort((a, b) => a.localeCompare(b)),
        ['huawei-vpc'],
      );
      assert.deepEqual(listSkillDirs(join(base, 'missing')), []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

// retrieve_skill is the server-side skill loader, so its name boundary is
// security-relevant: traversal-shaped names must be rejected before any
// filesystem access.

test('retrieve_skill rejects traversal-shaped and non-skill names', async () => {
  for (const name of ['../src/packs/obs/skills/huawei-obs', '..%2f..', 'huawei ecs', 'HUAWAI-ECS', '/etc', '']) {
    const result = (await callTool('huaweicloud_retrieve_skill', { name })) as RetrieveSkillResult;
    assert.equal(result.ok, false, `name ${JSON.stringify(name)} must be rejected`);
    assert.match(result.error!, /Invalid skill name|Skill name is required/);
  }
});

test('retrieve_skill serves the full skill from the server-relative tree', async () => {
  const result = (await callTool('huaweicloud_retrieve_skill', { name: 'huawei-ecs' })) as RetrieveSkillResult;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.name, 'huawei-ecs');
  assert.match(result.content!, /^---\r?\nname: huawei-ecs/);
  assert.ok(result.references.length > 0, 'huawei-ecs ships reference files');
  assert.ok(result.references.some((ref) => ref.filename === 'create-instance.md'));
});

// The consumer-level pin of the truncation fix: the parser unit tests and
// the structure invariant guard the module and the corpus, this guards the
// wiring — a future first-line regex dropped back into retrieveSkill fails
// here even though every other gate stays green.

test('retrieve_skill returns the full multi-line description, quote-stripped', async () => {
  const result = (await callTool('huaweicloud_retrieve_skill', { name: 'huawei-ecs' })) as RetrieveSkillResult;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.version, '1');
  assert.ok(result.description!.startsWith('Use when'), 'the YAML quote must not survive into retrieve_skill output');
  assert.ok(
    result.description!.includes('HC活动场景'),
    'the multi-line second paragraph must survive into retrieve_skill output',
  );
  assert.deepEqual(
    result.references.map((ref) => ref.filename),
    ['create-instance.md', 'evs.md', 'flavors.md', 'hc-activity.md', 'troubleshooting.md', 'windows-ssh.md'],
    'references list in the same deterministic order list_skills serves',
  );
});

// The truncation cap must be visible, not silent: a reference cut at 4000
// chars carries a marker naming the <skillRoot> direct-read path, so a
// cross-reference deeper than the cap (e.g. a safety remediation citing a
// late section) reads as "beyond the cut", never as "does not exist".

test('retrieve_skill marks truncated references and leaves short ones whole', async () => {
  const result = (await callTool('huaweicloud_retrieve_skill', { name: 'huawei-ecs' })) as RetrieveSkillResult;
  assert.equal(result.ok, true, result.error);
  const long = result.references.find((ref) => ref.filename === 'create-instance.md')!;
  assert.ok(long.content.length > 4000, 'create-instance.md exceeds the cap after the 1.1.10 port');
  assert.match(long.content, /\[truncated at 4000 chars[^\]]*\]/, 'cut references must carry the truncation marker');
  const short = result.references.find((ref) => ref.filename === 'evs.md')!;
  assert.ok(!short.content.includes('[truncated'), 'short references must not carry the marker');
});

test('search_docs matches tokens from the multi-line description second paragraph', async () => {
  // 'Nginx部署' lives only in huawei-ecs's second paragraph: the CONTENT
  // index path found it even before the multi-line fix (whole-file match),
  // so the discriminating assertion is the snippet — the old first-line
  // snippet was quote-prefixed and paragraph-free.
  const result = (await callTool('huaweicloud_search_docs', { query: 'Nginx部署' })) as {
    ok: boolean;
    results: Array<{ name: string; snippet: string }>;
  };
  assert.equal(result.ok, true);
  const hit = result.results.find((entry) => entry.name === 'huawei-ecs');
  assert.ok(hit, 'the second-paragraph token must find huawei-ecs');
  assert.ok(hit!.snippet.startsWith('Use when'), 'the snippet must carry the quote-stripped description');
});

test('list_operations fans DMS/DEW out to their KooCLI sub-services', async () => {
  await withFakeHcloudForList(async () => {
    for (const [aggregate, subs] of [
      ['DMS', ['Kafka', 'RabbitMQ', 'RocketMQ']],
      ['DEW', ['KMS', 'CSMS']],
    ] as const) {
      const result = (await callTool('huaweicloud_list_operations', {
        service: aggregate,
        maxRetries: 0,
        timeoutMs: 30000,
        vendorConfirmed: 'test: vendor established by the harness',
      })) as {
        service: string;
        aggregate: boolean;
        aggregatedFrom: string[];
        subServices: Array<{ subService: string; command: string }>;
      };
      assert.equal(result.aggregate, true, `${aggregate} is an aggregate name`);
      assert.deepEqual(result.aggregatedFrom, [...subs]);
      assert.deepEqual(
        result.subServices.map((s) => s.subService),
        [...subs],
      );
      for (const sub of result.subServices) {
        assert.match(sub.command, new RegExp(`^hcloud ${sub.subService} --help$`));
      }
    }
  });
});

test('list_operations carries BSS identity notes (Customer vs Partner API split)', async () => {
  await withFakeHcloudForList(async () => {
    const result = (await callTool('huaweicloud_list_operations', {
      service: 'BSS',
      maxRetries: 0,
      timeoutMs: 30000,
      vendorConfirmed: 'test: vendor established by the harness',
    })) as {
      identityNotes: Array<{ identity: string; apis: string[]; note: string }>;
    };
    assert.ok(Array.isArray(result.identityNotes) && result.identityNotes.length === 2);
    const partner = result.identityNotes.find((n) => n.identity.includes('Partner'));
    assert.ok(partner, 'the Partner-level class is present');
    assert.ok(partner!.apis.includes('ListQuotaCoupons'));
    assert.match(partner!.note, /NOT bad AK\/SK or a missing cli-domain-id/);
  });
});

async function assertSkillForIntent(intent: string, expectedSkill: string): Promise<void> {
  const result = (await callTool('huaweicloud_service_catalog', {
    intent,
    vendorConfirmed: 'test: vendor established by the harness',
  })) as {
    recommendedSkills?: string[];
  };
  assert.ok(
    (result.recommendedSkills ?? []).includes(expectedSkill),
    `intent "${intent}" must route to ${expectedSkill}, got ${JSON.stringify(result.recommendedSkills)}`,
  );
}

test('serviceCatalog routes Chinese intent keywords to the right skills', async () => {
  const cases: Array<[string, string]> = [
    ['弹性云服务器怎么创建', 'huawei-ecs'],
    ['申请一个弹性公网IP', 'huawei-vpc'],
    ['对象存储静态托管', 'huawei-obs'],
    ['函数工作流触发器配置', 'huawei-functiongraph'],
    ['关系型数据库高可用', 'huawei-rds'],
    ['访问密钥在哪里管理', 'huawei-iam'],
    ['密钥管理服务加密', 'huawei-cloud-dew-key-management'],
    ['查询账单计费明细', 'huawei-billing'],
    ['配置监控告警', 'huawei-cloud-eye'],
    ['查看审计追踪记录', 'huawei-cloud-cts-trace-management'],
    ['创建备份存储库', 'huawei-cbr'],
    ['文档数据库连接', 'huawei-cloud-dds-dcs-instance-management'],
    ['负载均衡监听器', 'huawei-vpc'],
  ];
  for (const [intent, expectedSkill] of cases) {
    await assertSkillForIntent(intent, expectedSkill);
  }
});

test('serviceCatalog: slash-bearing keywords (ak/sk, ci/cd) match via the phrase path', async () => {
  // Same routing contract as the Chinese-intent test above, exercised through
  // the shared assertSkillForIntent helper to avoid duplicating its loop.
  await assertSkillForIntent('configure AK/SK credentials', 'huawei-iam');
  await assertSkillForIntent('ci/cd pipeline for deployment', 'huawei-cloud-deployment-task-management');
});

async function withFakeHcloudForList(fn: () => Promise<void>): Promise<void> {
  const dir = fixtureDir('tools-list-ops-');
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(script, `console.log('operations: ListX ShowX CreateX'); process.exit(0);`, 'utf8');
  const prevBin = process.env.HCLOUD_BIN;
  const prevArgs = process.env.HCLOUD_BIN_ARGS_JSON;
  process.env.HCLOUD_BIN = process.execPath;
  process.env.HCLOUD_BIN_ARGS_JSON = JSON.stringify([script]);
  try {
    await fn();
  } finally {
    if (prevBin === undefined) delete process.env.HCLOUD_BIN;
    else process.env.HCLOUD_BIN = prevBin;
    if (prevArgs === undefined) delete process.env.HCLOUD_BIN_ARGS_JSON;
    else process.env.HCLOUD_BIN_ARGS_JSON = prevArgs;
  }
}

// ── Advisory-face warn for unrecognized hcloud operations (2026-11-05 UX report #8) ──

test('huaweicloud_hook_check_command upgrades an unrecognized hcloud operation to warn', async () => {
  const result = (await callTool('huaweicloud_hook_check_command', {
    command: 'hcloud FooBar BazQux --nonsense=1',
  })) as HookCheckResult;
  assert.equal(result.decision, 'warn');
  assert.equal(result.ok, true, 'warn stays advisory — the face never blocks');
  assert.equal(result.findings[0]?.ruleId, 'hwc-unknown-operation');
  assert.match(result.findings[0]?.message ?? '', /does not recognize/);
  // Known reads keep the bare allow (no findings, no warn).
  const known = (await callTool('huaweicloud_hook_check_command', { command: 'hcloud obs ls' })) as HookCheckResult;
  assert.equal(known.decision, 'allow');
  assert.equal(known.findings.length, 0);
});

// ── Deployment-intent fallback (2026-11-05 UX report #1) ────────────────────

test('serviceCatalog deployment intents always carry a compute/hosting recommendation', async () => {
  const vendor = 'test: vendor established by the harness';
  const report = (await callTool('huaweicloud_service_catalog', {
    intent: '部署一个带负载均衡和数据库的 Web 应用',
    vendorConfirmed: vendor,
  })) as ServiceCatalogResult & { recommendedServices?: string[] };
  assert.equal(report.recommendedSkills?.[0], 'huawei-sandbox', 'the hosting option leads a deployment intent');
  assert.ok(report.recommendedSkills?.includes('huawei-ecs'), 'the compute carrier is never missing');
  assert.ok(report.recommendedServices?.includes('ECS'));

  // Narrow phrasings used to fall to the empty fallback entirely.
  const bare = (await callTool('huaweicloud_service_catalog', {
    intent: '部署 web 应用',
    vendorConfirmed: vendor,
  })) as ServiceCatalogResult;
  assert.ok((bare.recommendedSkills?.length ?? 0) > 0, 'a bare deployment phrasing must not recommend nothing');
  assert.ok(bare.recommendedSkills?.includes('huawei-ecs'));

  // Matched services keep their positions ahead of the fallback entries, so a
  // user-named service never drops out of the capped list (loop round 2 R7:
  // RDS used to be evicted by the prepended Sandbox/ECS).
  const many = (await callTool('huaweicloud_service_catalog', {
    intent: 'deploy an app with 数据库 网络 存储 监控 审计 账单',
    vendorConfirmed: vendor,
  })) as ServiceCatalogResult & { recommendedServices?: string[] };
  assert.ok(many.recommendedServices?.includes('RDS'), 'the user-named database stays in the services list');
  assert.ok(many.recommendedServices?.includes('ECS'), 'the fallback compute carrier survives the cap');
  assert.ok((many.recommendedServices?.length ?? 0) <= 7, 'the exit cap is 7');

  // Non-deployment intents are untouched.
  const billing = (await callTool('huaweicloud_service_catalog', {
    intent: '查询账单',
    vendorConfirmed: vendor,
  })) as ServiceCatalogResult;
  assert.deepEqual(billing.recommendedSkills, ['huawei-billing']);
});

test('serviceCatalog deployment fallback fires only for deploy ACTIONS (loop round 2 R2)', async () => {
  const vendor = 'test: vendor established by the harness';
  // Non-action intents must not gain the COMPUTE fallback. (The sandbox and
  // obs routes fire on their own keywords — 'hosting 是什么意思' carries the
  // route word 'hosting', '写网站文案' the route word '网站'; that is
  // pre-existing route behavior, not the fallback. Every other case below
  // carries no route word at all.)
  const assertNoComputeFallback = async (intent: string) => {
    const result = (await callTool('huaweicloud_service_catalog', {
      intent,
      vendorConfirmed: vendor,
    })) as ServiceCatalogResult;
    assert.ok(!result.recommendedSkills?.includes('huawei-ecs'), `"${intent}" must not be pointed at ECS provisioning`);
    assert.ok(
      !result.recommendedSkills?.includes('huawei-sandbox') || /hosting|网站|网页/.test(intent),
      `"${intent}" must not be pointed at sandbox provisioning`,
    );
  };
  // Deployment ARTIFACTS and troubleshooting are query intents, not actions.
  // (Loop round 4: the artifact-noun adjacency window is gone — it read the
  // deploy OBJECT of real sentences (发布状态页/搭建日志分析平台) as a query
  // artifact and landed them on nothing. What remains: query verbs opening
  // the sentence (now with 帮我/查 prefixes), how-to-troubleshoot shapes, and
  // definitional questions. 梳理 mid-sentence no longer blocks anything.)
  await assertNoComputeFallback('查询部署记录');
  await assertNoComputeFallback('帮我查询部署记录');
  await assertNoComputeFallback('查一下部署日志');
  await assertNoComputeFallback('部署失败怎么排查');
  await assertNoComputeFallback('部署组是什么');
  await assertNoComputeFallback('上线历史在哪里看');
  await assertNoComputeFallback('hosting 是什么意思');
  // Noun usages: the unbounded 'host' substring inside localhost/ghost used
  // to light the trigger.
  await assertNoComputeFallback('localhost 开发环境调试');
  await assertNoComputeFallback('ghost 博客迁移方案');
  await assertNoComputeFallback('host 头攻击怎么防');
  await assertNoComputeFallback('host-header 攻击怎么防');
  await assertNoComputeFallback('部署白皮书怎么写');
  await assertNoComputeFallback('host 机器在哪');
  await assertNoComputeFallback('写网站文案');
  await assertNoComputeFallback('写网页爬虫');
  await assertNoComputeFallback('what is deployment');
  // 'deployment pipeline' DELIBERATELY fires (loop round 3): the pipeline
  // block killed real deploy sentences (用流水线部署我的应用), and a stray
  // compute rec on a CI/CD phrasing is advisory noise, not a misroute that
  // provisions — the accepted trade documented in the gate.

  // The WAF adjacency must not gain a compute fallback under any phrasing.
  for (const wafIntent of ['为 web 应用配置 WAF 规则', '给网站加 WAF 防护规则', 'configure WAF rules for my website']) {
    const waf = (await callTool('huaweicloud_service_catalog', {
      intent: wafIntent,
      vendorConfirmed: vendor,
    })) as ServiceCatalogResult;
    assert.ok(!waf.recommendedSkills?.includes('huawei-ecs'), `"${wafIntent}" must not inject ECS`);
    assert.ok(
      waf.recommendedSkills?.includes('huawei-cloud-waf-aad-rule-management'),
      `"${wafIntent}" must keep the WAF route`,
    );
  }

  // Genuine deploy sentences keep the fallback — including deploy-object
  // nouns that look like artifact words (loop round 4 B1: 发布状态页/搭建日志
  // 分析平台 landed on nothing), mixed action+query sentences (B2), and
  // mid-sentence 梳理 (B3, the twin of the rescued 诊断).
  for (const deployIntent of [
    '部署新版本 失败自动回滚',
    '搭建带自动回滚的发布流程',
    '用流水线部署我的应用',
    '部署前先诊断网络配置',
    '部署前先梳理网络配置',
    '怎么部署 web 应用',
    '发布状态页',
    '搭建日志分析平台',
    '部署日志服务',
    '上线通知列表功能',
    '上线失败重试功能',
    '部署服务状态监控',
    '部署应用，然后查看部署日志',
    '先部署网站，再看部署记录',
  ]) {
    const dep = (await callTool('huaweicloud_service_catalog', {
      intent: deployIntent,
      vendorConfirmed: vendor,
    })) as ServiceCatalogResult;
    assert.ok(dep.recommendedSkills?.includes('huawei-ecs'), `"${deployIntent}" must keep the compute carrier`);
  }
  // Noun-first site phrasings (B6) and the bare site-build form.
  for (const siteIntent of ['做个网页', '网站怎么做', '把网站做出来', '网站想建一个']) {
    const site = (await callTool('huaweicloud_service_catalog', {
      intent: siteIntent,
      vendorConfirmed: vendor,
    })) as ServiceCatalogResult;
    assert.ok(site.recommendedSkills?.includes('huawei-ecs'), `"${siteIntent}" must carry the compute rec`);
  }
  // A deployment with a security group in it is still a deployment (组 in
  // 安全组 must not read as the deployment-group artifact noun).
  const sg = (await callTool('huaweicloud_service_catalog', {
    intent: '部署一个带安全组的网络',
    vendorConfirmed: vendor,
  })) as ServiceCatalogResult;
  assert.ok(sg.recommendedSkills?.includes('huawei-ecs'), '安全组 must not block the deploy trigger');
});

test('serviceCatalog troubleshooting how-to phrasings stay blocked in all families (loop round 4 S3)', async () => {
  const vendor = 'test: vendor established by the harness';
  for (const intent of [
    '部署失败怎么办',
    '部署出错了怎么办',
    '部署失败如何排查',
    '部署出错如何解决',
    '部署失败如何处理',
    '部署后如何验证',
    'my deployment failed, how do I fix it',
    'how to fix a failed deployment',
    'my deployment is stuck, what should I do',
    '帮我看看部署记录',
    '检索部署记录',
    '搜一下部署方案',
    '查一下部署日志，然后部署新版本'.replace('，然后部署新版本', ''), // pure query form
  ]) {
    const result = (await callTool('huaweicloud_service_catalog', {
      intent,
      vendorConfirmed: vendor,
    })) as ServiceCatalogResult;
    assert.ok(
      !result.recommendedSkills?.includes('huawei-ecs'),
      `"${intent}" is a troubleshooting/query phrasing — must not gain the compute fallback`,
    );
  }
  // The compound mirror: query opens, real deploy clause follows — the gate
  // must NOT kill the deploy half (loop round 4 seat-3 H8).
  const compound = (await callTool('huaweicloud_service_catalog', {
    intent: '查一下部署日志，然后部署新版本',
    vendorConfirmed: vendor,
  })) as ServiceCatalogResult;
  assert.ok(
    compound.recommendedSkills?.includes('huawei-ecs'),
    'a query-open + deploy-clause sentence keeps the carrier',
  );
});

test('serviceCatalog query-verb family covers the colloquial forms (loop round 5 seat-3 B1)', async () => {
  const vendor = 'test: vendor established by the harness';
  for (const intent of [
    '帮我看下部署日志',
    '帮我看一下部署记录',
    '麻烦看下部署日志',
    '帮我瞧瞧部署记录',
    '看下部署日志',
  ]) {
    const result = (await callTool('huaweicloud_service_catalog', {
      intent,
      vendorConfirmed: vendor,
    })) as ServiceCatalogResult;
    assert.ok(
      !result.recommendedSkills?.includes('huawei-ecs'),
      `"${intent}" is a query — must not gain the compute fallback`,
    );
  }
});

test('serviceCatalog query family round-6/7 colloquial forms stay blocked (loop rounds 6-7 seat-3)', async () => {
  const vendor = 'test: vendor established by the harness';
  for (const intent of [
    '帮我看下部署日志',
    '帮我看一下部署记录',
    '麻烦看下部署日志',
    '帮我瞧瞧部署记录',
    '看下部署日志',
    // loop round 6: stacked prefixes, 您, 看一眼, bare 看, 瞅/瞄 families
    '麻烦帮我看看部署日志',
    '请帮我看下部署日志',
    '麻烦您看一下部署日志',
    '帮我看一眼部署记录',
    '看一眼部署日志',
    '帮我看部署记录',
    '帮我瞅瞅部署记录',
    '帮我瞅一眼部署日志',
    '瞄一眼部署日志',
    // loop round 7: star-joined stacks, 给我/劳驾/拜托, near-scan, bare-noun tail
    '麻烦您请帮个忙瞅瞅部署记录',
    '给我看下部署日志',
    '劳驾检索部署记录',
    '拜托瞄一眼部署日志',
    '帮我看下部署日志，部署是谁做的',
  ]) {
    const result = (await callTool('huaweicloud_service_catalog', {
      intent,
      vendorConfirmed: vendor,
    })) as ServiceCatalogResult;
    assert.ok(
      !result.recommendedSkills?.includes('huawei-ecs'),
      `"${intent}" is a query — must not gain the compute fallback`,
    );
  }
  // The compound exemption requires a deploy OBJECT after the comma — the
  // bare word asking who/what does not count (loop round 7 seat-3 B1).
  const who = (await callTool('huaweicloud_service_catalog', {
    intent: '帮我看下部署日志，部署是谁做的',
    vendorConfirmed: vendor,
  })) as ServiceCatalogResult;
  assert.ok(!who.recommendedSkills?.includes('huawei-ecs'));
});

test('serviceCatalog double-clause tails mentioning the deploy word fire (loop round 12 documented residual)', async () => {
  const vendor = 'test: vendor established by the harness';
  for (const intent of [
    '帮我看下部署日志，看看部署失败没有',
    '帮我瞅瞅部署记录，部署流程对不对',
    '帮我看下部署日志，部署记录很长',
    '帮我看看部署日志，上线流程对不对',
  ]) {
    const result = (await callTool('huaweicloud_service_catalog', {
      intent,
      vendorConfirmed: vendor,
    })) as ServiceCatalogResult;
    assert.ok(
      result.recommendedSkills?.includes('huawei-ecs'),
      `"${intent}" is the documented noise direction (tail mentions the deploy word)`,
    );
  }
});
