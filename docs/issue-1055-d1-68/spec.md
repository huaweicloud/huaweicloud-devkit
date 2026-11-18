# Issue #1055 — D1-68 region 读取优先级契约漂移（修复说明）

## 缺陷

区域环境变量解析把短别名 `HW_REGION` 放在官方名 `HUAWEICLOUD_REGION` 之前，与设计契约「`HUAWEICLOUD_REGION` 优先」相反（SPEC-MISMATCH）。两个变量同时设置时，实际生效的区域与契约不符，存在跨区域误操作风险。测试证据：`evidence/D1-68/stdout.log`（v1.1.13-next.0 报告，1.1.14 复核仍复现）。

## 受影响的四个入口（全部改）

| #   | 入口                         | 位置                                                    | 取值来源                                                           |
| --- | ---------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | `resolveCredentials()`       | `plugins/huaweicloud-core/src/auth/credentials.mjs:225` | `process.env`                                                      |
| 2   | `readCodeArtsCredentials()`  | 同文件 `:339`                                           | `.codeartsdoer/mcp/mcp_settings.json` 的 `mcpServers.<devkit>.env` |
| 3   | `readWorkEnvironmentEntry()` | 同文件 `:173`                                           | `~/.codearts/mcp/mcp_settings.json` 的 `environment`               |
| 4   | `cmdAuthInit()` 默认区域     | `plugins/huaweicloud-core/src/setup-cli.mjs:4983`       | `process.env`                                                      |

> 第 4 处不在报告的行号里，但表达式与前三处完全相同（同一契约缺陷、同一交付路径 `auth init`），因此一并修正，避免只修一半、下次复核换个入口复发。

## 契约（验收口径）

1. 两个变量同时设置 → `HUAWEICLOUD_REGION` 生效。
2. 只设置 `HW_REGION` → 仍生效（别名向后兼容）。
3. `HUAWEICLOUD_REGION=''` → 不得遮蔽已赋值的 `HW_REGION`（保持 `||` 语义，不用 `??`）。
4. 四条入口的优先级**一致**。
5. 不改变 AK / SK / securityToken 解析、占位符判定（R11）、vault 优先级（R9）、STS 三元组优先级——只改 `region` 的取值顺序。

## 变更

- `plugins/huaweicloud-core/src/auth/credentials.mjs`、`plugins/huaweicloud-core/src/setup-cli.mjs`：4 行顺序互换（`HUAWEICLOUD_REGION || HW_REGION`）。
- `test/issue-1055-d1-68-region-priority.test.mjs`：6 条回归用例（三入口优先级 + 别名回退 + 空值不遮蔽 + 源码级「反向写法」守卫）。

## 验证

- RED：先加用例、源码未改 → 4/6 失败（两条别名回退用例本就应通过）。
- GREEN：改动后 6/6 通过。
- `node --test test/auth-credentials.test.mjs`：47/50，3 条失败与本改动无关（`/root/.codearts` mkdir 环境问题，基线同样失败）。
- `node ./scripts/validate-package.mjs`：29 skills + KooCLI 7.3.12 pairing 通过。
- Prettier `--check`：改动文件通过。

## 风险与回退

若某部署同时设置两个变量且此前依赖 `HW_REGION` 生效，升级后区域取值会切换为 `HUAWEICLOUD_REGION`——这正是契约要求；处置方式是移除不可信的那个变量。回退为单 PR revert，无配置/数据迁移。
