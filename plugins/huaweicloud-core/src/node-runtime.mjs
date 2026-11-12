import { createRequire } from 'node:module';

const NODE_FLOOR_MAJOR = 22;
const NODE_FLOOR_MINOR = 5;

export function parseNodeVersion(version = process.versions.node) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return { major, minor };
}

export function needsSqliteFlag(version = process.versions.node) {
  const { major, minor } = parseNodeVersion(version);
  if (major === 22) return minor >= NODE_FLOOR_MINOR && minor < 13;
  if (major === 23) return minor < 4;
  return false;
}

export function sqliteSupport(version = process.versions.node) {
  const { major, minor } = parseNodeVersion(version);
  if (major < NODE_FLOOR_MAJOR || (major === NODE_FLOOR_MAJOR && minor < NODE_FLOOR_MINOR)) {
    return 'unsupported';
  }
  return needsSqliteFlag(version) ? 'flag' : 'ok';
}

function displayVersion(version) {
  return String(version).startsWith('v') ? String(version) : `v${version}`;
}

export function sqliteGuidance(version = process.versions.node) {
  const support = sqliteSupport(version);
  if (support === 'unsupported') {
    return `OfficeAce integration requires Node.js >= 22.5 (current: ${displayVersion(version)}).`;
  }
  if (support === 'flag') {
    return (
      'OfficeAce integration requires Node.js >= 22.5. ' +
      `On Node ${displayVersion(version)} it also needs --experimental-sqlite. ` +
      'The CLI enables it automatically; if setup-cli was invoked directly, set ' +
      'NODE_OPTIONS=--experimental-sqlite and retry.'
    );
  }
  return `node:sqlite failed to load on Node ${displayVersion(version)}. Please upgrade Node.js or report this issue.`;
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
