import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';

// #1014: 遥测分级上报——P0 领券类工具同步 flush、领券成功补缓存 userHash、
// flush 前身份字段兜底回填、installId 惰性恢复、P1 退出兜底 flush 注册。

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];

// 隔离 telemetry.mjs 模块级目录常量（GLOBAL_TELEMETRY_DIR 在 import 时固定）：
// 临时 HUAWEICLOUD_DEVKIT_HOME + 带 query 的 import 强制新模块实例。
// 同时启动本地 mock 服务承接遥测 POST（HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT）。
async function withIsolatedTelemetry(fn, { hdkitHandler } = {}) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdk-tel-1014-'));
  const prev = {
    home: process.env.HUAWEICLOUD_DEVKIT_HOME,
    endpoint: process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT,
    hdkit: process.env.HDKITSERVICE_ENDPOINT,
    ak: process.env.HW_ACCESS_KEY,
    sk: process.env.HW_SECRET_KEY,
    noProxy: process.env.NO_PROXY,
    proxy: Object.fromEntries(PROXY_KEYS.map((k) => [k, process.env[k]])),
  };
  process.env.HUAWEICLOUD_DEVKIT_HOME = tmp;
  process.env.NO_PROXY = 'localhost,127.0.0.1';
  for (const k of PROXY_KEYS) delete process.env[k];

  const telemetryBodies = [];
  const hdkitRequests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const respond = (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url.startsWith('/hdkit/')) {
        hdkitRequests.push({ url: req.url, body });
        respond(hdkitHandler ? hdkitHandler(req.url, body) : { ok: true });
        return;
      }
      try {
        telemetryBodies.push(...JSON.parse(body));
      } catch {}
      respond({ ok: true });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const iso = `iso-${Date.now()}-${port}`;
  process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT = `http://127.0.0.1:${port}/t`;
  process.env.HDKITSERVICE_ENDPOINT = `http://127.0.0.1:${port}/hdkit/`;

  // 防止 isolated 模块注册的退出兜底 handler 泄漏到测试进程
  const signalListenersBefore = {
    SIGTERM: process.listeners('SIGTERM'),
    SIGINT: process.listeners('SIGINT'),
  };

  try {
    const telemetry = await import(`../plugins/huaweicloud-core/src/telemetry/telemetry.mjs?${iso}`);
    return await fn(telemetry, { tmp, received: telemetryBodies, hdkitRequests, port, iso });
  } finally {
    for (const [sig, before] of Object.entries(signalListenersBefore)) {
      for (const listener of process.listeners(sig)) {
        if (!before.includes(listener)) process.removeListener(sig, listener);
      }
    }
    for (const [key, value] of Object.entries(prev)) {
      if (key === 'proxy') {
        for (const [k, v] of Object.entries(value)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      } else if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('flushEvents backfills userHash on queued events enqueued before hash was known', async () => {
  await withIsolatedTelemetry(async (telemetry, { received }) => {
    telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
    // userHash 尚未解析到时入队（模拟 initialize 阶段 3s 竞速超时场景）
    telemetry.trackToolInvoke('voucher_claim_probe');
    // 领券成功后补缓存 userHash（#1014 P0）
    telemetry.cacheUserHash('hash_after_claim_1014');
    await telemetry.flushEvents();
    const toolEvent = received.find((e) => e.key === 'tool:voucher_claim_probe');
    assert.ok(toolEvent, 'tool event must be flushed');
    assert.equal(toolEvent.userHash, 'hash_after_claim_1014');
  });
});

test('flushEvents backfills userHash from user-hash file via loadUserHash fallback', async () => {
  await withIsolatedTelemetry(async (telemetry, { tmp, received }) => {
    telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
    telemetry.trackToolInvoke('probe_file_backfill');
    // 不走 cacheUserHash，直接落盘 user-hash 文件（跨进程写入场景）
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(path.join(tmp, '.huaweicloud-devkit', 'telemetry'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.huaweicloud-devkit', 'telemetry', 'user-hash'), 'hash_from_file_1014');
    await telemetry.flushEvents();
    const toolEvent = received.find((e) => e.key === 'tool:probe_file_backfill');
    assert.ok(toolEvent);
    assert.equal(toolEvent.userHash, 'hash_from_file_1014');
  });
});

test('enqueueEvent lazily recovers installId instead of dropping the event', async () => {
  await withIsolatedTelemetry(async (telemetry, { received }) => {
    // 不调用 initTelemetry —— 直接入队（未走 initialize 的 tools/call 场景）
    telemetry.trackToolInvoke('probe_no_init');
    await telemetry.flushEvents();
    const toolEvent = received.find((e) => e.key === 'tool:probe_no_init');
    assert.ok(toolEvent, 'event must not be dropped when installId was not initialized');
    assert.equal(typeof toolEvent.installId, 'string');
    assert.ok(toolEvent.installId.length > 0);
  });
});

test('flushAllEvents drains a multi-batch queue', async () => {
  await withIsolatedTelemetry(async (telemetry, { received }) => {
    telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
    const BATCH = 100;
    for (let i = 0; i < 2 * BATCH + 7; i++) {
      telemetry.enqueueEvent({ key: 'tool:probe_batch', value: String(i) });
    }
    await telemetry.flushAllEvents();
    const toolEvents = received.filter((e) => e.key === 'tool:probe_batch');
    assert.equal(toolEvents.length, 2 * BATCH + 7);
  });
});

test('concurrent flushEvents calls share one in-flight flush', async () => {
  await withIsolatedTelemetry(async (telemetry, { received }) => {
    telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
    telemetry.trackToolInvoke('probe_concurrent');
    const p1 = telemetry.flushEvents();
    const p2 = telemetry.flushEvents();
    await Promise.all([p1, p2]);
    assert.equal(received.filter((e) => e.key === 'tool:probe_concurrent').length, 1);
  });
});

test('voucher claim tool call flushes telemetry synchronously with userHash (P0 e2e)', async () => {
  await withIsolatedTelemetry(
    async (_telemetry, { received, hdkitRequests }) => {
      // 假凭证仅发往本地 mock hdkit 服务，不会触达真实云端
      process.env.HW_ACCESS_KEY = 'TEST_AK_1014';
      process.env.HW_SECRET_KEY = 'TEST_SK_1014';

      // mcp-protocol 的静态导入链会创建 telemetry.mjs 的"真实路径"模块实例；
      // 此刻 HUAWEICLOUD_DEVKIT_HOME 已指向 tmp，故该实例同样被隔离。
      const { dispatch } = await import('../plugins/huaweicloud-core/src/mcp-protocol.mjs');

      // #1055 D9-12: tools/call requires a completed MCP initialize handshake.
      await dispatch('initialize', { clientInfo: {}, protocolVersion: '2024-11-05' });

      const result = await dispatch('tools/call', {
        name: 'huaweicloud_voucher_claim',
        arguments: {},
      });
      assert.equal(result.isError, false);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.claimed, true);
      assert.equal(
        hdkitRequests.some((r) => r.url.includes('voucher/claim')),
        true,
        'claim request must hit mock hdkit service',
      );

      // P0 断言：callTool 完毕后无需等待 60s 定时器，事件已同步送达；
      // 且领券响应携带的 userHash 已被 cacheUserHash 缓存并兜底回填到该事件。
      const claimEvent = received.find((e) => e.key === 'tool:huaweicloud_voucher_claim');
      assert.ok(claimEvent, 'voucher claim tool event must be flushed synchronously');
      assert.equal(claimEvent.userHash, 'hash_claim_resp_1014');
      assert.equal(typeof claimEvent.installId, 'string');
    },
    {
      hdkitHandler: () => ({ claimed: true, userHash: 'hash_claim_resp_1014', coupon_id: 'CP_TEST' }),
    },
  );
});

test('registerExitFlush is idempotent and removable', async () => {
  await withIsolatedTelemetry(async (telemetry) => {
    const before = process.listeners('SIGTERM').length;
    const unregister = telemetry.registerExitFlush();
    assert.equal(process.listeners('SIGTERM').length, before + 1);
    // 二次注册不重复
    telemetry.registerExitFlush();
    assert.equal(process.listeners('SIGTERM').length, before + 1);
    unregister();
    assert.equal(process.listeners('SIGTERM').length, before);
  });
});

test('initTelemetry registers exit flush handler', async () => {
  await withIsolatedTelemetry(async (telemetry) => {
    const before = {
      SIGTERM: process.listeners('SIGTERM').length,
      SIGINT: process.listeners('SIGINT').length,
    };
    telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
    assert.equal(process.listeners('SIGTERM').length, before.SIGTERM + 1);
    assert.equal(process.listeners('SIGINT').length, before.SIGINT + 1);
  });
});
