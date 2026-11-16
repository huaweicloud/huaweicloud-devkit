import { z } from 'zod';

import {
  getCachedUpdateInfo,
  getUpdateDistTags,
  invalidateUpdateCache,
  judgeUpdate,
  determineTarget,
  readInstalledVersion,
  writeSkipState,
  resolveSkipFilePath,
  upgradePackage,
} from '../../update-check.ts';
import type { PackToolDefinition, LooseToolSchema } from '../../lib/pack-types.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';
import { approvalTokenArg, approvedByUserArg } from '../../lib/tool-schema-parts.ts';

// Handlers migrated verbatim from src/tools.ts; the doQuery injection seam on
// CallToolOptions is passed through unchanged (test/upgrade-session.test.ts
// #607 depends on it reaching getUpdateDistTags/getCachedUpdateInfo).
async function handleCheckUpdate(args: ToolArgs = {}, opts: CallToolOptions = {}) {
  const { sessionId = null, doQuery } = opts;
  const current = readInstalledVersion() || '0.0.0';
  if (args.dismiss === true) {
    const distTags = await getUpdateDistTags(current, { sessionId, doQuery });
    if (!distTags) {
      // 查询失败：不降级为 current 冷却、不写 skip，返回 check_failed。
      // 不调 invalidateUpdateCache()，以保留 failedAt 的 5 分钟失败节流。
      return judgeUpdate(current, null, null);
    }
    const target = determineTarget(current, distTags);
    const dismissedVersion =
      typeof args.dismissVersion === 'string' && args.dismissVersion ? args.dismissVersion : target || current;
    const state = writeSkipState(resolveSkipFilePath(sessionId), dismissedVersion);
    invalidateUpdateCache();
    return judgeUpdate(current, distTags, state);
  }
  return getCachedUpdateInfo(current, { sessionId, doQuery });
}

async function handleUpgrade(args: ToolArgs = {}, opts: CallToolOptions = {}) {
  const sessionId = opts?.sessionId || null;
  const target = typeof args.target === 'string' && args.target ? args.target : 'all';
  const version = typeof args.version === 'string' && args.version ? args.version : 'latest';
  const current = readInstalledVersion() || '0.0.0';
  const info = await getCachedUpdateInfo(current, { sessionId });
  if (info && info.result === 'up_to_date') {
    return {
      success: false,
      requiresRestart: false,
      message: '已是最新版本，无需升级。',
      currentVersion: info.currentVersion,
      targetVersion: info.targetVersion,
    };
  }
  return upgradePackage({ target, version });
}

const checkUpdateSchema = z.looseObject({
  dismiss: z.boolean().optional().describe('用户拒绝升级时传 true，记录冷却状态。'),
  dismissVersion: z
    .string()
    .optional()
    .describe('与 dismiss:true 搭配，用户拒绝的版本号。缺省时用当前检测到的 targetVersion。'),
});

const upgradeSchema = z.looseObject({
  version: z.string().optional().describe('仅支持 "latest"（默认）。'),
  target: z
    .string()
    .optional()
    .describe('agent 目标（opencode/codex/codearts/.../all）。缺省时用 all（仅更新已安装的）。'),
  approvalToken: approvalTokenArg,
  approvedByUser: approvedByUserArg,
});

export const UPDATE_TOOLS = [
  {
    name: 'huaweicloud_check_update',
    description:
      '检查 huaweicloud-devkit 插件是否有新版本。结果含 currentVersion / latestStable / latestNext / targetVersion / updateAvailable / dismissExpiresAt / result。支持 dismiss:true 记录用户拒绝（3 天冷却，新版本会重新提醒）。',
    schema: checkUpdateSchema,
    handler: handleCheckUpdate,
  },
  {
    name: 'huaweicloud_upgrade',
    // The mechanical approval gate enforces the consent this line used to
    // only ask for (PR-3c): token mode runs the approve command from the
    // gate's rejection envelope in the user's own terminal, ask mode lets
    // the server raise the confirmation itself.
    description:
      '升级 huaweicloud-devkit 到最新版本。升级会改写磁盘上的插件本体，因此由审批门机械把关：默认 token 模式下，无 token 调用会返回 USER_CONFIRMATION_REQUIRED 与 approve 命令行，用户在自己的终端确认后才可重试；DEVKIT_APPROVAL_MODE=ask 时由服务器在调用内弹出确认（表单或聊天往返）。version 仅支持 "latest"。完成后需重启会话生效。',
    schema: upgradeSchema,
    handler: handleUpgrade,
  },
] as const satisfies readonly PackToolDefinition[];

export type UpdateToolName = (typeof UPDATE_TOOLS)[number]['name'];

// Schema map keyed by tool name for src/tool-schemas.ts: TOOL_SCHEMAS spreads
// it in place, keeping the satisfies Record<ToolName, LooseToolSchema>
// completeness check over every ToolName key.
export const UPDATE_TOOL_SCHEMAS: Readonly<Record<UpdateToolName, LooseToolSchema>> = {
  huaweicloud_check_update: checkUpdateSchema,
  huaweicloud_upgrade: upgradeSchema,
};

// Dispatch map merged into PACK_TOOL_HANDLERS in packs/registry.ts. Typed over
// UpdateToolName, so a tool added to UPDATE_TOOLS without a handler entry
// here — or the reverse — fails to compile instead of failing at runtime.
export const UPDATE_TOOL_HANDLERS: Readonly<Record<UpdateToolName, PackToolDefinition['handler']>> = {
  huaweicloud_check_update: handleCheckUpdate,
  huaweicloud_upgrade: handleUpgrade,
};
