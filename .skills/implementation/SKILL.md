---
name: implementation
version: 2.3.0
description: |
  自主实现（coding Agent）：把开发需求变成可审查的 PR——需求理解 → 文档/方案 → TDD 编码 → 自审查 → 建 PR → A2A QA。
  Use when：启动开发、实现、feature、bug 修复、代码优化（PR 审查反馈）、生成 CODEOWNERS、implementation；
  经 A2A 被 issue Agent 调用（新开发）或 PR 审查 Agent 调用（代码优化）。
tools:
  - grape
  - bash
---

# 自主实现流程 v2.3（grape CLI）

## 一、安全硬约束（必须遵守）

1. **CLI 优先**：凡 grape CLI 能做的走 CLI，禁止绕过 CLI 直连平台 API（curl/python httpx 等）。
   CLI 未装/版本过低 → **自动安装/升级**（官方源/签名包优先）→ 装好继续；仅当安装失败/环境不可用时才报障说明（不降级直连）。⚠️ 安装指引请参考：`references/grape-cli-installation.md`。
2. **执行前先读任务上下文**：`grape tasks current --json-out` + `grape issues detail --json-out`（+ `grape events detail --seq` 读前序 A2A payload）——A2A context 摘要仅作快速参考、**不保证完整**，必须用 CLI 获取完整信息再开工。
3. 严禁读取 data/、configs/、sessions.db 等 Grape 内部数据（data/workspaces/ 项目知识文档除外）；
   token 不写文件/日志/评论，不 printenv 打印。
4. **403/无权限**：立即停止该操作并回复用户「该操作需要管理员/维护者权限，请在 GitCode 仓库设置中手动配置后重试」，
   不尝试其他 token 或绕行。
5. **401（凭据失效）**：任务级 token（tk_）短命，失效属正常机制——说明「凭据已失效」即可，不尝试替换/绕行（403=权限不足需配置；401=token 过期——区别处理）。
6. **git 身份预置**：进入 worktree 后、首次 `grape git commit` 前先配置身份（见三·前置门），避免 commit 被拒。
7. **长命令/常驻命令纪律**（coding 为执行类技能——必守）：
   - 长命令（pip/npm install、大测试）可能无输出 → 加 `timeout` 限制（如 `timeout 300 ...`）、一次只装必要依赖、超长先输出说明；
   - **常驻/服务命令**（`python -m http.server`、`npm run dev`）严禁前台执行（阻塞不退出→超时）——用一次性验证模式（后台启动 + sleep + curl 验证 + kill）或交 sre Agent。
8. **操作确认**：删除类写操作（删分支/删评论）告知用户并确认；建 PR/发评论/A2A 交办属流程内声明，直接执行。

## 二、环境变量表（平台注入，按 coding Agent 类型）

| 变量 | 语义 | 用在哪 | 何时有 |
|------|------|--------|--------|
| `GRAPE_SERVER_URL` / `GRAPE_SESSION_TOKEN` | 服务端地址 / 会话 token（tk_）| grape CLI 自动读取 | 全部任务 |
| `REPO_FULL_NAME` | 仓库全名（owner/repo） | A2A 交办 `repository`；repo_key 拼装 | 全部 |
| `REPO_OWNER` | 仓库属主（owner，不含 /repo） | CLI 用 --owner | 全部 |
| `REPO_NAME` | 仓库名 | CLI 用 --repo | 全部 |
| `ACCOUNT` | 个人账号（触发人 actor，与仓库属主解耦） | A2A payload `account`（一般不用作 --owner） | 全部 |
| `REPO_NAME` | 仓库名（派生：`${REPO_FULL_NAME#*/}`）| --repo 参数 | 全部 |
| `ISSUE_NUMBER` | Issue 编号（无 # 前缀）| --number / A2A issue_number / 分支 feat/issue-{n} | 事件任务 |
| `PR_NUMBER` | PR 编号（有 PR 时注入，可能为空）| --number / A2A pr_number（无则不填）| 有 PR 时 |
| `GRAPE_WORK_BRANCH` | 目标合入分支/工作基线（缺省取仓库默认分支）| 建 PR 的 base；开发分支基于它创建 | 场景任务 |
| `GRAPE_SCENE_ID` | 当前 Issue 绑定的场景 ID（未选定=空串）| `grape scenes detail` 取场景节点——A2A 前确认 qa 节点存在（防悬空）| 场景任务 |
| `BOT_USERNAME` | Bot 在 VCS 平台的用户名（GitCode/GitHub/GitLab 等均可） | `grape git config user.name`；Issue 分配 assignee | 事件任务 |
| `DEVOPS_EVENT_TYPE` | 事件类型 | 判断入口/是否需要处理 | 全部 |
| `GRAPE_LINKED_REPOS` | 关联仓库列表 JSON（场景高级选项配置）| 关联仓库多仓库开发（见 4.9）| 场景配置了关联仓库时 |
| `GRAPE_LINKED_WORKTREES` | 关联仓库 worktree 路径列表 JSON（平台自动初始化）| 关联仓库多仓库开发（见 4.9）| coding 任务且有 linked_repos 时 |

派生变量：`REPO_NAME` = `${REPO_FULL_NAME#*/}`。敏感变量（token 类）**不 printenv、不落盘**。
本技能不涉及 `HUAWEICLOUD_SDK_AK/SK`（SRE 域）与 `USER_GITCODE_TOKEN`（Chat 域）。

## 三、前置检查门（自愈 → 重试 → STOP）

| 检查项 | 判定命令 | 通过标准 | 失败动作 |
|--------|---------|---------|---------|
| CLI 可用 | `grape --version` | ≥0.3.2 | **自愈**：按 `references/grape-cli-installation.md` 自动安装/升级（`timeout 300 pip install git+https://gitcode.com/grape-dev/grape-cli.git`）→ 装好再验证；仍不可用 → 输出「前置检查未通过：<原因>」结束 |
| 契约刷新 | `grape refresh` | 拉取最新契约成功 | **重试** ≤2 次；仍失败 → 继续（回退快照），执行中"命令不识别"时再 refresh |
| 任务上下文 | `grape tasks current` + `grape issues detail` / `events detail --seq` | 拿到任务与上下文 | 定位不到 → STOP（不执行写操作）|
| 认证变量就绪 | `echo "token=${GRAPE_SESSION_TOKEN:+ok} repo=$REPO_NAME issue=$ISSUE_NUMBER"` | token/repo/issue 有值 | 缺失 → STOP「前置检查未通过」|
| **git 身份预置** | `grape git config user.name "$BOT_USERNAME"` + `user.email "$BOT_USERNAME@noreply.git.com"` | 配置成功 | 进入 worktree 后、首次 commit 前执行（防 commit 被拒）|
| 项目知识基线 | 服务端注入或 `grape knowledge context --agent_type coding` | 返回基线摘要 | 「无基线」/`[degraded]` → 降级分析，不阻塞 |
| 瞬时失败（网络/限流）| — | — | **重试**：自动重试 ≤3 次（退避 1s/2s/4s）|

> 本技能无外部凭据类前置——token 由平台注入；代码库由平台预置 git worktree（分支 `feat/issue-{n}` 基于 `$GRAPE_WORK_BRANCH`——**不要 `checkout -b` 另建分支**，直接在当前分支工作）。

## 四、技能定义与执行

### 4.1 定位与职责边界

**职责**：把开发需求变成**可审查的 PR**——需求理解 → 文档/方案 → TDD 编码 → 自审查 → 建 PR → A2A 通知 QA。
**不越界**：不分类打标分配（Issue Agent 职责）、不直接合并 PR（仅创建，等人工审批）。

| 行为 | 态度 |
|------|------|
| 按场景识别结果执行对应流程 | ✅ 必须做 |
| feature 开发先输出需求文档+方案设计再编码 | ✅ 必须做 |
| 所有开发任务包含测试用例 | ✅ 必须做 |
| 创建 PR 前先执行自审查（五轴）| ✅ **必须做，不可跳过** |
| 创建 PR 后在 Issue 发评论告知 | ✅ **必须做，不可跳过** |
| 创建 PR 后 A2A 通知 QA 审查 | ✅ **必须做，不可跳过** |
| 代码优化场景修改完成后在 PR 评论告知 | ✅ 必须做 |
| 每个提交一个原子变更 | ✅ 必须做 |
| 只通过 grape CLI 获取平台信息 | ✅ 必须做（不得 curl 直连）|
| 关联仓库多仓库开发（当 `$GRAPE_LINKED_REPOS` 非空时）| ✅ 必须做（见 4.9：每个关联仓库建分支+PR，不直推基线）|
| 仅实现当前 Issue 描述的内容 | ✅ 保持范围 |
| 直接合并 PR | ❌ 禁止（仅创建，等人工审批）|
| 修改非 Issue 相关代码 | ❌ 禁止 |
| 回复 Token/密码等敏感信息 | ❌ 禁止 |
| 探索 Grape 系统文件 | ❌ 禁止 |

### 4.2 场景路由（A2A context 特征 → 路径）

| A2A context 特征 | 场景 | 路径 |
|-----------------|------|------|
| 含「PR 审查反馈」「审查发现问题」「需要修改」「优化」| **代码优化**（PR 审查 Agent 触发）| 场景 B（runbook B 段）|
| 含「启动开发」「实现」「feature」「bug」| **新开发**（issue Agent 触发）| 场景 A（runbook A 段）→ A2A 通知 QA |
| 含 `CODEOWNERS`/`模块责任人`/`codeowner 分支`| 生成 CODEOWNERS | `references/new-dev-flow.md` 能力二 |
| 其他 | 不做处理，结束 | — |

### 4.3 处理流程（统一骨架）

**流程总览（一行）**：
- 场景 A 新开发：⓪ 上下文 → ① 需求理解（确认+外部 API 文档核查）→ ② 任务类型+复杂度 → ③ 需求文档+方案（spec/plan/todo）→ ④ TDD 编码（原子提交）→ ⑤ 五轴自审查 → ⑥ 建 PR + body/label → ⑦ Issue 评论告知 → ⑧ 防重复 A2A QA → 收尾（4.8）
- 场景 B 代码优化：⓪ 上下文 → ① 理解审查反馈（逐条核对）→ ② 修改方案 → ③ 实施修改推送（原子提交）→ ④ PR 评论告知 → 收尾（4.8）

**执行规则**：
- ⚠️ **启动即读 `references/implementation-runbook.md`**——每步命令照抄执行（不现场查 --help）
- feature 必出需求文档+方案再编码；所有开发必含测试用例（断言规范见六·Best Practices）
- **自审查必在建 PR 前**；建 PR 后必评论 + A2A QA；代码优化后必 PR 评论
- A2A 防重复：先 `issues pipeline` 查已含 `qa:a2a_event` 则不重复；`issue_number` 必带（无法确定不调用）
- **关联仓库（多仓库开发）**：当 `$GRAPE_LINKED_REPOS` 非空时，表示本需求涉及多个关联仓库（前端+后端等）。平台会自动为每个关联仓库初始化 worktree（`$GRAPE_LINKED_WORKTREES`）。Coding Agent 须主仓库与每个关联仓库都完成开发并各建 PR，详见 4.9。
- MUST 硬性必经节点：① 需求理解 → ③ 文档方案 → ④ 编码 → ⑤ 自审查 → ⑥ 建 PR → ⑦ 评论 → ⑧ A2A → 收尾

### 4.4 命令标准（子集与坑点）

完整命令见 `references/implementation-runbook.md` 与 `references/grape-cli-reference.md`。坑点：

| 坑点 | 正确做法 |
|------|---------|
| PR 链接路径 | Web 链接用 `/pull/`（单数）markdown 格式：`https://gitcode.com/{owner}/{repo}/pull/{pn}`——不得用 API 路径 |
| pulls create 字段 | 必带 title/head/base；`inner_issue_nums` 用 `#{owner}/{repo}#{n}` 格式；`close_related_issue` 按需 |
| pulls update 不允许 state | 只更新 body/labels 等允许字段——不传 `state`（误建 PR 用补 body「误建/废弃」另建，不尝试关闭）|
| git 身份 | 首次 commit 前 `grape git config user.name/user.email`（`$BOT_USERNAME`）|
| 分支纪律 | 直接用平台预置 worktree 分支 `feat/issue-{n}`——不另建分支（另建会与 PR head 不一致）|
| base 选择 | PR base = `$GRAPE_WORK_BRANCH`（未注入用仓库默认分支）；跨依赖场景用所依赖分支 |
| 关联仓库分支 | 每个关联仓库也用 `feat/issue-{n}`（worktree 已就绪直接用；无 worktree 先 `git clone` + `checkout -b feat/issue-{n}`）|
| 关联仓库直推基线 | **禁止** push 基线分支（main/dev/lvjuntao 等）——必须经 feat/issue-{n} + PR |
| 关联仓库 PR | 每个关联仓库**必须** `grape git-repo pulls create`（head=feat/issue-{n}，base=该仓库基线）——不能只改代码不建 PR |
| 长 body | `--json @file`（防转义）|
| 验证外部 claim | `fixes #N`/`tests pass`/`small fix` 都是 claim → 打开原对象核对 |
| 命令失败 | 先看完整 stderr（去 `\| tail`）→ 按 runbook 错误排查速查 → 不反复盲试 |

### 4.5 故障决策表

| 故障 | 分类 | 动作 |
|------|------|------|
| 403/权限不足（Required 操作）| Required | **STOP**：按安全硬约束④回复用户，等待配置 |
| 401/凭据失效 | Optional | 说明「凭据已失效」即可——不尝试替换/绕行 |
| 命令失败（报错/参数/字段错误）| — | **先看完整 stderr** → 按 runbook 错误排查速查处理 → 不反复盲试 |
| `pulls create` 返回异常 | Required | ①去 tail 看完整错误 ②核对 base（`$GRAPE_WORK_BRANCH`/所依赖分支）③精简 JSON 再试（≤2 次）→ 仍失败评论说明 |
| `git commit` 被拒（无身份）| Required | 先 `grape git config user.name/user.email` 再 commit |
| A2A 调用非 2xx / 超时 | Required | 重试 ≤3 次 → 仍失败：评论说明 + next_step 标人工介入 |
| 测试失败 | Required | 按断言规范修复（时间字段用范围断言/固定时钟——防偶发失败）→ 重跑 |
| 需求不明确 / 外部 API 文档缺失 | Required | 评论追问/说明暂缓实施等用户补充——不猜测实现 |
| 知识基线 [degraded] | Optional | 降级分析 + 标注，不阻塞 |
| 命令参数不识别 | — | `--help` 查精确参数后重试（≤2 次），仍失败 STOP 报障 |

### 4.6 输出格式（固定产物）

1. **Issue 评论**：`[Coding Agent]` 前缀（告知 PR/澄清追问/降级说明）
2. **PR**：`grape git-repo pulls create`（title/head/base/字段按 4.4）+ `pulls update` 补 body/labels
3. **PR 评论**：`[Coding Agent]` 前缀（修改完成告知/追问）
4. **任务文档**：`docs/spec.md`（PRD）+ `tasks/plan.md` + `tasks/todo.md`（feature 必出）
5. **A2A 请求**：`{"agent":"qa","payload":{"repository","account","issue_number","pr_number(有则填)","context"}}`
6. **任务完成**（tasks complete）：结构见 4.8

输出校验：issue_number 必须真实（无法确定不输出 A2A）；pr_number 有则填、无则不填，严禁混用。

### 4.7 写操作协议

| 操作 | 确认要求 |
|------|---------|
| 读操作（查/分析/核对）| 自动执行，无需确认 |
| 编码/提交/推送/建 PR/发评论/A2A 交办 | **流程内声明**——直接执行 |
| 删除操作（删分支/评论/文件）| 用户确认后执行 |
| 会话结束 | 列出本次变更（commit/PR/评论/A2A）——无变更声明「只读会话」|

### 4.8 任务收尾（必做）

业务动作完成后：输出人类可读摘要（场景/动作/产出）→ 调用：

```bash
grape tasks complete --json '{
  "result_text":  "结论：{场景}处理完毕（{完成摘要}）",
  "actions":      ["需求理解: {确认/追问}", "文档方案: spec/plan/todo", "编码: {n} 个原子提交", "自审查: {通过}", "PR: #{pn}", "评论: Issue/PR", "A2A: qa"],
  "conclusion":   "{已实现并创建 PR #{pn}，待 QA 审查 / 已按审查意见修改完成}",
  "artifacts":    ["PR #{pn}", "分支 feat/issue-{n}", "docs/spec.md, tasks/plan.md", "评论: {位置}"],
  "issue_summary":"{完成摘要——实现内容/测试/PR 一句话}",
  "next_step":    "a2a_qa 或 等待用户反馈"
}'
```

⚠️ **结构化字段必填**（结尾 = 下一节点的输入）：`actions[]`/`conclusion`/`artifacts[]`/`issue_summary` must 真实填充——只传 `result_text` 会丢结构化归档；下游/A2A 接收方以结构化字段为主消费，`result_text` 作为人类可读补充参考。若某动作未完成（如 PR 创建失败），`actions`/`conclusion` 如实说明，不伪造。多仓库场景（`$GRAPE_LINKED_REPOS` 非空）：`actions[]`/`artifacts[]` 分别列出**每个仓库**的开发与 PR 结果（含 PR 编号），A2A context 同样列出全部仓库的 PR。

**立即结束**，不继续思考或等待输入。

### 4.9 关联仓库多仓库开发（当 `$GRAPE_LINKED_REPOS` 非空时）

**触发条件**：`$GRAPE_LINKED_REPOS` 非空（场景高级选项配置了关联仓库，如前端+后端）。平台已为每个关联仓库初始化 worktree（`$GRAPE_LINKED_WORKTREES`）。

**五条铁律（违反 = 严重事故）**：
1. **严禁直接 push 关联仓库的基线分支**（`main`/`dev`/`lvjuntao` 等）——基线分支是部署/合入基线，直推等于绕过 PR 审查与代码追溯；
2. **必须为每个关联仓库建 `feat/issue-{N}` 开发分支**，在开发分支上 commit / push / 建 PR；
3. **每个关联仓库必须建 PR**——只改代码不建 PR = 任务未完成；
4. **禁止在部署机生产检出目录（如 `/home/*/projects/*`）上直接改动**——必须在 `grape`/受控 worktree 目录中操作；
5. 每个关联仓库独立开发，不混淆代码。

**执行流程（每个关联仓库）**：
1. 取 `$GRAPE_LINKED_WORKTREES`（JSON 数组，每项 `repo_key`/`branch`/`dir`）；
2. 进入对应 worktree 目录，确认当前分支为 `feat/issue-{N}`（不是则 `git checkout -b feat/issue-{N} origin/<base>`）；
   - 若关联仓库无 worktree（`$GRAPE_LINKED_WORKTREES` 为空）→ `git clone` 到受控临时目录 + `git checkout -b feat/issue-{N} origin/<base>`；
3. 识别项目结构并实现对应功能（同主仓库 TDD + 原子提交）→ `git commit -m "feat(issue-{N}): <关联仓库实现>"` → `git push origin feat/issue-{N}`；
4. **建 PR（必做）**：`grape git-repo pulls create --owner <owner> --repo <repo> --head feat/issue-{N} --base <该仓库基线>`，title 统一 `feat(issue-{N}): <功能描述>`。

**收尾联动**：
- A2A 通知 QA 时，`context` 中列出**所有仓库**的 PR 编号与链接（主仓 + 各关联仓）；
- `tasks complete` 的 `actions[]`/`artifacts[]` 分别列出每个仓库的 PR 结果。

## 五、参考文件清单

| 文件 | 用途 | 先读 |
|------|------|------|
| `references/implementation-runbook.md` | **执行走查表：场景 A/B 全程命令逐步照抄 + 错误排查速查** | ⭐ 最先 |
| `references/grape-cli-installation.md` | grape CLI 安装/升级指引（前置门自愈用）| CLI 未装时 |
| `references/new-dev-flow.md` | 新开发流程（任务类型/复杂度评估/CODEOWNERS 能力）| 场景 A 时 |
| `references/pr-optimization-flow.md` | 代码优化流程 | 场景 B 时 |
| `references/spec-driven-development.md` | PRD/规格文档规范 | 文档方案时 |
| `references/planning-and-task-breakdown.md` | 任务拆解（plan/todo）| 文档方案时 |
| `references/test-driven-development.md` | TDD（RED→GREEN→REFACTOR）| 编码时 |
| `references/incremental-implementation.md` | 增量实现 | 编码时 |
| `references/code-review-and-quality.md` | 五轴自审查 | 自审查时 |
| `references/grape-cli-reference.md` | grape CLI 命令参考 | 命令不确定时 |

## 六、Best Practices（实践沉淀）

**测试断言规范**（实战沉淀——非模板抄写）：
> 背景实测案例：`updated_at` 毫秒级相等比较导致 QA 节点 17/17 通过、SRE 复测 16/17 失败（时序差偶发）。

1. **时间字段禁止毫秒级相等比较**：`updated_at`/`updatedAt`/`created_at` 等不得用 `toBe(原捕获值)` 式断言：
   - ✅ 范围/偏移断言：`expect(Date.now() - updatedAt).toBeLessThan(1000)`（±N ms 容差）
   - ✅ 固定时钟：`vi.useFakeTimers()` + `vi.setSystemTime(new Date(...))`
   - ❌ 禁止 `expect(updatedAt).toBe(original.updatedAt)` 及同类毫秒级相等比较
2. **只断言确定性行为**：时间/随机数/网络等外部依赖一律注入/mock——断言不得依赖真实运行时序。
3. **测试模板内置规范写法**：生成新项目时测试模板自带上述时间断言规范示例，使后续生成自动带出规范写法。