import type { E2eCase } from '../types.ts';

// S1 vault seed: setup_obs_config syncs from the global credential vault,
// which errors on an empty vault — the reviewer-verified precondition.
const S1_SEED = JSON.stringify({ ak: 'E2E_M5_AK', sk: 'E2E_M5_SK', securityToken: '', region: 'cn-north-4' }, null, 2);

export const obsCases: E2eCase[] = [
  {
    id: 'obs-setup-config-writes-obsutilconfig',
    pack: 'obs',
    prompt:
      '我的全局凭证已配置好(cn-north-4)。运行 huaweicloud_setup_obs_config 把 OBS 的 obsutil 配置生成好,告诉我配置文件路径和 endpoint。',
    fixtures: {
      home: {
        '.config/huaweicloud/credentials.json': S1_SEED,
      },
    },
    expect: [
      { kind: 'toolCall', name: 'huaweicloud_setup_obs_config', ok: true },
      // writeObsConfig emits the region-derived endpoint and both keys.
      { kind: 'file', path: '.obsutilconfig', contains: 'ak=E2E_M5_AK' },
      { kind: 'file', path: '.obsutilconfig', contains: 'endpoint=https://obs.cn-north-4.myhuaweicloud.com' },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['obsutilconfig', 'endpoint', 'cn-north-4'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
];

export const discoveryCases: E2eCase[] = [
  {
    id: 'discovery-detect-framework-react',
    pack: 'discovery',
    prompt:
      '检测 {workdir} 这个本地项目目录的 web 框架类型(detect framework),把识别出的框架、包管理器和构建命令告诉我。只检测,不要安装或构建。',
    fixtures: {
      workdir: {
        'package.json': JSON.stringify(
          {
            name: 'e2e-react-fixture',
            private: true,
            dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0' },
            scripts: { build: 'vite build' },
          },
          null,
          2,
        ),
      },
    },
    expect: [
      // projectPath is the interpolated absolute workdir path; args partial
      // matching keys only on presence of a non-empty string — the runner
      // knows the path only after mkdtemp, so assert the tool ran ok and
      // the framework landed in the final message instead of pinning the
      // path literal.
      { kind: 'toolCall', name: 'huaweicloud_detect_framework', ok: true },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['react', 'React', 'spa', 'vite'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
  {
    // HUAWEICLOUD_ICONS_OFFLINE=1 forces the bundled snapshot
    // (src/data/icons-manifest.v1.json) — without it a networked host
    // (the nightly runner) would fetch the LIVE manifest from
    // open.huaweicloud.com, breaking the zero-egress contract and making
    // the case's data source environment-dependent.
    id: 'discovery-get-service-icon-offline',
    pack: 'discovery',
    env: { HUAWEICLOUD_ICONS_OFFLINE: '1' },
    prompt: '用 huaweicloud_get_service_icon 找一下 ECS 服务的官方图标,告诉我图标链接。',
    fixtures: {},
    expect: [{ kind: 'toolCall', name: 'huaweicloud_get_service_icon', args: { service: 'ecs' }, ok: true }],
    softExpect: [{ kind: 'agentSays', text: { any: ['logo', '图标', 'ecs'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
];
