# Token 认证（X-Auth-Token）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持华为云 Token（X-Auth-Token）认证——无 AK/SK 时用注入的 token 换临时 AK/SK 走 hcloud，且不破坏现有永久/临时 AK/SK 登录。

**Architecture:** 纯增量。新增 `token-exchange.mjs`（token → IAM 临时 AK/SK 换取 + 内存缓存 + single-flight），`credentials.mjs` 新增两个只读解析函数，`hcloud-cli.mjs` 把 `resolveStsInjectArgs` 异步化并在无 AK/SK 时追加 token 分支，脱敏规则覆盖 token 字段。

**Tech Stack:** Node ≥22 ESM、`node:test` + `node:assert/strict`、`undici`（走 `getProxyDispatcher`）、IAM `POST /v3.0/OS-CREDENTIAL/securitytokens`。

## Global Constraints

- 分支：`codearts_web_test`，不触碰 `dev`。
- **兼容性红线**：永久 AK/SK（`ak`+`sk`）、临时 AK/SK+STS（三元组）、`resolveCredentials` 优先级链、STS 过期检测——行为逐位不变。`resolveStsInjectArgs` 从同步改 async 是允许的签名变化，但各输入下的**返回结果不变**（现有测试仅需补 `await`，断言保持）。
- token 字段：`HW_X_AUTH_TOKEN`；过期字段（可选）：`HW_X_AUTH_TOKEN_EXPIRES_AT`；`duration_seconds` 默认 **900**；IAM 端点默认 `https://iam.myhuaweicloud.com`（`HW_TOKEN_IAM_ENDPOINT` 可覆盖）。
- 错误 code 约定：换取 401/403 → `TOKEN_INVALID`；换取其它非 201 / 网络错误 → `TOKEN_EXCHANGE_FAILED`；token 主动过期 → `TOKEN_EXPIRED`；临时凭证到期且 token 失效 → `CREDENTIAL_EXPIRED`（复用现有）。
- 测试风格：新用例只覆盖「无 AK/SK + 有 token」分支，不与现有用例重叠或改判定。
- 命名/copy：新增错误信息用简体中文 + 英文 `action`，与 `guidance.mjs` 现有 `ERROR_TABLE` 风格一致。

---

### Task 1: `token-exchange.mjs` — `exchangeTokenForCredentials`

**Files:**
- Create: `plugins/huaweicloud-core/src/auth/token-exchange.mjs`
- Test: `test/token-exchange.test.mjs`

**Interfaces:**
- Produces: `exchangeTokenForCredentials(token, options?)` → `Promise<{ ak, sk, securityToken, expiresAt }>`；`options.durationSeconds`（默认 900）、`options.iamEndpoint`、`options.fetchImpl`（测试注入）。

- [ ] **Step 1: 写失败测试**

```js
// test/token-exchange.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { exchangeTokenForCredentials } from '../plugins/huaweicloud-core/src/auth/token-exchange.mjs';

function stubFetch(status, body) {
  return async (url, opts) => ({
    status,
    json: async () => body,
    _url: url,
    _opts: opts,
  });
}

test('exchangeTokenForCredentials returns temporary credential when 201', async () => {
  const response = {
    credential: {
      access: 'TEMP_AK',
      secret: 'TEMP_SK',
      securitytoken: 'TEMP_STS',
      expires_at: '2026-10-20T08:56:33.710000Z',
    },
  };
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { status: 201, json: async () => response };
  };
  const result = await exchangeTokenForCredentials('the-token', { fetchImpl });
  assert.deepEqual(result, {
    ak: 'TEMP_AK',
    sk: 'TEMP_SK',
    securityToken: 'TEMP_STS',
    expiresAt: Date.parse('2026-10-20T08:56:33.710000Z'),
  });
  assert.match(captured.url, /\/v3\.0\/OS-CREDENTIAL\/securitytokens$/);
  const body = JSON.parse(captured.opts.body);
  assert.deepEqual(body.auth.identity.methods, ['token']);
  assert.equal(body.auth.identity.token.id, 'the-token');
  assert.equal(body.auth.identity.token.duration_seconds, 900);
});

test('exchangeTokenForCredentials throws TOKEN_INVALID on 401', async () => {
  await assert.rejects(
    exchangeTokenForCredentials('bad-token', { fetchImpl: stubFetch(401, {}) }),
    (err) => err.code === 'TOKEN_INVALID',
  );
});

test('exchangeTokenForCredentials throws TOKEN_EXCHANGE_FAILED on non-201', async () => {
  await assert.rejects(
    exchangeTokenForCredentials('bad-token', { fetchImpl: stubFetch(500, {}) }),
    (err) => err.code === 'TOKEN_EXCHANGE_FAILED',
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/token-exchange.test.mjs`
Expected: FAIL（`Cannot find module .../token-exchange.mjs`）

- [ ] **Step 3: 实现**

```js
// plugins/huaweicloud-core/src/auth/token-exchange.mjs
import { getProxyDispatcher } from '../proxy/proxy-agent.mjs';

const DEFAULT_DURATION_SECONDS = 900;
const DEFAULT_IAM_ENDPOINT = 'https://iam.myhuaweicloud.com';

export async function exchangeTokenForCredentials(token, options = {}) {
  const durationSeconds = options.durationSeconds ?? DEFAULT_DURATION_SECONDS;
  const iamEndpoint = options.iamEndpoint || process.env.HW_TOKEN_IAM_ENDPOINT || DEFAULT_IAM_ENDPOINT;
  const fetchImpl = options.fetchImpl || fetch;

  const body = {
    auth: {
      identity: {
        methods: ['token'],
        token: { id: token, duration_seconds: durationSeconds },
      },
    },
  };

  const dispatcher = await getProxyDispatcher(iamEndpoint);
  const fetchOpts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf8' },
    body: JSON.stringify(body),
  };
  if (dispatcher) fetchOpts.dispatcher = dispatcher;

  let resp;
  try {
    resp = await fetchImpl(`${iamEndpoint}/v3.0/OS-CREDENTIAL/securitytokens`, fetchOpts);
  } catch (error) {
    const err = new Error(`Token exchange request failed: ${error.message}`);
    err.code = 'TOKEN_EXCHANGE_FAILED';
    throw err;
  }

  if (resp.status === 401 || resp.status === 403) {
    const err = new Error('X-Auth-Token is invalid or expired.');
    err.code = 'TOKEN_INVALID';
    throw err;
  }
  if (resp.status !== 201) {
    const err = new Error(`Token exchange returned unexpected status ${resp.status}.`);
    err.code = 'TOKEN_EXCHANGE_FAILED';
    throw err;
  }

  const data = await resp.json();
  const cred = data?.credential;
  if (!cred?.access || !cred?.secret || !cred?.securitytoken) {
    const err = new Error('Token exchange response missing credential fields.');
    err.code = 'TOKEN_EXCHANGE_FAILED';
    throw err;
  }
  const expiresAt = cred.expires_at ? Date.parse(cred.expires_at) : NaN;
  return {
    ak: cred.access,
    sk: cred.secret,
    securityToken: cred.securitytoken,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/token-exchange.test.mjs`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add plugins/huaweicloud-core/src/auth/token-exchange.mjs test/token-exchange.test.mjs
git commit -m "feat(auth): add token→temporary-AK/SK exchange (CreateTemporaryAccessKeyByToken)"
```

---

### Task 2: `token-exchange.mjs` — `getTokenCredentials`（缓存 + single-flight）

**Files:**
- Modify: `plugins/huaweicloud-core/src/auth/token-exchange.mjs`
- Test: `test/token-exchange.test.mjs`

**Interfaces:**
- Produces: `getTokenCredentials(token, options?)` → `Promise<{ ak, sk, securityToken, expiresAt }>`；`__resetTokenCache()`（测试专用，重置模块级缓存与 inflight）。

- [ ] **Step 1: 写失败测试**

```js
// 追加到 test/token-exchange.test.mjs 顶部 import
import { exchangeTokenForCredentials, getTokenCredentials, __resetTokenCache } from '../plugins/huaweicloud-core/src/auth/token-exchange.mjs';

test('getTokenCredentials caches the result and avoids re-exchange while valid', async () => {
  __resetTokenCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      status: 201,
      json: async () => ({
        credential: {
          access: 'AK',
          secret: 'SK',
          securitytoken: 'STS',
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        },
      }),
    };
  };
  const a = await getTokenCredentials('t', { fetchImpl });
  const b = await getTokenCredentials('t', { fetchImpl });
  assert.equal(calls, 1, 'second call should hit cache');
  assert.equal(a.ak, b.ak);
  __resetTokenCache();
});

test('getTokenCredentials re-exchanges when cached credential is expired', async () => {
  __resetTokenCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      status: 201,
      json: async () => ({
        credential: {
          access: 'AK' + calls,
          secret: 'SK',
          securitytoken: 'STS',
          expires_at: new Date(Date.now() - 1000).toISOString(), // 已过期
        },
      }),
    };
  };
  const a = await getTokenCredentials('t', { fetchImpl });
  const b = await getTokenCredentials('t', { fetchImpl });
  assert.equal(calls, 2, 'expired credential should force re-exchange');
  assert.notEqual(a.ak, b.ak);
  __resetTokenCache();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/token-exchange.test.mjs`
Expected: FAIL（`getTokenCredentials` / `__resetTokenCache` 未定义）

- [ ] **Step 3: 实现（追加到 token-exchange.mjs）**

```js
const GRACE_MS = 60 * 1000;

let cached = null; // { ak, sk, securityToken, expiresAt }
let inflight = null; // Promise 单飞

export function __resetTokenCache() {
  cached = null;
  inflight = null;
}

export async function getTokenCredentials(token, options = {}) {
  const now = Date.now();
  if (cached && cached.expiresAt && cached.expiresAt - GRACE_MS > now) {
    return cached;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      cached = await exchangeTokenForCredentials(token, options);
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/token-exchange.test.mjs`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add plugins/huaweicloud-core/src/auth/token-exchange.mjs test/token-exchange.test.mjs
git commit -m "feat(auth): cache + single-flight token→AK/SK exchange"
```

---

### Task 3: `credentials.mjs` — `resolveXAuthToken` + `resolveXAuthTokenExpiry`

**Files:**
- Modify: `plugins/huaweicloud-core/src/auth/credentials.mjs`
- Test: `test/auth-credentials.test.mjs`

**Interfaces:**
- Produces: `resolveXAuthToken()` → `string|null`（读 env + CodeArts env）；`resolveXAuthTokenExpiry()` → `number|null`（epoch ms，读 `HW_X_AUTH_TOKEN_EXPIRES_AT`）。

- [ ] **Step 1: 写失败测试**

```js
// 追加到 test/auth-credentials.test.mjs（假设已 top-level await import credentials）
import {
  resolveXAuthToken,
  resolveXAuthTokenExpiry,
} from '../plugins/huaweicloud-core/src/auth/credentials.mjs';

test('resolveXAuthToken reads HW_X_AUTH_TOKEN env and rejects placeholders', () => {
  const saved = process.env.HW_X_AUTH_TOKEN;
  try {
    delete process.env.HW_X_AUTH_TOKEN;
    assert.equal(resolveXAuthToken(), null);
    process.env.HW_X_AUTH_TOKEN = 'real-token-value';
    assert.equal(resolveXAuthToken(), 'real-token-value');
    process.env.HW_X_AUTH_TOKEN = '<HW_X_AUTH_TOKEN>';
    assert.equal(resolveXAuthToken(), null);
  } finally {
    if (saved === undefined) delete process.env.HW_X_AUTH_TOKEN;
    else process.env.HW_X_AUTH_TOKEN = saved;
  }
});

test('resolveXAuthTokenExpiry parses ISO8601 and epoch seconds', () => {
  const saved = process.env.HW_X_AUTH_TOKEN_EXPIRES_AT;
  try {
    delete process.env.HW_X_AUTH_TOKEN_EXPIRES_AT;
    assert.equal(resolveXAuthTokenExpiry(), null);
    process.env.HW_X_AUTH_TOKEN_EXPIRES_AT = '2026-10-20T08:56:33.710000Z';
    assert.equal(resolveXAuthTokenExpiry(), Date.parse('2026-10-20T08:56:33.710000Z'));
    process.env.HW_X_AUTH_TOKEN_EXPIRES_AT = '1765788993';
    assert.equal(resolveXAuthTokenExpiry(), 1765788993 * 1000);
  } finally {
    if (saved === undefined) delete process.env.HW_X_AUTH_TOKEN_EXPIRES_AT;
    else process.env.HW_X_AUTH_TOKEN_EXPIRES_AT = saved;
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/auth-credentials.test.mjs`
Expected: FAIL（`resolveXAuthToken` / `resolveXAuthTokenExpiry` 未导出）

- [ ] **Step 3: 实现（追加到 credentials.mjs，放在 `resolveCredentialsWithRuntime` 之后）**

```js
export function resolveXAuthToken() {
  const envToken = process.env.HW_X_AUTH_TOKEN;
  if (present(envToken)) return envToken;

  const parentCwd = getParentCwd();
  const searchDirs = [process.env.CODEARTS_PROJECT_DIR, parentCwd, process.cwd(), homedir()];
  for (const dir of searchDirs) {
    if (!dir) continue;
    const path = join(dir, '.codeartsdoer', 'mcp', 'mcp_settings.json');
    try {
      if (!existsSync(path)) continue;
      const config = JSON.parse(readFileSync(path, 'utf8'));
      const server = pickDevkitMcpServer(config?.mcpServers);
      const token = server?.env?.HW_X_AUTH_TOKEN;
      if (present(token)) return token;
    } catch {}
  }

  const workPaths = [
    join(homedir(), '.codearts', 'mcp', 'mcp_settings.json'),
    join(homedir(), '.codeartswork', 'mcp', 'mcp_settings.json'),
  ];
  for (const path of workPaths) {
    try {
      if (!existsSync(path)) continue;
      const config = JSON.parse(readFileSync(path, 'utf8'));
      const server = pickDevkitMcpServer(config?.mcp);
      const token = server?.environment?.HW_X_AUTH_TOKEN;
      if (present(token)) return token;
    } catch {}
  }
  return null;
}

export function resolveXAuthTokenExpiry() {
  const v = process.env.HW_X_AUTH_TOKEN_EXPIRES_AT;
  if (!v || typeof v !== 'string' || !v.trim()) return null;
  const asNum = Number(v.trim());
  if (Number.isFinite(asNum) && asNum > 0) return asNum > 1e12 ? asNum : asNum * 1000;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? t : null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/auth-credentials.test.mjs`
Expected: PASS（含新增 2 tests）

- [ ] **Step 5: Commit**

```bash
git add plugins/huaweicloud-core/src/auth/credentials.mjs test/auth-credentials.test.mjs
git commit -m "feat(auth): resolve X-Auth-Token and expiry from env/CodeArts env"
```

---

### Task 4: `hcloud-cli.mjs` — `resolveStsInjectArgs` 异步化 + token 分支

**Files:**
- Modify: `plugins/huaweicloud-core/src/hcloud-cli.mjs:300-368`、`443-488`（调用点 `await`）、顶部 import
- Test: `test/hcloud-cli.test.mjs:437-517`（现有用例补 `await`）、追加 token 分支用例

**Interfaces:**
- Consumes: `resolveXAuthToken`、`getTokenCredentials`（Task 2/3）
- Produces: `resolveStsInjectArgs(rawArgs)` → `Promise<Array<string>>`；`resolveTokenInjectArgs(rawArgs)` → `Promise<Array<string>>`（可选拆出）

- [ ] **Step 1: 改实现——import 与函数签名**

在 `hcloud-cli.mjs` 顶部 import 段（`import { ... } from './auth/credentials.mjs';`）补充 `resolveXAuthToken`；新增 import：

```js
import { getTokenCredentials } from './auth/token-exchange.mjs';
```

将 `export function resolveStsInjectArgs(rawArgs) {` 改为 `export async function resolveStsInjectArgs(rawArgs) {`。

- [ ] **Step 2: 改实现——在「无 AK/SK」分支追加 token 逻辑**

将现有（约 353 行）：

```js
  if (!creds || !creds.ak || !creds.sk || !creds.securityToken) return [];
```

替换为：

```js
  if (!creds || !creds.ak || !creds.sk) {
    const token = resolveXAuthToken();
    if (token) {
      const temp = await getTokenCredentials(token);
      return ['--cli-access-key=' + temp.ak, '--cli-secret-key=' + temp.sk, '--cli-security-token=' + temp.securityToken];
    }
    return [];
  }
  if (!creds.securityToken) return [];
```

- [ ] **Step 3: 改实现——`runHcloud` 调用点补 `await`**

将 `runHcloud` 内（约 471 行）：

```js
  const stsInject = resolveStsInjectArgs(normalizedArgs);
```

替换为：

```js
  const stsInject = await resolveStsInjectArgs(normalizedArgs);
```

- [ ] **Step 4: 更新现有测试（仅补 async/await，断言不变）**

`test/hcloud-cli.test.mjs` 中以下测试函数体改为 `async` 并为 `resolveStsInjectArgs` 调用加 `await`（断言原样）：

- `'resolveStsInjectArgs returns empty for long-lived creds (no token)'`（约 437 行）：`async () => { ... assert.deepEqual(await resolveStsInjectArgs(...), []) ... }`
- `'resolveStsInjectArgs injects STS args for live runtime tokens'`（约 444 行）
- `'resolveStsInjectArgs uses obsutil -i/-k/-t for OBS subcommands'`（约 452 行）
- `'resolveStsInjectArgs skips help/metadata commands'`（约 491 行）
- `'resolveStsInjectArgs skips bash/sudo wrapper invocations'`（约 500 行）
- `'resolveStsInjectArgs skips configure/config and existing explicit creds'`（约 509 行）

- [ ] **Step 5: 新增 token 分支测试**

在 `test/hcloud-cli.test.mjs` 顶部 import 段（已有 `resolveStsInjectArgs`、`setRuntimeCredentials`、`clearRuntimeCredentials`）。用 `t.mock.module` 桩掉 `token-exchange.mjs` 的 `getTokenCredentials`，避免真实网络调用：

```js
test('resolveStsInjectArgs injects exchanged temp creds for token mode', async (t) => {
  clearRuntimeCredentials();
  const savedToken = process.env.HW_X_AUTH_TOKEN;
  try {
    process.env.HW_X_AUTH_TOKEN = 'the-token';
    t.mock.module('../plugins/huaweicloud-core/src/auth/token-exchange.mjs', {
      namedExports: {
        getTokenCredentials: async () => ({
          ak: 'EX_AK',
          sk: 'EX_SK',
          securityToken: 'EX_STS',
          expiresAt: Date.now() + 60000,
        }),
      },
    });
    const { resolveStsInjectArgs } = await import('../plugins/huaweicloud-core/src/hcloud-cli.mjs');
    const injected = await resolveStsInjectArgs(['VPC', 'ListVpcs']);
    assert.deepEqual(injected, ['--cli-access-key=EX_AK', '--cli-secret-key=EX_SK', '--cli-security-token=EX_STS']);
  } finally {
    if (savedToken === undefined) delete process.env.HW_X_AUTH_TOKEN;
    else process.env.HW_X_AUTH_TOKEN = savedToken;
    clearRuntimeCredentials();
  }
});

test('resolveStsInjectArgs prefers AK/SK over token when both present', async () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  const savedToken = process.env.HW_X_AUTH_TOKEN;
  try {
    process.env.HW_X_AUTH_TOKEN = 'the-token';
    const injected = await resolveStsInjectArgs(['VPC', 'ListVpcs']);
    assert.deepEqual(injected, ['--cli-access-key=STS_AK', '--cli-secret-key=STS_SK', '--cli-security-token=STS_TOKEN']);
  } finally {
    if (savedToken === undefined) delete process.env.HW_X_AUTH_TOKEN;
    else process.env.HW_X_AUTH_TOKEN = savedToken;
    clearRuntimeCredentials();
  }
});
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test test/hcloud-cli.test.mjs`
Expected: PASS（现有用例 + 新增 2 tests 全绿）

- [ ] **Step 7: Commit**

```bash
git add plugins/huaweicloud-core/src/hcloud-cli.mjs test/hcloud-cli.test.mjs
git commit -m "feat(auth): token mode in resolveStsInjectArgs — exchange then inject on no-AK/SK"
```

---

### Task 5: 脱敏加固（token 字段不落日志/回显）

**Files:**
- Modify: `plugins/huaweicloud-core/src/safety-policy.mjs`（`isSecretKeyName`/`redactString`）
- Modify: `plugins/huaweicloud-core/src/risk-rule-engine.mjs`（`redactEvidence`）
- Test: `test/risk-rule-engine.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: token 形如 `X_AUTH_TOKEN` / `x-auth-token` / `X-Auth-Token` 在脱敏输出中变为 `<redacted>`。

- [ ] **Step 1: 写失败测试**

```js
// 追加到 test/risk-rule-engine.test.mjs
test('evidence snippets redact X-Auth-Token values', () => {
  const result = evaluateCommandRisk('echo $HW_X_AUTH_TOKEN=SecretTokenValue123');
  assert.doesNotMatch(JSON.stringify(result), /SecretTokenValue123/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/risk-rule-engine.test.mjs`
Expected: FAIL（token 值未被脱敏）

- [ ] **Step 3: 实现**

在 `redactEvidence`（`risk-rule-engine.mjs`）的替换列表加入 token 字段；在 `redactString`（`safety-policy.mjs`）同步加：

```js
.replace(
  /((?:x[_-]?auth[_-]?token|x[_-]?subject[_-]?token)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
  '$1<redacted>',
)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/risk-rule-engine.test.mjs test/safety-policy.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/huaweicloud-core/src/safety-policy.mjs plugins/huaweicloud-core/src/risk-rule-engine.mjs test/risk-rule-engine.test.mjs
git commit -m "fix(safety): redact X-Auth-Token values in command/evidence output"
```

---

### Task 6: 全量回归

- [ ] **Step 1: 跑完整测试套件**

Run: `npm test`
Expected: 全绿（735 baseline + 新增 token 用例，约 745+；零 fail）

- [ ] **Step 2: 跑 lint / validate / format**

Run: `npm run lint:js && npm run validate && npm run format`

- [ ] **Step 3: Commit（若有 format 产物）**

```bash
git add -A
git commit -m "chore: format + validate for token auth"
```

---

### Task 7: 版本 bump + 发布（运维流程，执行阶段另做）

- [ ] 版本 bump 到 `1.1.9-next.6`（`sed` 全量替换 `.version-override`/`package.json`/`package-lock.json`/`plugin.json`/`openclaw.plugin.json`/5 个 manifest/README×2 badge）并更新 `docs/CHANGELOG.md`。
- [ ] `npm run validate && npm test && npm run format:check` 全绿。
- [ ] 提交 + 打 tag `v1.1.9-next.6` + push。
- [ ] dispatch `npm-publish.yml`（from tag）+ 审批 `npm-publish` environment。
- [ ] 验证 npm `next` 指向 `1.1.9-next.6`。
- [ ] ECS 真机验证：注入真实 `HW_X_AUTH_TOKEN`，跑 `drawing` 只读命令（`ECS ListServersDetails`）验证 token→临时AK/SK→hcloud 全链路；确认与现有 AK/SK 路径并存的回归（无 token 时走原有 AK/SK 路径）。
```

## Self-Review

- **Spec 覆盖**：技术路径（Task1/2/4）、resolveXAuthToken（Task3）、缓存+single-flight（Task2）、错误处理（Task1 `TOKEN_INVALID`/`TOKEN_EXCHANGE_FAILED`）、脱敏（Task5）、回归（Task6）、兼容红线（Global Constraints + Task4 的「AK/SK 优先」测试）。
- **占位符**：无 TBD/TODO；Task4 的 token 分支测试用 `t.mock.module` 精确桩，无「待补充」。
- **类型一致**：`getTokenCredentials` 返回 `{ak,sk,securityToken,expiresAt}`，Task4 用 `temp.ak/temp.sk/temp.securityToken`，一致；`resolveXAuthToken`/`resolveXAuthTokenExpiry` 在 Task3 定义、Task4 消费，签名一致。