# grape CLI 命令参考（implementation skill 专用）

> 来源：cli-code-analysis-spec.md（CLI v0.3.x，216 条契约经 `grape commands` 核对）
> 本文件只列 implementation skill 实际用到的命令子集，不列全量。

---

## 1. 安装与就绪检查

grape CLI 由 worker 包预装。使用前检查：

```bash
which grape          # 验证安装，无结果直接报障，不自行安装
grape --version      # 确认版本
```

> ⚠️ grape 未安装时直接报障，不 curl 直连 API。

---

## 2. 认证与配置

| 项 | 说明 |
|----|------|
| `$GRAPE_SESSION_TOKEN` | 服务端注入，任务级临时 token（`tk_` 前缀），`grape` 自动读取，不需手动 export |
| `$GRAPE_SERVER_URL` | 服务端注入，指向 API 地址 |
| Token 优先级 | `--token` > `GRAPE_SESSION_TOKEN` > `GRAPE_API_TOKEN` > config.json |
| base_url 优先级 | `--base-url` > `GRAPE_BASE_URL` > `GRAPE_SERVER_URL` > config.json > `http://localhost:8000` |

---

## 3. 常用命令（implementation 实际用到的子集）

### 3.1 任务上下文读取（共用，执行前必做）

| 命令 | 用途 |
|------|------|
| `grape tasks current --json-out` | 获取分配给自己的任务（执行前必读） |
| `grape issues detail --owner {owner} --repo {repo} --number {n} --json-out` | Issue 全貌（含 stage/事件/pipeline，执行前必读） |
| `grape events detail --seq {seq} --json-out` | 读取前序 A2A 交接 payload |
| `grape issues pipeline --owner {owner} --repo {repo} --number {n} --json-out` | Issue pipeline（防重复 A2A 检查） |
| `grape commands [pattern]` | 列出可调用命令（命令发现） |

### 3.2 知识与项目上下文

| 命令 | 用途 |
|------|------|
| `grape knowledge context --repo {owner}/{repo} --agent_type coding --json-out` | 合并注入上下文（项目知识基线等） |
| `grape knowledge content --repo {owner}/{repo} --file {path} --json-out` | 读取知识文件全文 |

### 3.3 GitCode Issue 读取

| 命令 | 用途 |
|------|------|
| `grape git-repo issues get --owner {owner} --repo {repo} --number {n} --json-out` | 单 Issue 原始信息（标题/正文/标签/状态） |
| `grape git-repo issues comments list --owner {owner} --repo {repo} --number {n} --json-out` | Issue 全部评论 |

### 3.4 PR 读写（新开发 / 代码优化核心）

| 命令 | 用途 |
|------|------|
| `grape git-repo pulls create --owner {owner} --repo {repo} --json '{"title":"...","head":"feat/issue-{n}","base":"main","inner_issue_nums":"{owner}/{repo}#{n}","close_related_issue":true}'` | 创建 PR |
| `grape git-repo pulls update --owner {owner} --repo {repo} --number {pn} --json '{"body":"...","labels":"auto-pr"}'` | 更新 PR（body/labels/title） |
| `grape git-repo pulls get --owner {owner} --repo {repo} --number {pn} --json-out` | 单 PR 信息 |
| `grape git-repo pulls list --owner {owner} --repo {repo} --state all --json-out` | PR 列表（幂等检查：同源 PR 是否已存在） |
| `grape git-repo pulls comments list --owner {owner} --repo {repo} --number {pn} --json-out` | PR 行内评论（审查意见） |
| `grape git-repo pulls comments create --owner {owner} --repo {repo} --number {pn} --json '{"body":"[Coding Agent] ..."}'` | 发 PR 评论（修改告知/追问） |

> PR 链接规则：GitCode Web 页面 PR 链接使用 `/pull/`（单数）`https://gitcode.com/{owner}/{repo}/pull/{pn}`；Issue/PR 评论中必须用 markdown 链接格式 `[PR #{pn}](...)`。

### 3.5 Issue 评论写操作

| 命令 | 用途 |
|------|------|
| `grape git-repo issues comments create --owner {owner} --repo {repo} --number {n} --json '{"body":"[Coding Agent] ..."}'` | 发 Issue 评论（实现告知/需求澄清/PR 链接） |

### 3.6 任务完成与 A2A 交接

| 命令 | 用途 |
|------|------|
| `grape tasks complete --json '{"result_text":"...","next_step":"..."}'` | 自报完成（收尾必做） |
| `grape a2a handoff --json '{"agent":"qa","payload":{...}}'` | A2A 交棒 QA Agent（新开发场景必做；代码优化场景不触发） |

### 3.7 --json body Schema（implementation 用到的）

| Body schema | 使用命令 | 必填 | 可选 |
|-------------|---------|------|------|
| `PullRequestCreateBody` | `git-repo pulls create` | — | `base`, `close_related_issue`, `head`, `inner_issue_nums`, `title`（`head`/`base`/`title` 实际必填） |
| `PullRequestUpdateBody` | `git-repo pulls update` | — | `body`, `labels`, `title` |
| `CommentBody` | `git-repo pulls comments create` / `git-repo issues comments create` | `body` | — |
| `A2AHandoffBody` | `a2a handoff` | — | `agent`, `payload` |
| `CompleteBody` | `tasks complete` | — | `actions`, `artifacts`, `conclusion`, `issue_summary`, `next_step`, `result_text`, `task_id` |

### 3.8 A2A payload 标准结构

```json
{
  "agent": "qa",
  "payload": {
    "repository": "{owner}/{repo}",
    "account": "{user}",
    "issue_number": {n},
    "pr_number": {pn},
    "context": "{交接说明：PR 编号 + 原始需求摘要 + 待审查要点}"
  }
}
```

- `issue_number` 必填（创建 PR 前确认真实 Issue 编号）；`pr_number` 有则必填（新开发场景 = 刚创建的 PR 编号）；`repository` 与 `account` 必填。

---

## 4. 命令限制与不存在的能力

### 命令存在性核验

implementation 引用的命令子集（§3.1-§3.6）经 `grape commands` + `grape <cmd> --help` 动态验证：

| 命令 | 类型 | 验证结果 |
|------|------|---------|
| `grape tasks current` | GET | ✅ 可执行（`--json-out`） |
| `grape tasks complete` | POST | ✅ 可执行 |
| `grape issues detail` | GET | ✅ 可执行（`--owner/--repo/--number/--json-out`） |
| `grape issues pipeline` | GET | ✅ 可执行（`--owner/--repo/--number/--json-out`） |
| `grape events detail` | GET | ✅ 可执行（`--seq/--json-out`） |
| `grape git-repo issues get` | GET | ✅ 可执行 |
| `grape git-repo issues comments list` | GET | ✅ 可执行 |
| `grape git-repo issues comments create` | POST | ✅ 可执行（body: `body`） |
| `grape git-repo pulls create` | POST | ✅ 可执行（body: `base/close_related_issue/head/inner_issue_nums/title`，session-only） |
| `grape git-repo pulls update` | PATCH | ✅ 可执行（body: `body/labels/title`，session-only） |
| `grape git-repo pulls get` | GET | ✅ 可执行 |
| `grape git-repo pulls list` | GET | ✅ 可执行（`--state`） |
| `grape git-repo pulls comments list` | GET | ✅ 可执行 |
| `grape git-repo pulls comments create` | POST | ✅ 可执行（body: `body`） |
| `grape knowledge context` | GET | ✅ 可执行（`--repo/--agent_type/--json-out`） |
| `grape knowledge content` | GET | ✅ 可执行（`--repo/--file/--json-out`） |
| `grape a2a handoff` | POST | ✅ 可执行（body: `agent/payload`） |

> ⚠️ `grape git-repo pulls merge` 等合并类命令**存在但本技能禁止使用**（implementation 不合并 PR，仅创建，等待人工审批）。

### 无 grape api 逃生舱

v0.2.2 移除 `grape api` 通用兜底命令。契约未覆盖的端点无法通过 CLI 调用，不要 curl 直连。

### 不存在的能力（不要尝试）

任务删除（有 close 非删除）· 知识上传 · Issue/PR 删除 · 分支创建/删除（本地 git 分支操作除外）· Token 管理 · `tasks create`（已移除，用 `issues create`）· 流式输出 · 交互式提示 · 配置初始化

---

## 5. 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 1 | 通用/配置错误 |
| 2 | click 用法错误 |
| ≥400 | HTTP 透传 |
| 130 | Ctrl+C |

---

## 6. 安全与边界

- **token 使用范围**：只用 `$GRAPE_SESSION_TOKEN`（grape CLI 自动读取）和 prompt 注入的 `$BOT_GITCODE_TOKEN`。不得从数据库、配置文件、日志、历史中寻找其他 token。
- **禁止访问的内部数据路径**：`data/sessions.db`、`user_accounts` 表、`managed_repos` 表、`configs/` 目录（含 `global-bot-token.json` 等）。`data/workspaces/` 项目知识文档除外。
- **403/401 处理**：命令返回 403 或权限不足时，停止操作并回复「该操作需要管理员/维护者权限，请在 GitCode 仓库设置中手动配置后重试」，不尝试其他 token 或绕行手段。
- **token 不写入文件**：不将 token 写进日志、脚本、Issue 评论或工具调用以外的地方。