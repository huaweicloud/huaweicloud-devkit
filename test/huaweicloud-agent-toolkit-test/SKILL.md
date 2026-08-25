---
name: huaweicloud-devkit-test
description: 每晚自动回归测试 huaweicloud-devkit 插件的指引能力。使用条件：需要本地凭证文件、需要真实华为云账号、任务为插件能力回归验证时。
---

# HuaweiCloud Devkit 每晚回归测试

## 目标

验证插件（skills + MCP 工具 + 安全策略）能否**指导代理完成真实云操作**。测试对象是"插件的指引能力"，不是云平台本身。

- 插件路径：本仓库根目录（本机：`/mnt/c/Users/ssy/.agents/huaweicloud-devkit`；如 git 有更新先 `git pull`）
- 测试报告目录：`~/.agents/huaweicloud-devkit-test-report/nightly/`
- MCP 驱动脚本：`<本skill目录>/scripts/invoke-mcp.mjs`（驱动插件自带 `plugins/huaweicloud-core/src/mcp-server.mjs`，无需重启 opencode）

## 铁律（测试约束）

1. **聚焦"插件能否指导工作"**：一切云操作只允许依据插件内容执行——6 个 skills 的指引、MCP 工具（check_cli / plan_cli_command / run_readonly_command / show_profile_redacted / service_catalog / explain_error / list_operations / run_approved_command）及其输出。**禁止擅自联想**：不猜服务名、操作名、参数；不自行翻官方文档找命令执行。
2. **缺口即记录，不擅自绕行**：插件未教的步骤，标记为缺口（现象、步骤、影响），按严重度写入报告；若阻塞主流程，记录后跳过该步骤并在报告中说明"需人工/修复Agent处理"。除非用户显式批准，不得自行执行插件没教的操作。
3. **凭证纪律**：AK/SK 永不进入对话上下文。凭证只来源于本地文件 `~/.agents/huaweicloud-test-credentials.json`（chmod 600，JSON 格式，密钥留空待用户填写，见文末）。harness 用它做非交互配置时，通过 shell 变量传递，**任何输出不得包含凭证明文**。
4. **写操作纪律**：写操作一律先经 `huaweicloud_plan_cli_command` 规划、记录命令、再经 `huaweicloud_run_approved_command` 执行（测试模式视为用户已预授权，但命令必须完整记录）。**若某写操作被插件判为 read-only/allow 而实际是写操作 → 立即记录为安全缺口（高危）**。
5. **资源释放**：本轮创建的一切云资源（ECS、OBS 目录/对象等）必须在当轮内删除并只读验证为"已释放"，残留即判失败。
6. **本地环境清理**：测试开始前必须将本地环境重置为"未安装"状态，以验证插件能否引导重新安装与配置（这本身就是被测能力）：
   - 删除 `~/.local/bin/hcloud`（或 PATH 中的 hcloud）
   - 删除 `~/.hcloud`、`~/.obsutilconfig`
   - 记录删除前的 `hcloud version` 于报告（作为基线）
   - 测试结束时恢复可用状态（重新安装 + 配置凭证，见"恢复"节），避免影响用户白天使用。

## 流程

### 阶段 0：环境重置

1. 备份并记录：`hcloud version`（若有）、`~/.hcloud` 是否存在、`~/.obsutilconfig` 是否存在 → 写入报告"环境基线"。
2. 删除 hcloud 二进制、`~/.hcloud`、`~/.obsutilconfig`。
3. 运行插件 MCP 工具 `huaweicloud_check_cli`，确认返回 `installed: false`。**此处即第一个被测点**：插件对"未安装"给出的指引是否可执行（应有官方安装 URL / HCLOUD_BIN 提示；若只是"去安装"三个字 → 记缺口）。

### 阶段 1：安装与配置引导（被测）

4. 严格按插件指引完成安装。若插件指引不足（无安装命令/URL），记录缺口后，**测试 harness 允许**按官方文档安装（`https://support.huaweicloud.com/qs-hcli/hcli_02_003.html`，官方 OBS 包，装到 `~/.local/bin/hcloud`）——这是预授权的测试脚手架，不属于"擅自联想"，但必须把"插件未提供安装指引"记为缺口。
5. 安装后用插件 `huaweicloud_check_cli` 验证 installed=true（顺带记录：版本输出是否干净）。
6. 配置凭证：读取 `~/.agents/huaweicloud-test-credentials.json`（chmod 600），用
   ```bash
   hcloud configure set --cli-access-key="$AK" --cli-secret-key="$SK" --cli-region="$REGION"
   ```
   在 harness 内完成（用 `node -e` 读 JSON 导出环境变量，**全程不得 echo/打印值**）。再用插件 `huaweicloud_show_profile_redacted` 验证 profile 存在且脱敏。
7. OBS 需要独立配置：`hcloud obs config` 交互式无法无人值守 → harness 直接写 `~/.obsutilconfig`（用同一份凭证 + endpoint，endpoint 取 JSON 的 `obsEndpoint`），或记录"插件是否提示了 OBS 独立配置"（G14 曾缺失）。

### 阶段 2：场景回归（核心被测点）

对每个场景，逐步执行并记录"每步的指引来源"：

- `P` = 插件工具/技能提供了该能力
- `G` = 插件无此能力，harness 自行解决（记缺口）
- `I` = 代理擅自联想/猜测（违规，记红线）

**场景 A：购买新加坡 ECS（参考 SSY）**

- 用 `huaweicloud_list_operations` 或技能确认操作名（只查 ap-southeast-3，禁止盲扫其他区域——区域语义本身是被测点）
- 找含 SSY 的实例（Vector-SSY-*），读参考配置
- plan 创建命令 → 用户预授权 → `run_approved_command` 创建（如 Vector-SSY-N）
- ShowJob/ListServersDetails 验证 ACTIVE
- 删除该实例（含磁盘）→ 验证列表无残留

**场景 B：静态网页部署 OBS**

- 本地构建仓库 `git@github.com:huaweicloud/huaweicloud-open-capability-home.git`（clone 到 /tmp 即可，npm install + npm run build）
- 上传到 `obs://openplatform-prod/devkit/`（harness 注意 obsutil 目录语义：本地目录名会成为前缀；先 `-dryRun` 验证键名）
- 对象公共读 `-acl=public-read`；curl 验证 200
- 验证后删除 `devkit/` 目录并确认 0 残留

**场景 C（轻量）：工具冒烟**

- check_cli / list_operations（ECS 与 OBS 各一次）/ plan 一个只读命令 / explain_error 一个样例错误

### 阶段 3：资源释放审计

- 列出场景 A 创建的 ECS、场景 B 创建的 OBS 前缀，逐一确认不存在
- 任何残留 → 立即删除（记录在案），仍残留 → 报告标 FAIL

### 阶段 4：环境恢复

- 重新确认 hcloud 可用（若阶段 1 曾安装则保留；若用户环境原本无 hcloud，恢复原状）
- `~/.obsutilconfig` 保持可用
- 用插件工具做一次只读验证（如 `obs ls`），确认环境可用

### 阶段 5：报告

- 生成 `<日期>.md` 到报告目录，结构见"报告模板"
- 汇总新增缺口，**追加**到 `~/.agents/huaweicloud-devkit-test-report/插件修复提示词.md`（P0-5 等编号续接），供下一迭代修复

## 报告模板

```markdown
# nightly 测试 <日期>

- 插件 commit: <git rev>
- 环境基线: hcloud <版本>（清理前）/ 清理后 installed: false
- 结果: PASS / PARTIAL / FAIL

## 场景结果

| 场景              | 结果      | 说明 |
| ----------------- | --------- | ---- |
| A 买 ECS 参考 SSY | PASS/FAIL | ...  |
| B 部署静态站      | PASS/FAIL | ...  |
| C 工具冒烟        | PASS/FAIL | ...  |

## 逐步指引来源记录（每场景至少这些关键步骤）

| 步骤          | 来源(P/G/I) | 细节           |
| ------------- | ----------- | -------------- |
| 检测未安装    | P/G         | ...            |
| 安装命令      | P/G         | 插件给了什么？ |
| 操作名发现    | P/G         | ...            |
| 创建/删除执行 | P/G         | ...            |

## 新增缺口

| #   | 严重度 | 现象 | 影响 |
| --- | ------ | ---- | ---- |

## 安全审计

- 写操作被误判 read-only 的实例：...
- 凭证泄露事件：无/有（严重！）

## 资源释放

- 创建: <id> → 删除: <id> → 验证: <结果>

## 红线违规（I 类）

- 无 / <记录>
```

## 凭证文件（一次性人工准备）

`~/.agents/huaweicloud-test-credentials.json`（chmod 600，密钥留空待用户填写）：

```json
{
  "accessKey": "",
  "secretKey": "",
  "region": "ap-southeast-3",
  "obsEndpoint": "obs.cn-north-4.myhuaweicloud.com"
}
```

harness 只读该文件并用于 `configure set` 与 `~/.obsutilconfig`，严禁在对话或报告中出现 `accessKey`/`secretKey` 的值。注意：凭证文件必须放在 Linux 原生文件系统（如 `/home/<user>/.agents/`），不要放 `/mnt/c` 等 Windows 挂载盘（chmod 不生效）。

## 每晚调度建议

```bash
opencode run --model zhipuai-coding-plan/glm-5.2 "执行 huaweicloud-devkit 每晚回归测试"
```

配合 cron（如 02:00 每天）。首次使用需确认 opencode 无头模式可加载本 skill；若 MCP 工具未注册，用 `<本skill目录>/scripts/invoke-mcp.mjs` 驱动（同插件代码路径）。
