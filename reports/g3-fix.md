# G3-FIX 报告 — p1-owner：PR #1 对抗轮修复（5 条 findings）

**目标重述。** 总目标是把 HuaweiCloud-Devkit 的 hook 拦截能力扩展到全部 harness。本单元是 PR #1（OpenCode ≥2 shell 面阻断适配器）的对抗修复轮：双模型对抗审查产出 5 条已验证 findings（最重的是 live 证明的 compound 命令绕过），本轮修复它们、补回归测试、重跑全门并 live 复证。修复方向按协调者裁决执行；5 条语义全部落地，无打折。

分支 `hookgate-p1`，6 个修复提交叠加在 tip `0fceeaf9` 之上，直线历史，未 push 未 merge。

## 修复摘要（逐条 finding）

### FIX-1（CRITICAL）compound 命令绕过 — 逐元素分类

- **先自证复现**（Bug fix 步骤 1）：离线 staging 部署态适配器，喂宿主 scanner 产出的分裂形 `['ls /tmp','hcloud ECS DeleteServers --server.id=x']` → `effect:"allow"`；同一文本整串喂适配器与 `.mjs` 孪生 → 双双 deny。绕过机制直接观测成立（`/tmp/opencode/g3-repro/repro.out`）。
- **修复**：handler 改逐段分类——每个 `String` 元素独立跑 `classifyTextCommand`，任一段 deny 即整体 deny，取第一个 deny 的 reason；空/纯空白段跳过，全空事件零干预。宿主 per-resource 语义的忠实移植。
- **测试**：旧 join 测试重写为 per-segment 语义钉（分裂形 deny / 良性两段 allow / read+write 混合 deny / 首 deny reason 顺序 / 空白与 null 边）；新增逐段 parity 钉——8 条命令语料逐条喂 `.mjs` 与适配器，verdict 与 reason 字节相等。
- **提交** `e3b3013a`。

### FIX-2（MEDIUM）逐元素 8KiB 上限

- **修复**：段文本 > 8192 字节在分类前直接 deny fail-closed，reason 写明 `"the command text is too large for synchronous in-hook classification (N bytes > 8192); split the command or pass complex parameters via --cli-jsonInput"`（前缀不变）；被证伪的 `safety-gate.js` "cannot hang" 注释重写为如实陈述（逐段分类 + 3s 竞速界 + 8KiB 界及实测依据：96KB→213s 二次方外推，8KiB 最坏 ≈1.5-2s）。
- **测试**：8193 字节单段 deny 且 reason 含 `--cli-jsonInput` 指向；恰好 8192 字节正常分类；两段各 6000 字节（总和 12000）不受影响——逐段界不误伤合法 compound。原 256KiB 测试退役（该帽是 `.mjs` 面的内部帽，本面在它之前拦截）。
- **提交** `ab454837`。

### FIX-3（MEDIUM）seam edit-deny 扩到 payload 根

- **修复**：(a) seam 增加 **edit-only glob 类**——`payloadEditDenyGlobs` 派生 `huaweicloud-plugins/**`，edit/write/patch 工具在该 glob 下 deny，同一 add-only-if-absent + value-exact-removal 所有权契约；`apply`/`remove` 增第二参数（默认空）；`external_directory` allow **刻意不扩**——被 allow 的外部目录继承 workspace 默认（bash 可写），payload 不能变成免提示 bash 写入目标。doctor 按类评估（edit-only 类只要求 edit deny），label 补报覆盖（`Skills-tree permission seam (allow + edit deny; payload edit deny)`），golden diff 仅此一行（计数行不变）。(b) approvals.md / CHANGELOG 残余披露见 FIX-5 条。
- **测试**：Part A 纯逻辑矩阵（glob 派生含反斜杠形 / edit-only 写入形状 / 用户值保序 / value-exact 删除 + 段落修剪）；Part B 真实 installer 行（全 seam + 幂等计数含 payload 键 / **真实世界 heal**：删掉 payload 键的旧安装，重装只补 payload edit 键、绝不补 external allow / uninstall deepEqual 强制 payload 键删除）；doctor-skills-tree 的 remediation 文案断言同步。`probe-disarm` 的 S1/S2 在 edit 工具向量上由 globs 覆盖关闭（文档 + 测试层断言）。
- **live 加证**：真机安装输出确认 `payload edit deny: deny` 写入一次性根的 opencode.json。
- **提交** `cac2fe9e`；重复折叠（见纪律节）`4a164826`。

### FIX-4（LOW）import 3s 竞速界

- **修复**：`loadPolicy()` 的 import 与 3s 一次性定时器 `Promise.race`；超时 → deny fail-closed（复用 `POLICY_LOAD_FAILED_REASON`）+ **清缓存保持可重试**（与既有失败清除语义一致）。
- **测试**：staging 一个 top-level 永久 pending 的 policy 模块（FIX-4 挂死形），handler 实测 ~3s 后 deny，无 fake timer（实现层选择：钉的就是真实生产界，等待真实发生，非 flaky）。
- **提交** `f76f3acc`。

### FIX-5（LOW）残余枚举补 script-file 类

- **修复**：approvals.md 的 "It does NOT defend against" 段整合为一段完整披露——变量间接类 + script-file 载体（`bash /tmp/x.sh` 跑的是文本门永远看不到的内容）+ 经 bash 改写分类器文件的自解除向量（opencode seam 已关 edit 工具半边；**bash 半边在所有 in-process 门上开放**，架构级，修复方向是安装时完整性校验，本轮不做，记 follow-up）。CHANGELOG Unreleased 段重写为最终事实（逐段分类 + 竞速界 + 8KiB 界 + payload edit deny + 全部残余）。AGENTS.md、README harness notes、hook-rule-model 矩阵行同步两 seam 类与逐段/界事实；过时的 "cannot hang" 声称从所有面清除。
- **提交** `502abe52`。

## 验收记录（exit code 直接落盘，不经管道）

| # | 验收项 | 命令 | exit | 备注 |
| --- | --- | --- | --- | --- |
| 1 | 新增/重写测试全绿 | `node --test test/opencode-safety-gate.test.ts test/opencode-permission-seam.test.ts test/doctor-skills-tree.test.ts test/structure.test.ts` | 0 | 17+14+17+50 全绿（结构文件合并跑 50/50） |
| 2 | 变异自证（join 回退 → compound 回归红） | 改回 join 后 `node --test --test-name-pattern "per-segment classification" …` | **1** → 还原后 0 | 红：`✖ per-segment classification…`；还原绿。证据 `/tmp/opencode/g3-mutation-red.log` / `g3-mutation-green.log` |
| 3a | build | `npm run build` | 0 | dist 重建 + 30 技能同步 |
| 3b | typecheck | `npm run typecheck` | 0 | 两 project 干净 |
| 3c | validate | `npm run validate` | 0 | 30 skills / KooCLI 7.3.12 / 34 pack 模块 |
| 3d | lint | `npm run lint` | 0 | 0 error（87 条基线告警不变） |
| 3e | lint:dup（完整门参数） | `npm run lint:dup -- --baseline .jscpd-baseline.json --fail-on-new-clones 0` | 0 | 208 clones，0 新增，baseline 文件未动 |
| 4 | 全量测试 | `npm test` | 1 | 2816 tests / 2812 pass / 2 fail——仅基线豁免的 real-agents 环境项（同 G2：opencode 握手子测试 + 其父测试），**无新增失败** |
| 5 | doctor golden 重生成 | `node scripts/doctor-golden.mjs --regen` + `node --test test/doctor-golden.test.ts` | 0/0 | diff 仅 seam label 一行（`…(allow + edit deny; payload edit deny)`），计数行不变 |
| 6 | live 门（隔离两段式三例） | `bash /tmp/opencode/hookgate-g3-live/run-g3-live.sh` | 0 | 摘录见下节 |

**验收 3e 的教训（已修）**：首轮全量跑里结构测试的 jscpd 门红（1 新克隆——FIX-3 让 apply/remove 两循环结构同形），而裸 `npm run lint:dup` 不带 `--fail-on-new-clones 0` 时同克隆不红。按 brief 预判（"FIX-3 可能撞重复——共享定义放一处"）折叠：`sectionFor`（标量所有权检查）与 `seamSections`（两类 section 表）各归一处，两循环剩余部分行为本就不同（add-only-if-absent vs value-exact delete）。0 新克隆，未动 baseline。

## live 门摘录（`/tmp/opencode/hookgate-g3-live/`）

真实 installer 部署（自然探针门，opencode v2.2.7），剥披露面后三例：

```
  Safety gate -> …/plugins
  Skills-tree permission (external_directory allow + edit deny) -> …/opencode.json
payload edit deny: deny          ← FIX-3 的安装半边真机落盘
g3-compound exit=0 wall_ms=10592
g3-benign  exit=0 wall_ms=8919
g3-single  exit=0 wall_ms=11196
```

**compound 例**（A live 证明过的绕过，修复后必须 live 关闭——已关闭）：

> The command was blocked. Here's the output:
>
> ```json
> {"error":{"type":"permission.rejected","message":"Huawei Cloud safety hook blocked this action: Huawei Cloud write operation blocked until the agent presents a plan and receives explicit user approval."},"content":[]}
> ```
>
> The `ls /tmp` part didn't produce output either — the safety hook rejected the whole command before execution…

**良性例**：

> The output is:
>
> ```
> g3-live-bc-1794998832
> ```

**单写例**（G2 回归）：

> ```json
> {"error":{"type":"permission.rejected","message":"Huawei Cloud safety hook blocked this action: Huawei Cloud write operation blocked until the agent presents a plan and receives explicit user approval."},"content":[]}
> ```

三例全部宿主稳定（exit 0），deny reason 逐字回传模型。

## Follow-up（对抗者披露、裁决 out-of-scope，逐条列出）

1. **安装时完整性校验**（架构级，本 PR 不做）：经 **bash 面**改写部署的 `dist/safety-policy.js` 在所有 in-process 门上自解除——seam 已关 edit 工具向量，bash 向量开放（适配器 import 的模块与 `.mjs` 同锚点）。修复方向：安装/加载时对部署 policy 做哈希校验或签名，fail-closed 于校验不过。
2. **`.mjs` 孪生同锚点暴露**：Claude 宿主上 hooks.json 跑同一相对路径的 policy 文件，暴露面更大（B 披露）；同一完整性校验方案落地时应一并覆盖。
3. **action 名碰撞/改名残余**：适配器精确匹配 `action === "shell"`（V2 实测名）。若未来宿主像 V1→V2 那样再改名、或非 shell 工具的 action 恰名 "shell"，门会静默零干预（fail-open 方向）。属宿主 API 演进风险，无 devkit 侧可测锚点，留给后续版本门收紧时复查。
4. **文本门共享残余**（既有披露，本轮补全枚举）：变量间接拼写（`V=approve; npx … $V`）与 script-file 载体（`bash /tmp/x.sh`）在所有文本门外；外国非-devkit MCP 工具不在信任边界内。
5. **real-agents opencode 握手子测试的环境性失败**（G1 已归档的 managed service 端口冲突类）本机持续，与本轮改动无关（G2 已用 gate-off 对照证明同症状）；沙箱内 per-root 端口规避是测试基建修复，值得后续单元处理。

## 提交清单

```
4a164826 fix(install): fold the seam's duplicated section machinery into one shared definition
502abe52 docs: the adversarial round's honest residual disclosure and the corrected gate claims
cac2fe9e fix(install): extend the opencode seam's edit deny to the payload root — close the edit-tool vector on the classifier
ab454837 fix(safety): cap each scanner segment at 8KiB before classification — the 'cannot hang' claim was measured false
f76f3acc fix(safety): race the adapter's policy import against a 3s fail-closed bound
e3b3013a fix(safety): close the compound-command bypass — per-segment classification in the evaluate adapter
```

## 结束语

5 条 findings 全部修复并各有回归钉死，变异自证红绿成立，全门绿（基线豁免项除外），live 三件复证含绕过关闭。分支等协调者收 PR。
