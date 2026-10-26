import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  appendFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, hostname, type as osType, networkInterfaces, release as osRelease } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { fetchWithProxy } from '../proxy/proxy-agent.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_DIR = join(__dirname, '..', '..');
const AGENT_TELEMETRY_DIR = join(PLUGIN_DIR, 'telemetry');
const GLOBAL_TELEMETRY_DIR = join(
  (process.env.HUAWEICLOUD_DEVKIT_HOME || '').trim() || homedir(),
  '.huaweicloud-devkit',
  'telemetry',
);

let PLUGIN_VERSION = '0.0.0';
try {
  const pkg1 = join(PLUGIN_DIR, 'package.json');
  const pkg2 = join(PLUGIN_DIR, '..', '..', 'package.json');
  for (const p of [pkg1, pkg2]) {
    if (existsSync(p)) {
      const v = JSON.parse(readFileSync(p, 'utf8')).version;
      if (v) {
        PLUGIN_VERSION = v;
        break;
      }
    }
  }
} catch {}
function hookEventsPath() {
  return join(AGENT_TELEMETRY_DIR, 'hook-events.jsonl');
}
function installStampPath() {
  return join(AGENT_TELEMETRY_DIR, 'install-stamp');
}
function installCounterPath() {
  return join(AGENT_TELEMETRY_DIR, 'install-counter');
}
function dauStampPath() {
  return join(AGENT_TELEMETRY_DIR, 'dau-stamp');
}
function firstUseStampPath() {
  return join(AGENT_TELEMETRY_DIR, 'first-use-stamp');
}
const MACHINE_FINGER_PATH = join(GLOBAL_TELEMETRY_DIR, 'machine-finger');
const INSTALLATION_ID_PATH = join(GLOBAL_TELEMETRY_DIR, 'installation-id');
const USER_HASH_PATH = join(GLOBAL_TELEMETRY_DIR, 'user-hash');

const MAX_QUEUE_SIZE = 500;
const FLUSH_INTERVAL_MS = 60_000;
const BATCH_SIZE = 100;
const FETCH_TIMEOUT_MS = 5000;
const MAX_VALUE_LENGTH = 255;
const MAX_RETRIES = 3;

const DEFAULT_ENDPOINT = 'https://devkit.huaweicloud.com/rest/developer/server/hdkitservice/telemetry/events';

let eventQueue = [];
let currentFlush = null;
let flushTimer = null;
let lastCheckedDate = '';
let installId = null;
let userHash = null;
let agentHarness = 'unknown';
let agentVersion = '0.0.0';
const osTypeStr = osType();
const osVersionStr = osRelease();

const DEBUG = process.env.HUAWEICLOUD_DEVKIT_DEBUG === 'true';
function debugLogPath() {
  return join(AGENT_TELEMETRY_DIR, 'telemetry-debug.log');
}

function debugLog(msg) {
  if (!DEBUG) return;
  try {
    const path = debugLogPath();
    ensureDir(dirname(path));
    appendFileSync(path, `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch (_) {}
}

function ensureDir(dirPath = GLOBAL_TELEMETRY_DIR) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function readTextFile(filePath) {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function writeTextFile(filePath, content) {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, content, 'utf8');
}

function touchFile(filePath) {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, '', 'utf8');
}

function stampExists(filePath) {
  return existsSync(filePath);
}

function getStampUTCDate(filePath) {
  try {
    return new Date(statSync(filePath).mtime).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function getUTCToday() {
  return new Date().toISOString().slice(0, 10);
}

function generateMachineFinger() {
  const host = hostname();
  const nets = networkInterfaces();
  let firstMac = '';
  for (const key of Object.keys(nets).sort((a, b) => a.localeCompare(b))) {
    const iface = nets[key].find((a) => a.mac && a.mac !== '00:00:00:00:00:00');
    if (iface) {
      firstMac = iface.mac;
      break;
    }
  }
  const factor = `${host}|${firstMac}|${osTypeStr}|${homedir()}`;
  return createHash('sha256').update(factor).digest('hex');
}

export function generateOrRecoverInstallId() {
  ensureDir();
  if (existsSync(INSTALLATION_ID_PATH)) {
    const cached = readTextFile(INSTALLATION_ID_PATH);
    if (cached) return cached;
  }
  const finger = existsSync(MACHINE_FINGER_PATH) ? readTextFile(MACHINE_FINGER_PATH) : generateMachineFinger();
  if (!finger) {
    const fallback = randomUUID();
    writeTextFile(INSTALLATION_ID_PATH, fallback);
    return fallback;
  }
  writeTextFile(MACHINE_FINGER_PATH, finger);
  const id = createHash('sha256').update(finger).digest('hex');
  writeTextFile(INSTALLATION_ID_PATH, id);
  return id;
}

function loadUserHash() {
  if (existsSync(USER_HASH_PATH)) {
    const cached = readTextFile(USER_HASH_PATH);
    if (cached) userHash = cached;
  }
}

export function isTelemetryEnabled() {
  return process.env.HUAWEICLOUD_DEVKIT_TELEMETRY !== 'off';
}

function getEndpoint() {
  return process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT || DEFAULT_ENDPOINT;
}

function capabilityFromKey(key) {
  if (key.startsWith('tool:')) return 'mcp';
  if (key.startsWith('cli:')) return 'cli';
  return undefined;
}

export function sanitizeValue(value) {
  if (typeof value !== 'string') value = value == null ? '' : String(value);
  value = value.replace(/[\r\n\t]+/g, ' ').trim();
  if (value.length > MAX_VALUE_LENGTH) {
    value = value.slice(0, MAX_VALUE_LENGTH - 3) + '...';
  }
  return value;
}

function buildEvent(raw) {
  const event = {
    key: raw.key,
    value: sanitizeValue(raw.value),
    installId: installId,
    userHash: userHash,
    version: PLUGIN_VERSION,
    harness: agentHarness,
    agentVersion: agentVersion,
    os: osTypeStr,
    osVersion: osVersionStr,
  };
  const cap = raw.capability || capabilityFromKey(raw.key);
  if (cap) event.capability = cap;
  return event;
}

export function enqueueEvent(raw) {
  if (!isTelemetryEnabled()) return;
  // #1014: installId 未初始化时（如未走 initialize 直接 tools/call）不再丢弃事件，
  // 惰性恢复，避免 telemetry_event 缺记录。
  if (!installId) installId = generateOrRecoverInstallId();

  ingestHookEvents();

  checkDauPing();

  const event = buildEvent(raw);
  eventQueue.push(event);

  if (eventQueue.length > MAX_QUEUE_SIZE) {
    eventQueue = eventQueue.slice(eventQueue.length - MAX_QUEUE_SIZE);
  }

  if (eventQueue.length >= BATCH_SIZE) setImmediate(() => flushEvents());
}

function checkDauPing() {
  const today = getUTCToday();
  if (today === lastCheckedDate) return;
  lastCheckedDate = today;
  if (!stampExists(dauStampPath()) || getStampUTCDate(dauStampPath()) !== today) {
    eventQueue.unshift(buildEvent({ key: 'dau:active_today', value: '1' }));
  }
}

function shouldSendFirstUsePing() {
  return !stampExists(firstUseStampPath());
}

export function trackInstall() {
  if (!isTelemetryEnabled()) return;
  ensureDir(AGENT_TELEMETRY_DIR);

  let count = 0;
  const existing = readTextFile(installCounterPath());
  if (existing) count = parseInt(existing, 10) || 0;
  writeTextFile(installCounterPath(), String(count + 1));
}

function consumeInstallCounter() {
  ensureDir(AGENT_TELEMETRY_DIR);
  const existing = readTextFile(installCounterPath());
  if (!existing) return 0;
  const count = parseInt(existing, 10) || 0;
  if (count <= 0) return 0;
  writeTextFile(installCounterPath(), '0');
  return count;
}

export function ingestHookEvents() {
  const hookPath = hookEventsPath();
  const processingPath = hookPath + '.processing';
  if (existsSync(processingPath)) {
    try {
      const lines = readFileSync(processingPath, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          eventQueue.push(buildEvent(parsed));
        } catch {}
      }
    } catch {
    } finally {
      try {
        unlinkSync(processingPath);
      } catch {}
    }
  }
  if (!existsSync(hookPath)) return;
  try {
    renameSync(hookPath, processingPath);
  } catch {
    return;
  }
}

export function trackToolInvoke(toolName, value = '1') {
  if (!isTelemetryEnabled()) return;
  enqueueEvent({ key: `tool:${toolName}`, value });
}

export function trackSkillRetrieve(skillName) {
  if (!isTelemetryEnabled()) return;
  enqueueEvent({ key: 'skill:retrieve', value: skillName });
}

export function trackSandboxConnect() {
  if (!isTelemetryEnabled()) return;
  enqueueEvent({ key: 'sandbox:connect', value: '1' });
}

export function trackSandboxDisconnect() {
  if (!isTelemetryEnabled()) return;
  enqueueEvent({ key: 'sandbox:disconnect', value: '1' });
}

export function cacheUserHash(hash) {
  if (!hash) return;
  userHash = hash;
  ensureDir();
  writeTextFile(USER_HASH_PATH, hash);
}

export function clearUserHash() {
  userHash = null;
  try {
    unlinkSync(USER_HASH_PATH);
  } catch {}
}

// #1014: flush 前兜底补齐队列事件的缺失身份字段——
// userHash 在 enqueue 之后才解析到（领券响应 / user-hash 文件）时，
// 已入队事件的 userHash 仍为 null，这里统一回填，降低 user_hash null 占比。
function backfillIdentityFields() {
  try {
    if (!installId) installId = generateOrRecoverInstallId();
    if (!userHash) loadUserHash();
    for (const event of eventQueue) {
      if (!event.installId && installId) event.installId = installId;
      if (event.userHash == null && userHash) event.userHash = userHash;
    }
  } catch (_) {
    debugLog('BACKFILL identity fields failed');
  }
}

// #1014: flush 可被 await（P0 领券类工具同步上报）；
// 并发调用复用同一次 in-flight flush（currentFlush 声明于模块顶部）。
export function flushEvents() {
  if (currentFlush) return currentFlush;
  if (eventQueue.length === 0) return Promise.resolve();
  currentFlush = performFlush().finally(() => {
    currentFlush = null;
  });
  return currentFlush;
}

async function performFlush() {
  // flush 前统一回填身份字段（含 userHash 重解析，#1014）：
  // 入队时身份未解析的事件此前会永久携带 null userHash。
  backfillIdentityFields();

  const batch = eventQueue.splice(0, BATCH_SIZE);
  const keys = batch.map((e) => e.key).join(',');
  debugLog(
    `FLUSH start events=${batch.length} harness=${batch[0].harness} agentVersion=${batch[0].agentVersion} keys=[${keys}]`,
  );

  const endpoint = getEndpoint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetchWithProxy(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // #1028: 遥测上报统一携带 X-HW-Agent，与 hdkitservice 其余调用一致，
        // 服务端可按 agent 归因；未初始化/未命中白名单时为 'unknown'。
        'X-HW-Agent': agentHarness || 'unknown',
      },
      body: JSON.stringify(batch.map(({ _retries, ...rest }) => rest)),
      signal: controller.signal,
    });
    clearTimeout(timer);
    debugLog(`POST status=${resp.status} events=${batch.length}`);
    if (resp.ok) {
      for (const event of batch) {
        if (event.key === 'dau:active_today') touchFile(dauStampPath());
        if (event.key === 'plugin:install') touchFile(installStampPath());
        if (event.key === 'plugin:first_use') touchFile(firstUseStampPath());
      }
    } else if (resp.status >= 400 && resp.status < 500) {
      debugLog(`POST status=${resp.status} dropping ${batch.length} events (client error)`);
    } else {
      requeueEvents(batch);
    }
  } catch (error) {
    clearTimeout(timer);
    debugLog(`POST FAIL err=${error.message} events=${batch.length}`);
    requeueEvents(batch);
  }
}

// #1014 P1: 排空整个队列（退出兜底用，单次 flush 只发一个 batch）。
export async function flushAllEvents() {
  const maxBatches = Math.ceil(MAX_QUEUE_SIZE / BATCH_SIZE) + 1;
  for (let i = 0; i < maxBatches && eventQueue.length > 0; i++) {
    await flushEvents();
  }
}

const EXIT_FLUSH_TIMEOUT_MS = 3000;
let exitFlushRegistered = false;

// #1014 P1: SIGTERM/SIGINT 退出兜底 flush（有界超时，避免阻塞退出）。
// 返回反注册函数（仅测试使用）。
export function registerExitFlush() {
  if (exitFlushRegistered) return () => {};
  exitFlushRegistered = true;
  const flushAndExit = () => {
    if (eventQueue.length === 0) {
      // eslint-disable-next-line n/no-process-exit -- signal shutdown with nothing to flush
      process.exit(0);
    }
    const cap = new Promise((resolve) => {
      const t = setTimeout(resolve, EXIT_FLUSH_TIMEOUT_MS);
      t.unref?.();
    });
    const done = flushAllEvents().catch(() => {});
    Promise.race([done, cap]).finally(() => {
      // eslint-disable-next-line n/no-process-exit -- signal shutdown after bounded exit flush
      process.exit(0);
    });
  };
  process.once('SIGTERM', flushAndExit);
  process.once('SIGINT', flushAndExit);
  return () => {
    process.removeListener('SIGTERM', flushAndExit);
    process.removeListener('SIGINT', flushAndExit);
    exitFlushRegistered = false;
  };
}

function requeueEvents(batch) {
  const kept = [];
  for (const event of batch) {
    const retries = event._retries || 0;
    if (retries >= MAX_RETRIES) {
      debugLog(`DROP event key=${event.key} after ${MAX_RETRIES} retries`);
      continue;
    }
    event._retries = retries + 1;
    kept.push(event);
  }
  if (kept.length > 0) eventQueue = [...kept, ...eventQueue];
}

export function initTelemetry({ harness, version }) {
  installId = generateOrRecoverInstallId();
  agentHarness = harness || 'unknown';
  agentVersion = version || '0.0.0';

  loadUserHash();

  // #1014 P1: SIGTERM/SIGINT 退出兜底 flush（队列空时立即退出，零开销）。
  registerExitFlush();

  if (!isTelemetryEnabled()) return;

  if (!stampExists(installStampPath()) && !existsSync(installCounterPath())) {
    trackInstall();
  }

  const pendingInstalls = consumeInstallCounter();
  for (let i = 0; i < pendingInstalls; i++) {
    enqueueEvent({ key: 'plugin:install', value: '1' });
  }

  if (shouldSendFirstUsePing()) {
    enqueueEvent({ key: 'plugin:first_use', value: '1' });
  }

  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => {
    ingestHookEvents();
    checkDauPing();
    if (eventQueue.length > 0) setImmediate(() => flushEvents());
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();

  ingestHookEvents();
  if (eventQueue.length > 0) setImmediate(() => flushEvents());
}
