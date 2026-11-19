# CI 基线债修复报告（hookgate-ci-baseline）

基线：`origin/v2`（`17670943`，next.4 发布 bump），基线红 run `44255880996`。
本 worktree 三个 commit，直线历史，未 push、未 merge。**全部改动都在测试 / format / 依赖面，零产品行为变更。**

| commit     | 族                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `ae6f9323` | fix(ci): prettier sweep for the next.4 release-bump format debt                                |
| `9a846a49` | fix(ci): cross-version test fixes for the node22 floor and the windows lanes                   |
| `fae8b70a` | fix(ci): clear the security job — inline-allow the two synthetic test keys, in-range audit fix |

---

## 族 1 — format：发布 bump 的 prettier 债

**根因。** `17670943` 手写五个插件 manifest 并携带 devbridge/sandbox 编辑，从未过 prettier。基线上 `npm run format:check` 红 10 个文件：brief 预言的 9 个（5 个 manifest、`huawei-sandbox/SKILL.md`、`devbridge-cleanup.ts`、`test/devbridge-cleanup.test.ts`、`test/structure-sandbox-resource-pool.test.ts`）加未跟踪的 `BRIEF-ci-baseline.md` 本身。

**修法。** `npm run format` 全仓 sweep，只提交 9 个已跟踪文件（BRIEF 留在未跟踪态）。纯重排，零语义。

**验收。** `npm run format:check` → **exit 0**（终态树复验通过）。

---

## 族 2 — security：红的真源是 gitleaks，不是 dev 审计

**根因（修正 brief 的归属）。** security job 里阻断性步骤是 `npm audit --audit-level=high --omit=dev`（生产依赖），基线上它 **found 0 vulnerabilities**；全量 dev 审计那步是 `continue-on-error: true`（设计如此）。基线 run 真正红的是 **gitleaks 8.24.0 扫出 2 个 secret**，都是 `17670943` 引入的合成测试夹具：

- `test/e2e/approvals-watcher.ts:34` — `E2E_VAULT_MASTER_KEY`（base64 的 32 字节，文件内注释本就声明 pinned、public）
- `test/approval-gate.test.ts:2703` — 脱敏表里的 hex token 夹具 `a1b2c3d4e5f67890`

**修法与取舍（brief 的二选一）。** 选 (a) 修因，未用 (b) 抑制：

- **dev 依赖审计**：`npm audit fix` 走 **in-range 升级**（markdownlint、@eslint/config-array、typescript-estree 一族的修复版本全部在 caret 区间内），**lockfile-only、package.json 零变更、无 major 跳版**。brief 担心的大面积 churn 没有发生——升级后 `lint`/`typecheck`/全量测试均绿，无需任何 workflow 门槛调整。本地审计面从 17 条（2 low / 12 moderate / 3 high；CI 当日为 23 条）降到 4 low，`npm audit --audit-level=high` 由此 exit 0。
- **gitleaks**：对两个夹具行加行级 `// gitleaks:allow` 内联豁免，理由写在标记行。不用路径级 allowlist（会削弱对未来 test 文件的扫描），不关 job。

**验收（workflow 原命令的本地等价，gitleaks 用 CI 同版 8.24.0 二进制）**

| 命令                                                                         | exit                             |
| ---------------------------------------------------------------------------- | -------------------------------- |
| `npm audit --audit-level=high --omit=dev`                                    | **0**（found 0 vulnerabilities） |
| `npm audit --audit-level=high`                                               | **0**（剩 4 low，低于阈值）      |
| `gitleaks detect --source . --no-git`（终态树；即 CI depth-1 checkout 所见） | **0**                            |
| `gitleaks detect --source . --log-opts="--max-count=1"`                      | **0**                            |

**如实披露。** 深历史全量扫描（本 worktree 是深克隆）仍有 20 条命中，全部位于**历史 commit 的 diff** 里、当前树中已不存在的值（`--no-git` 为 0 即证）。CI 的 depth-1 checkout 构造不出这个扫描面，因此不构成 CI 红；为历史 suppress 会引入路径级 allowlist，不做。

---

## 族 3a — node22 floor：三个具体 API 面差异，非 V8 时序

**根因（修正 brief 的两个归属）。** 基线 node22 车道红的是**两条失败线**，brief 只点名了其一，且根因假设（Error cause/prototype 快照语义）不成立：

1. **`test/hdkit-fold-safety.test.ts` 整文件挂**（链接期 SyntaxError）。真因：该文件用 `mock.module(spec, { exports: {...} })` 键，而 **node 22.19 的实现忽略 `exports` 键、铸出空命名空间**（本地最小复现：mock 后 `Object.keys(mod)` 为 `[]`；node 26 同代码为 `["createConnection","getCredentials"]`）。消费方 `hdkitservice-api.ts` 链接期即 `does not provide an export named 'getCredentials'`。其余五个测试文件全用 `namedExports` 键（22/26 双收），所以只有本文件挂。
2. **`test/hdkit-gate-retry.test.ts` 的 engine error-family 测试**（brief 误记在 fold-safety 文件）挂 `ReferenceError: SuppressedError is not defined`。真因：`SuppressedError` 是 22.x 之后才有的全局，测试直写 `SuppressedError.prototype`。
3. **修 1 后暴露**：node 22 的 runner 会在模块体暂停于顶层 `await import` 的间隙开跑已注册的 test，handler 折叠的 setup 块在文件后部，四个用例撞 `handleConnect` 的 TDZ（`Cannot access 'handleConnect' before initialization`）。node 24+ 等模块体求值完才开始跑，所以只有 22 红。

**修法（跨版本等价，零产品代码变更）。**

- 两处 `mock.module` 改 `namedExports` 键，删掉双重断言桥接（26 上 namedExports 只有弃用告警，22.19 上它是唯一可用键；地板抬过 22 后可全仓一次性换键——文件内注释已记）。
- 已知家族名单只点名引擎实际持有的家族：`typeof SuppressedError !== 'undefined'` 才入列；未来引擎补齐后，钉侧的结构化枚举扫描自动覆盖，不靠名单。
- handler setup 块上移到所有 test 注册之前，顺序约束写在块注释。

**验收。**

| 命令                                                                                                                       | exit                                                       |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `npx -p node@22.19 node --experimental-test-module-mocks --test test/hdkit-fold-safety.test.ts`（brief 验收第 3 条原命令） | **0**，29/29                                               |
| 同命令跑 `test/hdkit-gate-retry.test.ts`（node 22.19）                                                                     | **0**，190/190                                             |
| 两文件 node 26 回归                                                                                                        | **0**，29/29 与 190/190                                    |
| **node 22.19 全量 `npm test`**（floor 车道全形状）                                                                         | exit 1，2791/2795 pass，2 fail 仅为下述既有 real-agents 对 |

---

## 族 3b — windows：8 个测试，5 类环境语义根因

全部根因从基线 run 的逐字错误签名定位（`✖` 行 + 断言 diff），逐个：

1. **`an oversized JSON ... 512MB budget`（gate-retry）**：子进程 spawn 用 `driver.pathname`，win32 上是 `/D:/...`（前导斜杠+盘符），子进程 `Cannot find module`。改 `fileURLToPath(driver)`。
2. **`ask mode: run without the attestation ...`（hcloud-cli-approval:781）**：期望 `ASK_CONFIRMATION_REQUIRED`，实得 `SPAWN_ERROR`。真因：用例复用了先行 ritual 用例的同一 args；win32 上 POSIX-only 的假 bin spawn 不可投递 → 按设计（S1 retry memo：uncertain/failed 续装、delivered 清除）memo 续装 → 下一**逐字节相同**的未证到达合法复用 consent 而不再询问。已在 Linux 用"存在但不可执行"的 HCLOUD_BIN 精确复现同链路（PRIME→RUN=SPAWN_ERROR→AFTER=SPAWN_ERROR）。产品按设计工作，测试隔离缺陷：改用独占 args 钉住"新鲜到达必问"这一真正主语。
3. **`预检查询与子进程共享 npm 认证与镜像归一`**：挂点在 `env.PATH` 断言——win32 保留 env 键首见大小写（`Path`），POSIX 拼写直查落空。改大小写不敏感读回，断言语义不变。同用例的大小写变体凭证拼写段移出（见 skip 清单）。
4. **`npmrc 级联与 npm 的表单语义`**：`~/.npmrc` 兜底走 `homedir()`，win32 读 `USERPROFILE` 不读测试钉的 `HOME`。测试在 win32 加钉 `USERPROFILE`（产品按仓库既定平台 home 约定工作，不改产品）。
5. **`devkit 镜像未设时保留操作者的 npm_config_registry` 与 `纯空白的 exact-case 值按未设处理`**：`withEnv` 顺序应用批内键，win32 env 大小写不敏感——`npm_config_registry: mirror` 后随 `NPM_CONFIG_REGISTRY: undefined` 把同一变量删掉。`withEnv` 在 win32 把批内大小写碰撞键折叠（已定义值胜过变体拼写 delete；POSIX 保持原顺序）。折叠语义对全部调用点做了穷举核对 + 纯函数 scratch 验证。

**Windows skip 清单（2 个，均带理由注释，无静默跳）。**

| 测试                                                                                  | skip 理由                                                                                                          |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `upgradePackage 升级子进程: 重复的大小写拼写折叠到一条通道`（从"预检查询"用例中拆出） | win32 env 大小写不敏感：NPM_TOKEN 与 npm_token 是同一个变量，"两种拼写携带不同值共存"这一输入状态在 win32 无法构造 |
| `upgradePackage 升级子进程: devkit 镜像的大小写拼写收敛到一个通道`                    | 同上：exact-case 与变体拼写共存的输入状态在 win32 无法构造                                                         |

**验收（本地可模拟面）。** 四个被改文件在 Linux node 26 与 node 22.19 双绿：fold-safety 29/29、gate-retry 190/190、hcloud-cli-approval 35/35、update-check-upgrade 360/360。真 win32 车道的最终证明由 CI 出（本地无 win32）。

---

## 全量验收矩阵（终态树，exit code 直接落盘）

| BRIEF 验收项                                                                   | 结果                                                                                      |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 1. `npm run format:check`                                                      | **0**                                                                                     |
| 2. security 本地等价（prod audit / full audit / gitleaks 树扫 / 单 commit 扫） | **0 / 0 / 0 / 0**                                                                         |
| 3. node22.19 下 fold-safety 复现消失                                           | **0**，29/29                                                                              |
| 4. `npm test`（node 26）                                                       | exit 1 — 2791 pass，2 fail **全部为既有 real-agents 对**（见下）                          |
| 5. windows 族本地可模拟面                                                      | 4 文件双引擎绿；不可模拟面已加带理由 skip ×2                                              |
| 6. `npm run build` / `typecheck` / `validate` / `lint`                         | **0 / 0 / 0 / 0**                                                                         |
| 加项：CI 的 lint:dup 门（`--fail-on-new-clones 0 --fail-on-empty`）            | **0**（基线指纹 +2，均为 AGENTS.md 认可的"搬移未删/测试有意重复"类，format 后按规程再生） |

**`npm test` exit 1 的如实说明。** 唯二失败是 `test/real-agents.test.ts` 的 real opencode 生命周期对（`real opencode: install -> agent view -> uninstall` 及其子测 `agent view: live MCP handshake...`），断言同为 `mcp list must show huaweicloud-devkit connected`。A/B 证据：**在干净基线 `17670943` 上逐字同样 2 挂**（node 26，8/10 pass）；本文件 CI 从不跑（`DEVKIT_REAL_AGENT_TESTS=1` 门控，基线红 run 的失败清单里没有它），属本机既有环境条件，非本单元回归。其余 2791 个测试 node 26 与 node 22.19 全绿。

---

## 与 brief 的出入（证据修正）

1. "every engine error-family prototype" 测试在 `hdkit-gate-retry.test.ts:4403`，不在 fold-safety 文件。
2. node22 根因不是 Error cause/prototype 快照语义，是三个具体 API 面差异（mock.module 键、SuppressedError 全局、runner 启动时机），且 fold-safety 是**整文件**挂（链接期死），不止一个用例。
3. security job 的红源是 gitleaks 两夹具，不是 dev 审计（阻断性 prod audit 基线即为 0；dev 审计步骤设计上不阻断）。
4. 协调者看到的"n22 后台 run 中途死掉"是会话冻结的假象：该 run 与会话一起被冻结，恢复后续跑完成，`NPMTEST_N22=1` 落盘在日志尾，2791/2795 pass。真 Windows 无本地复现环境，8 个失败的根因均以基线 run 的逐字错误签名 + Linux 等价机制复现定位。

## 结束语

基线三族 CI 债已修绿，三个 commit 直线历史待协调者验收后走正常 PR 流程；`npm test` 的 exit 1 为既有 real-agents 本机条件（基线同挂、CI 不跑），其余全量门在本机与 node22.19 floor 形状下全绿。真 win32 车道由 CI 终判。

---

## 追加 — windows 残余 2 例定点修复（#23 第二轮，run `44498912057`）

背景：#23 首轮 CI 中六个 windows 修复全部生效（windows 从基线 8 失败收敛到 2）。本轮一个 commit（`01ac4bb3`），只动两个测试面，未碰产品。

### 残余 1 — `an oversized JSON ... 512MB budget`：断裂点在驱动器内部，不在 spawn 实参

**根因（对 brief 假设的修正）。** protocol `'d:'` 的 `ERR_UNSUPPORTED_ESM_URL_SCHEME` 是 ESM **说明符**层错误。上轮的 `fileURLToPath(driver)` 让子进程主模块入口在 win32 上正常加载（CI 日志的错误发生在驱动器开始执行之后）——入口没问题。真正的断裂在 `test/fixtures/oversize-json-driver.mjs` 内部：驱动器用 `fileURLToPath` 算出裸路径再拼 `${ROOT}/plugins/...` 作 **`import()` 说明符**。win32 的 ESM loader 把 `D:\...` 说明符按 URL 解析（protocol `'d:'`）直接拒。POSIX 上裸绝对路径说明符恰好等于 `file:///` URL 所以一直绿。

**修法。** 驱动器内部两个 `import()` 改为 `new URL('../../plugins/...', import.meta.url).href`（file:// URL 说明符——双平台唯一同合法形态），顺带删掉只为拼路径存在的 `ROOT`/`fileURLToPath`。spawn 实参保持 `fileURLToPath(driver)`：**实测证据**——传 URL 串在本机 node 26 上被入口层当路径解析而挂（`Cannot find module '.../file:/...'`），裸路径在入口层是双平台合法形态。brief 的「传 href」处方对入口不成立，已在代码注释与本节记录实测依据。

**本地验收。** 512MB 单测 node 26 与 node 22.19 双绿；驱动器内不再存在任何裸路径说明符（构造上杜绝 win32 复发）。

### 残余 2 — `npmrc 级联`：`envReplace is exact-name only` 断的是 POSIX env 层性质

**根因（对 brief 两个假设的双排除）。** 其一排除：该用例走 `withSavedEnv`（CI 栈帧 :392），与上轮改的 `withEnv` 折叠语义无涉。其二排除：夹具无 `HOME`/`home` 类双拼写冲突。真因：断言的主语「变体拼写不得解析」依赖 `env[name]` **大小写敏感**——这是 POSIX env 层的性质。win32 的 `process.env` 代理大小写不敏感，`nexus_token` 即 `NEXUS_TOKEN`，「只设变体、未设精确名」这一输入状态在 win32 上**不存在**。产品 `envReplace`（src/update-registry.ts:210）与 npm 同为直查 `env[name]`，win32 上解析变体就是平台可观察真值（npm 在 win32 行为相同）。

**修法。** 断言改为按平台断各自真值（期望值 `isWin`）：POSIX 保持 exact-name-only 原语义；win32 断大小写不敏感解析（npm parity），理由注释在断言处。产品零变更——exact-name 语义按仓库既有契约是对的，它只在 POSIX env 层可成立。首版编辑曾把期望值写成 `!isWin`（布尔反了，Linux 本地即刻抓红），已在验收前修正——顺带说明本轮验收确实跑过这条断言的 Linux 侧。

**残余面复查。** 该用例 fail-fast 于首个断言，:3424 之后还有约 150 行未在 win32 执行过的子场景。已逐段过读：后续全部是 `join()`/chdir 的 workspace-glob 与 nerf-walk 场景，无大小写变体 env 拼写、无裸路径说明符、无 POSIX-only 语义；其中的「last userconfig spelling wins」顺序对在 win32 上退化为 OS 自身的 last-write-wins，与两断言的期望恰好一致。

### 第二轮验收矩阵（exit code 落盘）

| 验收项                                                                                       | 结果                                                                                              |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `npx -p node@26 node --test test/hdkit-gate-retry.test.ts test/update-check-upgrade.test.ts` | **0**（550/550）                                                                                  |
| `npx -p node@22.19 node --test` 同两文件                                                     | **0**（550/550）                                                                                  |
| `lint:js` / `typecheck` / prettier / `lint:dup`（CI 参数）                                   | **0** / **0** / **0** / **0**                                                                     |
| `npm run lint:md`（跟踪树）                                                                  | **0**（134 文件 0 issue；唯一 MD018 命中是协调者未跟踪的 BRIEF 文件自身 `#23` 标题写法，不进 CI） |
| `npm test`（node 26）                                                                        | exit 1 —— 仅既有 real-agents 环境对（2791 pass，与基线 A/B 相同签名）                             |
| 真 win32 双车道终判                                                                          | 由 CI 出（协调者 push 后重跑 PR）                                                                 |

### 追加 — 第三轮：最后一例 `an empty last userconfig spelling is skipped`（:3703）

512MB 修复在 #23 新 run 落地后，windows 仅剩此例。根因与 round-1 两条 skip 同类：该子景**直接在 process.env 上**先设 `npm_config_userconfig`（customConfig）再设 `NPM_CONFIG_USERCONFIG = ''`——win32 的 env 大小写不敏感，两个拼写是同一个变量，第二次赋值覆写第一次，「设值兄长 + 空值末位拼写」的输入状态不可构造，塌缩成「单一空值」→ userconfig 通道退到无令牌的 homeNpmrc → success false ≠ true。

**prefix 兄弟（:3695）的裁决：一并跳过（实证，非推测）。** 塌缩态在 Linux 上复现：prefix 单一空值 + userconfig 令牌在 → success true（通过）；抽走 userconfig 令牌 → false。即 win32 上该断言的绿是 userconfig 通道的旁路绝缘，不验证「空末位拼写不遮蔽」这一主语——按协调者的诚实标准并入同一平台跳过。

**修法。** 两景并入 `if (!isWin)` 守卫，理由注释同 round-1 skip 同风格；POSIX 分支逐字节不变。win32 侧 else 分支等价补齐下一条 `uppercase globalconfig channel is honored`（单拼写、win32 可构造）的前置（prefix/etc/npmrc 令牌文件、无令牌版 homeNpmrc、清 userconfig 通道），使它在 win32 上保持与 POSIX 同前置的**有义**验证，而非继承旁路绝缘的空过。

**第三轮验收（exit code 落盘）**：两文件 node 26 → 0（550/550）；node 22.19 → 0（550/550）；`npm run lint` 全量 → 0；prettier/typecheck/lint:dup（CI 参数）→ 0/0/0。真 win32 终判由 CI 出。
