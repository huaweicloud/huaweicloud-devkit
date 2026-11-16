import { createRequire } from 'node:module';

const NODE_FLOORS = [
  { major: 22, minor: 19 },
  { major: 23, minor: 4 },
];

export function parseNodeVersion(version = process.versions.node) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return { major, minor };
}

export function isSupportedNode(version = process.versions.node) {
  const { major, minor } = parseNodeVersion(version);
  if (major > NODE_FLOORS[NODE_FLOORS.length - 1].major) return true;
  const floor = NODE_FLOORS.find((entry) => entry.major === major);
  return floor ? minor >= floor.minor : false;
}

function displayVersion(version) {
  return String(version).startsWith('v') ? String(version) : `v${version}`;
}

export function sqliteGuidance(version = process.versions.node) {
  const current = displayVersion(version);
  if (!isSupportedNode(version)) {
    return `Node.js >= 22.19 (or >= 23.4.0) is required for the OfficeAce integration (current: ${current}).`;
  }
  return `node:sqlite failed to load on Node ${current}. Please upgrade Node.js or report this issue.`;
}

function sqliteUnavailable() {
  const error = new Error(sqliteGuidance());
  error.code = 'HCDEVKIT_SQLITE_UNAVAILABLE';
  return error;
}

let sqliteModule;

export function loadSqliteModule() {
  if (sqliteModule) return sqliteModule;
  try {
    const candidate = createRequire(import.meta.url)('node:sqlite');
    if (!candidate || typeof candidate.DatabaseSync !== 'function') {
      throw sqliteUnavailable();
    }
    sqliteModule = candidate;
    return candidate;
  } catch (error) {
    if (error?.code === 'HCDEVKIT_SQLITE_UNAVAILABLE') throw error;
    if (error?.code === 'ERR_UNKNOWN_BUILTIN_MODULE') throw sqliteUnavailable();
    throw error;
  }
}
