import { homedir } from 'node:os';
import { join } from 'node:path';

// Single Source of Truth for onboarding guidance steps and the auth error
// surface (#900). Leaf module: imports NOTHING from auth/ siblings. Zero IO —
// pure builders. It deliberately compiles into BOTH import graphs: the
// zod-free unbundled dist/setup-cli.js (setup-cli.ts imports auth/*) and the
// zod-bearing bundled dist/mcp-server.js — so only node builtins are allowed
// here, and structure.test.ts walks src/auth/ to keep that true.

export interface GuidanceStep {
  order?: number;
  action: string;
  args?: Record<string, string>;
  label?: string;
  target?: string;
}

export function buildOnboardingSteps(scenario: number, { codearts = false } = {}): GuidanceStep[] {
  switch (scenario) {
    case 3: {
      const base = [{ order: 1, action: 'obtain-aksk', target: 'console', label: '获取 AK/SK(华为云控制台)' }];
      if (codearts) {
        return [
          ...base,
          {
            order: 2,
            action: 'write-import',
            target: join(homedir(), '.config', 'huaweicloud', 'creds-import.json'),
            label: '把 AK/SK 写入 creds-import.json',
          },
          {
            order: 3,
            action: 'auth_switch',
            // QA #905 Required: scenario-3 codearts flow writes creds-import.json
            // in step 2, so the import must READ that file (mode:'import').
            // mode:'mcp-config' reads the CodeArts injected environment, which
            // is empty/placeholder in scenario 3 — the channel would not close.
            args: { mode: 'import', action: 'persist' },
            label: '执行导入完成配置',
          },
        ];
      }
      return [...base, { order: 2, action: 'auth-init', args: {}, label: '运行 npx huaweicloud-devkit auth init' }];
    }
    case 4:
      return [
        {
          order: 1,
          action: 'auth_switch',
          args: { mode: codearts ? 'mcp-config' : 'import', action: 'persist' },
          label: '导入该账号',
        },
      ];
    default:
      return [];
  }
}

// #900 error contract table. messageZh: Chinese, human-readable, no English
// sentences, no internal codenames. action: directly executable. nextStep is
// kept as a derived compatibility field for existing consumers.
// NOTE: CREDENTIAL_EXPIRED is deliberately NOT here — it is the hcloud runner's
// result code for expired platform-injected STS (a runtime fast-fail), not an
// onboarding/table state.
export const ERROR_TABLE = {
  HDKIT_CRED_MISSING: {
    messageZh: '未配置华为云凭证,需要先完成登录。',
    action: 'npx huaweicloud-devkit auth init',
  },
  HDKIT_CRED_INVALID: {
    messageZh: '凭证已被华为云拒绝(AK/SK 无效或已过期),请重新生成。',
    action: 'npx huaweicloud-devkit auth status',
  },
  HDKIT_CRED_FORBIDDEN: {
    messageZh: '凭证有效但无权限列出项目,请检查账号授权。',
    action: 'hcloud IAM KeystoneListProjects --cli-region=<region>',
  },
  HDKIT_CRED_REGION_MISSING: {
    messageZh: '缺少 region(区域),登录配置不完整。',
    action: 'hcloud configure set --cli-region=<region>',
  },
  HDKIT_KOOCLI_NOT_READY: {
    messageZh: 'KooCLI(hcloud)未安装或未就绪。',
    action: 'npx huaweicloud-devkit install-hcloud',
  },
  HDKIT_PROJECT_ID_MISSING: {
    messageZh: 'KooCLI 配置缺少 project_id,导致同步失败。',
    action: 'hcloud configure set --cli-project-id=<id>',
  },
  // Runtime credentials (in-process, set via auth_init/auth_switch) suppress
  // auto-sync (rule R10). No `auth sync --force` flag exists; the real unblock
  // is clearing the runtime store first, then re-running the sync.
  HDKIT_SYNC_SKIPPED_RUNTIME: {
    messageZh: '运行时凭证生效,自动同步已跳过。',
    action: 'huaweicloud_auth_switch action=clear',
  },
  // auth_sync propagates the persisted S1 store only. When S1 is empty but the
  // session carries runtime or env credentials, the generic missing-credential
  // error read as "nothing configured" while auth_status's reconciled panel
  // showed the same process as configured (2026-11-05 UX report #3); this code
  // names the actual state and the persist path.
  HDKIT_SYNC_S1_MISSING_SESSION_ACTIVE: {
    messageZh: '落盘凭证未配置;当前会话存在临时凭证(运行时或环境变量,仅本会话有效),同步只传播落盘凭证。',
    action: 'huaweicloud_auth_switch action=persist',
  },
  // IAM returned something other than 200/401/403 (or the request itself
  // failed). The canonical debug hint lives in the cli-and-auth skill.
  HDKIT_CRED_UNEXPECTED: {
    messageZh: '凭证校验遇到异常响应,请开启调试排查。',
    action: 'hcloud <Service> <Op> --cli-debug=true',
  },
} as const;

export type ErrorCode = keyof typeof ERROR_TABLE;

export interface TableErrorShape {
  code: string;
  messageZh: string;
  action: string;
  nextStep: string;
}

export function errorFromTable(code: ErrorCode | (string & {}), detail?: string): TableErrorShape {
  // The `(string & {})` intersection keeps compile-time completion for the
  // known codes while still accepting future/unknown codes — they degrade to
  // the detail-only shape below instead of throwing.
  const e = (ERROR_TABLE as Record<string, { messageZh: string; action: string }>)[code];
  if (!e) {
    // Unknown code: the detail rides in messageZh only. nextStep stays empty —
    // a prose sentence there would violate the one contract this table exists
    // to enforce (top-level nextStep is always an executable command).
    return { code, messageZh: detail || String(code), action: '', nextStep: '' };
  }
  return {
    code,
    messageZh: detail ? `${e.messageZh}(${detail})` : e.messageZh,
    action: e.action,
    nextStep: e.action,
  };
}

export interface TableError extends Error {
  code: string;
  action: string;
  nextStep: string;
  messageZh: string;
}

export function makeError(code: ErrorCode | (string & {}), detail?: string): TableError {
  const shape = errorFromTable(code, detail);
  const err = new Error(shape.messageZh) as TableError;
  err.code = shape.code;
  err.action = shape.action;
  err.nextStep = shape.nextStep;
  err.messageZh = shape.messageZh;
  return err;
}
