# INTEGRITY 报告 — int-owner：payload 完整性单元（bash 改写残余的关停与抬高）

**目标重述。** 总目标是把 HuaweiCloud-Devkit 的 hook 拦截能力扩展到全部 harness。Phase 1（PR #22，`hookgate-p1`）落地了 OpenCode shell 面阻断门，对抗验证留下一条已披露的架构级残余：agent 经 bash 面改写部署的分类器文件，门在会话内自解除（TLA 模型里唯一破规则的路径）。本单元把这个残余从「完全开放」抬到「多层设防 + 可检出」：路径写拒绝（层 1）+ 载入期行为自检（层 2）+ doctor 漂移检查（层 3）+ 如实披露（层 4），并如实记录剩余天花板。

分支 `hookgate-integrity`，6 个工作 commit 叠加在 tip 之上，直线历史，未 push 未 merge。

## 工作区基线的一次证据驱动修正（如实记录，先于一切实现）

BRIEF 写的基线是 `origin/v2`（`17670943`），但本单元的靶子是 PR #22 自己的产物：层 2 要改的适配器（`integrations/opencode/hooks/safety-gate.js`）、层 1 语义要对接的 `.mjs` 孪生金丝雀位、验收 4 的 live 门（要求已部署的 evaluate 适配器）、验收 5 的「既有全量判定零回归」基线——全部只存在于 `hookgate-p1`（194ca331）上，`origin/v2` 里没有。两个分支同源（merge-base 即 `17670943`），worktree 是从该点新切的。

处置：把本 worktree 的分支指针 fast-forward 到 `194ca331`（`git reset --hard`，无 merge commit、无 cherry-pick、p1 的 SHA 原样保留、push 无涉）。不这样做，brief 的四层语义无法在其指定的文件上落地，live 验收无法执行。此偏离在报告中如上记录，供协调者复核。

## 层 1 — 共享分类器的 payload 路径写拒绝

**根因。** seam（PR #22 `cac2fe9e`）关死了 edit 工具向量，但 bash 面完全开放：`echo '<permissive>' > <payload>/dist/safety-policy.js` 直接改写部署分类器，适配器的 lazy+retryable import 在首调/失败重试时加载 agent 写入的文件，门在会话内自解除（对抗者 B 的 S1/S2 双证 + TLA 反例路径）。`.mjs` 孪生（Claude 宿主）同锚点、逐次 import，暴露更大。

**实现。**

- `policy.json` 新增 `protectedPayloadPathMarkers`：`huaweicloud-plugins/`、`huaweicloud-core/dist/`、`huaweicloud-core/safety/`（分隔符无关，同时覆盖 copied-payload 与 package-root 两类安装布局）。词表进 policy.json（命令圣经：新封禁模式必须进 policy.json，不能只改一层）。
- TS 面：`src/safety/protected-payload.ts`（新模块）拥有形状规范——四候选（raw/quote-stripped shadow/各自的路径归一形，与凭证门同 `credentialFileCandidates` 教义）按 `[;&|\n\r]` 分块（只会过切不会漏切：真实 payload 路径不含分隔符），每块测六种写形：重定向 `>`/`>>`（目标侧标记）、`tee`（全部操作数皆目标）、`cp|mv|rsync|install`（终点词带标记——`cp <payload> /tmp/` 复出方向不拦）、`dd of=`、`sed -i`（无 `-i` 的只读 sed 不拦）、`patch`。锚定在命令位（env 赋值 + sudo/env/nice/nohup/command/xargs 前缀头之后），空白类只 `[ \t]`（JS/py 字节一致）。挂在 `classify-text.ts` 的凭证门之后、写门之前（brief 建议的位置）。deny 带 `risk: 'invalid'`——任何 roster 豁免类（write/execution/destructive）都不可跳过它。
- py 面（parity 纪律）：`huaweicloud-safety.py` 的 `load_policy` 从同一 key 编译同样的六形状（`PROTECTED_WRITE_RES`，`policy.get` 派生、非 list/空归一为未设、re.error 只降级本门——逐字段隔离教义），`evaluate()` 里紧挨 `CONFIG_FILE_RE` 门消费。**双面判定由 `hook-parity` 电池钉死**：新增 10 行电池行（8 deny 2 allow）双面 verdict 一致。
- 退化契约：旧部署 policy 无此 key → 两面门皆关（纯增量，既有判定零变化）；`loadPolicy` 对 present-but-empty 列表 fail-loud（`must not be empty`，与 writeOperationPrefixes 同教义）；py 的退化面是未设门（记录在案的分歞性状：.mjs 面是 fail-closed 的那一面）。

**验收。** 专用电池 `test/safety-protected-payload.test.ts`（6 测）：25 deny 行覆盖全部六写形 × 两类路径拼写 × 前缀头 × 混合 compound × heredoc/`bash -c` 载体；19 allow 行钉读形引用（cat/ls/grep/skills 读取）、复出方向、只读 sed、无关路径零变化；一个方向钉专测：`dd if=<payload> of=/tmp/...` 保留其**既有**的 destructive deny（reason 是 destructive 的，payload 门不掺和——证明本门不误伤方向语义）。

## 层 2 — 载入期行为自检（canary）

**根因。** import 成功不等于分类器可信：陈旧替换、半截覆写、坏升级会交出一个「形状对、判定错」的模块（对典型写向量 allow），静默解除整个门。层 1 关的是朴素向量；这层抓的是非对抗性损坏。

**实现。** 适配器（`safety-gate.js`）在 import settle 后、信任模块前跑三查：导出形状（`classifyTextCommand` 是函数）+ 行为金丝雀（固定规范串 `hcloud ECS DeleteServers --server.id=x` 必须 deny；`ls /tmp` 必须 allow——都取自既有测试的金丝雀命令，非事件派生）。任一不过 → `selfCheckFailed` 置位（进程粘性——ESM registry 缓存模块求值，重试无意义），此后每个事件 deny，reason 写明「部署的安全策略未通过自检；重装插件」。`.mjs` 孪生同三查、同 reason（两者字面量 byte 等同由 `opencode-safety-gate` 的 literal 钉测强制），失败在 `main()` 之前同步写裁决退出。三查本身 throw 也算败（对规范串都崩的模块不可信）。

**验收。** 适配器：impostor（形状对、判定错——stale 替换/半截覆写/naive disarm 形）→ deny 且良性输入也 deny；noExport（形状败）→ deny；throwing（规范串上崩）→ deny + 粘性；正常模块行为不变（20/20 绿）。`.mjs`：同 impostor 形三命令全 deny；corrupt-rules 旧测的 reason 从 classify-failed 更新为 self-check（载入期就抓到，归因更准——per-input 的 classify-failed reason 只保留给过了金丝雀却在特定输入上崩的模块）。

## 层 3 — doctor 完整性段

**根因。** 层 1/2 是运行时拦截；一条越过它们的漂移（crafted 模块、未覆盖写形）需要**可检出**。安装时记录部署侧分类器文件的哈希清单，doctor 比对——offline 检测面。

**实现。** `src/safety-integrity.ts`（新模块，node builtins only）：`copyServerPayload`（所有 install/update 共享的唯一放置缝）在放置完成后对**实际落盘字节**写 sha256 清单 `.safety-integrity.json`（范围：`dist/safety-policy.js` + 其 `dist/safety/` import 图、`safety/policy.json`、`safety/rules/`——分类器链，skills/node_modules 有各自的 freshness/equality 探针不在内）。receipt 式归属：devkit 所有、随 plugin dir 卸载、区别于 `.installed`（server 启动会删后者，receipt 必须留给 doctor）。doctor 每行 binding 新增 `integrity(ctx)`：`match` → PASS；漂移（changed/missing/**unrecorded**——无合法路径落 scope 文件而不重写 receipt，落单即事后投放的 tamper 形）→ FAIL + 重装修复文案；无 receipt（旧安装升级）→ **WARN 不是 FAIL**（向后兼容，不误报红）；无 payload → 静默。该模块按 payload 家族教义加入 zod-free structure guard（同一 commit 一条目）。

**验收。** `test/doctor-integrity.test.ts`（5 测）：scratch 单元行（scope 排序/receipt 形状/match）+ 三种 tamper 形（changed/missing/unrecorded）+ WARN 门（无 receipt/unparseable receipt/no-payload 静默）+ **真实 install 全周期**：安装写 receipt（install 输出新行）→ doctor PASS → 篡改部署文件 → FAIL 且文案点名 `dist/safety-policy.js` 与重装命令 → 重装 heal → 再 PASS → 删 receipt → WARN 不 FAIL → 卸载随目录移除。golden 重生成：`golden-b` 恰好 +1 PASS 行、计数 14→15；a/c 两金（无部署 payload）零改动。

## 层 4 — 文档

`approvals.md` 残余段：bash 向量从「open on every in-process gate, fix direction not built yet」升级为三层设防 + 天花板陈述（见下）。`docs/CHANGELOG.md` Unreleased 新条目记录全部四层与残余。`docs/hook-rule-model.md` 加 payload 路径写行（词表来源、六写形、方向豁免、双面消费）与分类器完整性三道防线段。`AGENTS.md` 安全节补同事实。均不夸大：朴素向量关死，crafted 模块仍是残余。

## policy.json 新 key 的双面消费证明

- **key**：`protectedPayloadPathMarkers`（3 个 marker，分隔符无关）。
- **TS 面**：`Policy` interface + `loadPolicy` 读取（空列表 fail-loud）→ `protected-payload.ts` 编译形状 → `classify-text.ts` 凭证门后消费——`test/structure-safety.test.ts` 新结构钉强制这三处（import 语句、调用点、`risk: 'invalid'`）。
- **py 面**：`load_policy` 内 `policy.get("protectedPayloadPathMarkers", [])` 派生编译（结构钉强制 `marker_alt` 从 policy 列表 join、编译在 load_policy 内、退化归一未设）→ `evaluate()` 紧邻 `CONFIG_FILE_RE` 消费（结构钉强制 chunk-split × 形状搜索的 gate 形状）——沿用 `APPROVAL_CLI_RE` 的「派生编译 + 无应用即 no-op」双钉教义，杜绝手抄词表漂移。
- **判定一致**：hook-parity 电池 10 行双面 verdict 相等；离线先导语料 29 行（TS）/28 行（py）全对齐。

## 测试使用面扫描结果

全仓 grep 测试/脚本/integration 中经 shell 写 marker 路径的合法用法：

- `test/hook-parity.test.ts:504` `cp $(mktemp -d)/x plugins/huaweicloud-core/dist/foo`——既有 allow 行（钉已退役的裸 `cloud` marker 的过拦），本单元**设计内翻转**为 deny（`cp` 终点词带 marker）。其原过度拦截钉由非 marker 兄弟行继续覆盖（`cp -r $(pwd)/src plugins/huaweicloud-core/` 仍 allow——目录本身非 marker）。
- `test/safety-text-command.test.ts:170` `node ./plugins/huaweicloud-core/dist/setup-cli.js secret get …`——node 执行形态非写形，不受影响（实测 allow 面零回归）。
- 其余全部命中（`agent-install-opencode`、`plugins-e2e-roster`、`hermes-config-merge`、`real-agents`、`doctor-integrity` 等）皆 Node `fs`/`mkdirSync` 构造夹具——不经 Bash 面，天然不受分类器管辖。
- e2e 夹具如 brief 预判多经 Node fs 构造；无其他 shell 写需调整。

## 剩余天花板（如实清单，不夸大）

1. **crafted 模块逃逸**：能读源码的对抗者可伪造一个通过三条金丝雀的 permissive 分类器（金丝雀是固定规范串）。层 2 抓的是非对抗性损坏，这是它的设计边界，如实归入残余。
2. **路径门的文本残余**：引号/变量拼写的 marker 路径（`P=~/.config/opencode/huaweicloud-plugins; echo x > $P/dist/…`）、`cp -t` 式 flag 目标、`timeout` 包裹的写动词、形状表外的动词（`truncate`/`ln`/…）。与既有文本门的天花板同族——文本门看不见展开后的 argv。
3. **receipt 是本地的**：有任意用户权限 bash 的对手同样可改写 `.safety-integrity.json` 匹配其篡改。doctor 是**检出**不是证明；对「rm/rename payload 文件」门会 fail-closed 于 import（破坏而非解除），改写门是把它换掉——两种形态层 3 都能抓（missing/changed），除非 receipt 同步伪造。
4. **无本地完全闭合**：对任意用户权限 bash，一切本地文件皆可写——纯本地机制没有完全闭合。逃逸成本已从「跑一条 echo」抬到「craft 一个过金丝雀的模块 **且** 绕过路径门自身的文本残余 **且** 同步伪造 receipt」。完全闭合方向（带外）：只读安装位置、签名 payload、或由 agent 写不到的进程执行校验。
5. 既有披露不变量不变：变量间接动词、script-file 载体（`bash /tmp/x.sh`）、非 devkit MCP 工具、无 hook 面 harness 的 TTY-only 残余。

## 验收记录（exit code 直接落盘，不经管道）

| #   | 验收项                                            | 命令                                                                                                                         | exit        | 备注                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a  | 层 1 形状覆盖电池                                 | `node --test test/safety-protected-payload.test.ts`                                                                          | 0           | 6/6（含 25 deny / 19 allow / 方向钉专测）                                                                                                                                                                                                                   |
| 1b  | 既有全量判定零回归                                | `node --test test/hook-node.test.ts test/hook-python.test.ts test/hook-parity.test.ts test/opencode-permission-seam.test.ts` | 0           | 72/72                                                                                                                                                                                                                                                       |
| 2   | canary 单测                                       | `node --test test/opencode-safety-gate.test.ts test/hook-node.test.ts`                                                       | 0           | 适配器 impostor/noExport/throwing deny + 正常模块行为不变（20+42 绿）                                                                                                                                                                                       |
| 3a  | doctor 全周期                                     | `node --test test/doctor-integrity.test.ts`                                                                                  | 0           | 5/5：PASS/篡改 FAIL+文案/无 receipt WARN/heal                                                                                                                                                                                                               |
| 3b  | golden 重生成                                     | `node scripts/doctor-golden.mjs --regen` + `node --test test/doctor-golden.test.ts`                                          | 0/0         | diff 仅 `golden-b` 一行新 PASS + 计数 14→15                                                                                                                                                                                                                 |
| 4   | **live 门**（`/tmp/opencode/hookgate-int-live/`） | `bash run-int-live.sh`                                                                                                       | 0           | **disarm 攻击在 echo 命令本身被 deny**（reason 逐字回传模型）；tee 变体 deny；良性 echo 不受扰；`ls` 分类器目录放行（读形合法）；hcloud 写 deny 回归；`classifier-hash-before == after`（部署分类器字节全程未变）；install 输出带 `Integrity receipt ->` 行 |
| 5a  | build / typecheck / validate                      | `npm run build` / `npm run typecheck` / `npm run validate`                                                                   | 0/0/0       | 30 skills / KooCLI 7.3.12 / 35 模块含 zod-free guard 新条目                                                                                                                                                                                                 |
| 5b  | lint / lint:md / format:check / lint:dup          | `npm run lint` 等                                                                                                            | 0×4         | 0 error（87 条基线告警不变）；lint:dup `--fail-on-new-clones 0` 209 clones 0 新增                                                                                                                                                                           |
| 5c  | 全量 `npm test`                                   | `npm test`                                                                                                                   | 1           | 2832/2828 pass，2 fail **仅为基线豁免的 real-agents 环境对**（opencode 握手子测试 + 其父测试，G1 起归档的同机环境项），无新增失败                                                                                                                           |
| 6   | 变异自证                                          | 判定删 → 电池红；canary 删 → 金丝雀测红；doctor 段删 → 全周期测红                                                            | 1→还原 0 ×3 | 层 1：3 测红（`/tmp/opencode/int-mutation-red.log`）；层 2 适配器：7 红；层 2 `.mjs`：1 红；层 3：1 红。全部还原后绿                                                                                                                                        |

## 纪律自查

- 未弱化任何既有 deny：词表纯增量，唯一 verdict 变化是一条 allow→deny 的**收紧**（parity 504 行，上文记录）。
- 未为绿灯改断言语义：corrupt-rules 测试的 reason 随归因升级更新（classify-failed → self-check），断言的是同一致败方向 + 更准确的归因。
- 只在本 worktree；未 push 未 merge；BRIEF 保持未跟踪。
- 基础设施：npm install（本 worktree 无 node_modules）+ 两次 build 后全程各门复跑。

## 提交清单

```
894f2af0 docs(safety): the integrity model across the residual disclosure, changelog, rule model, and agent bible — the honest ceiling stated
0e13d02f style: prettier sweep for the pre-existing format debt on this base
586d82dc style(safety): prettier for the integrity unit's own additions
fe220500 feat(doctor): deployed-payload integrity receipt and drift check — the offline half of the classifier-rewrite residual
956a045a feat(safety): load-time behavior canaries in the opencode adapter and the .mjs hook — refuse a shaped-but-wrong classifier
d774c805 feat(safety): payload path-write deny — the bash-face half of the classifier-rewrite residual
```

（prettier sweep 单列一 commit：本基线自带 next.4 的格式债，ci-baseline 单元在其自己的分支上已修；此处需要格式化树才能再生 jscpd baseline——指纹空白敏感。）

## Follow-up（记录，本单元不做）

1. **带外校验方向**（天花板 4 的正解）：只读安装位置 / 签名 payload / agent 写不到的进程做校验——架构级，需安装布局变更，超出本单元。
2. **路径门形状表扩展**：`cp -t`、`timeout` 包裹、`truncate`/`ln`/`install -D` 等可按需增量（词表机制就位，只是形状枚举的成本/收益权衡）。
3. **`.py` 宿主面（Hermes）**：`huaweicloud-safety.py` 的 `evaluate()` 已消费层 1；层 2 金丝雀在 py 面是宿主加载时机问题（importlib 逐次加载，可在模块加载后、`evaluate` 首调前加同三查）——本单元按 brief 范围只做了 `.mjs` 与适配器，py 面金丝雀记此待办。
4. real-agents opencode 握手环境项（G1 起归档）持续，与本单元无关。

## 结束语

bash 面的「一条 echo 解除整个门」已关死：写入命令本身被共享分类器拒绝，损坏的模块在载入期被拒，落地的漂移被 doctor 检出——对本地对手的逃逸成本从一条命令抬到「伪造三件套」。剩下的天花板（crafted 模块、本地 receipt 同步伪造）没有本地解，带外校验是正解，已如实写在每一层披露里。
