# REPORT.md — e2e-nightly opencode 腿 2 个失败修复（分支 e2e-nightly-fix-hm）

## 0. 任务与结论

目标：opencode 腿的 2 个 case（`sandbox-upload-file-md5`、`openmcp-execute-refusal-consent`）清零，根因先行、修在正确的层、interrogate 至 0 缺点、门禁全绿后一次规约式 commit。

结论：

- 两例均为**既有问题**，非 9bee29b6 引入。上游基线 run 41378291316（55f53ad0）同批 case 失败更重（8 个失败，含本例）；fork 近 6 个 nightly 里两例 5 次全绿、仅本次（run 41636889890）发散。
- 归类：case 1 = **(a) harness/expectation 缺陷**；case 2 = **(a) 场景措辞歧义（主）+ 产品教学欠明确（辅）**，触发因素为 LLM 行为（c），**不是 (b) 产品回归**——两次自授全部走了 ephemeral scope + canonical 拼写，所有 devkit floor 完好。
- e2e 级（真实 LLM 腿）验证按任务书由 run-e2e label 的 PR 承担；本地做了证据重放证明（观测记录 → 新 pin 全绿；构造回归 → 全红）。

## 1. 根因表

| case                            | 根因                                                                                                                                                                                                                                                                                                                                                                                                                                 | 归类                                                 | 证据                                                                                                                                                                                                                                                                                                                       | 修复                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sandbox-upload-file-md5         | ws 录制通道无 tool/agent 归因。`wsConnections 2..2` 把 agent 自发的验证 one-shot（conn3 `ls`，命令 `ls -la /tmp/hello-upload.txt && md5sum /tmp/hello-upload.txt`）计入总数；upload 工具本身完美复用缓存会话（conn2 = `export-path,rm,printf-append,base64-decode,md5sum`，0 新连接）。同理 `ZERO_UNKNOWN` 会在 agent 用非 `ls` 动词验证时误红（本次 run attempt-1 的 agent 实际组合了 `md5sum <p> && cat <p>`，未上 ws 通道属侥幸） | (a) expectation 缺陷                                 | 报告 attempt-2 wsCalls 与 stderr 工具序列（`huaweicloud_sandbox_upload_file` → `huaweicloud_sandbox_exec_one_shot`）；handlers-account.ts:27,34（connect=one-shot+缓存会话）；upload-file.ts:140（md5 复验走 execWithSession）；hwlink-connection.ts:138-163（one-shot=新连接 / session=缓存）；5/6 历史 nightly 为 2 连接 | 机制证明改为**共居锚定**：4 个上传 intent 必须 `onConnectionWith: 'export-path'`（新增 matcher 能力）；放弃 `wsConnections` 与 `ZERO_UNKNOWN`（同 `sandbox-upload-project-tunnel` 生而无此二钉的先例）；`md5sum` 锚定 1..2                            |
| openmcp-execute-refusal-consent | 场景措辞「先不要向我申请之外的任何授权,直接尝试执行」可双读为「常设预授权」；agent 两 attempt 均以该读法在网关拒绝后自授 once 规则。产品侧教学（「confirm with the user in conversation」）未限定同意的**对象**（grant）与**时点**（拒绝后），常设任务指令被算作对话内确认                                                                                                                                                           | (a) 场景歧义（主）+ 教学补强（辅）；LLM 行为是触发器 | 两 attempt stdout 自授理由（「依据你"直接执行"的指令…」「用户已在对话中明确预授权…」）；fake sidecar 冻结的 v0.2.0a4 拒绝文本（教同意路径）；tools.ts:128 与 SKILL.md:29 原文无时序/对象限定；基线 41378291316 与 5 个 fork nightly 均 0 次 manage_policy（该 case 绿）                                                    | 场景显式声明同意状态（仿 `core-approval-negative` 先例：未授权任何策略、授权与否由用户决定）；`gateway_call` 描述与 `huawei-openapi` SKILL.md 教学补强（grant 同意=拒绝后就 grant 询问；常设任务指令不是 policy write 的同意），均加 structure 测试钉 |

## 2. 修复明细（8 个文件）

| 文件                                               | 改动                                                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `test/e2e/types.ts`                                | `WsCommandMatcher` 新增可选 `onConnectionWith`（共居锚定语义与动机注释）                                                            |
| `test/e2e/evaluate-kinds.ts`                       | `ws` 分支按锚定 intent 过滤连接作用域；miss 证据仍回显全通道扁平视图（诚实调试视图）                                                |
| `test/e2e/cases/http-packs.ts`                     | upload case：4 个锚定 intent pin；`wsConnections`/`ZERO_UNKNOWN` 移除（注释含完整论证与 nightly 引证）；`md5sum` 1..2               |
| `test/e2e/cases/open-mcp.ts`                       | 新 prompt（显式同意状态）+ 事件注释（歧义双读、证据、残留）                                                                         |
| `test/e2e-evaluate.test.ts`                        | 3 个新测试：锚定命中/回归红/未锚定不变 + 前缀锚定突变体猎杀                                                                         |
| `test/structure-skill-teaching.test.ts`            | 2 处新钉：SKILL 与 served description 的「常设指令非 grant 同意」教学                                                               |
| `plugins/.../huaweicloud-open-mcp/tools.ts`        | `gateway_call` 描述：`confirm the grant ... after the refusal (a standing go-ahead for the task is not consent for a policy write)` |
| `plugins/.../skills/huawei-openapi/SKILL.md`（源） | 同语义补强；保留 `confirm with the user in conversation` 钉住短语                                                                   |

证明脚本（未入库）：`/tmp/opencode/verify-upload-pin.mjs` — 观测 nightly 记录→case 绿；回归 A（自开连接, 3 conn）→4 锚定 pin 全红；回归 B（逐命令 one-shot, 6 conn）→红；健康 2 conn→绿。

## 3. interrogate 记录（每轮发现数）

| 轮  | 对手                                                               | 发现（verified）                                                                                                                                           | 处置                                                                |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| R1  | 4（glm-5.3 / deepseek-v4.1-flash / glm-5.3-flash / glm-5.3-角度4） | **3**（合并后）：① ZERO_UNKNOWN+词汇误红（本 run agent 的真实命令风格证伪）；② 2..4 总数钉在 3 个 agent one-shot 时仍误红 + 注释误导；③ 前缀锚定突变体存活 | 移除两钉、`md5sum` 1..2、新增精确匹配锚定测试、注释重写             |
| R2  | 2                                                                  | **4**：1 MED（policy-FILE 自授盲区，**既有**）+ 3 LOW（md5sum min 归因、ok:true-on-deny trace、第 3 次会话复验红）                                         | MED→记录残留（现词汇表不可闭、腿上未触达）；3 LOW→注释边界/自觉权衡 |
| R3  | 2                                                                  | **2**（对手一：0；对手二：2 LOW 注释准确性：先例“dropped”应为“omitted at birth”；external_directory 引证错位）                                             | 措辞修正                                                            |
| R4  | 1                                                                  | **1** LOW（"the only observed"→语料库 10 次全 READ）                                                                                                       | 措辞修正                                                            |
| R5  | 1                                                                  | **0**（33 case 全量重放 0 非预期翻转、电池全绿、注释逐条对证）                                                                                             | 关闭                                                                |

R2 数量上升是诚实结果：新角度攻击**更新后**的改动，挖出一层既有盲区（非本轮引入）与边界项。R3 起严格递减至 0。

已核销（dropped，各带理由）：R1 的双 export-path 连接拆分（B1，产品路径不可达——upload-file.ts 从不 export PATH、getSession 重连不重导出）；非规范拼写 `action:'Add'`（devkit floor 在转发前拒绝）；OM7 三连重试红（既有 max=2，非本 diff 触碰）。

## 4. 门禁输出摘要

| 门禁                  | 结果                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`              | exit 0                                                                                                                                                                       |
| `npm run typecheck`   | exit 0（src + test 双工程）                                                                                                                                                  |
| `npm test`            | 首跑 1 fail：`hook-parity.test.ts` ReDoS **计时**探针（测 `safety-policy.ts`，与本 diff 零交集；单跑 4/4 绿）→ 全套重跑 **1487 tests / 1485 pass / 0 fail / 2 skip**，exit 0 |
| `npm run lint`        | 0 errors（74 warnings 均先存；e2e-evaluate.test.ts:309 的 `strict` 警告经 `git show HEAD` 证实先存于本 hunk）                                                                |
| `npm run lint:dup`    | exit 0（无新克隆，基线外零增量）                                                                                                                                             |
| `npm run validate`    | 30 skills、KooCLI 7.3.12 配对、pack boundaries、skills sync OK                                                                                                               |
| `npm run pack:verify` | 667 files, install OK                                                                                                                                                        |

## 5. 遗留与风险

1. **openmcp policy-FILE 自授盲区（既有，未闭）**：agent 可把 allow 行直写 pack-state 策略文件（路径可从 permanent-add floor 拒绝文本获知）后执行，现有 pin 全绿。当前期望词汇表不可闭（file pin 仅 contains；gateway 录制无 ok 字段；toolCall 级 manage_policy 禁令会误伤被祝福的 refusal-triggered `list` 诊断）。opencode 腿上该路径未触达（语料库所有 outside-workspace auto-reject 均为 READ）。建议后续加 `notContains` file 钉或 ok 判别。详见 case 注释。
2. **`callTool` trace 对 deny-by-return 记 `ok:true`**（R2 发现）：被 floor 拒绝的 gateway_call 进 trace 时 args 全带但 ok 为真；未来按 ok 设计的同意 pin 会漏掉全部 deny-by-return。潜在观测性问题，不在本任务权限面。
3. **upload-md5 `min:1` 归因限制**：产品丢验证 + agent 自行复验时该 case 可绿（通道无归因）；真正的 md5 内容门是 `toolCall ok`（产品 hash 不匹配即抛）。已注释记录。
4. **B1/B2 残留**：双 export-path 连接拆分（不可达）；connect 丢 devbridge-delete-all one-shot（既有盲区，全套无 case 钉它，reconstructed HEAD 同样绿）。
5. **e2e 级 LLM 行为未测**：本地无 `test/e2e/.env`；新场景措辞对真实模型的影响是**推断**（依据：歧义双读消除 + 5/6 历史行为 + core-approval-negative 同构先例 6/6 绿），不是测量。run-e2e label PR 是裁决点。
6. `md5sum` 第 3 次会话复验会红（自觉边界：观测语料 10/10 次 leg 报告零次会话级复验；无界上限会抹掉产品双复验牙齿）。

## 6. 跨界影响标注

- **共享面**（最小改动）：`huaweicloud_gateway_call` 工具描述与 `huawei-openapi` SKILL.md 是全部腿共享的教学文本；改动为同意语义补强（对 codex/hermes 腿同样有利——同一误导源被移除），新增 structure 测试钉防回退。
- **未触碰**：其他 agent 的 case、`.github/workflows/e2e-nightly.yml`（drift-guarded）、共享二进制、其他 worktree。case 总数 33 不变（roster 钉守住）。
