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

import { fetchWithProxy } from '../proxy/proxy-agent.ts';

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
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
      const v = parsed !== null && typeof parsed === 'object' ? (parsed as { version?: unknown }).version : undefined;
      if (v) {
        PLUGIN_VERSION = String(v);
        break;
      }
    }
  }
} catch {}
function hookEventsPath(): string {
  return join(AGENT_TELEMETRY_DIR, 'hook-events.jsonl');
}
function installStampPath(): string {
  return join(AGENT_TELEMETRY_DIR, 'install-stamp');
}
function installCounterPath(): string {
  return join(AGENT_TELEMETRY_DIR, 'install-counter');
}
function dauStampPath(): string {
  return join(AGENT_TELEMETRY_DIR, 'dau-stamp');
}
function firstUseStampPath(): string {
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

// `value` stays unknown at the boundary: callers pass strings, but hook-event
// JSON is parsed and validated before it reaches buildEvent.
interface TelemetryEventInput {
  key: string;
  value?: unknown;
  capability?: string;
}

interface TelemetryEvent {
  key: string;
  value: string;
  installId: string | null;
  userHash: string | null;
  version: string;
  harness: string;
  agentVersion: string;
  os: string;
  osVersion: string;
  capability?: string;
  _retries?: number;
}

let eventQueue: TelemetryEvent[] = [];
let isFlushing = false;
let flushTimer: NodeJS.Timeout | null = null;
let lastCheckedDate = '';
let installId: string | null = null;
let userHash: string | null = null;
let agentHarness = 'unknown';
let agentVersion = '0.0.0';
const osTypeStr = osType();
const osVersionStr = osRelease();

const DEBUG = process.env.HUAWEICLOUD_DEVKIT_DEBUG === 'true';
function debugLogPath(): string {
  return join(AGENT_TELEMETRY_DIR, 'telemetry-debug.log');
}

function debugLog(msg: string): void {
  if (!DEBUG) return;
  try {
    const path = debugLogPath();
    ensureDir(dirname(path));
    appendFileSync(path, `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch (_) {}
}

function ensureDir(dirPath: string = GLOBAL_TELEMETRY_DIR): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function readTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function writeTextFile(filePath: string, content: string): void {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, content, 'utf8');
}

function touchFile(filePath: string): void {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, '', 'utf8');
}

function stampExists(filePath: string): boolean {
  return existsSync(filePath);
}

function getStampUTCDate(filePath: string): string | null {
  try {
    return new Date(statSync(filePath).mtime).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function getUTCToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function generateMachineFinger(): string {
  const host = hostname();
  const nets = networkInterfaces();
  let firstMac = '';
  for (const key of Object.keys(nets).sort((a, b) => a.localeCompare(b))) {
    const list = nets[key];
    if (!list) continue;
    const iface = list.find((a) => a.mac && a.mac !== '00:00:00:00:00:00');
    if (iface) {
      firstMac = iface.mac;
      break;
    }
  }
  const factor = `${host}|${firstMac}|${osTypeStr}|${homedir()}`;
  return createHash('sha256').update(factor).digest('hex');
}

export function generateOrRecoverInstallId(): string {
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

function loadUserHash(): void {
  if (existsSync(USER_HASH_PATH)) {
    const cached = readTextFile(USER_HASH_PATH);
    if (cached) userHash = cached;
  }
}

export function isTelemetryEnabled(): boolean {
  return process.env.HUAWEICLOUD_DEVKIT_TELEMETRY !== 'off';
}

function getEndpoint(): string {
  return process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT || DEFAULT_ENDPOINT;
}

function capabilityFromKey(key: string): string | undefined {
  if (key.startsWith('tool:')) return 'mcp';
  if (key.startsWith('cli:')) return 'cli';
  return undefined;
}

export function sanitizeValue(value: unknown): string {
  let text = typeof value === 'string' ? value : value == null ? '' : String(value);
  text = text.replace(/[\r\n\t]+/g, ' ').trim();
  if (text.length > MAX_VALUE_LENGTH) {
    text = text.slice(0, MAX_VALUE_LENGTH - 3) + '...';
  }
  return text;
}

function buildEvent(raw: TelemetryEventInput): TelemetryEvent {
  const event: TelemetryEvent = {
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

// Hook-event JSON arrives as text; only an object carrying a non-empty string
// key is accepted. Malformed lines are dropped rather than queued.
function toTelemetryEventInput(value: unknown): TelemetryEventInput | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.key !== 'string' || record.key === '') return null;
  const input: TelemetryEventInput = { key: record.key, value: record.value };
  if (typeof record.capability === 'string') input.capability = record.capability;
  return input;
}

export function enqueueEvent(raw: TelemetryEventInput): void {
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

function checkDauPing(): void {
  const today = getUTCToday();
  if (today === lastCheckedDate) return;
  lastCheckedDate = today;
  if (!stampExists(dauStampPath()) || getStampUTCDate(dauStampPath()) !== today) {
    eventQueue.unshift(buildEvent({ key: 'dau:active_today', value: '1' }));
  }
}

function shouldSendFirstUsePing(): boolean {
  return !stampExists(firstUseStampPath());
}

export function trackInstall(): void {
  if (!isTelemetryEnabled()) return;
  ensureDir(AGENT_TELEMETRY_DIR);

  let count = 0;
  const existing = readTextFile(installCounterPath());
  if (existing) count = parseInt(existing, 10) || 0;
  writeTextFile(installCounterPath(), String(count + 1));
}

function consumeInstallCounter(): number {
  ensureDir(AGENT_TELEMETRY_DIR);
  const existing = readTextFile(installCounterPath());
  if (!existing) return 0;
  const count = parseInt(existing, 10) || 0;
  if (count <= 0) return 0;
  writeTextFile(installCounterPath(), '0');
  return count;
}

export function ingestHookEvents(): void {
  const hookPath = hookEventsPath();
  const processingPath = hookPath + '.processing';
  if (existsSync(processingPath)) {
    try {
      const lines = readFileSync(processingPath, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed: unknown = JSON.parse(line);
          const input = toTelemetryEventInput(parsed);
          if (input) eventQueue.push(buildEvent(input));
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

export function trackToolInvoke(toolName: string, value = '1'): void {
  if (!isTelemetryEnabled()) return;
  enqueueEvent({ key: `tool:${toolName}`, value });
}

export function trackSkillRetrieve(skillName: string): void {
  if (!isTelemetryEnabled()) return;
  enqueueEvent({ key: 'skill:retrieve', value: skillName });
}

export function trackSandboxConnect(): void {
  if (!isTelemetryEnabled()) return;
  enqueueEvent({ key: 'sandbox:connect', value: '1' });
}

export function trackSandboxDisconnect(): void {
  if (!isTelemetryEnabled()) return;
  enqueueEvent({ key: 'sandbox:disconnect', value: '1' });
}

export function cacheUserHash(hash: unknown): void {
  if (typeof hash !== 'string' || !hash) return;
  userHash = hash;
  ensureDir();
  writeTextFile(USER_HASH_PATH, hash);
}

export function clearUserHash(): void {
  userHash = null;
  try {
    unlinkSync(USER_HASH_PATH);
  } catch {}
}

function flushEvents(): void {
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
    body: JSON.stringify(batch.map(({ _retries, ...rest }) => rest)),
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
      } else if (resp.status >= 400 && resp.status < 500) {
        debugLog(`POST status=${resp.status} dropping ${batch.length} events (client error)`);
      } else {
        requeueEvents(batch);
      }
      isFlushing = false;
    })
    .catch((error: unknown) => {
      clearTimeout(timer);
      debugLog(`POST FAIL err=${error instanceof Error ? error.message : String(error)} events=${batch.length}`);
      requeueEvents(batch);
      isFlushing = false;
    });
}

function requeueEvents(batch: TelemetryEvent[]): void {
  const kept: TelemetryEvent[] = [];
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

export interface InitTelemetryOptions {
  harness?: string;
  version?: string;
}

export function initTelemetry({ harness, version }: InitTelemetryOptions): void {
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
