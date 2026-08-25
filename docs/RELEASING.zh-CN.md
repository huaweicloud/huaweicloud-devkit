# 版本管理与发布计划

本文档定义 `huaweicloud-devkit` 的版本号规则、变更与版本号升级的对应关系，
以及版本如何发布到 npm。它是所有发布决策的唯一依据。

## 1. 语义化版本号（SemVer）

所有版本遵循 [SemVer](https://semver.org)：`主版本.次版本.修订号`。

| 位置    | 名称                | 含义             | 何时 +1                                                              |
| ------- | ------------------- | ---------------- | -------------------------------------------------------------------- |
| 第 1 位 | **主版本（major）** | 破坏性变更       | 升级后现有用户会坏：工具被删除或改名、工作流行为不兼容、接口契约变化 |
| 第 2 位 | **次版本（minor）** | 向后兼容的新功能 | 新增能力，现有行为照常工作                                           |
| 第 3 位 | **修订号（patch）** | 向后兼容的修复   | 修 bug、文档、内部重构，对外无可见变化                               |

**一句话判断标准**：升级之后，现有用户的流程会不会坏？
会坏 → major；不会坏且新增能力 → minor；不会坏只是修复 → patch。

### 1.1 预发布版本（prerelease）

版本号带连字符后缀的就是预发布版本：

```
1.1.0            ← 稳定版（stable，挂在 latest 标签上）
1.1.0-next.0     ← 预发布（挂在 next 标签上）
1.1.0-next.1     ← 同一个未来 1.1.0 的下一次测试迭代
```

三位数字永远承诺**这个预发布所测试的未来稳定版**。`1.1.0-next.0` 的含义是
"未来 stable 1.1.0 的第 0 个测试构建"。后缀计数只表示同一个版本的测试迭代次数。

SemVer 排序规则：同数字下，稳定版大于任何预发布版。

```
1.1.0  >  1.1.0-next.1  >  1.1.0-next.0  >  1.0.2
```

挂在 `next` 标签上的预发布版本**永远不会**被普通的
`npm install huaweicloud-devkit` 装到，必须显式写 `@next`。

### 1.2 历史遗留：`1.0.2-dev.*`

注册表上的 `1.0.2-dev.0` 到 `1.0.2-dev.9` 是**悬空的预发布版本**。它们由已
退役的 `publish-dev` 工作流通过 `npm version prerelease --preid=dev` 生成，
承诺了一个从未发布的 stable `1.0.2`。这些版本已废弃，**不要再延续
`-dev.*` 这条线**。所有新的预发布一律使用 `X.Y.Z-next.N` 格式（见第 4 节）。

## 2. 变更与版本号的对应关系

| 变更类型                  | 本仓库实例                                                   | 结果              |
| ------------------------- | ------------------------------------------------------------ | ----------------- |
| 删除/改名工具或破坏工作流 | `refactor(sandbox): remove huaweicloud_sandbox_release tool` | **major** → 2.0.0 |
| 新增能力                  | `feat(routing): offer deployment targets with sandbox first` | **minor** → 1.1.0 |
| 修 bug、文档、内部重构    | `fix(install-hcloud): append+dedupe user PATH`               | **patch** → 1.0.2 |
| 无可见变化                | `docs:`、`chore:`、`test:`                                   | 不升版本          |

本仓库已使用的 commit 消息规范决定版本升级：

| Commit 写法                               | 版本变化 |
| ----------------------------------------- | -------- |
| `fix: ...`                                | patch    |
| `feat: ...`                               | minor    |
| `feat!: ...` 或带 `BREAKING CHANGE:` 脚注 | major    |

## 3. 发布频道（npm dist-tags）

| 标签     | 指向                      | 受众                 |
| -------- | ------------------------- | -------------------- |
| `latest` | 最新稳定版                | 所有用户（默认安装） |
| `next`   | 最新预发布 `X.Y.Z-next.N` | 尝鲜用户与公开预览   |

规则：

- `latest` 只接收稳定版。
- `next` 只接收某个未来稳定版的 `X.Y.Z-next.N` 预发布。
- 对应的稳定版发布后，`next` 线重置。

## 4. 预发布流程（当前，手动）

在 release-please 上线（第 6 节）之前，预发布采用手动方式。

**前提**：版本号升级决策。发预发布就是承诺一个未来的稳定版号：
`1.1.0-next.0` 即承诺 stable 会是 `1.1.0`。

步骤：

1. 确定未来的稳定版号，例如 `1.1.0`。
2. 本地升版本，不提交：

   ```powershell
   npm version 1.1.0-next.0 --no-git-tag-version
   ```

3. 同步全部插件清单（四个都要，包括 workbuddy）：

   ```powershell
   node ./scripts/sync-version.mjs
   npm run validate
   ```

4. 跑测试：`npm test`。
5. 发布到 `next` 标签：

   ```powershell
   npm publish --tag next
   ```

6. 把 `package.json` 复原为稳定版本号，只提交与版本无关的改动
   （仓库绝不能与已发布内容脱节）：

   ```powershell
   npm version <上一个稳定版号> --no-git-tag-version
   ```

7. 公告 `1.1.0-next.N` 及其变更清单；按版本号归档测试反馈。

后续迭代依次使用 `1.1.0-next.1`、`1.1.0-next.2`……

## 5. 内部测试政策

`next` 是**公开**频道：任何人都能装到。不要把它当作内部迭代循环
（这正是 `-dev.*` 版本泛滥的原因）。

| 场景                       | 使用方式                                |
| -------------------------- | --------------------------------------- |
| 单人开发、快速本地验证     | `npm pack` + 本地安装，不发 npm         |
| 小团队（≤ 5 人）、临时分发 | `npm pack` 生成 `.tgz` 分享，从文件安装 |
| 较大团队或标准化分发       | 发 `next` 预发布                        |
| 面向外部用户的公开预览     | 发 `next` 预发布                        |

预发布频率：每周最多 1~2 次，且必须先通过 `npm test` 和 `npm run validate`。

## 6. 发布计划（分阶段）

### 阶段 0 —— 基线对齐与清理

1. 确定下一个稳定版号并建立预发布线：
   - 推荐：下一个 stable = `1.1.0`；预发布 = `1.1.0-next.N`。
   - 悬空的 `1.0.2-dev.*` 线冻结并废弃（不再延续）。
2. 把 `.workbuddy-plugin/plugin.json` 加入 `scripts/sync-version.mjs` 和
   `scripts/validate-package.mjs`，保证四个插件清单始终同步。
3. 将所有清单对齐到当前基线版本。

### 阶段 1 —— 用 release-please 自动化稳定版发布

- 新增 `release-please-config.json`，配置 `release-type: node` 和
  `extra-files` 覆盖全部四个插件清单（在发布路径上替代 `sync-version.mjs`）。
- 新增 `.release-please-manifest.json`，初始化为当前基线版本。
- 新增 `release-please.yml`（`main` 分支）：根据 conventional commits 计算
  下一个版本号，开启发布 PR，自动更新 `package.json`、四个插件清单和
  `CHANGELOG.md`；合并该 PR 即自动创建 git tag 和 GitHub Release。
  **release-please 只负责定版本和打 tag，不发布 npm。**
- 新增 `publish.yml`（手动触发）：npm 发布的唯一入口，必须从 `v*` tag 上
  手动 dispatch，通过 `npm-publish` environment 审批后发布；`ci.yml` 增加
  `pack` 校验（每个 PR 验证 tarball 完整性 + 真实安装）。
- `cd-production.yml` 不再发布 npm，仅保留生产部署占位。
- 退役手动的 `Publish Release` 与 `Publish Dev` 工作流。

阶段 1 完成后的发布流程：

```
feat/fix 提交 → PR → 合并到 main
  → release-please 开启/更新发布 PR（版本号 + changelog）
  → 维护者合并该 PR
  → 自动打 git tag vX.Y.Z + 创建 GitHub Release（此时 npm 未变）
  → 维护者在 Actions 里对 vX.Y.Z tag 手动触发 Publish（dist-tag=latest）
  → npm-publish environment 审批（审批人 + tag 白名单 v*）
  → npm publish → latest
```

**发布与验证分离。** 每个 PR 的 CI 都执行 `npm pack` 验证（`scripts/pack-verify.mjs`：
检查 tarball 必备文件清单 + 在临时目录真实安装验证），发布前 Publish 工作流
再跑一遍同样的验证，保证"发到 npm 的字节 = 验证过的字节"。

**版本号由团队决定（标题覆盖规则）。** release-please 计算的版本号只是提案，
出现在发布 PR 的标题里（如 `chore: release 1.0.2`）。合并前维护者可以修改
PR 标题来强制指定版本号，合并后即按标题中的版本发布：

```
提案: chore: release 1.0.2
团队决定发 1.1.0 → 标题改为 chore: release 1.1.0 → 合并
团队决定发 2.0.0 → 标题改为 chore: release 2.0.0 → 合并
```

多类 commit 混在时（fix + feat + feat!），提案取最高优先级
（feat! > feat > fix）；如果团队判断实际影响低于提案，用标题覆盖降级即可。

### 阶段 2 —— `next` 频道（预发布）

- 维护一条 `next` 分支；release-please 在该分支运行，自动产出
  `X.Y.Z-next.N` 的发布 PR；合并后只打 tag，不发布。
- 预发布同样走手动 Publish：从 `vX.Y.Z-next.N` tag 触发，`dist-tag=next`。
- `next` 线与即将到来的稳定版保持挂钩：`1.1.0` 发布后，`next` 重置并指向
  下一个版本。

### 阶段 3 —— 清理与固化

- 对全部 `1.0.2-dev.*` 版本执行 `npm deprecate`，消息指向 `@latest`。
- 更新 `validate-package.mjs`：断言四个清单与 `package.json`、
  `.release-please-manifest.json` 一致。
- 将 `scripts/sync-version.mjs` 移出发布路径（仅本地开发需要时保留）。

## 7. 铁律（不可协商）

1. 任何人不得手工修改 `package.json` 的 version 字段。版本号只来自
   release-please 发布 PR：默认接受提案，需要调整时通过修改 PR 标题指定
   （过渡期暂按第 4 节步骤）。
2. 预发布必须宣告它所测试的未来稳定版号。
3. `latest` 永不接收预发布；`next` 永不接收稳定版。
4. 每次发布——稳定版或预发布——必须先通过 `npm test` 和 `npm run validate`。
5. 四个插件清单（codex、claude、cursor、workbuddy）与 `package.json` 版本号
   保持一致。
6. 仓库中的 `package.json` 永远反映最新**稳定版**；预发布版本号只存在于
   发布过程中的瞬时状态。
7. **npm 发布只允许通过 `publish.yml` 从 `v*` tag 手动触发**，且必须经过
   `npm-publish` environment 审批；禁止任何其他自动发布路径。
