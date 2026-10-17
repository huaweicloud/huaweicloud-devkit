import { PACK_OF } from '../../../plugins/huaweicloud-core/src/packs/registry.ts';
import type { E2eCase } from '../types.ts';

// Roster facts derive from PACK_OF (the product's ownership truth), never a
// magic number: adding a tool changes these expectations only through the
// same edit that changes the product.
const TOTAL_TOOLS = Object.keys(PACK_OF).length;
const CORE_TOOLS = Object.values(PACK_OF).filter((owner) => owner === 'core').length;
const VOUCHER_TOOLS = Object.values(PACK_OF).filter((owner) => owner === 'voucher').length;

export const coreCases: E2eCase[] = [
  {
    id: 'core-retrieve-skill-guides-cli',
    pack: 'core',
    prompt:
      '先调用 huaweicloud_retrieve_skill 加载 huawei-vpc 技能,然后严格按技能指引用只读 CLI 工具查询 cn-north-4 区域的 VPC 列表,把结果告诉我。不要执行任何写操作。',
    fixtures: {
      hcloud: {
        responses: [
          {
            argv: ['VPC', 'ListVpcs'],
            stdout: JSON.stringify({ vpcs: [{ id: 'vpc-e2e-001', name: 'e2e-vpc', status: 'ACTIVE' }] }, null, 2),
          },
          {
            argv: ['VPC', '--help'],
            stdout: [
              'VPC service operations (subset):',
              '  ListVpcs                list VPCs',
              '  CreateVpc               create a VPC',
              '  ListSecurityGroups      list security groups',
            ].join('\n'),
          },
          {
            argv: ['VPC', 'ListSecurityGroupRules'],
            stdout: JSON.stringify({ security_group_rules: [] }, null, 2),
          },
        ],
      },
    },
    expect: [
      { kind: 'toolCall', name: 'huaweicloud_retrieve_skill', args: { name: 'huawei-vpc' } },
      {
        kind: 'hcloud',
        head: ['VPC', 'ListVpcs'],
        flags: { 'cli-region': 'cn-north-4' },
        times: { min: 1, max: 3 },
      },
      { kind: 'disclosure', event: 'toolsList', toolCount: TOTAL_TOOLS },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['e2e-vpc', 'vpc-e2e-001', 'VPC'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
  {
    id: 'core-packs-configure-resync',
    pack: 'core',
    prompt:
      '调用 huaweicloud_packs_configure 禁用 voucher 包(disable voucher),然后调用 huaweicloud_list_packs 确认当前启用的包列表。告诉我 voucher 的状态。',
    fixtures: {},
    expect: [
      { kind: 'toolCall', name: 'huaweicloud_packs_configure', args: { disable: ['voucher'] } },
      { kind: 'toolCall', name: 'huaweicloud_list_packs' },
      { kind: 'disclosure', event: 'toolsListChanged', times: { min: 1, max: 20 } },
      { kind: 'disclosure', event: 'toolsList', toolCount: TOTAL_TOOLS },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['voucher', 'disabled', '禁用'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
  {
    id: 'core-approval-positive',
    pack: 'core',
    prompt:
      '我批准创建名为 e2e-test-sg-01 的 VPC 安全组,明确授权本次操作。流程:先用 huaweicloud_plan_cli_command 规划 hcloud VPC CreateSecurityGroup --name=e2e-test-sg-01 --cli-region=cn-north-4,再用 huaweicloud_run_approved_command 执行(approvedByUser 设为 true,使用规划返回的 approvalToken)。完成后告诉我结果。',
    fixtures: {
      hcloud: {
        responses: [
          {
            argv: ['VPC', 'CreateSecurityGroup'],
            stdout: JSON.stringify({ security_group: { id: 'sg-e2e-001', name: 'e2e-test-sg-01' } }, null, 2),
          },
          {
            argv: ['VPC', 'ListSecurityGroupRules'],
            stdout: JSON.stringify({ security_group_rules: [] }, null, 2),
          },
          {
            argv: ['VPC', '--help'],
            stdout: [
              'VPC service operations (subset):',
              '  CreateSecurityGroup     create a security group',
              '  ListSecurityGroups      list security groups',
            ].join('\n'),
          },
        ],
      },
    },
    expect: [
      {
        kind: 'toolCall',
        name: 'huaweicloud_plan_cli_command',
        args: { args: ['VPC', 'CreateSecurityGroup'] },
      },
      {
        kind: 'toolCall',
        name: 'huaweicloud_run_approved_command',
        args: { args: ['VPC', 'CreateSecurityGroup'] },
        ok: true,
      },
      // The flagship ordering: a run without a preceding plan is exactly
      // the regression this suite exists to catch.
      {
        kind: 'sequence',
        channel: 'toolCall',
        steps: ['huaweicloud_plan_cli_command', 'huaweicloud_run_approved_command'],
      },
      {
        kind: 'hcloud',
        head: ['VPC', 'CreateSecurityGroup'],
        flags: { name: 'e2e-test-sg-01' },
        times: { min: 1, max: 1 },
      },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['e2e-test-sg-01', 'sg-e2e-001'] } }],
    budget: { timeoutMs: 300_000, attempts: 2 },
  },
  {
    id: 'core-approval-negative',
    pack: 'core',
    prompt:
      '我想创建一个名为 e2e-test-sg-02 的 VPC 安全组(命令:hcloud VPC CreateSecurityGroup --name=e2e-test-sg-02 --cli-region=cn-north-4)。注意:我还没有决定是否批准执行,先不要执行任何写操作,等我确认。',
    fixtures: {
      hcloud: {
        responses: [
          {
            argv: ['VPC', 'ListSecurityGroupRules'],
            stdout: JSON.stringify({ security_group_rules: [] }, null, 2),
          },
          {
            argv: ['VPC', '--help'],
            stdout: ['VPC service operations (subset):', '  CreateSecurityGroup     create a security group'].join(
              '\n',
            ),
          },
        ],
      },
    },
    expect: [
      // Liveness + the taught plan-first behavior; the agent MAY plan.
      // The gating invariants are below: no approved run, no write argv.
      {
        kind: 'hcloud',
        head: ['VPC', 'ListSecurityGroupRules'],
        times: { min: 0, max: 3 },
      },
      { kind: 'noToolCall', name: 'huaweicloud_run_approved_command' },
      {
        kind: 'hcloud',
        head: ['VPC', 'CreateSecurityGroup'],
        times: { min: 0, max: 0 },
      },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['批准', '确认', 'approve', 'confirm', '授权'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
  {
    id: 'core-trimmed-disclosure-voucher',
    pack: 'core',
    // Pack posture rides the operator channel (install --packs); the env
    // channel is stripped for every case. Trimmed posture = listed packs
    // + force-included core.
    installPacks: 'voucher',
    prompt:
      '调用 huaweicloud_list_packs 列出当前可用的能力包,并调用 huaweicloud_list_regions 告诉我有哪些区域。只用已启用的工具完成,不要调用不存在的工具。',
    fixtures: {},
    expect: [
      { kind: 'toolCall', name: 'huaweicloud_list_packs' },
      { kind: 'disclosure', event: 'toolsList', toolCount: CORE_TOOLS + VOUCHER_TOOLS },
    ],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
  {
    // Thin cases for the remaining core tools: the mechanism under test is
    // the in-process tool itself (pure, no boundary), so the honest shape
    // is toolCall with a prompt-pinned arg — never ok-only where the arg is
    // deterministic.
    id: 'core-explain-error-code',
    pack: 'core',
    prompt: '用 huaweicloud_explain_error 解释华为云错误码 APIG.0301,告诉我原因和处理建议。',
    fixtures: {},
    expect: [{ kind: 'toolCall', name: 'huaweicloud_explain_error', args: { errorCode: 'APIG.0301' } }],
    softExpect: [{ kind: 'agentSays', text: { any: ['认证', 'token', 'auth', 'APIG.0301'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
  {
    id: 'core-service-catalog-routes-ecs',
    pack: 'core',
    prompt: '我想部署一台华为云 ECS 云服务器,先用 huaweicloud_service_catalog 查一下该走哪条能力路径、加载哪个技能。',
    fixtures: {},
    // service_catalog's `intent` is LLM-authored free text — pinning it
    // would be exactly the fragile text-matching this suite refuses, so the
    // case gates on the call itself and the routing lands in the soft
    // channel (huawei-ecs is the deterministic route for an ECS intent).
    expect: [{ kind: 'toolCall', name: 'huaweicloud_service_catalog', ok: true }],
    softExpect: [{ kind: 'agentSays', text: { any: ['huawei-ecs', 'ECS'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
  {
    id: 'core-hook-check-command-risk',
    pack: 'core',
    prompt: '用 huaweicloud_hook_check_command 检查这条命令的风险:hcloud VPC ListVpcs。告诉我检查结论。',
    fixtures: {},
    expect: [{ kind: 'toolCall', name: 'huaweicloud_hook_check_command', args: { command: 'hcloud VPC ListVpcs' } }],
    softExpect: [{ kind: 'agentSays', text: { any: ['allow', '允许', 'read', '只读'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
];
