# 版本升级检测与自动升级设计方案

## 概述

用户通过 npx 安装 huaweicloud-devkit 后，无法感知新版本发布。本方案实现：

1. **检测**：用户在 agent 会话中首次使用插件时，自动检测是否有新版本
2. **提醒**：有新版本时询问用户是否升级
3. **升级**：用户同意后自动完成升级
4. **冷却**：用户拒绝后 3 天内不再打扰

## 检测机制（双层）

### 第一层：Skills 驱动（主方案）

`huaweicloud-core/SKILL.md` 中新增启动指令，Agent 在首次操作前自动调用 `huaweicloud_check_update`。

SKILL.md 新增内容：

```markdown
## 会话启动

首次操作前必须先调用 `huaweicloud_check_update` 检查插件版本：

1. 如果 `updateAvailable == true` 且 `dismissed == false`，询问用户是否升级
2. 用户同意 → 调用 `huaweicloud_upgrade` 完成升级
3. 用户拒绝 → 调用 `huaweicloud_check_update` 传入 `dismiss: true`
```

### 第二层：Tool 响应附加（兜底）

如果 Agent 未遵守 SKILL.md 指令，在第一个非检查类 tool 的响应中附加版本信息。

MCP Server 统一包装函数：

```javascript
function wrapResult(result, callCount) {
  if (callCount > 1 || result._skipCheck) return result;
  const info = getCachedUpdateInfo();
  if (info && info.updateAvailable && !info.dismissed) {
    result._updateInfo = {
      currentVersion: info.currentVersion,
      latestVersion: info.latestVersion,
    };
  }
  return result;
}
```

仅在**会话中第一个 tool 调用**时附加，后续调用不再重复。

## MCP Tool 定义

### huaweicloud_check_update

检测插件是否有新版本。

**输入：**

```json
{
  "dismiss": false,
  "dismissVersion": ""
}
```

- `dismiss`：用户拒绝升级时设为 `true`
- `dismissVersion`：拒绝的版本号（与 `dismiss: true` 搭配使用）

**输出：**

```json
{
  "currentVersion": "1.1.0-next.8",
  "latestStable": "1.2.0",
  "updateAvailable": true,
  "dismissed": false,
  "dismissExpiresAt": null,
  "result": "update_available"
}
```

| result             | 含义                       |
| ------------------ | -------------------------- |
| `up_to_date`       | 已是最新版本               |
| `update_available` | 有新版本                   |
| `dismissed`        | 用户已拒绝，冷却期中       |
| `check_failed`     | 版本检测失败（网络问题等） |

### huaweicloud_upgrade

执行升级操作。

**输入：**

```json
{
  "version": "latest"
}
```

**输出：**

```json
{
  "success": true,
  "previousVersion": "1.1.0-next.8",
  "installedVersion": "1.2.0",
  "requiresRestart": true,
  "message": "升级完成，请重启当前会话使新版本生效"
}
```

## 版本比对规则

| 当前版本     | npm latest   | 是否提醒          |
| ------------ | ------------ | ----------------- |
| 1.1.0-next.8 | 1.2.0        | ✅                |
| 1.1.0-next.8 | 1.1.0-next.9 | ❌（pre-release） |
| 1.2.0        | 1.2.0        | ❌（相同）        |
| 1.0.2        | 1.2.0        | ✅                |

比对基于 `npm view huaweicloud-devkit version`（latest tag），`-next.x` 后缀的版本被排除。

## 冷却机制

用户拒绝升级后，记录到插件根目录的 `.update-skip.json`：

```json
{
  "dismissedVersion": "1.2.0",
  "dismissedAt": "2026-08-28T10:00:00Z",
  "expireAt": "2026-08-31T10:00:00Z"
}
```

- 冷却期：3 天
- 冷却期内 `huaweicloud_check_update` 返回 `dismissed: true`
- 冷却期后重新提醒
- 有新版本（> dismissedVersion）时无视冷却期，重新提醒
- 文件位置：`<pluginDir>/.update-skip.json`（各 agent 插件目录不同）

## 升级流程

```
用户同意升级
  │
  ├── MCP Server 收到 huaweicloud_upgrade 请求
  │
  ├── 异步执行：
  │     ├── npm view huaweicloud-devkit@latest version（确认版本）
  │     ├── npm install huaweicloud-devkit@latest（更新 npx 缓存）
  │     └── node setup-cli.mjs install --target <agent>（重新同步文件）
  │
  ├── 返回升级结果
  │
  └── 用户手动重启会话 → MCP Server 以新版本启动
```

## 规避的风险

| 风险                         | 措施                                                   |
| ---------------------------- | ------------------------------------------------------ |
| npm registry 请求慢          | `initialize` 阶段异步请求，tool 调用时读缓存           |
| 多 agent 路径不一致          | dismiss 文件存到各自插件目录                           |
| Agent 不遵守 SKILL.md        | 兜底方案（首调用附加字段）                             |
| 升级后 MCP Server 仍跑旧代码 | 明确告知用户需重启会话                                 |
| npm install 权限不足         | 失败时提示用户手动执行 `npx huaweicloud-devkit update` |
| 离线环境                     | `check_failed` 时不阻塞正常工具调用                    |

## 实现优先级

1. `huaweicloud_check_update` tool（版本检测 + dismiss）
2. 首调用兜底包装（`wrapResult`）
3. `huaweicloud_upgrade` tool
4. SKILL.md 更新
5. 测试
