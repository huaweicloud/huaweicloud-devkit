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
