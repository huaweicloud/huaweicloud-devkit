// The capability catalog: the pack-registry-facing tool handlers, split out
// of tools.ts. Owns the intent router (service_catalog), the pack inventory
// (list_packs / pack_info), session pack configuration (packs_configure),
// the skill→pack ownership inversion (SKILL_OWNER) the boot guard and the
// skill-serving handlers cross-check, and the shared pack-refusal helpers.
// tools.ts dispatches into this module from its core switch; the
// skill-disclosure family (retrieve_skill / list_skills / search_docs)
// imports SKILL_OWNER and the refusal helpers from here.
import { z } from 'zod';

import { TOOL_DEFINITIONS } from './tool-definitions.ts';
import type { CallToolOptions } from './tools.ts';
// PACKS feeds the pack inventory and the SKILL_OWNER inversion; enable.ts
// carries the live enablement set (DEVKIT_PACKS > all packs).
import { PACKS } from './packs/registry.ts';
import { resolveEnabledPacks } from './packs/enable.ts';
import { type PackId } from './lib/pack-types.ts';
import { getToolSchema, SCHEMA_DRIFT_IGNORED_KEYS } from './tool-schemas.ts';

export function serviceCatalog(intent: string = '') {
  const it = String(intent).toLowerCase();
  const routeMap = [
    {
      keywords: [
        'ecs',
        'server',
        'vm',
        'instance',
        'compute',
        'flavor',
        'image',
        '弹性云服务器',
        '云服务器',
        '服务器',
        '虚拟机',
        '镜像',
      ],
      skills: ['huawei-ecs'],
      services: ['ECS'],
    },
    {
      keywords: [
        'vpc',
        'subnet',
        'network',
        'security group',
        'eip',
        'nat',
        'vpn',
        'bandwidth',
        '虚拟私有云',
        '子网',
        '网络',
        '安全组',
        '弹性公网IP',
        'NAT网关',
        'VPN网关',
        '带宽',
      ],
      skills: ['huawei-vpc'],
      services: ['VPC', 'EIP'],
    },
    {
      keywords: [
        'obs',
        'bucket',
        'storage',
        'object',
        'static website',
        'static site',
        'hosting',
        '对象存储',
        '存储桶',
        '桶',
        '存储',
        '对象',
        '静态网站',
        '静态托管',
        'cors',
        'CORS',
        'browser direct upload',
        '直传',
        '预签名上传',
      ],
      skills: ['huawei-obs'],
      services: ['OBS'],
    },
    {
      keywords: [
        'functiongraph',
        'serverless',
        'function',
        'lambda',
        'trigger',
        'faas',
        '函数工作流',
        '函数',
        '触发器',
        '无服务器',
        '函数计算',
      ],
      skills: ['huawei-functiongraph'],
      services: ['FunctionGraph'],
    },
    {
      keywords: ['cce', 'kubernetes', 'k8s', 'container', 'cluster', 'node pool', 'swr', 'docker', 'image registry'],
      skills: ['huawei-cce'],
      services: ['CCE', 'SWR'],
    },
    {
      keywords: ['apig', 'api gateway', 'publish', 'throttle', 'API网关', '限流'],
      skills: ['huawei-cloud-apig-instance-management'],
      services: ['APIG'],
    },
    {
      keywords: ['rds', 'mysql', 'postgresql', 'database', 'db', '关系型数据库', '数据库'],
      skills: ['huawei-rds'],
      services: ['RDS'],
    },
    {
      keywords: ['gaussdb', 'distributed', 'sharding', 'opengauss', '高斯数据库', '分布式数据库'],
      skills: ['huawei-cloud-gaussdb-instance-management'],
      services: ['GaussDB'],
    },
    {
      keywords: [
        'iam',
        'permission',
        'policy',
        'role',
        'user',
        'ak/sk',
        'access key',
        'agency',
        '身份认证',
        '身份管理',
        '权限',
        '策略',
        '角色',
        '用户',
        '访问密钥',
        '委托',
        'primary account',
        'sub-account',
        'account type',
        '主账号',
        '子账号',
      ],
      skills: ['huawei-iam'],
      services: ['IAM'],
    },
    {
      keywords: [
        'dew',
        'secret',
        'kms',
        'encrypt',
        'decrypt',
        'certificate',
        'csms',
        '数据加密服务',
        '密钥管理',
        '密钥',
        '加密',
        '解密',
        '证书',
        '凭据管理',
      ],
      skills: ['huawei-cloud-dew-key-management'],
      services: ['CSMS', 'KMS'],
    },
    {
      keywords: ['modelarts', 'ai', 'model', 'training', 'inference', 'machine learning'],
      skills: ['huawei-modelarts'],
      services: ['ModelArts'],
    },
    {
      keywords: ['billing', 'cost', 'bill', 'budget', 'expense', 'bss', '计费', '费用', '账单', '预算', '开销'],
      skills: ['huawei-billing'],
      services: ['BSS'],
    },
    {
      keywords: ['waf', 'aad', 'ddos', 'firewall', 'web protection'],
      skills: ['huawei-cloud-waf-aad-rule-management'],
      services: ['WAF', 'AAD'],
    },
    {
      keywords: ['smn', 'dms', 'notification', 'message', 'kafka', 'rabbitmq', 'rocketmq'],
      skills: ['huawei-cloud-smn-dms-message'],
      services: ['SMN', 'DMS'],
    },
    {
      keywords: ['ces', 'monitor', 'alarm', 'metric', 'dashboard', 'cloud eye', '监控', '告警', '云监控'],
      skills: ['huawei-cloud-eye'],
      services: ['CES'],
    },
    {
      keywords: ['cts', 'audit', 'trace', 'tracker', '审计', '追踪'],
      skills: ['huawei-cloud-cts-trace-management'],
      services: ['CTS'],
    },
    {
      keywords: ['cbr', 'backup', 'restore', 'vault', 'snapshot', '备份', '恢复', '快照', '存储库'],
      skills: ['huawei-cbr'],
      services: ['CBR'],
    },
    {
      keywords: ['deployment', 'deploy', 'ci/cd', 'pipeline', 'release'],
      skills: ['huawei-cloud-deployment-task-management'],
      services: ['CloudDeploy'],
    },
    {
      keywords: [
        'sandbox',
        'devstation',
        'workspace',
        'terminal',
        'preview',
        'hwlink',
        'website',
        'web app',
        'webapp',
        'hosting',
        '网站',
        '网页',
        '静态',
      ],
      skills: ['huawei-sandbox'],
      services: ['Sandbox', 'DevStation'],
    },
    {
      keywords: [
        'dds',
        'dcs',
        'mongodb',
        'redis',
        'memcached',
        'cache',
        'document db',
        '文档数据库',
        '缓存',
        '内存数据库',
      ],
      skills: ['huawei-cloud-dds-dcs-instance-management'],
      services: ['DDS', 'DCS'],
    },
    {
      keywords: ['elb', 'load balancer', '负载均衡', '弹性负载均衡', '监听器', '证书'],
      skills: ['huawei-vpc'],
      services: ['ELB'],
    },
    {
      keywords: ['openapi', 'api catalog', 'api explorer', 'rest call', 'open api', '全量目录', '接口目录'],
      skills: ['huawei-openapi'],
      services: [],
    },
    {
      keywords: ['voucher', 'coupon', 'incentive', 'credit', '领券', '代金券', '优惠券', '激励金', '领取'],
      skills: ['huawei-voucher'],
      services: ['Incentive Voucher'],
    },
  ];
  const matched = [];
  const tokens = new Set(it.split(/[\s,./-]+/).filter((t) => t.length > 0));
  const cjk = /[\u4e00-\u9fff]/;
  for (const route of routeMap) {
    // Phrase path (space/CJK/slash-bearing keywords like 'ak/sk' and 'ci/cd'):
    // substring match — the tokenizer splits on '/', so those keywords can
    // never be single tokens. Token path: membership, both sides lowercased
    // so a mixed-case keyword ('ModelArts') stays matchable.
    if (
      route.keywords.some((kw) =>
        kw.includes(' ') || kw.includes('/') || cjk.test(kw)
          ? it.includes(kw.toLowerCase())
          : tokens.has(kw.toLowerCase()),
      )
    ) {
      matched.push(route);
    }
  }
  const recommendedSkills = [...new Set(matched.flatMap((r) => r.skills))];
  // Never recommend a skill whose owning pack is disabled — the router must
  // not send the agent to a loader that will refuse (same filter searchDocs
  // applies to its index).
  const enabled = resolveEnabledPacks();
  const gated = recommendedSkills.filter((skill) => {
    const owner = SKILL_OWNER.get(skill);
    return !owner || enabled.has(owner);
  });
  let recommendedServices = [...new Set(matched.flatMap((r) => r.services))].slice(0, 5);

  // Deployment intent must land on a compute/hosting recommendation, never a
  // bare data-service list or nothing at all (2026-11-05 UX report #1: the
  // intent 部署一个带负载均衡和数据库的 web 应用 recommended ELB+RDS with no
  // compute carrier, and narrower phrasings like 部署 web 应用 matched nothing).
  // The keyword routes stay deliberately narrow — broad 'web 应用'/'webapp'
  // keywords misroute WAF phrasings onto ECS and double-route the sandbox
  // (probe-proven) — so the fallback adds the two hosting targets when the
  // intent is a deploy ACTION.
  //
  // Loop round 5 (seat-3 round-4): the negative classes are an OPEN set, so
  // the gate states its final contract here instead of chasing words: the
  // how-to-TROUBLESHOOT arm covers 怎么/如何 + fix verbs plus 怎么办 (the
  // highest-frequency Chinese ops question) and the English how-to-fix
  // shapes; the query-prefix arm covers the 帮我/请/查 families plus
  // 看看/检索/搜/显示. A compound sentence that QUERY-opens but then carries
  // a real deploy clause (查一下部署日志，然后部署新版本) is exempted from the
  // query block — blocking it landed the round-4 B5 mirror (mixed sentences
  // landing on nothing). Residual approximations, accepted and documented:
  // post-positioned query nouns (部署记录查询), bare ambiguous queries
  // without a deploy verb, and occasional non-action phrasings (发布订阅模式,
  // deployment pipeline, publish the npm package) fire — advisory noise,
  // never the original failure (a deploy sentence without a compute carrier).
  const definitional =
    /是什么|什么意思|区别|概念|怎么写|在哪|在哪里|多少钱|价格|是多少|\bwhat is\b|\bwhat are\b|\bwhat should i do\b/i;
  const troubleshootHowTo =
    /怎么办|(?:怎么|如何).{0,6}(?:排查|处理|解决|修复|定位|看|查|验证|检查)|\bhow\s+(?:do\s+i|to|can\s+i|should\s+i)\b[^。;；]{0,24}\b(?:fix|solve|resolve|troubleshoot|debug)\b/i;
  const queryVerbs =
    /(?:查询|查看|看看|看下|看一下|看一眼|看|瞧瞧|瞧一下|瞧一眼|瞧|瞅瞅|瞅一眼|瞅|瞄一眼|瞄|检索|搜|显示|找|查)/;
  // The politeness-prefix stack is star-joined: prefix chains stack freely
  // in Chinese (麻烦您请帮个忙看下…) and a single-slot alternation let any
  // novel politeness word through (loop rounds 6-7, seat-3 B2).
  const queryPrefix = new RegExp('^(?:请|帮我|帮忙|帮个忙|麻烦|劳驾|拜托|你好|您好|在吗)*' + queryVerbs.source);
  const hostNoun = /\bhost\s*[-\s]*(?:头|header)/i;
  // Loop round 10 (seat-3, structural): the query/deploy judgment is
  // POSITIONAL — a query verb occurring BEFORE the sentence's first
  // deploy-family verb (within 14 chars) reads as a query ABOUT deployment
  // artifacts (帮我看下部署日志/顺便看下部署日志/麻烦了，帮我瞅瞅部署记录);
  // a deploy verb FIRST with a query trailing (先部署网站，再看部署记录/
  // 部署应用，然后查看部署日志) is a deploy action with a query afterthought.
  // The compound exemption only rescues the query-open form whose tail
  // carries a real deploy clause (查一下部署日志，然后部署新版本). The
  // irreducible residual, documented and one-directional: post-positioned
  // query nouns (部署记录查询/托管服务查询/帮我查询部署情况) fire — advisory
  // noise, never the original failure (a deploy sentence landing on nothing).
  const queryVerbRe = new RegExp(queryVerbs.source, 'g');
  const deployVerbRe = /部署|上线|发布|搭建|托管/;
  const firstQuery = it.search(queryVerbRe);
  const firstDeploy = it.search(deployVerbRe);
  const queryBeforeDeploy =
    firstQuery >= 0 && firstDeploy >= 0 && firstQuery < firstDeploy && firstDeploy - firstQuery <= 14;
  // A query OPEN followed by a comma-separated deploy CLAUSE is an action
  // sentence (查一下部署日志，然后部署新版本). Loop round 12 (FINAL): the
  // negative look-ahead is pinned to the five interrogative words and WILL
  // NOT grow. Rounds 8-11 proved this arm has no fixed point: widening the
  // connector set or the noun-exclusion list flips direction every round
  // (round-8 noun list swallowed the round-4 deploy-object sentence
  // 发布状态页 mirror; round-11 list swallowed it again via 状态/失败). The
  // residual is the documented contract, BOTH directions:
  //  - miss (deploy sentence landing on nothing): non-comma connectors
  //    (查完部署文档就上线新版本), gaps > 16 chars, tails whose first word
  //    is a listed noun — the skills layer's deployment-target doctrine
  //    re-catches these;
  //  - noise (pure query gaining the compute rec): tails MENTIONING the
  //    deploy word (帮我看下部署日志，看看部署失败没有) — advisory noise,
  //    never a misroute that provisions.
  const compoundDeployTail = /[,，;；][^，。;；]{0,16}?(?:部署|搭建|上线|发布|托管)(?!\s*(?:是|谁|什么|如何|怎么))/;
  const blocked =
    definitional.test(it) ||
    troubleshootHowTo.test(it) ||
    ((queryPrefix.test(it) || queryBeforeDeploy) && !compoundDeployTail.test(it)) ||
    hostNoun.test(it);
  // Site-artifact build phrasings: create-verb + 网站/网页 ending the
  // sentence ('做个网页'), noun-first how-to ('网站怎么做', '网站想建一个'), and
  // the 把/将 construction ('把网站做出来'). A trailing object after the site
  // noun ('写网站文案') is writing ABOUT a site, not building one. (A regex
  // literal chain `a || b` would collapse to the first always-truthy regex
  // object at declaration — the shapes must be tested, not OR'd as values.)
  const siteBuildZh = (intent: string) =>
    /(?:做|建|搭|写|开发|制作)[^，。,.]{0,8}(?:网站|网页)[^，。,.]?$/.test(intent) ||
    /(?:网站|网页)[^，。,.]{0,6}怎么(?:做|搭|建|写)/.test(intent) ||
    /(?:网站|网页)[^，。,.]{0,4}(?:建|做|搭)(?:一|一个|出来)?[^，。,.]{0,2}$/.test(intent) ||
    /(?:把|将)(?:网站|网页)[^，。,.]{0,4}(?:做|建|搭)出来/.test(intent);
  const deploymentIntent =
    !blocked &&
    (/部署|上线|发布|搭建|托管/.test(it) ||
      siteBuildZh(it) ||
      /\b(?:deploy|deployment|deploying|host|hosting|hosted|publish|publishing|preview)\b/i.test(it));
  if (deploymentIntent) {
    const enabledOwner = (skill: string) => {
      const owner = SKILL_OWNER.get(skill);
      return !owner || enabled.has(owner);
    };
    const fallbacks = ['huawei-sandbox', 'huawei-ecs'].filter((skill) => !gated.includes(skill) && enabledOwner(skill));
    gated.unshift(...fallbacks);
    // The sandbox leads a deployment intent (the pre-existing doctrine the
    // reorder block carried): whatever order the unshift produced, hoist it.
    if (gated.includes('huawei-sandbox')) {
      gated.splice(gated.indexOf('huawei-sandbox'), 1);
      gated.unshift('huawei-sandbox');
    }
    // Matched services keep their positions ahead of the fallback entries —
    // a user-named service never drops out (loop round 2 R7: RDS was evicted
    // when the fallbacks were prepended into a flat 5-slot list). The matched
    // half was already capped at 5 above (the pre-fallback contract for
    // non-deployment intents is unchanged); the two fallback entries ride
    // AFTER it, so both halves survive.
    const serviceFallbacks = fallbacks.map((skill) => (skill === 'huawei-sandbox' ? 'Sandbox' : 'ECS'));
    recommendedServices = [...new Set([...recommendedServices, ...serviceFallbacks])];
  }

  return {
    intent,
    recommendedSkills: gated.length ? gated : ['Use huaweicloud-core to route intent.'],
    recommendedServices: recommendedServices.length
      ? recommendedServices.slice(0, 7)
      : ['Run hcloud --help to list available services.'],
    capabilityOrder: [
      'Huawei Cloud Skills for task-specific workflows and examples',
      'KooCLI hcloud for local authenticated operations and quick inspection',
      'Huawei Cloud API documentation for exact request and response contracts',
      'Huawei Cloud SDKs for application code integration',
      'Huawei Cloud MCP when an official or approved server is available',
      'Terraform Provider only when IaC reviewability and repeatability are important',
    ],
    ruleOfThumb: {
      skills: 'Start here when the task (already a Huawei Cloud one) is scenario-shaped or needs a guided workflow.',
      cli: 'Use for local diagnostics, read-only inspection, and commands the user can review.',
      api: 'Use for exact service contract, region endpoint, project_id, pagination, and error codes.',
      sdk: 'Use when writing application code that calls Huawei Cloud services.',
      mcp: 'Prefer approved MCP tools when available because tools can carry structured schemas.',
      terraform: 'Keep low priority in V1; suggest it for reviewed infrastructure changes, not quick diagnosis.',
    },
  };
}

// ── Pack meta tools ──
// Both tools read the pack registry (PACK_OF inversion in packs/registry.ts),
// the tool definitions (name/description), the zod schemas, and the live
// enablement set (packs/enable.ts, DEVKIT_PACKS > all packs), so their output
// can never disagree with tools/list: a disabled pack is listed with
// enabled:false, and pack_info refuses to detail it.

// Skill directory → owning pack, inverted from the PACKS claims. The tree is
// server data, so an unclaimed directory is a retired skill name that
// survived a copy: copyServerPayload prunes those on update, and treating
// stragglers as unowned (outside pack gating) is defense in depth — the
// enablement filter in searchDocs/retrieveSkill never crashes on them.
export const SKILL_OWNER = new Map<string, PackId>(
  PACKS.flatMap((pack) => pack.skills.map((skill) => [skill, pack.id] as const)),
);

export function listPacks(opts: CallToolOptions = {}) {
  const enabled = resolveEnabledPacks();
  // packs_configure is core-owned but registered only on surfaces that carry
  // session state (stdio). The meta tools must not advertise a tool where
  // tools/list will never carry it, so core's tool list is filtered by the
  // same seam the registration factory uses.
  const runtimeToggling = Boolean(opts.onPacksChanged);
  return {
    ok: true,
    count: PACKS.length,
    packs: PACKS.map((pack) => ({
      id: pack.id,
      title: pack.title,
      description: pack.description,
      skills: pack.skills,
      tools:
        pack.id === 'core' && !runtimeToggling
          ? pack.tools.filter((name) => name !== 'huaweicloud_packs_configure')
          : pack.tools,
      enabled: enabled.has(pack.id),
    })),
  };
}

// Shared enablement remediation: pack_info, list_skills, and retrieve_skill
// serve the same instructions for the same condition, so a wording fix lands
// once. The stdio qualifier keeps the message honest on the stateless
// remote, which never registers the session-toggle tool.
export function packEnablementRemediation(packId: string): string {
  return (
    'Enable it for this session with huaweicloud_packs_configure (stdio agent sessions; confirm with the user when the operator trimmed the pack on purpose), or ask the operator to persist it with npx huaweicloud-devkit packs enable ' +
    packId +
    ' --target <agent>, then restart the agent (that command rewrites DEVKIT_PACKS in the agent MCP config).'
  );
}

// Shared refusal for an unknown pack id: names every valid id so the caller
// can retry without a second discovery call.
export function packNotFound(packId: string): { ok: false; error: string } {
  const available = PACKS.map((entry) => entry.id).join(', ');
  return { ok: false, error: 'Pack "' + packId + '" not found. Available: ' + available };
}

export function packNotEnabled(packId: string): { ok: false; error: string } {
  return { ok: false, error: 'Pack "' + packId + '" is not enabled. ' + packEnablementRemediation(packId) };
}

export function packInfo(pack: string, opts: CallToolOptions = {}) {
  const packId = String(pack || '').trim();
  if (!packId) return { ok: false, error: 'Pack id is required.' };
  const found = PACKS.find((entry) => entry.id === packId);
  if (!found) return packNotFound(packId);
  const enabled = resolveEnabledPacks();
  if (!enabled.has(found.id)) return packNotEnabled(found.id);
  // Same surface filter as listPacks: core owns packs_configure, but only
  // session-carrying surfaces register it, and pack_info must not advertise
  // a tool tools/list will never carry.
  const toolNames =
    found.id === 'core' && !opts.onPacksChanged
      ? found.tools.filter((name) => name !== 'huaweicloud_packs_configure')
      : found.tools;
  const tools = toolNames.map((name) => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
    const schema = z.toJSONSchema(getToolSchema(name)) as Record<string, unknown>;
    for (const key of SCHEMA_DRIFT_IGNORED_KEYS) delete schema[key];
    return { name, description: definition?.description ?? '', schema };
  });
  return {
    ok: true,
    pack: found.id,
    title: found.title,
    description: found.description,
    skills: found.skills,
    tools,
    enabled: true,
  };
}
