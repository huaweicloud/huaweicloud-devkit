# implementation 执行走查表（runbook）

> 目的：把 implementation 每一步**要做什么 + 用哪条确切命令**固化下来，Agent **照着执行、不要查 `--help` / `grape commands`**。
> 环境变量直接使用：`$ACCOUNT`、`$REPO_NAME`、`$ISSUE_NUMBER`、`$PR_NUMBER`（有则填）、`$GRAPE_WORK_BRANCH`、`$BOT_USERNAME`。
> **评论前缀硬规**：Issue/PR 评论一律 `[Coding Agent]` 开头。

---

## Step 0 · 任务上下文与就绪（必须最先）

```bash
grape refresh                        # 契约刷新（前置门②）
grape tasks current --json-out
grape issues detail --owner "$REPO_OWNER" --repo "$REPO_NAME" --number "$ISSUE_NUMBER" --json-out
grape events detail --seq {seq} --json-out   # 能定位到前序 A2A seq/id 时读取
# git 身份预置（进入 worktree 后、首次 commit 前执行一次）：
grape git config user.name  "$BOT_USERNAME"
grape git config user.email "$BOT_USERNAME@noreply.git.com"
```

> CLI 自愈安装（仅未装/版本低时）：`timeout 300 pip install git+https://gitcode.com/grape-dev/grape-cli.git`。

---

## 场景 A · 新开发（按顺序执行，上一步未完成不得进入下一步）

### A1 · 需求理解（必做）
```bash
grape git-repo issues get --owner "$REPO_OWNER" --repo "$REPO_NAME" --number "$ISSUE_NUMBER" --json-out
grape git-repo issues comments list --owner "$REPO_OWNER" --repo "$REPO_NAME" --number "$ISSUE_NUMBER" --json-out
# 需求不明确 → 先评论确认（[Coding Agent] 追问）
# 需外部 API/第三方服务 → 先获取 API 文档确认接口存在且参数明确；缺失 → 评论说明暂缓实施
```

### A2 · 任务类型 + 复杂度评估（按 `references/new-dev-flow.md` §3-§4）
- 类型：CODEOWNERS 生成 / feature / bug / 其他（不做处理结束）
- 复杂度：简单（单文件 <50 行）/ 中等 / 大型（跨模块/架构/外部服务集成——不得低估）

### A3 · 需求文档 + 方案设计（所有 feature 必做）
- `references/spec-driven-development.md` → 写 `docs/spec.md`
- `references/planning-and-task-breakdown.md` → 写 `tasks/plan.md` + `tasks/todo.md`
- Issue 评论告知方案：
```bash
grape git-repo issues comments create --owner "$REPO_OWNER" --repo "$REPO_NAME" --number "$ISSUE_NUMBER" \
  --json '{"body":"[Coding Agent] 方案已输出：docs/spec.md（需求文档）+ tasks/plan.md（任务拆解）"}'
```

### A4 · 代码实现（TDD + 增量；直接在当前 worktree 分支 feat/issue-{n} 上工作）
```bash
# 分支纪律：直接用平台预置分支，不要 checkout -b 另建
# TDD：RED→GREEN→REFACTOR（references/test-driven-development.md）
git add -A && git commit -m "feat: #{$ISSUE_NUMBER} {描述}"        # 每个提交一个原子变更
git push origin feat/issue-$ISSUE_NUMBER
# 测试断言按 SKILL.md 六·Best Practices（时间字段范围断言/固定时钟——防偶发失败）
```

### A5 · 自审查（建 PR 前必做，不可跳过）
- `references/code-review-and-quality.md` 五轴审查（正确性/安全/性能/可维护性/测试）→ 修复发现的问题

### A6 · 创建 PR（必做）
```bash
grape git-repo pulls create --owner "$REPO_OWNER" --repo "$REPO_NAME" \
  --json '{"title":"feat: #'$ISSUE_NUMBER' {标题}","head":"feat/issue-'$ISSUE_NUMBER'","base":"'${GRAPE_WORK_BRANCH:-main}'","inner_issue_nums":"#'"$ACCOUNT/$REPO_NAME"'#'$ISSUE_NUMBER'","close_related_issue":true}'
# 补充 PR body 与 label：
grape git-repo pulls update --owner "$REPO_OWNER" --repo "$REPO_NAME" --number "${PR_NUMBER:-$PR_NUMBER_FROM_CREATE}" \
  --json '{"body":"## 概述\n\n自动实现 Issue #'$ISSUE_NUMBER'","labels":"auto-pr"}'
# 从 pulls create 返回值取 PR 编号（若 $PR_NUMBER 未注入）
```

### A7 · Issue 评论告知（必做，不可跳过）
```bash
# ⚠️ PR 链接用 Web 页面 /pull/（单数）markdown 格式——不得用 API 路径
grape git-repo issues comments create --owner "$REPO_OWNER" --repo "$REPO_NAME" --number "$ISSUE_NUMBER" \
  --json '{"body":"[Coding Agent] ✅ 已完成实现，请审查 PR [#'"$PR_NUMBER"'](https://gitcode.com/'"$ACCOUNT/$REPO_NAME"'/pull/'"$PR_NUMBER"')。"}'
```

### A8 · A2A 通知 QA（必做，不可跳过——仅新开发场景）
```bash
# ⚠️ 防悬空：$GRAPE_SCENE_ID 非空时先查场景节点——确认 qa 节点存在再交办
grape scenes detail --scene_id "$GRAPE_SCENE_ID" --json-out    # 仅 ${GRAPE_SCENE_ID:-} 非空时执行；无 qa 节点 → 评论说明不交办
# ⚠️ 防重复：先查 pipeline，已含 qa:a2a_event 则不重复 A2A，只发评论
grape issues pipeline --owner "$REPO_OWNER" --repo "$REPO_NAME" --number "$ISSUE_NUMBER" --json-out
# 交办（issue_number 必填；pr_number 有则填、无则不填，严禁混用）
grape a2a handoff --json '{"agent":"qa","payload":{"repository":"'"$ACCOUNT/$REPO_NAME"'","account":"{user}","issue_number":'"$ISSUE_NUMBER"',"pr_number":'"${PR_NUMBER:-0}"',"context":"Issue #'"$ISSUE_NUMBER"' 开发已完成，PR #'"${PR_NUMBER:-0}"' 已创建。请对该 PR 进行代码审查。原始需求：{简要摘要}"}}'
# A2A 失败 → 重试 ≤3 次 → 仍失败：评论说明 + next_step 人工介入
```

### A9 · 关联仓库多仓库开发（必做，仅当 `$GRAPE_LINKED_REPOS` 非空时）

> 主仓库开发 + 每个关联仓库开发（前端+后端等）。平台已为关联仓库初始化 worktree（`$GRAPE_LINKED_WORKTREES`）。

```bash
LINKED_WT="$GRAPE_LINKED_WORKTREES"
if [ -z "$LINKED_WT" ]; then
  echo "无关联仓库 worktree（$GRAPE_LINKED_REPOS）——跳过"
else
  echo "$LINKED_WT" | python3 -c "
import json,sys
for w in json.load(sys.stdin):
    print(f\"{w['repo_key']}\t{w.get('branch','main')}\t{w['dir']}\")
" | while IFS=$'\t' read -r rk base dir; do
    cd "$dir"
    # 分支纪律：必须在 feat/issue-{N}，严禁在基线分支上直接改动
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    if [ "$CURRENT_BRANCH" != "feat/issue-$ISSUE_NUMBER" ]; then
      git checkout -b "feat/issue-$ISSUE_NUMBER" "origin/$base"
    fi
    # 识别项目结构并实现（TDD + 原子提交；测试写法见 SKILL.md 六·Best Practices）
    # mvn package / npm install / pip install ...
    git add -A
    git commit -m "feat(issue-$ISSUE_NUMBER): 关联仓库 $rk 实现"
    git push origin "feat/issue-$ISSUE_NUMBER"
    # 建 PR（必做！每个关联仓库都必须建 PR）
    LINKED_REPO_PATH="${rk#gitcode:}"       # owner/repo
    LINKED_OWNER="${LINKED_REPO_PATH%%/*}"
    LINKED_REPO="${LINKED_REPO_PATH#*/}"
    grape git-repo pulls create --owner "$LINKED_OWNER" --repo "$LINKED_REPO" \
      --json "{\"title\":\"feat(issue-$ISSUE_NUMBER): 关联仓库实现\",\"head\":\"feat/issue-$ISSUE_NUMBER\",\"base\":\"$base\"}" --json-out
  done
fi
```

> ⚠️ 五条铁律：① 严禁直推基线分支（main/dev/lvjuntao）② 必须走 feat/issue-{N} ③ 每仓库必须建 PR ④ 禁止在部署机生产检出目录改动（必须在受控 worktree）⑤ 各仓库独立开发不混淆。
> 主仓库 + 各关联仓库的 PR 编号，统一在 A8 的 A2A context 中列出。

---

## 场景 B · 代码优化（按顺序执行）

### B1 · 理解审查反馈（必做）
```bash
grape git-repo pulls comments list --owner "$REPO_OWNER" --repo "$REPO_NAME" --number "$PR_NUMBER" --json-out
# 逐条核对代码是否已修改、问题是否解决；不明确处 PR 评论追问
```

### B2 · 制定修改方案（已有 PR——只需修改问题点，不需需求文档）
- 方案内容：**问题点清单 → 每个问题对应修改策略**（依据 B1 的审查反馈逐条映射；涉及文件/改动方式/验证方式）
- 提交粒度：每个问题一个原子提交（commit message 注明修复的 issue 编号——见 B3）

### B3 · 实施修改并推送
```bash
# 在现有 PR 分支上修改：每个问题一个原子提交（commit message 注明修复的问题编号）
git add -A && git commit -m "fix: #{n} 修复 {问题描述}" && git push origin {pr_branch}
```

### B4 · PR 评论告知（必做）
```bash
grape git-repo pulls comments create --owner "$REPO_OWNER" --repo "$REPO_NAME" --number "$PR_NUMBER" \
  --json '{"body":"[Coding Agent] 已根据审查意见完成修改，请重新审查。"}'
```

---

## Step 收尾 · 任务完成流程（必做，任何分支都必须执行到最后）

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

> ⚠️ **结束信号**：tasks complete 后立即结束，不要继续思考或等待输入。A2A 交办成功 ≠ 任务结束。结构化字段 must 真实填充；某动作未完成（如 PR 创建失败）——actions/conclusion 如实说明，不伪造。
> **多仓库场景**（`$GRAPE_LINKED_REPOS` 非空）：`actions[]`/`artifacts[]` 分别列出每个仓库的开发与 PR 结果（含 PR 编号）；`next_step` 仍为 `a2a_qa`；A2A context 已在 A8 列出全部仓库 PR。

---

## 错误排查速查（命令返回异常时）

> ⚠️ 出错时**先看完整错误**（命令去掉 `| tail -N` 截断，`2>&1` 保留 stderr）；runbook 命令照抄仍失败，才允许 `grape commands <关键词>` / `grape <group> --help` 按 Body fields 修正。**不反复盲试同一命令**。

| 现象 | 处理 |
|------|------|
| `No such command 'X'` | 命令名抄错，核对 runbook/reference；仍不确定再 `grape commands <关键词>` |
| `unknown request field(s): ...` | `--json` 有契约不允许字段（如 `pulls update` 的 `state`）→ `--help` 看 Body fields 删多余 |
| `pulls create` 返回异常 | ①去掉 tail 看完整错误 ②核对 base（`$GRAPE_WORK_BRANCH`/跨依赖所依赖分支）③精简 JSON（去 `inner_issue_nums`/`close_related_issue`）再试 |
| `pulls create` 成功但 head/base 不对 | 误建 PR → 不尝试 `state:closed`；`pulls update` 补 body 标注「误建/废弃」，另建正确 PR（见 A6）|
| 关联仓库 no worktree / 已检出在基线分支 | 若 `$GRAPE_LINKED_WORKTREES` 为空 → `git clone` 到受控目录 + `git checkout -b feat/issue-{n}`；若当前在基线分支 → `git checkeout -b feat/issue-{n} origin/<base>`（严禁直接在基线分支改动）|
| 关联仓库 `git push` 被拒 / 无权限 | 确认分支=feat/issue-{n}（非基线）；被 403 说明无该仓库写权限，评论告知 |
| 关联仓库 `pulls create` 失败 | 同一仓库不能重复开同 head 的 PR——先 `pulls list` 查是否已建；核对 owner/repo/base 取值（LINKED_OWNER/LINKED_REPO 从 repo_key 解析）|
| `git commit` 被拒（无 user.name/email）| 先 `grape git config user.name/user.email`（见 Step 0）再 commit |
| `pulls comments list` 返回空 | 属正常（无行内评论）——按「无审查意见」处理不报错 |
| 测试偶发失败（时间字段）| 按 SKILL.md 六·Best Practices：改范围断言/固定时钟——不修业务代码掩盖 |
| 401 凭据失效 | 说明「凭据已失效」即可，不换 token（安全硬约束⑤）|
| 403 账户/平台管理类 | 说明需管理员配置/`grape_` 级凭据，本技能不涉及——不绕行 |
| 报「契约过期/命令不识别」| 先 `grape refresh` 再重试（前置门②）|