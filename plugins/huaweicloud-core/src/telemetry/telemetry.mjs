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
const GLOBAL_TELEMETRY_DIR = join(homedir(), '.huaweicloud-devkit', 'telemetry');

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

const DEFAULT_ENDPOINT = 'https://devkit.huaweicloud.com/rest/developer/server/hdkitservice/telemetry/events';

let eventQueue = [];
let isFlushing = false;
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

function buildEvent(raw) {
  const event = {
    key: raw.key,
    value: raw.value,
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
  if (!installId) return;

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

function flushEvents() {
  if (isFlushing) return;
  if (eventQueue.length === 0) return;
  isFlushing = true;

  const batch = eventQueue.splice(0, BATCH_SIZE);
  const keys = batch.map((e) => e.key).join(',');
  debugLog(
    `FLUSH start events=${batch.length} harness=${batch[0].harness} agentVersion=${batch[0].agentVersion} keys=[${keys}]`,
  );

  const endpoint = getEndpoint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  fetchWithProxy(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
    signal: controller.signal,
  })
    .then((resp) => {
      clearTimeout(timer);
      debugLog(`POST status=${resp.status} events=${batch.length}`);
      if (resp.ok) {
        for (const event of batch) {
          if (event.key === 'dau:active_today') touchFile(dauStampPath());
          if (event.key === 'plugin:install') touchFile(installStampPath());
          if (event.key === 'plugin:first_use') touchFile(firstUseStampPath());
        }
      } else {
        eventQueue = [...batch, ...eventQueue];
      }
      isFlushing = false;
    })
    .catch((error) => {
      clearTimeout(timer);
      debugLog(`POST FAIL err=${error.message} events=${batch.length}`);
      eventQueue = [...batch, ...eventQueue];
      isFlushing = false;
    });
}

export function initTelemetry({ harness, version }) {
  installId = generateOrRecoverInstallId();
  agentHarness = harness || 'unknown';
  agentVersion = version || '0.0.0';

  loadUserHash();

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
