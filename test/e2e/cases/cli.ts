import type { E2eCase } from '../types.ts';

export const cliCases: E2eCase[] = [
  {
    id: 'cli-readonly-list-vpc-sg',
    pack: 'huaweicloud-cli',
    prompt:
      '使用 devkit 提供的 CLI 工具,以只读方式查询 cn-north-4 区域的 VPC 安全组列表(security groups),然后把结果告诉我。不要执行任何写操作。',
    fixtures: {
      hcloud: {
        responses: [
          {
            argv: ['VPC', 'ListSecurityGroups'],
            stdout: JSON.stringify({ security_groups: [] }, null, 2),
          },
          {
            argv: ['VPC', '--help'],
            stdout: [
              'VPC service operations (subset):',
              '  ListSecurityGroups      list security groups',
              '  ListSecurityGroupRules  list security group rules',
              '  CreateSecurityGroup     create a security group',
            ].join('\n'),
          },
          {
            argv: ['VPC', 'help'],
            stdout: 'Usage: hcloud VPC <operation> [parameters]',
          },
        ],
      },
    },
    expect: [
      {
        kind: 'hcloud',
        head: ['VPC', 'ListSecurityGroups'],
        flags: { 'cli-region': 'cn-north-4' },
        times: { min: 1, max: 3 },
      },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['安全组', 'security group', '0', '空'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
];
