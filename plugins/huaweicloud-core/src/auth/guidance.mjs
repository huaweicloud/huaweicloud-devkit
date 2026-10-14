// plugins/huaweicloud-core/src/auth/guidance.mjs
// Single Source of Truth for onboarding guidance steps and the error surface.
// Leaf module: imports NOTHING from auth/ siblings. Zero IO — pure builders.
// Callers: credentials.mjs (failure path), service.mjs (computeOnboarding),
// credential-validator / reconcile / hcloud-probe (error shapes).
import { homedir } from 'node:os';
import { join } from 'node:path';

export function buildOnboardingSteps(scenario, { codearts = false } = {}) {
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
  // IAM returned something other than 200/401/403 (or the request itself
  // failed). The canonical debug hint lives in the cli-and-auth skill.
  HDKIT_CRED_UNEXPECTED: {
    messageZh: '凭证校验遇到异常响应,请开启调试排查。',
    action: 'hcloud <Service> <Op> --cli-debug=true',
  },
};

export function errorFromTable(code, detail) {
  const e = ERROR_TABLE[code];
  if (!e) return { code, messageZh: detail || String(code), action: '', nextStep: detail || '' };
  return {
    code,
    messageZh: detail ? `${e.messageZh}(${detail})` : e.messageZh,
    action: e.action,
    nextStep: e.action,
  };
}

export function makeError(code, detail) {
  const shape = errorFromTable(code, detail);
  const err = new Error(shape.messageZh);
  err.code = shape.code;
  err.action = shape.action;
  err.nextStep = shape.nextStep;
  err.messageZh = shape.messageZh;
  return err;
}
