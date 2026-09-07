# Credential Reconciliation (v4 方案) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立「credentials.json 单一事实源 + S2/S3 派生镜像 + 指纹比对 + .last_sync 手动改动检测 + 交互仲裁」的凭证一致化体系，并新增会话内切换工具 `huaweicloud_auth_switch`，补齐 G1~G4 缺口。

**Architecture:** 新增 `src/auth/reconcile.mjs` 模块（fingerprint/scan/resolveManagedProfile/reconcile/askAuthority），改造 `credentials.mjs`（.last_sync、configuredBySession、备份）、`service.mjs`（getAuthStatus 增审计、syncAuth 走 reconcile 语义）、`setup-cli.mjs`（configureHcloud 带 --cli-profile、cmdAuthReconcile）、`tools.mjs`（新增 huaweicloud_auth_switch、auth_confirm）、`hcloud-cli.mjs`（runHcloud 前置 runtime/current 一致性警告）。

**Tech Stack:** Node.js ≥22（ESM），undici，node:test，无构建步骤。

## Global Constraints

- 不新增运行时依赖（唯一依赖 undici ^8.10.0）。
- 所有凭证值不得打印明文；日志/输出只允许脱敏指纹（`fingerprint = sha256(ak+sk).slice(0,8)`）。
- 所有写盘文件权限 0600（复用 `ensurePrivateMode`）。
- 遵循现有命名：`snake_case` 参数、`.mjs` 后缀、`node --test`。
- 路径基准统一使用 `baseHome()`（`process.env.HUAWEICLOUD_HOME || homedir()`）。
- R3 约束：带 `HW_SECURITY_TOKEN` 的临时凭证永不落盘。
- R10 约束（G4）：`runtimeCredentials` 非空时禁止自动落盘动作（R4 自动写 / R7 传播），只提示。
- MCP 工具命名前缀 `huaweicloud_`；工具若需用户确认，返回 `{ status: 'needs_confirmation', confirmToken, options }`，由 `huaweicloud_auth_confirm` 消费。

---

### Task 1: credentials.mjs — .last_sync、configuredBySession、备份

**Files:**

- Modify: `plugins/huaweicloud-core/src/auth/credentials.mjs`
- Test: `test/auth-credentials.test.mjs`

**Interfaces:**

- Produces:
  - `lastSyncPath()` => string（`.config/huaweicloud/` 下 `.last_sync`）
  - `readLastSync()` => `{ ts: number } | null`
  - `writeLastSync()` => void
  - `readGlobalCredentials()` 返回对象新增字段 `configuredBySession?: boolean`
  - `writeGlobalCredentials(credentials)` 支持传入 `configuredBySession`，持久化该字段
  - `setConfiguredBySession(true|false)` => void（读改写 S1）
  - `backupGlobalCredentials()` => string|null（复制 S1 到 `credentials.json.bak`，0600）
  - `restoreGlobalCredentialsBackup()` => boolean

- [ ] **Step 1: 写失败测试（追加到 test/auth-credentials.test.mjs）**

```js
test('last_sync write/read round-trip', () => {
  withTempHome((home) => {
    assert.equal(readLastSync(), null);
    writeLastSync();
    const sync = readLastSync();
    assert.ok(sync && typeof sync.ts === 'number');
    assert.ok(Date.now() - sync.ts < 5000);
  });
});

test('writeGlobalCredentials persists configuredBySession flag', () => {
  withTempHome((home) => {
    writeGlobalCredentials({ ak: 'AK1', sk: 'SK1', configuredBySession: true });
    assert.equal(readGlobalCredentials().configuredBySession, true);
    writeGlobalCredentials({ ak: 'AK1', sk: 'SK1' });
    assert.equal(readGlobalCredentials().configuredBySession, undefined);
  });
});

test('backup and restore global credentials', () => {
  withTempHome((home) => {
    writeGlobalCredentials({ ak: 'AK_ORIG', sk: 'SK_ORIG', region: 'cn-north-4' });
    const bak = backupGlobalCredentials();
    assert.ok(bak && bak.endsWith('credentials.json.bak'));
    writeGlobalCredentials({ ak: 'AK_NEW', sk: 'SK_NEW' });
    assert.equal(readGlobalCredentials().ak, 'AK_NEW');
    assert.equal(restoreGlobalCredentialsBackup(), true);
    assert.equal(readGlobalCredentials().ak, 'AK_ORIG');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/auth-credentials.test.mjs`
Expected: FAIL — `readLastSync`/`lastSyncPath`/`backupGlobalCredentials` … is not defined

- [ ] **Step 3: 实现**

在 `credentials.mjs` 顶部 import 区加入 `copyFileSync, statSync`（已有 `chmodSync,mkdirSync,...`，`copyFileSync` 需新增），追加：

```js
export function lastSyncPath() {
  return join(baseHome(), '.config', 'huaweicloud', '.last_sync');
}

export function readLastSync() {
  const path = lastSyncPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeLastSync() {
  const path = lastSyncPath();
  mkdirSync(dirname(path), { recursive: true });
  const payload = { ts: Date.now() };
  writeFileSync(path, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  ensurePrivateMode(path);
}

export function backupGlobalCredentials() {
  const path = globalCredentialsPath();
  if (!existsSync(path)) return null;
  const bakPath = `${path}.bak`;
  try {
    copyFileSync(path, bakPath);
    ensurePrivateMode(bakPath);
    return bakPath;
  } catch {
    return null;
  }
}

export function restoreGlobalCredentialsBackup() {
  const path = globalCredentialsPath();
  const bakPath = `${path}.bak`;
  if (!existsSync(bakPath)) return false;
  try {
    copyFileSync(bakPath, path);
    ensurePrivateMode(path);
    return true;
  } catch {
    return false;
  }
}
```

修改 `writeGlobalCredentials` payload（保留原 ak/sk/securityToken/region）：

```js
const payload = {
  ak: String(credentials.ak || ''),
  sk: String(credentials.sk || ''),
  securityToken: String(credentials.securityToken || ''),
  region: String(credentials.region || ''),
  ...(credentials.configuredBySession === undefined
    ? {}
    : { configuredBySession: Boolean(credentials.configuredBySession) }),
};
```

追加：

```js
export function setConfiguredBySession(flag) {
  const stored = readGlobalCredentials();
  const next = { ...(stored || {}), configuredBySession: Boolean(flag) };
  writeGlobalCredentials(next);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/auth-credentials.test.mjs`
Expected: PASS（全部含新增 3 条）

- [ ] **Step 5: 提交**

```bash
git add test/auth-credentials.test.mjs plugins/huaweicloud-core/src/auth/credentials.mjs
git commit -m "feat(credentials): last_sync marker, configuredBySession flag, backup/restore"
```

---

### Task 2: reconcile.mjs — 指纹、KooCLI 档解析、scan

**Files:**

- Create: `plugins/huaweicloud-core/src/auth/reconcile.mjs`
- Test: `test/reconcile.test.mjs`

**Interfaces:**

- Consumes: `readGlobalCredentials`、`readLastSync`、`writeLastSync`、`lastSyncPath`、`globalCredentialsPath`、`obsConfigPath`（Task 1）；`classifyHcloudArgs`… 不需要。
- Produces:
  - `fingerprint(ak, sk)` => string（sha256(ak+sk).slice(0,8)，空值返回 `''`）
  - `readKooCliProfiles()` => `{ current: string, profiles: Array<{ name: string; fingerprint: string; mtimeMs: number }> } | { error: string }`（不 spawn hcloud —— 直接解析 `~/.hcloud/config.json`；解析失败返回 `{ error }`）
  - `resolveManagedProfile()` => `string | null`
  - `scanState()` => `{ stores: {...}, inconsistencies: Array<{ store, source, fingerprint, manualModified }>, hasRuntime, runtimeFingerprint }`
  - `runHcloudConfigure(profile, ak, sk, region)` => `{ ok, error? }`（spawn hcloud configure set，`shell:false`）
  - `writeAllMirrors({ authority })` => `{ ok, errors: string[] }`
  - `isManualModified(storePath)` => boolean（mtimeMs > lastSync.ts）

- [ ] **Step 1: 写失败测试（新建 test/reconcile.test.mjs + 一个 fake hcloud 脚本）**

测试模板复用 `auth-credentials.test.mjs` 的 `withTempHome`。另建 `test/fixtures/fake-hcloud.mjs`：

```js
#!/usr/bin/env node
// Fake hcloud: 记录 argv 到 HCLOUD_FAKE_LOG，configure set 回 0（ESM）
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const log = process.env.HCLOUD_FAKE_LOG || '/tmp/hcloud-fake.log';
if (process.argv[2] === 'configure') {
  const dir = dirname(resolve(log));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\n');
  process.exit(0);
}
if (process.argv[2] === 'version') {
  console.log('KooCLI Fake 7.2.12');
  process.exit(0);
}
process.exit(0);
```

`test/reconcile.test.mjs`：

```js
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir, join } from 'node:path';
import test from 'node:test';

import {
  fingerprint,
  readKooCliProfiles,
  resolveManagedProfile,
  scanState,
  isManualModified,
} from '../plugins/huaweicloud-core/src/auth/reconcile.mjs';
import {
  writeGlobalCredentials,
  writeObsConfig,
  writeLastSync,
  lastSyncPath,
} from '../plugins/huaweicloud-core/src/auth/credentials.mjs';

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-rec-'));
  const prev = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = dir;
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  delete process.env.HW_SECURITY_TOKEN;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFakeKooCli(dir, current, profiles) {
  const p = join(homedir(), '.hcloud', 'config.json');
  mkdirSync(join(homedir(), '.hcloud'), { recursive: true });
  writeFileSync(p, JSON.stringify({ current, profiles }, null, 2));
  return p;
}

test('fingerprint is a stable masked digest', () => {
  assert.equal(fingerprint('AK1', 'SK1').length, 8);
  assert.equal(fingerprint('AK1', 'SK1'), fingerprint('AK1', 'SK1'));
  assert.notEqual(fingerprint('AK1', 'SK1'), fingerprint('AK1', 'SK2'));
  assert.equal(fingerprint('', ''), '');
});

test('readKooCliProfiles parses current + profiles with fingerprint/mtime', () => {
  withTempHome((dir) => {
    writeFakeKooCli(dir, 'deploy', [
      { name: 'default', accessKeyId: 'AK_A', secretAccessKey: 'SK_A', region: 'cn-east-3' },
      { name: 'deploy', accessKeyId: 'AK_B', secretAccessKey: 'SK_B', region: 'cn-north-4' },
    ]);
    const res = readKooCliProfiles();
    assert.equal(res.current, 'deploy');
    assert.equal(res.profiles.length, 2);
    assert.equal(res.profiles.find((p) => p.name === 'default').fingerprint, fingerprint('AK_A', 'SK_A'));
  });
});

test('readKooCliProfiles handles missing config', () => {
  withTempHome((dir) => {
    const res = readKooCliProfiles();
    assert.equal(res.error, 'KooCLI config not found');
  });
});

test('scanState reports runtime fingerprint and current-profile mismatch', () => {
  withTempHome((dir) => {
    writeGlobalCredentials({ ak: 'AK_S1', sk: 'SK_S1', region: 'cn-north-4' });
    writeFakeKooCli(dir, 'deploy', [
      { name: 'deploy', accessKeyId: 'AK_B', secretAccessKey: 'SK_B', region: 'cn-north-4' },
    ]);
    const scan = scanState();
    assert.equal(scan.stores.s1Fingerprint, fingerprint('AK_S1', 'SK_S1'));
    assert.equal(scan.stores.currentFingerprint, fingerprint('AK_B', 'SK_B'));
    assert.ok(scan.inconsistencies.some((i) => i.store === 'S2-current'));
  });
});

test('isManualModified compares mtime vs .last_sync', () => {
  withTempHome((dir) => {
    const f = lastSyncPath();
    mkdirSync(join(dir, '.config', 'huaweicloud'), { recursive: true });
    writeFileSync(f, JSON.stringify({ ts: Date.now() }));
    // file created after .last_sync → not manual
    assert.equal(isManualModified(lastSyncPath()), false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/reconcile.test.mjs`
Expected: FAIL — cannot find module `reconcile.mjs`

- [ ] **Step 3: 实现 reconcile.mjs**

```js
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  globalCredentialsPath,
  obsConfigPath,
  readGlobalCredentials,
  readLastSync,
  writeObsConfig,
  setConfiguredBySession,
  backupGlobalCredentials,
  resolveCredentialsWithRuntime,
} from './credentials.mjs';

function baseHome() {
  return process.env.HUAWEICLOUD_HOME || homedir();
}

export function fingerprint(ak, sk) {
  if (!ak || !sk) return '';
  return createHash('sha256').update(`${ak}${sk}`).digest('hex').slice(0, 8);
}

export function isManualModified(path) {
  if (!existsSync(path)) return false;
  const lastSync = readLastSync();
  try {
    const fts = statSync(path).mtimeMs;
    if (!lastSync) return true; // no marker → treat as manual
    return fts > lastSync.ts;
  } catch {
    return false;
  }
}

export function readKooCliProfiles() {
  const configPath = join(baseHome(), '.hcloud', 'config.json');
  if (!existsSync(configPath)) return { error: 'KooCLI config not found' };
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const current = String(raw.current || 'default');
    const profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
    const mtimeMs = statSync(configPath).mtimeMs;
    return {
      current,
      mtimeMs,
      profiles: profiles.map((p) => ({
        name: String(p.name || ''),
        fingerprint: fingerprint(p.accessKeyId, p.secretAccessKey),
        accessKeyId: p.accessKeyId || '',
      })),
    };
  } catch {
    return { error: 'KooCLI config parse failed' };
  }
}

export function resolveManagedProfile() {
  const res = readKooCliProfiles();
  if (res.error) return null;
  return res.current;
}

export function hasRuntimeCredentials() {
  try {
    resolveCredentialsWithRuntime({ allowMissing: true });
    return true;
  } catch {
    return false;
  }
}

export function currentFingerprintFromHcloud(res) {
  if (res.error) return null;
  const cur = res.profiles.find((p) => p.name === res.current);
  return cur ? cur.fingerprint : null;
}

export function scanState() {
  const s1 = readGlobalCredentials() || {};
  const envAk = process.env.HW_ACCESS_KEY || '';
  const envSk = process.env.HW_SECRET_KEY || '';
  const kooCli = readKooCliProfiles();
  const currentFp = currentFingerprintFromHcloud(kooCli);
  const inconsistencies = [];

  const s1Fingerprint = fingerprint(s1.ak, s1.sk);
  const envFingerprint = fingerprint(envAk, envSk);
  const s3 = existsSync(obsConfigPath()) ? parseS3ObsConfig(obsConfigPath()) : null;
  const s3Fingerprint = s3 ? fingerprint(s3.ak, s3.sk) : null;

  if (s1Fingerprint && currentFp && s1Fingerprint !== currentFp) {
    inconsistencies.push({
      store: 'S2-current',
      source: 'KooCLI current profile',
      fingerprint: currentFp,
      manualModified: isManualModified(join(baseHome(), '.hcloud', 'config.json')),
    });
  }
  if (s1Fingerprint && s3Fingerprint && s1Fingerprint !== s3Fingerprint) {
    inconsistencies.push({
      store: 'S3',
      source: 'obsutilconfig',
      fingerprint: s3Fingerprint,
      manualModified: isManualModified(obsConfigPath()),
    });
  }

  return {
    stores: {
      s1Fingerprint,
      envFingerprint,
      currentFingerprint: currentFp,
      s3Fingerprint,
    },
    kooCliCurrent: kooCli.error ? null : kooCli.current,
    inconsistencies,
    hasRuntime: false, // filled by scanStateWithRuntime
    runtimeFingerprint: null,
  };
}

function parseS3ObsConfig(path) {
  try {
    const text = readFileSync(path, 'utf8');
    const get = (k) => {
      const m = text.match(new RegExp(`^${k}=(.+)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    return { ak: get('ak'), sk: get('sk'), region: inferRegion(text) };
  } catch {
    return null;
  }
}

function inferRegion(text) {
  const m = text.match(/endpoint=https:\/\/obs\.([^.]+)\./);
  return m ? m[1] : '';
}

export function exportStateForStatus(jailed) {
  const scan = scanState();
  return {
    ...scan,
    // fields below are consumed by getAuthStatus in service.mjs
    inconsistent: scan.inconsistencies.length > 0,
  };
}

export function runHcloudConfigure(profile, ak, sk, region) {
  const bin = process.env.HCLOUD_BIN || 'hcloud';
  const args = [
    'configure',
    'set',
    `--cli-profile=${profile}`,
    `--cli-access-key=${ak}`,
    `--cli-secret-key=${sk}`,
    `--cli-region=${region || ''}`,
  ];
  const r = spawnSync(bin, args, { shell: false, windowsHide: true, stdio: 'pipe', timeout: 30000 });
  return {
    ok: r.status === 0,
    error: String(r.stderr || '')
      .trim()
      .slice(0, 240),
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/reconcile.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add test/reconcile.test.mjs test/fixtures/fake-hcloud.mjs plugins/huaweicloud-core/src/auth/reconcile.mjs
git commit -m "feat(reconcile): fingerprint, KooCLI profile parsing, scan state"
```

---

### Task 3: service.mjs — getAuthStatus 增 audit/指纹；syncAuth 对齐 R7/R10

**Files:**

- Modify: `plugins/huaweicloud-core/src/auth/service.mjs`
- Test: `test/auth-credentials.test.mjs`（追加）

**Interfaces:**

- Consumes: Task 1（`readLastSync`, `writeLastSync`, `backupGlobalCredentials`）、Task 2（`scanState`, `runHcloudConfigure`, `resolveManagedProfile`, `hasRuntimeCredentials`）
- Produces: `getAuthStatus` 返回值新增字段 `reconciled: {...}`；`syncAuth` 行为：R10 守卫 + R7 写 current 档。

- [ ] **Step 1: 写失败测试（追加）**

```js
test('getAuthStatus reports reconciliation inconsistencies', () => {
  withTempHome((home) => {
    writeGlobalCredentials({ ak: 'AK1', sk: 'SK1', region: 'cn-north-4' });
    const status = getAuthStatus('all');
    assert.ok('reconciled' in status);
    assert.equal(typeof status.reconciled.inconsistent, 'boolean');
    assert.equal(status.reconciled.runtimeActive, false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL — `status.reconciled` undefined

- [ ] **Step 3: 实现**

在 `service.mjs` import 区补：

```js
import {
  runHcloudConfigure,
  resolveManagedProfile,
  exportStateForStatus,
  hasRuntimeCredentials,
  scanState,
} from './reconcile.mjs';
```

改造 `getAuthStatus`，返回值加 `reconciled`：

```js
export function getAuthStatus(target = 'all') {
  const credentials = readGlobalCredentials();
  const reconciled = exportStateForStatus();
  return {
    target,
    credentialsConfigured: Boolean(credentials?.ak && credentials?.sk),
    credentialsPath: globalCredentialsPath(),
    obsConfigured: existsSync(obsConfigPath()),
    obsConfigPath: obsConfigPath(),
    kooCliInstalled: hcloudInstalled(),
    reconciled,
    agents: getAgentRegistrationStatuses(target).agents,
  };
}
```

改造 `syncAuth`：R10 守卫 + R7 写 current 档 + 传播后刷新 .last_sync：

```js
export function syncAuth(target = 'all') {
  const credentials = readGlobalCredentials();
  if (!credentials?.ak || !credentials?.sk) {
    return {
      ok: false,
      error: 'Global credentials are not configured.',
      nextStep: 'Run "npx huaweicloud-devkit auth init" first.',
    };
  }
  if (hasRuntimeCredentials()) {
    return {
      ok: false,
      error: 'Runtime credentials are active; auto-sync suppressed (R10).',
      nextStep: 'Run huaweicloud_auth_switch action=clear or action=persist first.',
    };
  }

  let obs;
  try {
    obs = writeObsConfig(credentials);
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      nextStep: 'Run "npx huaweicloud-devkit auth init" to refresh credentials and region.',
    };
  }

  const profile = resolveManagedProfile();
  let hcloud = { ok: false, message: 'KooCLI not installed' };
  if (hcloudInstalled()) {
    if (!profile) {
      hcloud = { ok: false, message: 'KooCLI current profile unresolved' };
    } else {
      const r = runHcloudConfigure(profile, credentials.ak, credentials.sk, credentials.region);
      hcloud = r.ok
        ? { ok: true, message: `KooCLI config synced to profile=${profile}` }
        : { ok: false, message: 'KooCLI config sync failed', error: r.error };
    }
  }

  writeLastSync();

  return {
    ok: true,
    profile,
    obs: { configured: true, path: obs.path, endpoint: obs.endpoint },
    hcloud,
    credentialsConfigured: true,
    agents: getAgentRegistrationStatuses(target).agents,
    note: 'OBS credentials were synced from the global credential vault. Agent MCP registration is managed by "npx huaweicloud-devkit install --target <agent>".',
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/auth-credentials.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add test/auth-credentials.test.mjs plugins/huaweicloud-core/src/auth/service.mjs
git commit -m "feat(auth): audit status + R7 current-profile sync + R10 runtime guard"
```

---

### Task 4: tools.mjs — 新增 huaweicloud_auth_switch 与 huaweicloud_auth_confirm

**Files:**

- Modify: `plugins/huaweicloud-core/src/tools.mjs`
- Test: `test/tools.test.mjs`

**Interfaces:**

- Consumes: Task 1/2/3 exports；`readGlobalCredentials/writeGlobalCredentials`；`setConfiguredBySession`；`backupGlobalCredentials/restoreGlobalCredentialsBackup`；`reconcile` 流程。
- Produces:
  - tool `huaweicloud_auth_switch`：
    - params: `{ mode: 'import'|'memory'|'mcp-config', action: 'persist'|'temporary'|'clear', region?, securityToken? }`
    - `clear` → `clearRuntimeCredentials()`；返回 `{ status:'cleared' }`
    - `temporary` → `setRuntimeCredentials(ak,sk,securityToken??undefined,region)`；`mcp-config` 从 `readCodeArtsCredentials` 取；`import` 从 `~/.config/huaweicloud/creds-import.json` 读并擦除；返回 `{ status:'ok', scope:'temporary' }`
    - `persist` → R2 流程：备份旧 S1 → 写 S1(configuredBySession=true) → writeObsConfig → runHcloudConfigure(current) → writeLastSync → 返回结果
  - tool `huaweicloud_auth_confirm`：`{ token, decision: 's1'|'manual' }` → 执行对应覆盖，返回 `{ status:'ok' }`

- [ ] **Step 1: 写失败测试（追加 test/tools.test.mjs）**

```js
test('auth_switch temporary sets runtime credentials for api path', async () => {
  const prev = {
    AK: process.env.HW_ACCESS_KEY,
    SK: process.env.HW_SECRET_KEY,
  };
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  try {
    const out = await callTool('huaweicloud_auth_switch', {
      mode: 'memory',
      action: 'temporary',
      ak: 'RUNTIME_AK',
      sk: 'RUNTIME_SK',
      region: 'cn-north-4',
    });
    assert.equal(out.scope, 'temporary');
    const resolved = resolveCredentialsWithRuntime({});
    assert.equal(resolved.ak, 'RUNTIME_AK');
  } finally {
    clearRuntimeCredentials();
    if (prev.AK === undefined) delete process.env.HW_ACCESS_KEY;
    else process.env.HW_ACCESS_KEY = prev.AK;
    if (prev.SK === undefined) delete process.env.HW_SECRET_KEY;
    else process.env.HW_SECRET_KEY = prev.SK;
  }
});

test('auth_switch clear resets runtime', async () => {
  setRuntimeCredentials('A', 'B', undefined, 'cn-north-4');
  const out = await callTool('huaweicloud_auth_switch', { action: 'clear' });
  assert.equal(out.status, 'cleared');
  let threw = false;
  try {
    resolveCredentialsWithRuntime({});
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/tools.test.mjs`
Expected: FAIL — cannot find tool / unknown

- [ ] **Step 3: 实现**

在 tools.mjs 顶部 import 区补：

```js
import {
  setConfiguredBySession,
  backupGlobalCredentials,
  restoreGlobalCredentialsBackup,
} from './auth/credentials.mjs';
import { runHcloudConfigure, resolveManagedProfile, scanState } from './auth/reconcile.mjs';
import { readCodeArtsCredentials } from './auth/credentials.mjs';
```

新增工具定义（追加到 TOOL_DEFINITIONS 数组中 `huaweicloud_auth_init` 之后）：

```js
{
  name: 'huaweicloud_auth_switch',
  description:
    'Switch Huawei Cloud credentials within the current session. action=temporary keeps AK/SK in memory only (restart loses them; hcloud commands are unaffected and an A+C warning will be raised). action=persist writes S1 (single source of truth) with configuredBySession flag and propagates to S2 (KooCLI current profile) and S3 (OBS). action=clear resets runtime credentials. mode=import reads AK/SK from ~/.config/huaweicloud/creds-import.json then wipes it (SK never enters conversation). mode=memory passes AK/SK as tool arguments (SK is visible to model - prefer import). mode=mcp-config reads the injected mcp_settings environment.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['import', 'memory', 'mcp-config'], description: 'Credential source channel' },
      action: { type: 'string', enum: ['persist', 'temporary', 'clear'], description: 'Apply scope' },
      ak: { type: 'string' },
      sk: { type: 'string' },
      securityToken: { type: 'string' },
      region: { type: 'string' },
    },
  },
},
{
  name: 'huaweicloud_auth_confirm',
  description:
    'Confirm a pending credential reconciliation choice returned by auth_switch persist when S1 already holds a different account (R2). decision=s1 keeps S1 as source of truth and propagates it; decision=newImported propagates the newly imported account into S1 and mirrors.',
  inputSchema: {
    type: 'object',
    properties: {
      token: { type: 'string', description: 'confirmation token from the needs_confirmation response' },
      decision: { type: 'string', enum: ['s1', 'newImported'] },
    },
  },
},
```

在 `callTool` switch 中补两个 case（放在 `huaweicloud_auth_init` case 之后）：

```js
case 'huaweicloud_auth_switch': {
  const action = args.action || 'temporary';
  if (action === 'clear') {
    clearRuntimeCredentials();
    return { status: 'cleared', message: 'Runtime credentials cleared. Fallback to env/file/S1.' };
  }

  let ak = args.ak || '';
  let sk = args.sk || '';
  let securityToken = args.securityToken || '';
  let region = args.region || '';
  let sourceChannel = args.mode || 'memory';

  if (sourceChannel === 'import' && (!ak || !sk)) {
    const imported = readImportFile();
    if (imported) ({ ak, sk, securityToken, region } = imported);
  }
  if (sourceChannel === 'mcp-config' && (!ak || !sk)) {
    const cc = readCodeArtsCredentials();
    if (cc) {
      ak = cc.ak; sk = cc.sk;
      securityToken = cc.securityToken || '';
      region = cc.region || region;
    }
  }

  if (!ak || !sk) {
    throw new Error('ak and sk are required (or provide creds-import.json for mode=import).');
  }

  if (action === 'temporary') {
    setRuntimeCredentials(ak, sk, securityToken || undefined, region);
    return {
      status: 'ok',
      scope: 'temporary',
      note: 'Runtime credentials active for this MCP process. hcloud commands still use the KooCLI current profile; use action=persist to align files.',
    };
  }

  // action === 'persist'
  const prev = readGlobalCredentials();
  const conflict = prev?.ak && prev.ak !== ak;
  if (conflict) {
    backupGlobalCredentials();
    const token = `switch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingConfirms.set(token, {
      newAk: ak,
      newSk: sk,
      newSecurityToken: securityToken,
      newRegion: region,
      oldFingerprint: fingerprint2(prev.ak, prev.sk),
      newFingerprint: fingerprint2(ak, sk),
    });
    return {
      status: 'needs_confirmation',
      confirmToken: token,
      options: [
        { key: 's1', label: '以 S1 现有账号为准（不切换，恢复 backup）' },
        { key: 'newImported', label: `以新账号（${fingerprint2(ak, sk)}）为准，覆盖 S1 并同步全部凭证文件` },
      ],
    };
  }

  return persistCredentials(ak, sk, securityToken, region);
}
case 'huaweicloud_auth_confirm': {
  const pending = pendingConfirms.get(args.token);
  if (!pending) throw new Error('confirmToken not found or expired.');
  pendingConfirms.delete(args.token);
  if (args.decision === 's1') {
    return { status: 'ok', outcome: 'aborted', message: '保持 S1 现有账号，未覆盖。' };
  }
  return persistCredentials(pending.newAk, pending.newSk, pending.newSecurityToken, pending.newRegion);
}
```

并在 tools.mjs 文件作用域内追加辅助函数（放在 switch 函数之前/同文件，模块级 `const pendingConfirms = new Map();`）：

tools.mjs 顶部已有 import（需按 Task 2/3 补充，勿用 require）：

```js
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { writeObsConfig, writeLastSync, setConfiguredBySession, backupGlobalCredentials } from './auth/credentials.mjs';
import { fingerprint, runHcloudConfigure, resolveManagedProfile } from './auth/reconcile.mjs';
```

模块级辅助实现（authentication uses fingerprint from reconcile.mjs，避免重复）：

```js
const pendingConfirms = new Map();

function readImportFile() {
  const path = join(homedir(), '.config', 'huaweicloud', 'creds-import.json');
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    rmSync(path, { force: true });
    return {
      ak: String(data.ak || ''),
      sk: String(data.sk || ''),
      securityToken: String(data.securityToken || ''),
      region: String(data.region || ''),
    };
  } catch {
    return null;
  }
}

function persistCredentials(ak, sk, securityToken, region) {
  const before = backupGlobalCredentials();
  writeGlobalCredentials({ ak, sk: String(sk), securityToken, region, configuredBySession: true });
  setConfiguredBySession(true);
  let obs = { ok: false };
  try {
    writeObsConfig({ ak, sk, securityToken, region });
    obs = { ok: true };
  } catch (e) {
    obs = { ok: false, error: e.message };
  }
  const profile = resolveManagedProfile();
  let hcloud;
  if (!profile) {
    hcloud = { ok: false, reason: 'KooCLI current profile unresolved' };
  } else {
    hcloud = runHcloudConfigure(profile, ak, sk, region);
  }
  writeLastSync();
  return {
    status: 'ok',
    scope: 'persist',
    backedUp: Boolean(before),
    obs: obs.ok ? { configured: true } : { configured: false, error: obs.error },
    hcloud,
    note: 'S1 written with configuredBySession; S2(current profile) and S3 synced. If devspace restarts the session, env-injected credentials become the default again.',
  };
}
```

在 auth_switch 的 `needs_confirmation` 分支使用 `fingerprint(prev.ak, prev.sk)` 与 `fingerprint(ak, sk)`（来自 reconcile.mjs），替换示意中的 `fingerprint2`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/tools.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add test/tools.test.mjs plugins/huaweicloud-core/src/tools.mjs
git commit -m "feat(tools): huaweicloud_auth_switch (import/memory/mcp-config x persist/temporary/clear) + auth_confirm"
```

---

### Task 5: hcloud-cli.mjs — runHcloud 前置 A+C 一致性警告（G4/R10 兜底）

**Files:**

- Modify: `plugins/huaweicloud-core/src/hcloud-cli.mjs`
- Test: `test/hcloud-cli.test.mjs`

**Interfaces:**

- Consumes: Task 2 `hasRuntimeCredentials`、`scanState`
- Produces: `runHcloud` 在 runtime 有效且 `runtimeFingerprint !== currentFingerprint` 时，返回值附 `authWarning` 字段（不阻塞执行）。

- [ ] **Step 1: 写失败测试（追加）**

```js
test('runHcloud emits authWarning when runtime differs from current profile', async () => {
  const prev = process.env.HW_ACCESS_KEY;
  delete process.env.HW_ACCESS_KEY;
  setRuntimeCredentials('RT_AK', 'RT_SK', undefined, 'cn-north-4');
  try {
    const result = await runHcloud(['--version'], { executable: 'echo', executableArgs: ['-n', 'ok'] });
    // fake hcloud → result.ok true
    assert.ok(result.ok);
  } finally {
    clearRuntimeCredentials();
    if (prev === undefined) delete process.env.HW_ACCESS_KEY;
    else process.env.HW_ACCESS_KEY = prev;
  }
});
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL（尚无 authWarning，或行为不满足）

- [ ] **Step 3: 实现**

在 `runHcloud` 返回前注入警告（在 runHcloudOnce 成功分支的 result 上附加；最简方式是在 `runHcloud` 循环外收口）：

```js
// 在 runHcloud() 内、resolve 返回之前
const finalResult = { ...result };
if (finalResult.ok) {
  try {
    const { hasRuntimeCredentials, scanState } = await import('./auth/reconcile.mjs');
    if (hasRuntimeCredentials()) {
      const scan = scanState();
      if (
        scan.stores.runtimeFingerprint &&
        scan.stores.currentFingerprint &&
        scan.stores.runtimeFingerprint !== scan.stores.currentFingerprint
      ) {
        finalResult.authWarning =
          '会话内临时账号与 KooCLI current 档不一致：hcloud 命令仍使用 current 档账号。如需对齐请用 huaweicloud_auth_switch action=persist。';
      }
    }
  } catch {
    /* reconcile unavailable → skip warning */
  }
}
return finalResult;
```

调整 `scanState`（Task 2）补足 runtime 字段：在返回对象中加：

```js
let runtimeFingerprint = null;
let hasRuntime = false;
try {
  const rt = resolveCredentialsWithRuntime(); // 通过 Module 内已有引用
  runtimeFingerprint = fingerprint(rt.ak, rt.sk);
  hasRuntime = true;
} catch {}
```

并确保 `scanState` 返回 `hasRuntime`、`runtimeFingerprint`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/hcloud-cli.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add test/hcloud-cli.test.mjs plugins/huaweicloud-core/src/hcloud-cli.mjs plugins/huaweicloud-core/src/auth/reconcile.mjs
git commit -m "feat(hcloud-cli): runtime/current A+C warning before hcloud commands"
```

---

### Task 6: setup-cli.mjs — cmdAuthReconcile + configureHcloud R7 + 文案错误清理

**Files:**

- Modify: `plugins/huaweicloud-core/src/setup-cli.mjs`
- Test: `test/cross-platform-install.test.mjs`（命令挂载）、`test/structure.test.mjs`

**Interfaces:**

- Consumes: Task 2/3 exports
- Produces: `cmdAuthReconcile()`；`configureHcloud` 增加 `--cli-profile=<resolveManagedProfile()>`；删除 install-hcloud 横幅中 `hcloud configure init` 备选；`runVersionCheck` authHint、OBS region 提示指向 `auth init`。

- [ ] **Step 1: 写失败测试（追加）**

```js
test('reconcile flag registered in CLI help', () => {
  // cmdAuth switch for 'auth reconcile' → returns cmdAuthReconcile
  // structural: cmdAuth 对子命令 reconcile 的处理
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/structure.test.mjs test/cross-platform-install.test.mjs`

- [ ] **Step 3: 实现**

在 `setup-cli.mjs` 的 `cmdAuth` switch 补：

```js
if (sub === 'reconcile') return cmdAuthReconcile();
```

新增 `cmdAuthReconcile`：

```js
async function cmdAuthReconcile() {
  console.log(BANNER);
  console.log('HuaweiCloud DevKit Credential Reconciliation\n');
  const { scanState, runHcloudConfigure, resolveManagedProfile } = await import('./auth/reconcile.mjs');
  const { writeLastSync, readGlobalCredentials } = await import('./auth/credentials.mjs');
  const state = scanState();
  if (state.inconsistencies.length === 0) {
    console.log('All credential files are consistent. ✓');
    return;
  }
  for (const inc of state.inconsistencies) {
    console.log(
      `  [${inc.store}] fingerprint ${inc.fingerprint} differs from S1 ${state.stores.s1Fingerprint}${inc.manualModified ? ' (manual modified)' : ''}`,
    );
  }
  const ask = await readLineQuestion('以 S1 为准同步到不一致文件? (y/N) ');
  if (!['y', 'Y', 'yes'].includes(ask.trim())) {
    console.log('Aborted.');
    return;
  }
  const credentials = readGlobalCredentials();
  try {
    const { writeObsConfig } = await import('./auth/credentials.mjs');
    writeObsConfig(credentials);
  } catch (e) {
    console.log(`OBS sync failed: ${e.message}`);
  }
  const profile = resolveManagedProfile();
  if (profile) {
    const r = runHcloudConfigure(profile, credentials.ak, credentials.sk, credentials.region);
    console.log(`  KooCLI ${r.ok ? 'synced' : 'sync failed'}: profile=${profile} ${r.error || ''}`);
  }
  writeLastSync();
  console.log('Done. .last_sync refreshed.');
}
```

`configureHcloud` 改 R7（在 `cmdAuthInit` 中也调用它，需兼容无 profile 场景）：

```js
function configureHcloud(credentials) {
  const hcloudBin = findHcloudBin() || process.env.HCLOUD_BIN || 'hcloud';
  const args = [
    'configure',
    'set',
    `--cli-profile=${configuredProfileName()}`,
    `--cli-access-key=${credentials.ak}`,
    `--cli-secret-key=${credentials.sk}`,
    `--cli-region=${credentials.region || ''}`,
  ];
  // ...同原实现
}
function configuredProfileName() {
  // parse ~/.hcloud/config.json current; default 'default'
  try {
    const path = join(homedir(), '.hcloud', 'config.json');
    if (existsSync(path)) {
      const cfg = JSON.parse(readFileSync(path, 'utf8'));
      return cfg.current || 'default';
    }
  } catch {}
  return 'default';
}
```

删除 `setup-cli.mjs:3729` 的 `console.log('  KooCLI only (alternative): hcloud configure init');`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test`（全量）

- [ ] **Step 5: 提交**

```bash
git add plugins/huaweicloud-core/src/setup-cli.mjs test/structure.test.mjs test/cross-platform-install.test.mjs
git commit -m "feat(cli): auth reconcile command + R7 configuredProfileName + remove configure init hint"
```

---

### Task 7: skill/default message 文案 + 全量测试矩阵 + lint/validate

**Files:**

- Modify: `plugins/huaweicloud-core/skills/huaweicloud-cli-and-auth/SKILL.md`（取消 SAFE/DANGEROUS 双档，统一 auth init）
- Test: 全量矩阵

- [ ] **Step 1: 更新文档**

- [ ] **Step 2: 写全场景用例矩阵测试（合并到一个新文件 test/cred-reconcile-e2e.test.mjs）**

覆盖以下用例（每例用 `withTempHome` + fake hcloud fixture）：

1. auth init 后三文件一致（fetch S1/S2/S3 指纹全等）
2. S2 手改（伪造 current 档）→ scanState 报 inconsistency + manualModified=true
3. S3 手改 → scanState 报 inconsistency + manualModified
4. syncAuth 在 runtime 非空时返回 R10 拒绝
5. syncAuth 正常传播按 current 档写入 fake hcloud 的 argv（校验日志含 `--cli-profile=deploy`）
6. auth_switch temporary → runtime 生效，运行 auth_sync 被 R10 拒
7. auth_switch persist 首次（无 S1）→ 三文件一致 + configuredBySession=true
8. auth_switch persist 冲突（S1 = A，新 = B）→ 返回 needs_confirmation + confirmToken
9. auth_confirm decision=newImported → 三文件一致、backup 存在
10. auth_confirm decision=s1 → S1 不变
11. auth_switch clear → runtime 清空、后续 syncAuth 可执行
12. create import file → auth_switch mode=import 读取后文件被擦除
13. 环境变量注入时无 configuredBySession → resolveCredentials 用 env
14. configuredBySession=true 时 resolveCredentials 用 S1（R9）
15. runtime 非空时 scanState().hasRuntime=true 且禁止 reconcile 自动写（R10）
16. restoreGlobalCredentialsBackup 恢复旧 S1

- [ ] **Step 3: 运行全量测试 + lint + validate**

```bash
cd /home/zhangranran/tmp/devkit-analyze/huaweicloud-devkit/.worktrees/cred-rework
npm test
npm run lint:js
npm run validate
```

Expected: 全绿。新增用例全部通过。

- [ ] **Step 4: 提交**

```bash
git add test/cred-reconcile-e2e.test.mjs plugins/huaweicloud-core/skills/huaweicloud-cli-and-auth/SKILL.md
git commit -m "test(cred): full matrix 16 scenarios + auth skill wording"
```
