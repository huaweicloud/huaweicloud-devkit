import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const selfPath = (() => {
  try {
    return new URL(import.meta.url).pathname.toLowerCase();
  } catch {
    return '';
  }
})();

export function installSegment() {
  const parts = selfPath.split('/').filter(Boolean);
  const srcIdx = parts.lastIndexOf('src');
  if (srcIdx < 1) return null;
  const parentIdx = srcIdx - 1;
  const firstHidden = parts.findIndex((p, i) => i < parentIdx && p.startsWith('.'));
  if (firstHidden >= 0) return parts.slice(firstHidden, parentIdx).join('/') || null;
  return parts[parentIdx - 1] || null;
}

export const AGENTS = [
  {
    id: 'codearts',
    pathPatterns: ['/.codeartsdoer/'],
    envVars: ['CODE_ARTS_HARNESS', 'CODEARTS_PROJECT_DIR'],
    version: { type: 'codearts' },
  },
  {
    id: 'opencode',
    pathPatterns: ['/.config/opencode/'],
    envVars: ['OPENCODE_SESSION_ID', 'OPENCODE_CONFIG_PATH'],
    version: null,
  },
  {
    id: 'codex-desktop',
    pathPatterns: ['/.codex/'],
    envVars: ['CODEX_DESKTOP', 'CODEX_ELECTRON'],
    version: null,
  },
  {
    id: 'codex',
    pathPatterns: null,
    envVars: ['CODEX_SESSION_ID', 'CODEX_CLI_VERSION', 'CODEX_SANDBOX', 'CODEX_THREAD_ID'],
    clientNames: ['codex-mcp-client'],
    version: null,
  },
  {
    id: 'codearts-work',
    pathPatterns: ['/.codeartswork/'],
    envVars: null,
    version: null,
  },
  {
    id: 'workbuddy',
    pathPatterns: ['/.workbuddy/'],
    envVars: ['WORK_BUDDY_SESSION_ID', 'WORKBUDDY_SESSION'],
    version: { type: 'workbuddy' },
  },
  {
    id: 'dsh',
    pathPatterns: ['/.dsh/'],
    envVars: ['DSH_SESSION_ID', 'DSH_HOME'],
    version: { type: 'dsh' },
  },
  {
    id: 'officeace',
    pathPatterns: ['/.office-claw/', '/.officeace/'],
    envVars: ['OFFICEACE_SESSION_ID', 'OFFICE_CLAW_CONFIG_ROOT'],
    clientNames: ['office-claw-mcp-connector-probe'],
    version: { type: 'officeace' },
  },
  {
    id: 'atomcode',
    pathPatterns: ['/.atomcode/'],
    envVars: ['ATOM_CODE_SESSION_ID', 'ATOMCODE_HOME'],
    version: null,
  },
  {
    id: 'hermes',
    pathPatterns: ['/.hermes/', '/hermes/'],
    envVars: ['HERMES_SESSION_ID', 'HERMES_HOME'],
    version: { type: 'hermes' },
  },
  {
    id: 'openclaw',
    pathPatterns: ['/.openclaw/', '/.agents/huaweicloud-plugins/'],
    envVars: ['OPENCLAW_SESSION_ID', 'OPENCLAW_CONFIG_ROOT'],
    clientNames: ['openclaw-bundle-mcp'],
    version: null,
  },
  {
    id: 'cursor',
    pathPatterns: ['/.cursor/', '/cursor/'],
    envVars: ['CURSOR_SESSION_ID', 'CURSOR_GIT_WORKDIR'],
    version: null,
  },
  {
    id: 'claude-code',
    pathPatterns: ['/.claude/'],
    envVars: ['CLAUDE_CODE_SESSION_ID'],
    version: null,
  },
  {
    id: 'cline',
    pathPatterns: ['/.vscode/extensions/saoudrizwan.claude-dev'],
    envVars: ['CLINE_ACTIVE'],
    version: null,
  },
  {
    id: 'github-copilot',
    pathPatterns: null,
    envVars: ['COPILOT_MODEL', 'COPILOT_ALLOW_ALL'],
    version: null,
  },
  {
    id: 'windsurf',
    pathPatterns: ['/.windsurf/', '/windsurf/'],
    envVars: ['WINDSURF_SESSION_ID'],
    version: null,
  },
  {
    id: 'kimi',
    pathPatterns: ['/.kimi/'],
    envVars: ['KIMI_PLUGIN_ROOT'],
    version: null,
  },
  {
    id: 'gemini-cli',
    pathPatterns: ['/.gemini/'],
    envVars: ['GEMINI_CLI'],
    version: null,
  },
  {
    id: 'augment-cli',
    pathPatterns: null,
    envVars: ['AUGMENT_AGENT'],
    version: null,
  },
  {
    id: 'aider',
    pathPatterns: ['/.aider/'],
    envVars: ['AIDER_SESSION'],
    version: null,
  },
  {
    id: 'tongyi-lingma',
    pathPatterns: ['/.lingma/'],
    envVars: ['LINGMA_SESSION_ID', 'LINGMA_PLUGIN_ROOT'],
    version: null,
  },
  {
    id: 'amazon-q',
    pathPatterns: ['/.amazonq/'],
    envVars: ['AMAZON_Q_SESSION_ID', 'AMAZON_Q_ENDPOINT'],
    version: null,
  },
  {
    id: 'continue',
    pathPatterns: ['/.continue/'],
    envVars: ['CONTINUE_SESSION_ID'],
    version: null,
  },
];

export function matchAgent(agent, clientInfo = {}) {
  if (agent.pathPatterns && agent.pathPatterns.some((p) => selfPath.includes(p))) return true;
  if (agent.envVars && agent.envVars.some((v) => process.env[v])) return true;
  const name = clientInfo.name;
  if (!name) return false;
  const lower = String(name).toLowerCase();
  if (agent.id.toLowerCase() === lower) return true;
  if (agent.clientNames && agent.clientNames.some((n) => n.toLowerCase() === lower)) return true;
  return false;
}

const _codeartsSearchBases = (() => {
  const bases = [];
  if (process.env.ProgramFiles) bases.push(join(process.env.ProgramFiles, 'CodeArts Agent'));
  if (process.env['ProgramFiles(x86)']) bases.push(join(process.env['ProgramFiles(x86)'], 'CodeArts Agent'));
  if (process.env.ProgramW6432) bases.push(join(process.env.ProgramW6432, 'CodeArts Agent'));
  if (process.env.LOCALAPPDATA) bases.push(join(process.env.LOCALAPPDATA, 'Programs', 'CodeArts'));
  return bases;
})();

function detectCodeArtsVersion() {
  for (const base of _codeartsSearchBases) {
    const p = join(base, 'resources', 'app', 'package.json');
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).version || null;
    } catch {}
  }
  for (let d = 'A'.charCodeAt(0); d <= 'Z'.charCodeAt(0); d++) {
    const drive = String.fromCharCode(d) + ':';
    try {
      const p = join(drive, '/', 'Program Files', 'CodeArts Agent', 'resources', 'app', 'package.json');
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).version || null;
    } catch {}
  }
  return null;
}

function detectDshVersion() {
  const candidates = [];
  // Standard npm global location
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  }
  candidates.push(join(homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  // Hermes-bundled DSH (Windows)
  if (process.env.LOCALAPPDATA) {
    candidates.push(
      join(process.env.LOCALAPPDATA, 'hermes', 'node', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    );
  }
  // DSH_HOME override
  if (process.env.DSH_HOME) {
    candidates.push(join(process.env.DSH_HOME, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    candidates.push(join(process.env.DSH_HOME, 'package.json'));
  }
  for (const p of candidates) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).version || null;
    } catch {}
  }
  return null;
}

function detectHermesVersion() {
  if (process.env.HERMES_VERSION) return process.env.HERMES_VERSION;
  const candidates = [];
  if (process.env.HERMES_HOME) candidates.push(process.env.HERMES_HOME);
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'hermes', 'hermes-agent'));
  candidates.push(join(homedir(), '.hermes', 'hermes-agent'));
  for (const base of candidates) {
    try {
      const initFile = join(base, 'hermes_cli', '__init__.py');
      if (existsSync(initFile)) {
        const content = readFileSync(initFile, 'utf8');
        const m = content.match(/__version__\s*=\s*['"]([^'"]+)['"]/);
        if (m) return m[1];
      }
    } catch {}
  }
  return null;
}

function detectWorkBuddyVersion() {
  const username = process.env.USERNAME || basename(homedir());
  const relPath = join('Users', username, 'AppData', 'Local', 'Programs', 'WorkBuddy');

  function tryBase(base) {
    const manifest = join(base, 'resources', 'install-manifest.json');
    try {
      if (existsSync(manifest)) {
        const m = JSON.parse(readFileSync(manifest, 'utf8'));
        if (m.appVersion) return `v${m.appVersion}`;
      }
    } catch {}
    const verFile = join(base, 'version');
    try {
      if (existsSync(verFile)) return readFileSync(verFile, 'utf8').trim() || null;
    } catch {}
    return null;
  }

  const localApp = join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy');
  const r = tryBase(localApp);
  if (r) return r;

  for (let d = 'A'.charCodeAt(0); d <= 'Z'.charCodeAt(0); d++) {
    const drive = String.fromCharCode(d) + ':';
    const r2 = tryBase(join(drive, '/', relPath));
    if (r2) return r2;
  }

  return null;
}

function detectOfficeAceVersion() {
  if (process.env.OFFICEACE_VERSION) return process.env.OFFICEACE_VERSION;

  function tryReleaseAt(base) {
    const releaseFile = join(base, '.office-claw-release.json');
    try {
      if (existsSync(releaseFile)) {
        const v = JSON.parse(readFileSync(releaseFile, 'utf8')).version;
        if (v) return `V${v}`;
      }
    } catch {}
    return null;
  }

  // 1. LOCALAPPDATA (works when child process inherits the right env)
  if (process.env.LOCALAPPDATA) {
    const r = tryReleaseAt(join(process.env.LOCALAPPDATA, 'Programs', 'OfficeAce'));
    if (r) return r;
  }

  // 2. Reconstruct LOCALAPPDATA from USERPROFILE (fallback when env differs)
  const up = process.env.USERPROFILE || process.env.HOME || homedir();
  if (up) {
    const r = tryReleaseAt(join(up, 'AppData', 'Local', 'Programs', 'OfficeAce'));
    if (r) return r;
  }

  // 3. Scan all drives (same strategy as WorkBuddy, handles off-system-drive installs)
  const username = process.env.USERNAME || basename(homedir());
  for (let d = 'A'.charCodeAt(0); d <= 'Z'.charCodeAt(0); d++) {
    const drive = String.fromCharCode(d) + ':';
    const r = tryReleaseAt(join(drive, '/', 'Users', username, 'AppData', 'Local', 'Programs', 'OfficeAce'));
    if (r) return r;
  }

  return null;
}

const VERSION_DETECTORS = {
  codearts: detectCodeArtsVersion,
  dsh: detectDshVersion,
  hermes: detectHermesVersion,
  workbuddy: detectWorkBuddyVersion,
  officeace: detectOfficeAceVersion,
};

export function detectVersion(versionConfig) {
  if (process.env.AGENT_VERSION) return process.env.AGENT_VERSION;
  if (!versionConfig) return null;
  const fn = VERSION_DETECTORS[versionConfig.type];
  return fn ? fn() : null;
}

export function findAgentById(id) {
  return AGENTS.find((a) => a.id === id) || null;
}
