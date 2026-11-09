# 未知服务三分:unknown_read 的运行时目录查证设计

日期:2026-11-06
状态:已实施(dev_feats 工作树,叠加于 `1a93591c`)
关联:2026-11-05 UX 执行报告 #8 / 《部分受限深度解析报告》D6、OBS-14(#564)、1a93591c 的 P0-B advisory warn

## 背景:fail-open 是裁决,不是疏忽

护栏对未知操作(`hcloud FooBar BazQux`)的直接放行,源流是三层事实:

1. **分层 fail-open 是成文裁决**(2026-09-20《能力包×三层安全模型集成设计》1.4 节):hook 的立身之本是"堵已知高危路径";对一切未知 fail-closed 会拦死用户的无关工作负载,插件会被卸载,三层模型失效。宿主 permission 系统是第一道闸,hook 只对华为域 + 已装 pack 域负责。
2. **词表是危险词表**:`writeOperationPrefixes` 列危险、放行其余;安全全集(200+ 服务的全部读操作)不可枚举。形状泛化已被语料两轮证伪(policy.ts:round 3 `Result(s)` 后缀正则被 5 个真写击破;round 4 泛化释放了 112 个 POST)。
3. **执行面 allow 是 P0-B 有意保留**:deny-only `assertAllowed` 门上升级 warn/deny 会杀死合法未知读(seat4 实跑证实),1a93591c 只在 advisory 面(hook_check_command)加了 `hwc-unknown-operation` warn。

残余风险随之明确:词表外的**真写**(Register/Restore 类,seat4 实证)在执行面按 read-only 直通,免审批。词表 ratchet 补词是存量收敛,架构上无固定点——这正是"正则/词表启发式面对开放式输入无固定点"的结构性局限在词表层的形态。

## 本设计:用本地目录补上"证据分级"

KooCLI 本地目录(`~/.hcloud/metaRepo/services_{cn,en}.json`,只含服务名,`readServiceCatalogs` 已有 TTL 缓存读取缝)能回答词表不能回答的问题:**这个服务名存在吗**。据此把 unknown_read 三分(实为四态):

| 证据态               | 判据                        | plan 面(planHcloudCommand)                                               | run 面(继承 assertAllowed)                               | advisory 面(hook_check_command)                     |
| -------------------- | --------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------- |
| **负证据**           | cn+en 双目录在场,服务都不在 | classification 改判 **deny/invalid**,warnings 附目录提示,safeToRun=false | **deny**(spawn 被抢占;反正执行必败,零成本收口"生人放行") | `hwc-unknown-service` warn,文案点名服务名           |
| **部分证据**         | cn 有 en 无                 | allow + warning 附 `--cli-lang=cn` 指引                                  | allow                                                    | `hwc-unknown-operation` warn,remediation 带 cn 指引 |
| **正证据、无法定性** | 服务真实,操作未被词表认识   | allow,无 triage 噪声                                                     | allow(P0-B 决议不变)                                     | `hwc-unknown-operation` warn,原文案                 |
| **无证据**           | 任一目录文件缺失            | allow,无 triage 噪声                                                     | allow                                                    | `hwc-unknown-operation` warn,原文案                 |

认识论边界一句话:**负证据收紧,无证据维持,正证据但无法定性则维持现状**。词表清空→加载即 throw(守卫自身损坏,fail-closed)与目录缺失→放行(环境无数据,非守卫损坏)的分野由此而来,与 1.4 的域辖哲学同源。

## 实现

- **`src/hcloud-triage.ts`**(新,src 根级):`triageUnknownService(service, metaDir?)` 唯一逻辑点,判别联合四态,非法状态不可表示。**刻意不进 `src/safety/`**——hook 图(hook mjs import `dist/safety-policy.js`)与 py 孪生保持词表-only,hook 的 deny-only 契约零接触。结构守卫钉住这条线(`structure-safety.test.ts`:safety 家族不得 import `hcloud-*`)。
- **`src/hcloud-plan.ts`**(唯一执行侧 seam):unknown_read + 目录负证据 → classification 改判 deny。run 面**零改动**继承(`runHcloud` 的 `assertAllowed(plan.classification)`),plan/run 对同一命令永不分歧(#6"同一份有效参数"教训:一个事实一个 seam)。审批令牌照常铸造——plan 面已告知,烧令牌于必败审批是文档化代价。
- **`src/tools.ts`** `withUnknownOperationWarn`:四态 finding + **catch→warn 收口**(分类器抛异常不再静默回退 allow——OBS-14 #564 同型残余,advisory 面按其契约取 warn;`classify` 参数可注入,收口行为可诚实钉测)。
- **共享文案**:`CN_LANG_SWITCH_HINT` 从 `appendLangHint` 提取为导出常量,run 注解与 triage 不漂移。
- **`HCLOUD_META_DIR`**:测试注入通道(镜像 `HCLOUD_BIN` 学说);**永不作为工具参数**暴露——agent 可控的目录路径等于让它伪造证据给自己减刑。

## 行为变化声明

装有完整双目录 metaRepo 的机器上,`FooBar` 类命令从 advisory warn 收紧为 **run 面 deny**(spawn 抢占)。`koocli-lang-gate.test.ts` 的 not-found 用例按新契约改写;`hcloud-cli-run.test.ts` 三个以假服务名测管道行为的用例钉上空 metaDir。stale 目录误杀由 remediation 自愈(`hcloud upgrade` / `--help` 判别)。

## Preserve / Change / Avoid / Risk

- **Preserve**:三层模型与域辖哲学;守卫失明/损坏即 fail-closed 的全部现有边界;deny-opaque 转向;advisory/执行面分工;`EXACT list, nothing shape-based` 语料裁决;hook 图纯度(本轮以结构守卫固化)。
- **Change(后续可选)**:操作级查证——`hcloud <Svc> --help` spawn 解析操作清单。**暂缓**:目录无读写语义,解决不了真写漏网;真实服务上编造的操作执行必败;spawn 复杂度(HCLOUD_BIN/代理/Windows/缓存)与收益不成比例。
- **Avoid**:形状泛化词表;PreToolUse hook 面加 warn(宿主 decision 契约只有 allow/deny);执行面对 operation-unknown 升 deny;metaDir 进工具参数。
- **Risk(明示残余)**:目录双全时的负证据只覆盖**服务名**;真实服务上词表外的真写(未来 `Snapshot*`/`Purge*` 型动词)仍按 unknown_read 直通——这是词表架构的边界,由 advisory warn + 语料 ratchet 兜底,彻底收敛需操作级语义源(KooCLI 目录不含),即"换架构"的既判边界之外再无免费午餐。

## 证据链

1.4 分层 fail-open 裁决(2026-09-20 会话存档)→ UX 报告 #8/D6(2026-11-05,`hcloud FooBar BazQux` → allow)→ P0-B advisory warn + 写词表补六词(1a93591c,2026-11-06)→ 本轮目录三分 + OBS-14 同型 catch-allow 收口(本工作树)。
