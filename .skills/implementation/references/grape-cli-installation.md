# grape CLI 安装与升级

> grape CLI 是**公开可安装**的独立包（仓库 `gitcode.com/grape-dev/grape-cli`）。前置检查（SKILL「三、前置检查门」）发现未安装或版本过低时，**自行安装/升级**，无需等待管理员。

## 版本要求

- 最低版本：**0.3.2**（本技能依赖 `issues detail/list/pipeline`、`git-repo issues get/comments`、`tasks current/notify/close/complete`、`a2a handoff`、`knowledge context/content` 等命令）。
- 检查：`grape --version`。

## 安装方式（pip 直装，无需手动 clone）

### ① 全新安装（首选）

```bash
# `git+<URL>` = pip 的 VCS 直装协议：从 Git 仓库（而非 PyPI）克隆并安装
pip install git+https://gitcode.com/grape-dev/grape-cli.git
grape --version
```

> 需要 Python >= 3.10（grape CLI 依赖 click/httpx，pip 自动安装依赖）。

### ② 独立 venv（隔离环境）

```bash
python3 -m venv /opt/grape-cli
/opt/grape-cli/bin/pip install git+https://gitcode.com/grape-dev/grape-cli.git
# 使用时确保 PATH 含 /opt/grape-cli/bin
export PATH="/opt/grape-cli/bin:$PATH"
```

### ③ 升级已装的 grape CLI

```bash
# 重跑同样命令即升级到最新
pip install --upgrade git+https://gitcode.com/grape-dev/grape-cli.git
grape --version
```

### ④ 开发/编辑源码（仅开发用地，日常安装用 ①）

```bash
git clone https://gitcode.com/grape-dev/grape-cli.git
cd grape-cli
pip install -e .[dev]
```

## 安装后验证

```bash
grape --version            # 应 >= 0.3.2
grape commands issues      # 应能列出 issues detail/list/pipeline 等
grape refresh              # 契约过期时重拉最新契约（或回退内置快照）
```

## 注意事项

- ⚠️ **禁止 `pip3 install grape`**：PyPI 上的 `grape` 是**第三方公有包**，不是本项目的 CLI，装错会误导命令执行。必须用 `pip install git+https://gitcode.com/grape-dev/grape-cli.git`。
- agent 环境通常已安装并注入环境变量，仅确认 `grape --version` 即可；未装才执行安装。
- 安装与验证后仍失败（如 Python 版本 < 3.10 无法装依赖）→ 输出「前置检查未通过：<原因>」并结束任务，不无限重试。
- 认证不需要配置：`$GRAPE_SESSION_TOKEN` 由服务端注入，`grape` 自动读取（详见 SKILL「二、环境变量表」与 `references/grape-cli-reference.md`）。