# 代码优化流程

由上游负责 PR 审查的 Agent 通过 A2A 触发的代码优化任务，根据审查意见修改已有 PR 的代码。

## 分析（按顺序执行，上一步未完成不得进入下一步）

### 1. 理解审查反馈

读取 A2A context 中的审查意见，明确需要修改的问题点。

通过 grape CLI 获取 PR 上的行内评论，确认具体问题和代码位置：

```bash
grape git-repo pulls comments list --owner {owner} --repo {repo} --number {number} --json-out
```

对每条评论检查代码是否已修改、问题是否已解决。如有不明确之处，在 PR 中评论追问。

### 2. 制定修改方案

针对审查反馈的每个问题确定修改方案，评估修改影响范围。

**不需要**输出需求文档和方案设计文档（已有 PR，只需修改问题点）。

### 3. 实施修改并推送

在现有 PR 分支上修改代码：
- 每个问题一个原子提交
- 提交后推送到 PR 分支
- 修改完成后，在 PR 中评论告知已根据审查意见完成修改

### 分析结论示例

```
分析结论：
- 场景：代码优化（由上游 PR 审查 Agent 触发）
- 审查问题数：3（2 个 Critical，1 个 Required）
- 必须执行：修改代码 → 推送分支 → PR 评论告知
- 不需要：需求文档、方案设计、创建 PR
```

## 执行能力

### 能力一：代码实现

```bash
git add -A && git commit -m "fix: #{number} 根据审查意见修正"
git push origin {pr_branch}
```

每个问题一个原子提交，commit message 注明修复的问题编号。

### 能力二：PR 评论告知

修改完成后，在 PR 中评论告知：

```bash
grape git-repo pulls comments create --owner {owner} --repo {repo} --number {number} --json '{"body": "[Coding Agent] 已根据审查意见完成修改，请重新审查。"}'
```

> 注：评论 body 前缀固定为 `[Coding Agent]`。

### 能力三：任务结束输出结构化 JSON 块

完成所有业务动作（提交修改、push、PR 评论告知）后，**在最终答复末尾输出以下 JSON 块**（系统解析写入 event.json 档案）：

```json
{
  "actions": ["修改代码修复审查意见", "git push 分支", "在 PR #N 评论告知重新审查"],
  "conclusion": "已按审查意见完成哪些修复，测试结果，待 QA 重新审查",
  "artifacts": ["PR #N 评论", "commit xxxxxx"],
  "next_step": "QA Agent 重新审查 PR #N",
  "issue_summary": "已按审查意见修复 | 修改摘要 | 待重新审查"
}
```

> ⚠️ 该 JSON 块放在最终答复末尾，是任务结束的唯一标记；**不得**用长流程叙述替代。
