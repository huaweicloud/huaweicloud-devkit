# huaweicloud-devkit 插件能力测试 · Function Graph 场景执行记录

- 测试日期：2026-08-07
- 插件：huaweicloud-devkit v0.1.0（npx huaweicloud-devkit-test install）
- 测试环境：WSL2 (Ubuntu)，KooCLI 7.2.12（测试从零环境开始：已卸载全部华为云 skills + KooCLI 后重新安装）
- 测试目标：Function Graph 轻量场景（A：timer 定时触发；B：APIG HTTP 触发），重点评估**插件能否指导工作**
- 测试原则：插件未教的工作禁止执行；缺口必须明示；记录供修复 Agent 使用

---

## 一、测试准备

### 1.1 安装（被测点 1）

- `npx --yes huaweicloud-devkit-test install` 安装成功（Node 检测、skills 21 个、MCP server、safety policy）
- **发现 D0**：安装器只写 `opencode.json`，不处理已存在的 `opencode.jsonc`，导致两个配置文件都含 `huaweicloud` MCP 且指向不同插件（双配置冲突）。已人工合并为 jsonc 单源。

### 1.2 从零环境（被测点 2：安装引导）

- 按要求卸载全部 28 个华为云 skills + hcloud + ~/.hcloud + ~/.obsutilconfig（清单已备份）
- `huaweicloud_check_cli` → `installed: false` + `errorCode: HCLOUD_NOT_FOUND` ✅（能区分 spawn 错误，指引含官方安装 URL 与 HCLOUD_BIN 提示）
- **发现 D-INS1**：未安装时插件只给安装 URL，无具体安装步骤（下载/解压/路径/PATH）；安装命令需自行从官方文档获取
- 安装 KooCLI 7.2.12（官方 OBS 包 → ~/.local/bin）
- **发现 D-AUTH1**：凭证配置零教学——check_cli 仅一句"对话外配置"，无 configure 命令、字段说明、AK/SK 获取路径（华为云官方机制：控制台「我的凭证→访问密钥」+ `hcloud configure init`/`configure set`，均为测试方自行查证）

### 1.3 MCP 工具摸底

- 12 个工具注册正常：check_cli / plan_cli_command / run_readonly_command / list_operations / run_approved_command / show_profile_redacted / service_catalog / explain_error / search_docs / retrieve_skill / list_regions / get_regional_availability
- **发现 D1（功能失效）**：`huaweicloud_search_docs` 与 `huaweicloud_retrieve_skill` 全部失效——`SKILLS_ROOT` 指向 `huaweicloud-plugins/skills`（不存在），而安装器实际把 skills 装在 `opencode/skills`。`retrieve_skill` 连候选列表都返回空（`Available: `）。两个核心"能力发现"工具形同虚设。
- ✅ `get_regional_availability(functiongraph, cn-north-4)` 可用

---

## 二、场景 A：timer 定时触发函数（PASS）

| 步骤 | 操作                           | 插件指引来源                                                | 结果                                        |
| ---- | ------------------------------ | ----------------------------------------------------------- | ------------------------------------------- |
| 1    | 区域可用性                     | `huaweicloud_get_regional_availability`                     | ✅ available                                |
| 2    | 操作名发现                     | `huaweicloud_list_operations(FunctionGraph)`                | ✅ 完整操作列表                             |
| 3    | 参数学习                       | `CreateFunction --help`（插件放行 local_metadata）          | ✅                                          |
| 4    | 创建函数（inline，Python3.10） | plan→deny→`run_approved_command`                            | ✅ func_urn 返回                            |
| 5    | 只读验证                       | `ListFunctions` / `ShowFunctionConfig` / `ShowFunctionCode` | ✅                                          |
| 6    | 手动调用                       | `InvokeFunction`（v0）                                      | ✅ 返回正确结果 "hello from devkit-fg-test" |
| 7    | timer 触发器（Rate 5m）        | `CreateFunctionTrigger --help` + approved                   | ✅ ACTIVE                                   |
| 8    | 触发器验证                     | `ListFunctionTriggers`                                      | ✅                                          |

**发现 D3（分类缺陷）**：`InvokeFunction` 被分类为 `allow/unknown_read`——有副作用（真实执行函数、产生调用）的操作可经"只读工具"直接放行，无需审批。执行类操作应单独分类。

**发现 D4（zip 上传陷阱）**：`CreateFunction` 用 `code_type=zip` 时代码**未上传**——用不存在的 `code_filename=nonexistent.zip` 也创建"成功"，且与真实文件创建的函数 `code_size`/`digest` 完全一致（占位值 286）。zip 函数实际运行空代码（返回 event 回显），inline 方式一切正常。该行为属 KooCLI 层，但插件无预警、无教学（正确的 zip 上传路径未覆盖）。**此坑若无人指导，代理无法发现**。

**发现 D2（工具能力缺口）**：MCP 的 hcloud 执行器无 `cwd` 支持，FG zip 上传"需 cd 到包目录"的要求无法表达（本次通过先 cd 再启动 MCP server 规避）。

## 三、场景 B：APIG(DEDICATEDGATEWAY) HTTP 触发（PASS，公网验证受限）

| 步骤 | 操作                         | 插件指引来源                                                 | 结果                                                                                                                       |
| ---- | ---------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 1    | APIG 实例查询                | `APIG ListInstancesV2`                                       | ✅ 4 实例（apig-api-test 等）                                                                                              |
| 2    | API 分组查询                 | `APIG ListApiGroupsV2`（需 instance_id，报错提示缺参后补上） | ✅ DEFAULT 分组                                                                                                            |
| 3    | 环境查询                     | `APIG ListEnvironmentsV2`                                    | ✅ RELEASE                                                                                                                 |
| 4    | 创建 DEDICATEDGATEWAY 触发器 | `CreateFunctionTrigger --help` + approved                    | ⚠️ 首次 FSS.1417，补齐参数后 ✅                                                                                            |
| 5    | APIG 侧注册验证              | `APIG ListApisV2`                                            | ✅ devkit_fg_api 已发布                                                                                                    |
| 6    | 公网调用                     | curl invoke_url                                              | ⚠️ 失败：实例 `eip_address: null`（未绑定 EIP），域名无法公网解析——环境限制，非插件问题（用户决策：以 API 注册为验证结论） |

**发现 D6（触发器参数教学缺失）**：DEDICATEDGATEWAY/APIG 触发器的 6 个必填参数（`instance_id`/`match_mode`/`protocol`/`name`/`type`/`env_name`）不在 create 响应错误里，首次创建报误导性错误 `FSS.1417 api not register in apigw`；正确参数只能从 100+ 行的 `--help` 大海捞针提取。插件无"触发器类型→必填参数/命名规则（API 名禁连字符）"教学。API 名称正则校验（连字符非法）也无提示。

## 四、资源清理（全部完成）

| 资源                                       | 结果                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 3 个触发器（2×TIMER + 1×DEDICATEDGATEWAY） | ✅ 已删                                                                                      |
| 2 个函数（inline + zip）                   | ✅ 已删                                                                                      |
| APIG API devkit_fg_api                     | ✅ 已删（**发现 D7**：删 FG 触发器不级联删 APIG API，需单独 `APIG DeleteApiV2`；插件无提示） |
| 验证                                       | ✅ ListFunctions/ListApisV2 均无 devkit 残留                                                 |

**发现 D5（删除陷阱）**：`DeleteFunction` 传 `:latest` URN 报 `FSS.0400 Can't delete the 'latest' version`，需去掉版本后缀；插件未教。

## 五、环境恢复

- ✅ 28 个 skills 已按备份清单装回（21 huawei-* + 6 huaweicloud-* + 1 test）
- ✅ KooCLI 7.2.12 + ~/.hcloud 凭证在位
- ⚠️ `~/.obsutilconfig`（OBS 独立配置）测试卸载后未重建，如需请用户终端执行 `hcloud obs config`

## 六、插件能力评估汇总

### 可用（亮点）

- 审批闸门：plan 对写操作正确 deny → approved_command 精确匹配校验 ✅
- `check_cli` 区分 HCLOUD_NOT_FOUND、指引含 URL/HCLOUD_BIN ✅
- `--help`/version 等本地元命令放行（local_metadata）✅
- `list_operations`/`get_regional_availability` 可用 ✅
- profile 脱敏、超时/重试参数暴露 ✅
- 从零到函数创建+双场景触发器全链路走通（在代理自行补知识的前提下）

### 缺口（按影响排序，供修复）

| #       | 缺口                                             | 影响                               | 建议                                                                                |
| ------- | ------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------- |
| D1      | search_docs/retrieve_skill 路径 bug              | 能力发现工具全废                   | SKILLS_ROOT 指向 `~/.config/opencode/skills`（或安装器装到 plugins/skills 并统一）  |
| D3      | 执行类操作（InvokeFunction 等）判为 unknown_read | 只读工具可放行有副作用操作         | 分类增加 execution 类，走审批                                                       |
| D4      | zip 代码上传陷阱无预警无教学                     | 创建"成功"实为空代码，代理无法自知 | 技能/工具提示 zip 上传的正确方式（或检测 code_filename 文件是否存在并校验上传结果） |
| D6      | 触发器必填参数/命名规则零教学                    | 多轮试错、误导性错误码             | 技能补充各触发器类型必填参数表与命名规则；错误码映射表（FSS.1417）                  |
| D5      | 删函数 URN 需去 :latest 无提示                   | 一次失败                           | 技能/错误映射补充 FSS.0400                                                          |
| D7      | 删 FG 触发器不级联 APIG API                      | 残留资源                           | 技能提示跨服务清理                                                                  |
| D2      | hcloud 执行器无 cwd                              | 依赖 cwd 的命令无法表达            | 暴露 cwd 参数                                                                       |
| D-AUTH1 | 凭证配置零教学                                   | 新用户卡死                         | 技能补充 configure 命令/字段/AK-SK 获取路径                                         |
| D-INS1  | 安装只有 URL 无步骤                              | 新用户卡死                         | check_cli 指引含安装步骤（下载/解压/PATH）                                          |
| D0      | 安装器忽略已有 opencode.jsonc                    | 双配置冲突                         | 安装器读写现有配置文件（jsonc 优先）                                                |
