# AgentArts 场景规划

日期: 2026-10-21。裁决基于 agentarts-sdk 0.1.7 钉版源码与仓库 43 个 CLI fixture 的分析, 细节与引证见 `docs/agentarts-pr0-findings.md`; 未经真机验证的结论均已注明。

## S1 宿主 agent 云记忆

S1 今天即可用, 只有 /recall /remember 指令层是坏的。

目标用户: 日常用宿主 agent（opencode、codex、claude code 等编程 agent）开发的个人与小团队。付费者是人, 消费者是宿主 agent 自身。痛点是 agent 跨会话失忆: 每个新会话都要重新交代项目背景与偏好, 记忆只能靠 transcript 和手写笔记, 不可检索、不可共享。

使用故事: 用户创建一个记忆空间, 拿到一把一次性数据面 api_key。在自己的终端把官方记忆插件装进宿主 agent（落盘 TS 捕获插件、/recall /remember 命令、opencode.json 的 mcp 段）, 重启宿主 agent。此后对话被自动记录到云记忆, 后续会话按语义召回。用户装完即无感, 记什么、何时召回由 agent 自己决定。

得到什么: 跨会话、跨项目的持久记忆, 按 user 与 scope 隔离。不用自建向量库, 不用配记忆抽取管道, 按量付费。

依赖与短缺:

- CLI 只到空间级: 数据面的会话、消息、语义检索在 SDK 里有 12 个方法, CLI 一个子命令都没有; api_key 无找回命令, 丢失只能删空间重建。
- `memory create` 默认 table 输出会永久丢一次性 api_key, 必须 `--output json`（devkit 已补偿）; `install --yes` 在凭证缺失时仍静默装出坏配置。
- /recall /remember 指令 curl 一个无人设置的 env, 开箱即坏, 等价能力走 MCP 工具; `install openclaw` 是 exit-0 的 no-op; region help 标注 cn-north-4 与实际默认 cn-southwest-2 不符, 用时显式传 `--region`。
- api_key 明文进宿主 agent 配置属 host-trust 决策, install 留在用户终端。

## S2 有状态 LangGraph agent

无状态部署已实测通过（PR8）; 有状态核心是手工 SDK 工程, 端到端未验证且有损。

目标用户: 用 LangGraph 构建有状态 agent 应用的开发者, 模型后端为 MaaS 或任意 OpenAI 兼容端点。痛点是 checkpoint 与状态存储要自己管数据库, 生产部署还要自己管镜像、制品库、运行端点。

使用故事: 用户把 agent 的 checkpoint 接到 AgentArts 的 Saver/Store, 项目 venv 本地冒烟, 一条命令完成构建、推送 SWR、创建云运行时。invoke 多轮对话, 状态落在云记忆。实例销毁后重建, 第二轮对话理论上接得上第一轮。

得到什么: 状态云化加部署托管化。用户写业务逻辑, 平台管生命周期。但"checkpoint 跨 destroy + re-deploy 存活"目前是源码级机制加预测, 真机验证前不向用户承诺。

依赖与短缺:

- init 模板零接线 Saver/Store, 有状态等于纯手工 SDK 工程; launch 后无就绪等待命令, invoke 要人工重试。
- `agentarts dev` 在 CLI 自身 venv 里跑, 框架模板必然 ModuleNotFoundError; init 不生成 `.dockerignore`, 含密钥的配置被 `COPY . .` 烤进推往 SWR 的镜像。
- `config set-env` 在 basic 模板确定性崩溃; Saver 把写异常吞成日志（静默丢状态）, 只持久化首个 tool_call, 超 10 轮产生重复消息, 重建只恢复 messages 通道。
- 消息 TTL 默认 168 小时即 7 天, checkpoint 存活限时, `memory update` 最大调到 8760h。

## S3 免烧密钥部署

部署侧可行, 容器侧未验证。

目标用户: 合规敏感的企业开发者与平台团队, 审计红线是长期密钥进镜像进 SWR。痛点是 agent 要访问云资源（OBS、数据库、内部 API）, 通行做法把长期 AK/SK 或模型 key 烧进镜像, 镜像入库即长期密钥落库, 泄漏半径是整个账号。

使用故事: 用户为部署的 agent 配 workload identity。agent 运行时经 identity 链换 STS 临时凭证, 用临时凭证访问云资源; gateway 按请求注入 workload token。长期密钥不出现在镜像、配置、制品库的任何一层。

得到什么: 镜像可公开, 凭证可轮转可审计, 泄漏半径从账号级缩到会话级。

依赖与短缺:

- 身份面零 CLI: workload identity、STS provider、OAuth2/API-key provider、access token 全族只有 Python API。
- 部署侧可达: yaml `execution_agency_name` / `agent_gateway_id` 接线; `gateway create` 省略 agency 名自动建 IAM 委托。
- `create_or_update_agent` 的 update 分支静默丢弃 identity_configuration, redeploy 即丢; 容器内身份客户端强制走 metadata 链, metadata 服务可用性未实测。
- `launch -m local` 不注入 env、无网关注入, 身份路径本地不可复现。

## S4 云 browser / code interpreter

CLI 不可行; devkit 走 SDK 桥接在架构上可行, 暂缓。

目标用户: 给 agent 配浏览器自动化与代码执行能力的构建者。痛点是本地浏览器自动化脆弱且占资源, 本地代码执行对本机是 RCE 风险, 沙箱要自己搭。

使用故事: 用户创建云浏览器或云代码解释器实例, agent 通过会话式接口使用。浏览器有点击、输入、导航、截图、live view、profile 持久化; 解释器有执行代码、装包、上传下载文件。环境用完即毁, 本机零风险。

得到什么: 隔离的一次性执行环境, 不占本机资源, 不动本机文件系统。

依赖与短缺:

- browser 约 40 方法、code interpreter 约 20 方法, 全部能力零 CLI。
- 解释器的命令注入拦截表是空数组, 宣称的防护是死代码, 允许清单还放行 `rm -rf /home/user`; devkit 若桥接必须自建拦截。另有三处文档与代码矛盾。
- 待真机裁决: 数据面 key 获取路径、数据面端点来源、计费、region 可用性。

## S5 gateway 开放 API

只有默认姿势今天可用, 完整场景等上游补文档。

目标用户: 把 agent 能力开放给外部系统的集成者与平台团队。痛点是 invoke 是内部协议, 外部系统需要标准 API 入口, 带鉴权和流控。

使用故事: 用户创建 gateway, 把已部署的 agent 挂为 target, 配置出网姿势。外部系统经标准 API 调用 agent 能力。

得到什么: agent 从内部工具变成可运营的 API 产品。

依赖与短缺:

- `--target-configuration` 在客户端源码中不存在 schema, 纯透传, 形状服务端私有; 同族 authorizer 与出网配置同为不透明。绕过路径: 部署期 yaml `agent_gateway_id` 挂载不需要该 JSON, 默认姿势（IAM 鉴权 + public 出网）今天经 devkit 补偿可用。
- `gateway delete`/`delete-target` 无跳过旗标, wrapper 硬停; 全族无 `--output json`; 无 `--region` 旗标; update 不能改出网。
- gateway 全族失败 exit 0; 与 runtime 分页基不一致; 限流在 SDK 与 CLI 均无。

## 上游 CLI 改进诉求

1. 诚实退出码（memory、gateway、config 全族）, 解锁 5/5
2. `agentarts runtime list`, 解锁 3/5
3. memory 数据面子命令 + `create` 默认输出 api_key, 解锁 2/5
4. `gateway delete --yes` + gateway JSON schema 文档化, 解锁 1.5/5
5. 全族 `--output json` + gateway `--region` + 修 region 文案, 全场景
6. `init --stateful` 接线 Saver + 生成 `.dockerignore`, S2
7. `launch --wait`; `dev` 支持项目 venv, S2
8. `identity` 命令组 + 修 update 丢配, S3
9. browser / code-interpreter CLI 化 + 修拦截死代码, S4
10. 移除 `-bt` 与 `BEARER_TOKEN` env 回退, 安全面, 全场景
