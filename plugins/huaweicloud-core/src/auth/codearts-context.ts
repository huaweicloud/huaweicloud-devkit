// The CodeArts context and injected-credential reader, extracted from the
// credentials monolith (the stable src/auth/credentials.ts face re-exports
// this family): the CodeArts/CodeArts Work environment detector, the DevKit
// MCP server picker, and the mcp_settings.json credential reader.
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { asText } from '../lib/as-text.ts';
import { asRecord } from '../lib/as-record.ts';
import { present } from './credential-placeholder.ts';

export interface CodeArtsCredentials {
  ak: string;
  sk: string;
  securityToken: string;
  region: string;
}

// Pick the Huawei Cloud DevKit MCP server entry from a map using prefix matching.
// CodeArts Work marketplace presets keyed entries like `huaweicloud-devkit_1`
// (suffix per installed instance); match by prefix so `_1`/`_2`/`HuaweiCloud DevKit`
// all resolve without hardcoding an instance number.
// Deterministically choose the Huawei Cloud DevKit MCP server entry from a map.
// Priority (stable, independent of object key order):
//   1. exact `huaweicloud-devkit` (installer-managed key)
//   2. `HuaweiCloud Dev Kit`
//   3. prefixed instances `huaweicloud-devkit_N` sorted by ascending N
export function pickDevkitMcpServer(mcpMap: unknown): Record<string, unknown> | null {
  const map = asRecord(mcpMap);
  const keys = Object.keys(map);
  const rank = (k: string): number => {
    if (k === 'huaweicloud-devkit') return -2;
    if (k === 'HuaweiCloud DevKit') return -1;
    const m = /^huaweicloud-devkit_(\d+)$/i.exec(k);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  const candidates = keys
    .filter((k) => /^huaweicloud-devkit(?:_|$)/i.test(k) || k === 'HuaweiCloud DevKit')
    .sort((a, b) => rank(a) - rank(b));
  for (const k of candidates) {
    if (map[k]) return map[k] as Record<string, unknown>;
  }
  return null;
}

function readWorkEnvironmentEntry(config: unknown): CodeArtsCredentials | null {
  const server = pickDevkitMcpServer(asRecord(config).mcp);
  const environment = asRecord(server?.environment);
  const ak = environment.HW_ACCESS_KEY;
  const sk = environment.HW_SECRET_KEY;
  if (present(ak) && present(sk)) {
    const region = environment.HUAWEICLOUD_REGION || environment.HW_REGION;
    return {
      ak,
      sk,
      securityToken: present(environment.HW_SECURITY_TOKEN) ? environment.HW_SECURITY_TOKEN : '',
      region: asText(region || ''),
    };
  }
  return null;
}

let _parentCwd: string | null | undefined = undefined;

export function getParentCwd(): string | null {
  if (_parentCwd !== undefined) return _parentCwd;
  try {
    _parentCwd = readlinkSync(`/proc/${process.ppid}/cwd`);
    return _parentCwd;
  } catch {
    _parentCwd = null;
    return null;
  }
}

// Shared with service.ts's computeOnboarding (#900): the codearts flag must
// select the identical builder variant on the resolver failure path and the
// status path — one detector, both call sites.
export function isCodeArtsContext(): boolean {
  return (
    existsSync(join(process.cwd(), '.codeartsdoer')) ||
    existsSync(join(homedir(), '.codeartsdoer')) ||
    existsSync(join(homedir(), '.codeartswork')) ||
    existsSync(join(homedir(), '.codearts'))
  );
}

export function readCodeArtsCredentials(): CodeArtsCredentials | null {
  const parentCwd = getParentCwd();
  const searchDirs = [process.env.CODEARTS_PROJECT_DIR, parentCwd, process.cwd(), homedir()];

  for (const dir of searchDirs) {
    if (!dir) continue;
    const path = join(dir, '.codeartsdoer', 'mcp', 'mcp_settings.json');
    try {
      if (!existsSync(path)) continue;
      const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const server = pickDevkitMcpServer(asRecord(config).mcpServers);
      const env = asRecord(server?.env);
      if (!server || !server.env) continue;

      const ak = env.HW_ACCESS_KEY;
      const sk = env.HW_SECRET_KEY;
      if (present(ak) && present(sk)) {
        const region = env.HUAWEICLOUD_REGION || env.HW_REGION;
        return {
          ak,
          sk,
          securityToken: present(env.HW_SECURITY_TOKEN) ? env.HW_SECURITY_TOKEN : '',
          region: asText(region || ''),
        };
      }
    } catch {
      // mcp_settings.json missing or invalid — skip
    }
  }

  // CodeArts Work — user-level only.
  // New layout (post platform migration): ~/.codearts/mcp/mcp_settings.json with
  // prefixed keys like `huaweicloud-devkit_1`; legacy ~/.codeartswork kept as
  // fallback while still in service.
  const workPaths = [
    join(homedir(), '.codearts', 'mcp', 'mcp_settings.json'),
    join(homedir(), '.codeartswork', 'mcp', 'mcp_settings.json'),
  ];
  for (const path of workPaths) {
    try {
      if (!existsSync(path)) continue;
      const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const entry = readWorkEnvironmentEntry(config);
      if (entry) return entry;
    } catch {
      // mcp_settings.json missing or invalid — skip
    }
  }

  return null;
}
