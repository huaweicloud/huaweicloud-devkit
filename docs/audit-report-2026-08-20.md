# 项目诊断报告 — huaweicloud-devkit

**日期:** 2026-08-20
**基准:** upstream/dev @ 43f25e8
**方法:** 全项目文件扫描 + 并行审计

---

## 总览

| 级别        | 数量   |
| ----------- | ------ |
| 🔴 严重     | 6      |
| 🟠 高危     | 5      |
| 🟡 中危     | 7      |
| ⚪ 低危     | 5      |
| 📋 代码质量 | 69     |
| **总计**    | **92** |

---

## 🔴 严重问题（必须修复）

### 1. `NODE_TLS_REJECT_UNAUTHORIZED = '0'` 全局禁用 TLS

- **文件:** `plugins/huaweicloud-core/src/mcp-server.mjs:2`
- **问题:** `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` 在模块顶层执行，对所有出站 HTTPS 连接生效，包括凭证传输。存在 MITM 中间人攻击风险。
- **修复方向:** 仅在需要时对特定请求禁用，不设全局。

### 2. `setRuntimeCredentials` 参数错位

- **文件:** `plugins/huaweicloud-core/src/tools.mjs:600`
- **问题:** 调用 `setRuntimeCredentials(args.ak, args.sk, args.region)`，但函数签名是 `setRuntimeCredentials(ak, sk, securityToken, region)`，`args.region` 被当作 `securityToken` 传入，导致 region 永远为 `undefined`。
- **修复:** 改为 `setRuntimeCredentials(args.ak, args.sk, undefined, args.region)`

### 3. `SERVICE_EXAMPLES` 大小写不匹配

- **文件:** `plugins/huaweicloud-core/src/tools.mjs:864`
- **问题:** `SERVICE_EXAMPLES[serviceName.toUpperCase()]` 将 serviceName 全大写查找，但 key 是 `FunctionGraph`、`GaussDB` 等混合大小写，导致永远返回 `undefined`，FunctionGraph/GaussDB/DDS/DCS 等服务的 examples 永远不会返回。
- **修复:** 将 SERVICE_EXAMPLES 的 key 全部改为大写，或 lookup 不做 toUpperCase。

### 4. MCP Server 版本号错误

- **文件:** `plugins/huaweicloud-core/src/mcp-server.mjs:107`
- **问题:** `serverInfo.version` 硬编码 `'0.1.0'`，实际 `package.json` 是 `1.0.2-next.13`。MCP 客户端收到的版本号不正确。
- **修复:** 动态读取 `package.json` 版本。

### 5. Python hook 与安全策略脱节

- **文件:** `plugins/huaweicloud-core/hooks/huaweicloud-safety.py:22-30`
- **问题:** AGENTS.md 宣称 Python hook 和 Node 共享 `policy.json`，实际 Python hook 硬编码了自己的正则规则，修改 `policy.json` 不会影响 Python hook 的安全检查。
- **修复:** 让 Python hook 读取 `safety/policy.json`。

### 6. `node:sqlite` 需要 Node 22+，项目要求 Node 20

- **文件:** `plugins/huaweicloud-core/src/auth/agent-registration.mjs:127`
- **问题:** `createRequire(import.meta.url)('node:sqlite')` 只在 Node 22.12+ 可用，项目 `engines` 设为 `>=20`，在 Node 20 上会抛出异常（虽被 try/catch 吞掉，但功能不生效）。
- **修复:** 需降级或用条件判断跳过。

---

## 🟠 高危问题

### 7. INSTALL.md 技能数错误

- **文件:** `INSTALL.md:94`
- **问题:** 写 `skills/ # 11 个技能`，实际 28 个（6 meta + 22 service）。

### 8. CONTRIBUTING.md 引用已删除的 workflow

- **文件:** `CONTRIBUTING.md:98,111-112`
- **问题:** 引用已退役的 `Publish Dev (next)`、`Prepare Release`、`Publish Release` workflow，当前只有 `release.yml` 和 `npm-publish.yml`。

### 9. cloud-find-skills 混用 Python/Node

- **文件:** `plugins/.../skills/huawei-cloud-find-skills/SKILL.md`
- **问题:** 代码引用 `search-skills.mjs`(Node.js)，但 Reference 表和 Troubleshooting 仍写 `search-skills.py`。Step 0 仍描述 Python 3 环境检查。

### 10. 两份 cloud-find-skills 副本

- **文件:**
  - `plugins/huaweicloud-core/skills/huawei-cloud-find-skills/` (使用 `search-skills.mjs`)
  - `skills/@huaweiclouddev/huawei-cloud-find-skills/` (使用 `search-skills.py`)
- **问题:** 两份不同实现，哪个是 canonical？

### 11. Plugin manifest 仓库 URL 大小写不一致

- **文件:** `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.workbuddy-plugin/plugin.json`
- **问题:** URL 写 `huaweicloud/HuaweiCloud-Devkit`，正确应为 `huaweicloud/huaweicloud-devkit`

---

## 🟡 中危问题

| #   | 文件                                    | 问题                                                    |
| --- | --------------------------------------- | ------------------------------------------------------- |
| 12  | `integrations/opencode/opencode.json:7` | 中文占位符 `<绝对路径>` 对非中文用户不友好              |
| 13  | `rules/huawei-agent-rules.md`           | 缺 sandbox/auth/icon/hook 工具引用                      |
| 14  | `setup-cli.mjs:580`                     | `uninstallCodex` 硬编码 `'HuaweiCloud-Devkit'` 作为回退 |
| 15  | `sandbox/session-manager.mjs:12`        | `DEFAULT_WORKSPACE_ID` 硬编码 demo UUID                 |
| 16  | `huaweicloud-core/SKILL.md:3`           | 描述只提 Codex/OpenCode，未提其他 4 个 Agent            |
| 17  | `docs/CHANGELOG.md`                     | `1.0.2-next.10/9` 有重复条目                            |
| 18  | `docs/RELEASING.md:147`                 | Phase 0/1 标记为未完成，实际已实现                      |

---

## ⚪ 低危问题

- `rules/huawei-agent-rules.md:3` 含内部开发笔记 `"对标 aws-core"`
- `test/0807test/` 有临时调试文件，应清理
- `.mcp.json` 配置硬编码路径

---

## 📋 代码质量问题（69 项摘要）

### 死链（6 项）

- `huawei-ecs/SKILL.md` 引用不存在的 `references/sg.md`
- `huawei-iam/SKILL.md` 引用不存在的 `iam-ops.md`, `agency.md`, `sts.md`
- `huawei-obs/SKILL.md` 引用不存在的 `replication.md`
- `huawei-vpc/SKILL.md` 引用不存在的 `eip.md`

### 路径错误（3 项）

- `cloud-find-skills` Reference 表写 `.py`，实际 `.mjs`
- Troubleshooting 写 `python scripts/search-skills.py`

### 破损代码（2 项）

- `huawei-dew/SKILL.md:56` 代码块 `` `\x08ash `` (含退格字符)

### 缺 YAML version（6 项）

- `huaweicloud-api-and-sdk`, `huaweicloud-capability-discovery`, `huaweicloud-cli-and-auth`, `huaweicloud-safety`, `huaweicloud-troubleshooting`, `huawei-cloud-find-skills`

### 重复代码（12+ 处）

- `setup-cli.mjs` 6 个 Agent 的 install/update/uninstall/status 模式重复
- `tools.mjs` sandbox 工具处理 4 个函数的变量提取模式重复
- `ws-exec-client.js` 和 `hwlink-exec-client.js` 重复 `normalizeCommand`/`normalizeTimeout`
- `safety-policy.mjs` 和 `risk-rule-engine.mjs` 重复脱敏正则

### 函数过复杂

- `classifyHcloudArgs` 185 行
- `tools.mjs` 1359 行应拆分

### 安全相关

- `hdkitservice-api.mjs` SK 以明文 HTTP Header 传输
- `credentials.mjs` Windows 上无文件权限控制
- `setup-cli.mjs` hcloud configure 通过命令行参数传递 AK/SK（进程可见）
